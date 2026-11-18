'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Analysis = require('../src/analysis-api.js');
const { fixture } = require('../tests/fixtures/advisory-exposure/graphs.cjs');
// This executes the current viewer wiring and the actual Blob worker source,
// including embedded current-module byte checks when emitted HTML is supplied.
const { harness, descendants, until, normalized } = require('./test-viewer-effects.cjs');
function panel(h, id = 'call-paths-content') { return h.elements.get(id); }
function find(h, label, id) {
  const elements = descendants(panel(h, id));
  const el = elements.find(e => e.attributes['aria-label'] === label) || elements.find(e => e.textContent === label);
  assert(el, label);
  return el;
}
function click(h, label, id) { return find(h, label, id).listeners.click(); }
function evidence(h, id) { const pre = descendants(panel(h, id)).filter(e => e.tagName === 'pre'); return pre.length ? JSON.parse(pre[pre.length - 1].textContent).result : null; }
const request = (extra = {}) => ({ op: 'callPaths', from: 'application::main', to: 'parser::affected', page: { limit: 100 }, ...extra });
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} callPaths API parity, complete symbolic alternatives and replay`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const q = request({ scope: { packageIds: ['application@1.0.0'], dependencies: 'none' } });
    const browser = await h.ui.queryConnections(q), agent = await api.query(q);
    assert.deepEqual(normalized(browser), agent); assert.equal(browser.completion.graphComplete, true); assert(browser.queryCoverage.hiddenIntermediaries > 0);
    const replay = await h.ui.queryConnections({ op: 'replay', replay: browser.replay }); assert.equal(replay.replayed, true); assert.deepEqual(normalized(replay.edges), agent.edges);
    const invalid = h.ui.queryConnections(request({ to: 'unknown-id' })); await assert.rejects(invalid, /Unknown captured function ID/);
  });
  test(`${worker ? 'worker' : 'fallback'} map endpoint selection and paging disclose visible/hidden nodes without changing pins`, async () => {
    const h = await harness(worker, fixture()); h.context.STATE_UI.pins = ['preserve'];
    h.ui.setCallEndpoint('from', 'application::main'); h.ui.setCallEndpoint('to', 'parser::affected');
    assert.equal(find(h, 'Call path start ID').value, 'application::main'); assert.equal(find(h, 'Call path destination ID').value, 'parser::affected');
    click(h, 'Find connecting calls'); await until(() => evidence(h)); assert.equal(evidence(h).status, 'captured-route');
    assert.deepEqual(h.context.STATE_UI.pins, ['preserve']);
    await h.ui.runCallPaths(request({ page: { nodes: { limit: 1 }, edges: { limit: 1 } } }));
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 5); assert(descendants(panel(h)).some(e => /PAGED OR INCOMPLETE VIEW/.test(e.textContent)));
    click(h, 'Next nodes'); await until(() => evidence(h)?.nodes.offset === 1);
    assert.equal(evidence(h).completion.graphComplete, true); assert.equal(evidence(h).completion.evidenceComplete, false);
    find(h, 'Call path possible policy').value = 'false'; find(h, 'Call path possible policy').listeners.change();
    assert.equal(evidence(h), null); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
  });
  test(`${worker ? 'worker' : 'fallback'} supported flow/flame/sequence and ordered drilldowns use captured procedures`, async () => {
    const h = await harness(worker, fixture()), calls = [];
    Object.assign(h.context.STATE_UI, { hasProcedure: () => true, focus: id => calls.push(['flow', id]), activate() {} });
    h.context.WATERFALL_UI = { open: (id, pins, mode) => calls.push([mode, id]), activate() {} };
    await h.ui.runCallPaths(request());
    for (const label of ['Inspect function execution', 'Inspect function flamegraph', 'Inspect function sequence']) click(h, label);
    assert(calls.some(c => c[0] === 'flow')); assert(calls.some(c => c[0] === 'flamegraph')); assert(calls.some(c => c[0] === 'sequence'));
    assert(calls.every(c => c[1] === 'application::main'));
    click(h, 'Check ordered flow');
    await until(() => descendants(h.elements.get('ordered-path-content')).some(e => e.tagName === 'pre'));
    assert(descendants(h.elements.get('ordered-path-content')).some(e => /Ordered evidence and replay/.test(e.textContent)));
    const orderedEvidence = JSON.parse(descendants(h.elements.get('ordered-path-content')).find(e => e.tagName === 'pre').textContent);
    assert.equal(orderedEvidence.request.function, 'application::main'); assert.equal(orderedEvidence.request.target.id, 'parser::affected');
    h.context.WATERFALL_UI.openWitness = (trace, mode) => calls.push(['route-' + mode, trace]);
    h.context.WATERFALL_UI.clearWitness = () => {};
    click(h, 'Open endpoint route sequence');
    await until(() => calls.some(c => c[0] === 'route-sequence') || descendants(panel(h)).some(e => /Selected-route detail indeterminate/.test(e.textContent)));
    if (calls.some(c => c[0] === 'route-sequence')) assert.match(JSON.stringify(calls.find(c => c[0] === 'route-sequence')[1]), /parser::affected/);
    const routeCount = calls.filter(c => c[0] === 'route-sequence').length;
    click(h, 'Open endpoint route sequence'); h.ui.setCallEndpoint('to', 'parser::unused');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.filter(c => c[0] === 'route-sequence').length, routeCount, 'changed destination suppresses stale route view'); assert.equal(evidence(h), null);
  });
  test(`${worker ? 'worker' : 'fallback'} dispatch snapshots input; cancel/replacement/capture reset discard stale results`, async () => {
    const h = await harness(worker, fixture()), q = request(), pending = h.ui.queryConnections(q);
    q.to = 'unknown-id'; q.page.limit = 1;
    assert.equal((await pending).request.to, 'parser::affected');
    const first = h.ui.queryConnections(request()); const rejected = assert.rejects(first, /superseded or cancelled/);
    const second = h.ui.queryConnections(request({ from: 'parser::unused', to: 'parser::unused' })); await rejected;
    assert.equal((await second).nodes.total, 1);
    const active = h.ui.runCallPaths(request()); const cancelled = assert.rejects(active, /superseded or cancelled/); h.ui.cancelConnections(); await cancelled;
    assert.equal(evidence(h), null); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    const old = h.ui.queryConnections(request()); const changed = assert.rejects(old, /superseded or cancelled|Capture changed/);
    h.ui.refresh(JSON.stringify(fixture())); await changed;
    assert.equal(find(h, 'Call path start ID').value, ''); assert.equal(evidence(h), null);
  });
}
if (process.env.CALL_PATHS_HTML || process.env.CALL_PATHS_CAPTURE) {
  test('actual CURRENT emitted HTML worker/fallback query and source/replay contract', async () => {
    assert(process.env.CALL_PATHS_HTML && process.env.CALL_PATHS_CAPTURE, 'both capture and current emitted HTML required');
    const raw = JSON.parse(fs.readFileSync(process.env.CALL_PATHS_CAPTURE, 'utf8')), html = fs.readFileSync(process.env.CALL_PATHS_HTML, 'utf8');
    const api = Analysis.create(raw), functions = (await api.query({ op: 'functions', page: { limit: 100 } })).functions.items;
    let q;
    for (const from of functions.filter(f => f.body.status === 'captured')) {
      const neighbors = await api.query({ op: 'neighbors', function: from.id, page: { limit: 100 } });
      const edge = neighbors.outgoing.items.find(e => e.execution && functions.some(f => f.id === e.target && f.body.status === 'captured'));
      if (edge) { q = request({ from: from.id, to: edge.target }); break; }
    }
    assert(q, 'actual captured interprocedural call');
    for (const worker of [false, true]) {
      const h = await harness(worker, raw, { html }), browser = await h.ui.runCallPaths(q), agent = await Analysis.create(raw, { rawText: h.raw }).query(q);
      assert.deepEqual(normalized(browser), agent); assert.equal(browser.status, 'captured-route'); assert(browser.edges.items.length > 0);
      assert(browser.edges.items.some(e => e.callsites.some(s => s.source_file))); assert.equal(evidence(h).graph.contentSha256, browser.graph.contentSha256);
      assert.equal((await h.ui.queryConnections({ op: 'replay', replay: browser.replay })).replayed, true);
    }
  });
}
module.exports = { harness, descendants, until, normalized, panel, find, click, evidence };

const controls = require('../tests/fixtures/advisory-exposure/graphs.cjs');
function panelButton(h, panelId, label) { const button = descendants(h.elements.get(panelId)).find(e => e.textContent === label); assert(button, label); button.listeners.click(); }
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} CP2 full 186-node map survives independent table paging and reset`, async () => {
    const h = await harness(worker, controls.corridor()), q = request({ from: 'corridor::0', to: 'corridor::185' }); delete q.page;
    const unchanged = preserveView(h); h.defer(q => q.op === 'effectPaths'); h.ui.selectEntryNode('corridor::100');
    await until(() => h.pending.length === 1); const oldEntry = h.pending[0];
    const r = await h.ui.runCallPaths(q); assert.equal(r.completion.graphComplete, true);
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 186); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.edges.size, 185);
    assert(h.context.ENTRY_EFFECT_ACTIVE.nodes.has(q.from)); assert(h.context.ENTRY_EFFECT_ACTIVE.nodes.has(q.to));
    assert(h.context.ENTRY_EFFECT_ACTIVE.edges.has('corridor::90\tcorridor::91'));
    oldEntry.resolve(); await until(() => entryEvidence(h));
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 186); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.edges.size, 185); unchanged();
    click(h, 'Next nodes'); await until(() => evidence(h)?.nodes.offset === 50);
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 186); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.edges.size, 185);
    click(h, 'Next edges'); await until(() => evidence(h)?.edges.offset === 50);
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 186); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.edges.size, 185);
    await h.ui.runCallPaths({ ...q, page: { limit: 100 } });
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 186); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.edges.size, 185);
    await h.ui.runCallPaths({ ...q, budgets: { maxNodes: 100 } });
    assert.equal(evidence(h).completion.graphComplete, false); assert.equal(h.context.ENTRY_EFFECT_ACTIVE.nodes.size, 0);
    assert(descendants(panel(h)).some(e => /PARTIAL MAP/.test(e.textContent)));
    h.ui.refresh(JSON.stringify(fixture())); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
  });
  for (const mode of ['direct', 'callback', 'mixed']) test(`${worker ? 'worker' : 'fallback'} CP4 ${mode} recursive callsite policy and replay`, async () => {
    const raw = controls.recursion(mode), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    for (const includePossible of [true, false]) {
      const q = request({ from: 'self::recursive', to: 'self::recursive', includePossible }), r = await h.ui.queryConnections(q);
      assert.deepEqual(normalized(r), await api.query(q)); assert.equal(r.edges.total, mode === 'callback' && !includePossible ? 0 : 1);
      assert.equal(r.edges.items.flatMap(e => e.callsites).length, mode === 'mixed' && includePossible ? 2 : mode === 'callback' && !includePossible ? 0 : 1);
      assert.deepEqual(normalized((await h.ui.queryConnections({ op: 'replay', replay: r.replay })).edges), normalized(r.edges));
    }
  });
  for (const kind of ['callback', 'possible', 'native', 'legacy', 'ownership', 'missing']) test(`${worker ? 'worker' : 'fallback'} CP5 ${kind} disjoint/reachable coverage controls`, async () => {
    for (const reachable of [false, true]) {
      const raw = controls.coverageGraph(kind, reachable), h = await harness(worker, raw);
      const q = request({ from: 'known::a', to: 'known::b', includePossible: false }), r = await h.ui.queryConnections(q);
      assert.deepEqual(normalized(r), await Analysis.create(raw, { rawText: h.raw }).query(q));
      assert.equal(r.queryCoverage.partial, reachable); if (!reachable) assert.equal(r.queryCoverage.excludedPossible, 0);
      if (reachable && kind !== 'possible') assert(r.queryCoverage.unknownFrontier.total > 0);
    }
  });
  test(`${worker ? 'worker' : 'fallback'} CP9 endpoint ownership cannot cancel pending or completed independent ordered proof`, async () => {
    const h = await harness(worker, fixture()), analyses = []; let cleared = 0;
    Object.assign(h.context.STATE_UI, { hasProcedure: () => true, focus() {}, activate() {}, setAnalysis: value => analyses.push(value) });
    h.context.WATERFALL_UI = { openWitness() {}, activate() {}, clearWitness() { cleared++; } };
    async function endpoint() {
      await h.ui.runCallPaths(request()); click(h, 'Check ordered flow');
      await until(() => descendants(h.elements.get('ordered-path-content')).some(e => e.tagName === 'pre'));
    }
    await endpoint();
    const manual = { op: 'orderedPath', function: 'bridge::left', target: { kind: 'procedure', id: 'parser::affected' } };
    const pending = h.ui.runOrderedQuery(manual); h.ui.setCallEndpoint('to', 'parser::unused');
    const accepted = await pending; assert(accepted.witness); assert.equal(accepted.request.function, manual.function);
    await endpoint(); await h.ui.runOrderedQuery(manual);
    panelButton(h, 'ordered-path-content', 'Open execution flow');
    const current = analyses.at(-1), before = analyses.length;
    panelButton(h, 'ordered-path-content', 'Open UML sequence'); const witnesses = cleared;
    h.ui.setCallEndpoint('from', 'parser::unused');
    assert.equal(analyses.length, before); assert.equal(analyses.at(-1), current); assert.equal(cleared, witnesses);
    assert.match(h.elements.get('state-status').textContent, /STRUCTURAL ordered witness/);
  });
  test(`${worker ? 'worker' : 'fallback'} CP9 connection changes preserve newer value/guard/current structural canvas`, async () => {
    const VF = require('../tests/fixtures/value-flow/fixture-graphs.cjs'), GF = require('../tests/fixtures/guard-obligations/fixture-graphs.cjs');
    for (const op of ['value', 'guard']) {
      const item = op === 'value' ? { raw: VF.simple(), request: VF.model() } : GF.scenario();
      item.raw.nodes.push(...fixture().nodes);
      const h = await harness(worker, item.raw), analyses = [];
      Object.assign(h.context.STATE_UI, { hasProcedure: () => true, focus() {}, activate() {}, setAnalysis: value => analyses.push(value) });
      await h.ui.runCallPaths(request()); click(h, 'Check ordered flow');
      await until(() => descendants(h.elements.get('ordered-path-content')).some(e => e.tagName === 'pre'));
      if (op === 'value') await h.ui.runValueQuery(item.request); else await h.ui.runGuardQuery(item.request);
      panelButton(h, op === 'value' ? 'value-flow-content' : 'guard-obligations-content', 'Open execution flow');
      const current = analyses.at(-1), before = analyses.length, disclosure = descendants(h.elements.get('state-evidence')).find(e => e.tagName === 'pre').textContent;
      assert(current); h.ui.setCallEndpoint('to', 'parser::unused');
      assert.equal(analyses.length, before); assert.equal(analyses.at(-1), current);
      assert.equal(descendants(h.elements.get('state-evidence')).find(e => e.tagName === 'pre').textContent, disclosure);
      h.ui.analyzeState(['root']); await until(() => analyses.length > before);
      const structural = analyses.at(-1), count = analyses.length; h.ui.cancelConnections(); assert.equal(analyses.length, count); assert.equal(analyses.at(-1), structural);
    }
  });
}

