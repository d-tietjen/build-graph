'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Analysis = require('../src/analysis-api.js');
const { fixture, engines, fn } = require('../tests/fixtures/advisory-exposure/graphs.cjs');
const query = (extra = {}) => ({ op: 'callPaths', from: 'application::main', to: 'parser::affected', page: { limit: 100 }, ...extra });
test('complete connecting graph keeps both diamond branches, multiple callsites and cycles', async () => {
  const r = await Analysis.create(fixture()).query(query());
  assert.equal(r.status, 'captured-route'); assert.equal(r.completion.graphComplete, true); assert.equal(r.completion.evidenceComplete, true);
  assert.deepEqual(new Set(r.nodes.items.map(n => n.id)), new Set(['application::main', 'bridge::left', 'bridge::right', 'parser::affected', 'parser::cycle']));
  assert.equal(r.edges.items.filter(e => e.source === 'bridge::left' && e.target === 'parser::affected')[0].callsites.length, 2);
  assert(r.edges.items.some(e => e.source === 'parser::cycle' && e.target === 'parser::affected'));
  assert.equal(r.semantics.orderedExecutionProven, false); assert.equal(r.examples.bounded, true);
});
test('same endpoints retain zero length and true recursion without CFG-loop pseudo calls', async () => {
  const raw = fixture(); raw.nodes.push(...fn('self::recursive', 'bridge@1.0.0', ['self::recursive']));
  const api = Analysis.create(raw);
  const r = await api.query(query({ from: 'self::recursive', to: 'self::recursive' }));
  assert.equal(r.endpoints.zeroLength, true); assert.equal(r.status, 'captured-route');
  assert(r.edges.items.some(e => e.kind === 'recursion')); assert(r.edges.items.every(e => e.kind !== 'loop'));
  const isolated = await api.query(query({ from: 'parser::unused', to: 'parser::unused' }));
  assert.equal(isolated.nodes.total, 1); assert.equal(isolated.edges.total, 0); assert.equal(isolated.status, 'captured-route');
});
test('direction and reference negatives never claim global impossibility or non-exposure', async () => {
  const api = Analysis.create(fixture());
  for (const q of [query({ from: 'parser::affected', to: 'application::main' }), query({ from: 'application::reference_only', to: 'parser::unused' })]) {
    const r = await api.query(q); assert.equal(r.status, 'no-captured-route'); assert.equal(r.nodes.total, 0);
    assert.equal(r.semantics.globalImpossibilityProven, false); assert.equal(r.queryCoverage.missingBodiesProveNonExposure, false);
    assert.equal(r.queryCoverage.partial, q.from === 'application::reference_only');
  }
});
test('global callback alternatives are possible and strict policy is explicitly incomplete', async () => {
  const api = Analysis.create(fixture());
  const q = query({ from: 'application::invoke', to: 'parser::unused' });
  const possible = await api.query(q); assert.equal(possible.status, 'captured-route');
  assert(possible.edges.items.some(e => e.classification === 'possible')); assert.equal(possible.semantics.invocationExact, false);
  const strict = await api.query({ ...q, includePossible: false }); assert.equal(strict.status, 'no-captured-route'); assert(strict.queryCoverage.excludedPossible > 0); assert(strict.queryCoverage.partial);
});
test('exact IDs reject ambiguous path aliases, unknown IDs and malformed budgets', async () => {
  const raw = fixture();
  for (const [id, pkg] of [['one', 'parser@1.2.3'], ['two', 'parser@2.0.0']]) {
    const nodes = fn('duplicate::same', pkg); nodes[0].id = id; nodes[1].id = 'flow:' + id; nodes[1].attributes.symbol_id = id; raw.nodes.push(...nodes);
  }
  const api = Analysis.create(raw);
  assert.equal((await api.query(query({ to: 'duplicate::same' }))).error.code, 'AMBIGUOUS_ENDPOINT');
  assert.equal((await api.query(query({ to: 'absent' }))).error.code, 'UNKNOWN_ENDPOINT');
  assert.equal((await api.query(query({ budgets: { maxWork: 0 } }))).error.code, 'INVALID_BUDGET');
});
test('scope hides no traversal, paging/replay preserve all evidence and input/output mutation is isolated', async () => {
  const raw = fixture(), api = Analysis.create(raw), q = query({ scope: { packageIds: ['application@1.0.0'], dependencies: 'none' }, page: { nodes: { limit: 1 }, edges: { limit: 2 } } });
  raw.nodes.length = 0;
  const r = await api.query(q); assert.equal(r.status, 'captured-route'); assert(r.queryCoverage.hiddenIntermediaries > 0); assert.equal(r.completion.graphComplete, true); assert.equal(r.completion.evidenceComplete, false);
  const replay = await api.query({ op: 'replay', replay: r.replay }); assert.equal(replay.replayed, true); assert.deepEqual(replay.nodes, r.nodes);
  const ids = []; let offset = 0;
  do { const p = await api.query({ ...q, page: { nodes: { limit: 2, offset } } }); ids.push(...p.nodes.items.map(n => n.id)); offset = p.nodes.nextOffset; } while (offset != null);
  assert.equal(new Set(ids).size, 5);
  r.nodes.items[0].id = 'mutated'; r.replay.request.to = 'changed';
  assert.notEqual((await api.query(q)).nodes.items[0].id, 'mutated');
});
test('work, memory and cancellation are incomplete without publishing an alleged complete graph', async () => {
  const { paths, evidence } = engines();
  for (const budgets of [{ maxWork: 1 }, { maxNodes: 1 }, { maxEdges: 1 }]) {
    const r = await paths.query(query({ budgets }), evidence); assert.equal(r.status, 'indeterminate'); assert.equal(r.completion.complete, false); assert.equal(r.nodes.total, 0);
  }
  const r = await paths.query(query(), evidence, { cancelled: () => true }); assert.equal(r.completion.reason, 'cancelled'); assert.equal(r.status, 'indeterminate');
});
if (process.env.CALL_PATHS_CAPTURE) test('actual controlled compiler capture exposes generic finite call routes', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.CALL_PATHS_CAPTURE, 'utf8')), api = Analysis.create(raw);
  const functions = (await api.query({ op: 'functions', page: { limit: 100 } })).functions.items;
  const root = functions.find(f => f.body.status === 'captured'); assert(root, 'actual captured body');
  const r = await api.query(query({ from: root.id, to: root.id })); assert.equal(r.status, 'captured-route'); assert.equal(r.endpoints.zeroLength, true);
  assert.equal(r.graph.contentSha256, api.graph.contentSha256); assert(r.nodes.items.some(n => n.procedureId));
});