function highlight(h) {
  const active = h.context.ENTRY_EFFECT_ACTIVE;
  return active && { nodes: Array.from(active.nodes).sort(), edges: Array.from(active.edges).sort() };
}
function entryEvidence(h) {
  return descendants(h.panel).filter(e => e.tagName === 'pre').map(e => JSON.parse(e.textContent))
    .find(e => e.request && e.request.op === 'effectPaths') || null;
}
function preserveView(h) {
  // These are the actual shared renderer globals; the highlight helper must leave them intact.
  const pins = ['keep-pin'], tree = new Map([['keep-tree', false]]), nodes = new Set(['function']), edges = new Set(['call']);
  h.context.STATE_UI.pins = pins; h.context.ARCH_TREE_OVERRIDES = tree;
  h.context.ARCH_NODE_FILTER = nodes; h.context.ARCH_EDGE_FILTER = edges;
  return () => {
    assert.equal(h.context.STATE_UI.pins, pins); assert.deepEqual(pins, ['keep-pin']);
    assert.equal(h.context.ARCH_TREE_OVERRIDES, tree); assert.deepEqual(Array.from(tree), [['keep-tree', false]]);
    assert.equal(h.context.ARCH_NODE_FILTER, nodes); assert.deepEqual(Array.from(nodes), ['function']);
    assert.equal(h.context.ARCH_EDGE_FILTER, edges); assert.deepEqual(Array.from(edges), ['call']);
  };
}
for (const worker of [false, true]) {
  for (const kind of ['opaque', 'yield', 'missing-mir']) test(`${worker ? 'worker' : 'fallback'} CP5 ${kind} accepted body availability/frontier/API/replay`, async () => {
    for (const reachable of [false, true]) {
      const raw = controls.bodyGapGraph(kind, reachable), h = await harness(worker, raw);
      const q = request({ from: 'known::a', to: 'known::b', includePossible: false });
      const r = await h.ui.runCallPaths(q), agent = await Analysis.create(raw, { rawText: h.raw }).query(q);
      assert.deepEqual(normalized(r), agent); assert.equal(r.queryCoverage.partial, reachable);
      assert.equal(r.endpoints.to.bodyStatus, reachable && kind === 'missing-mir' ? 'unavailable' : 'captured');
      assert.equal(r.endpoints.to.functionId, 'compiler:known::b');
      if (reachable) {
        const gap = r.queryCoverage.unknownFrontier.items.find(n => n.id === 'known::b').bodyGaps[0];
        assert.equal(gap.nodeId, 'known::b#bb0'); assert.equal(gap.source.source_file, 'fixture.rs'); assert.equal(gap.source.source_location, 3);
        assert.equal(gap.reason, kind === 'missing-mir' ? kind : kind === 'yield' ? 'yield-boundary' : 'opaque-block');
      } else assert.equal(r.queryCoverage.unknownFrontier.total, 0);
      assert.deepEqual(normalized((await h.ui.queryConnections({ op: 'replay', replay: r.replay })).queryCoverage), agent.queryCoverage);
    }
  });
  for (const outcome of ['success', 'error']) test(`${worker ? 'worker' : 'fallback'} CP10 delayed old effect route ${outcome} cannot replace the newer disclosed full corridor`, async () => {
    const h = await harness(worker, fixture()), unchanged = preserveView(h);
    h.defer(q => q.op === 'effectPaths'); h.ui.selectEntryNode('builder::main');
    await until(() => h.pending.some(p => p.request.op === 'effectPaths'));
    const gate = h.pending.find(p => p.request.op === 'effectPaths');
    const r = await h.ui.runCallPaths(request({ page: { nodes: { limit: 1 }, edges: { limit: 1 } } })), current = highlight(h);
    assert.deepEqual(current.nodes, Array.from(r.membership.nodeIds).sort());
    assert(current.nodes.includes('bridge::left') && current.nodes.includes('bridge::right'));
    if (outcome === 'success') { gate.resolve(); await until(() => entryEvidence(h)); }
    else { gate.reject(new Error('older-effect-route-error')); await until(() => descendants(h.panel).some(e => /older-effect-route-error/.test(e.textContent))); }
    assert.deepEqual(highlight(h), current); assert.equal(evidence(h).request.from, r.request.from); assert.equal(evidence(h).request.to, r.request.to);
    click(h, 'Next nodes'); await until(() => evidence(h)?.nodes.offset === 1); assert.deepEqual(highlight(h), current);
    click(h, 'Next edges'); await until(() => evidence(h)?.edges.offset === 1); assert.deepEqual(highlight(h), current); unchanged();
  });
  test(`${worker ? 'worker' : 'fallback'} CP10 entry selection delayed before its route cannot reclaim newer call ownership`, async () => {
    const h = await harness(worker, fixture()); h.defer(q => q.op === 'entrypoints' && q.function === 'builder::main');
    h.ui.selectEntryNode('builder::main'); await until(() => h.pending.length === 1);
    await h.ui.runCallPaths(request()); const current = highlight(h);
    h.pending[0].resolve(); await until(() => entryEvidence(h));
    assert.deepEqual(highlight(h), current); assert.equal(evidence(h).request.from, 'application::main');
  });
  test(`${worker ? 'worker' : 'fallback'} CP10 old Entries filters/clear/reset preserve the newer actor and current corridor pages`, async () => {
    const h = await harness(worker, fixture()), unchanged = preserveView(h);
    h.ui.selectEntryNode('builder::main'); await until(() => entryEvidence(h));
    await h.ui.runCallPaths(request()); const current = highlight(h);
    const category = find(h, 'Effect category', 'entry-effects-content'); category.value = 'network'; category.listeners.change();
    await until(() => entryEvidence(h)?.request.category === 'network'); assert.deepEqual(highlight(h), current);
    const possible = descendants(h.panel).find(e => e.tagName === 'input' && e.type === 'checkbox');
    possible.checked = false; possible.listeners.change(); await until(() => entryEvidence(h)?.request.includePossible === false);
    assert.deepEqual(highlight(h), current);
    click(h, 'Clear route highlight', 'entry-effects-content'); assert.deepEqual(highlight(h), current);
    const phase = find(h, 'Execution phase', 'entry-effects-content'); phase.value = 'build'; phase.listeners.change();
    assert.deepEqual(highlight(h), current); h.panelUI.reset(); assert.deepEqual(highlight(h), current); unchanged();
  });
  test(`${worker ? 'worker' : 'fallback'} CP10 newer entry/effect intent survives older connection clear/input/advisory cleanup`, async () => {
    const h = await harness(worker, controls.replaceBody(fixture(), 'parser::affected', 'opaque')), unchanged = preserveView(h);
    await h.ui.runCallPaths(request()); h.ui.selectEntryNode('builder::main');
    await until(() => entryEvidence(h)); const current = highlight(h);
    assert(current.nodes.includes('builder::main')); assert(!current.nodes.includes('application::main'));
    click(h, 'Cancel / clear call paths'); assert.deepEqual(highlight(h), current);
    h.ui.setCallEndpoint('to', 'parser::unused'); assert.deepEqual(highlight(h), current);
    const input = find(h, 'Call path start ID'); input.value = 'parser::unused'; input.listeners.input(); assert.deepEqual(highlight(h), current);
    const snapshot = find(h, 'Local advisory snapshot JSON', 'advisory-content'); snapshot.value = '{}'; snapshot.listeners.input();
    click(h, 'Cancel / clear advisory exposure', 'advisory-content'); assert.deepEqual(highlight(h), current); unchanged();
    // A fresh explicit run deliberately takes ownership back.
    await h.ui.runCallPaths(request()); assert(highlight(h).nodes.includes('application::main')); assert(!highlight(h).nodes.includes('builder::main'));
  });
  test(`${worker ? 'worker' : 'fallback'} CP10 delayed old call settlement cannot replace newer entry route membership`, async () => {
    const raw = controls.replaceBody(fixture(), 'parser::affected', 'opaque'), h = await harness(worker, raw);
    let release, waiting = false, ready = false; const gate = new Promise(resolve => { release = resolve; });
    // Delay settlement only; the original engine still runs in the real transport.
    function observe(target) {
      const create = target.CallPaths.create;
      target.CallPaths.create = (...args) => {
        const engine = create(...args), query = engine.query;
        engine.query = (...args) => query(...args).then(result => { waiting = true; return gate.then(() => result); });
        return engine;
      };
    }
    if (worker) {
      const post = h.context.Worker.prototype.postMessage;
      h.context.Worker.prototype.postMessage = function (message) { if (message.type === 'init') observe(this.context); return post.call(this, message); };
    } else observe(h.context);
    h.context.STATE_UI.setData = () => { ready = true; }; h.ui.refresh(JSON.stringify(raw)); await until(() => ready);
    const old = h.ui.runCallPaths(request()); await until(() => waiting);
    h.ui.selectEntryNode('builder::main'); await until(() => entryEvidence(h)); const current = highlight(h);
    assert(current.nodes.includes('builder::main') && current.nodes.includes('parser::affected'));
    release(); await old; assert.deepEqual(highlight(h), current);
    assert.equal(entryEvidence(h).request.entryId, h.panelUI.request.entryId);
  });
  test(`${worker ? 'worker' : 'fallback'} CP10 capture replacement fences old leases before cleanup and delayed settlement`, async () => {
    const h = await harness(worker, fixture()), unchanged = preserveView(h); h.defer(q => q.op === 'effectPaths');
    h.ui.selectEntryNode('builder::main'); await until(() => h.pending.length === 1); const old = h.pending[0];
    const oldClear = find(h, 'Clear route highlight', 'entry-effects-content').listeners.click;
    let ready = false; h.context.STATE_UI.setData = () => { ready = true; };
    h.ui.refresh(JSON.stringify(fixture())); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    await until(() => ready); await h.ui.runCallPaths(request()); const current = highlight(h);
    old.resolve(); await new Promise(resolve => setImmediate(resolve)); oldClear();
    assert.deepEqual(highlight(h), current); assert.equal(evidence(h).request.from, 'application::main'); unchanged();
  });
}