const controls = require('../tests/fixtures/advisory-exposure/graphs.cjs');
test('CP2 full bounded membership is invariant across independently paged evidence and replay', async () => {
  const api = Analysis.create(controls.corridor()), base = query({ from: 'corridor::0', to: 'corridor::185', page: { nodes: { limit: 1 }, edges: { limit: 2 } } });
  const r = await api.query(base);
  assert.equal(r.membership.schemaVersion, 1); assert.equal(r.membership.complete, true);
  assert.equal(r.membership.nodeIds.length, 186); assert.equal(r.membership.edges.length, 185);
  assert(r.membership.nodeIds.includes(base.from) && r.membership.nodeIds.includes(base.to));
  assert.equal(r.nodes.items.length, 1); assert.equal(r.edges.items.length, 2);
  const next = await api.query({ ...base, page: { nodes: { offset: 100, limit: 50 } } });
  assert.deepEqual(next.membership, r.membership);
  assert.deepEqual((await api.query({ op: 'replay', replay: r.replay })).membership, r.membership);
  const bounded = await api.query({ ...base, budgets: { maxNodes: 100 } });
  assert.equal(bounded.membership.complete, false); assert.equal(bounded.membership.nodeIds.length, 0);
});
for (const mode of ['direct', 'callback', 'mixed']) test(`CP4 ${mode} self-recursion preserves constituent certainty in API/replay`, async () => {
  const api = Analysis.create(controls.recursion(mode)), q = query({ from: 'self::recursive', to: 'self::recursive' });
  const included = await api.query(q), strict = await api.query({ ...q, includePossible: false });
  const sites = included.edges.items.flatMap(e => e.callsites);
  assert.equal(sites.length, mode === 'mixed' ? 2 : 1); assert(sites.every(s => s.invocationExact === false));
  assert.equal(strict.edges.total, mode === 'callback' ? 0 : 1);
  if (mode !== 'callback') { assert.equal(strict.edges.items[0].callsites.length, 1); assert.match(strict.edges.items[0].callsites[0].id, /#bb0@call$/); }
  if (mode !== 'direct') { assert(strict.queryCoverage.excludedPossible > 0); assert(strict.queryCoverage.partial); }
  assert.deepEqual((await api.query({ op: 'replay', replay: strict.replay })).edges, strict.edges);
});
for (const kind of ['callback', 'possible', 'native', 'legacy', 'ownership', 'missing']) test(`CP5 ${kind} uncertainty is source-reachable, with a disjoint negative`, async () => {
  const base = query({ from: 'known::a', to: 'known::b', includePossible: false });
  const clean = await Analysis.create(controls.coverageGraph('none', false)).query(base);
  const disjoint = await Analysis.create(controls.coverageGraph(kind, false)).query(base);
  const reachable = await Analysis.create(controls.coverageGraph(kind, true)).query(base);
  assert.equal(clean.queryCoverage.partial, false); assert.equal(disjoint.queryCoverage.partial, false);
  assert.equal(disjoint.queryCoverage.excludedPossible, 0); assert.deepEqual(disjoint.membership, clean.membership);
  assert.equal(reachable.queryCoverage.partial, true); if (kind !== 'possible') assert(reachable.queryCoverage.unknownFrontier.total > 0);
  if (kind === 'possible') assert(reachable.queryCoverage.excludedPossible > 0);
  assert.equal(reachable.queryCoverage.missingBodiesProveNonExposure, false);
});

for (const kind of ['opaque', 'yield', 'missing-mir']) test(`CP5 accepted ${kind} body gaps are local, source-linked and replayed`, async () => {
  const base = query({ from: 'known::a', to: 'known::b', includePossible: false });
  const clean = await Analysis.create(controls.coverageGraph('none', false)).query(base);
  const disjoint = await Analysis.create(controls.bodyGapGraph(kind, false)).query(base);
  assert.equal(clean.queryCoverage.partial, false); assert.equal(disjoint.queryCoverage.partial, false);
  assert.equal(disjoint.queryCoverage.unknownFrontier.total, 0); assert.deepEqual(disjoint.membership, clean.membership);
  const raw = controls.bodyGapGraph(kind, true), api = Analysis.create(raw), r = await api.query(base);
  assert.equal(r.status, 'captured-route'); assert.equal(r.completion.graphComplete, true); assert.equal(r.queryCoverage.partial, true);
  assert.equal(r.endpoints.to.procedureId, 'known::b'); assert.equal(r.endpoints.to.functionId, 'compiler:known::b');
  assert.equal(r.endpoints.to.bodyStatus, kind === 'missing-mir' ? 'unavailable' : 'captured');
  assert.equal(r.endpoints.to.bodyAvailability, kind === 'missing-mir' ? 'missing-mir' : 'available');
  const gap = r.queryCoverage.unknownFrontier.items.find(n => n.id === 'known::b').bodyGaps[0];
  assert.equal(gap.nodeId, 'known::b#bb0'); assert.equal(gap.blockId, 'bb0');
  assert.equal(gap.kind, kind === 'missing-mir' ? 'opaque' : kind);
  assert.equal(gap.reason, kind === 'missing-mir' ? kind : kind === 'yield' ? 'yield-boundary' : 'opaque-block');
  assert.equal(gap.source.source_file, 'fixture.rs'); assert.equal(gap.source.source_location, 3);
  assert.deepEqual((await api.query({ op: 'replay', replay: r.replay })).queryCoverage, r.queryCoverage);
});
test('CP5 reachable body-gap retention spends query work, bytes and cooperative cancellation', async () => {
  const raw = controls.replaceBody(controls.coverageGraph('none', false), 'known::b', 'opaque', 1024);
  const { paths, evidence } = controls.engines(raw), base = query({ from: 'known::a', to: 'known::b', includePossible: false });
  for (const budgets of [{ maxWork: 100 }, { maxEvidenceBytes: 4096 }]) {
    const r = await paths.query({ ...base, budgets }, evidence);
    assert.equal(r.completion.complete, false); assert.equal(r.membership.complete, false); assert.equal(r.membership.nodeIds.length, 0);
    assert.equal(r.completion.reason, budgets.maxWork ? 'work-budget' : 'evidence-byte-budget');
  }
  let cancelled = false, observed = false;
  const pending = paths.query(base, evidence, { cancelled: () => { observed = true; return cancelled; } });
  await new Promise(resolve => setTimeout(() => { assert(observed); cancelled = true; resolve(); }, 0));
  const r = await pending; assert.equal(r.completion.reason, 'cancelled'); assert.equal(r.membership.complete, false);
});
