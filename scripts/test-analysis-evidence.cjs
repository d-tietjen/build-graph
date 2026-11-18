const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const Evidence = require('../src/analysis-evidence.js');
const Model = require('../src/execution-model.js');

function flow(id, blocks, attributes = {}) {
  return { id: 'flow-' + id, source_file: 'src/lib.rs', source_location: 7,
    attributes: { kind: 'flow_function', path: id, package_id: 'pkg', unit_key: 'unit-1',
      function_id: 'compiler-' + id, source_digest: '0123456789abcdef', ...attributes,
      flow: JSON.stringify({ version: 1, function: id, function_id: 'compiler-' + id, entry: 'bb0', blocks }) } };
}
function block(id, kind = 'return', successors = [], extra = {}) {
  return { id, kind, successors, source_file: 'src/lib.rs', source_location: 9, ...extra };
}
function fixture() {
  return { nodes: [flow('root', [block('bb0', 'call', [{ target: 'bb1', kind: 'normal' }, { target: 'bb2', kind: 'unwind' }],
    { callee: 'sink', callee_id: 'compiler-sink' }), block('bb1'), block('bb2', 'unwind')]),
  flow('sink', [block('bb0')]), flow('other', [block('bb0')])], edges: [] };
}
function query(core, extra = {}) { return core.analyze(core.prepare({ op: 'reachability', pins: ['root', 'sink'], roots: 'root', ...extra })); }

test('capture byte digest and canonical digest have separate, portable contracts', () => {
  const graph = fixture(), raw = JSON.stringify(graph, null, 2);
  const core = Evidence.create(graph, { rawText: raw, source: '/fake/revision/target/features/toolchain.json' });
  assert.equal(core.graph.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  const reversed = { edges: [], nodes: graph.nodes.map(n => ({ attributes: n.attributes, source_location: n.source_location, source_file: n.source_file, id: n.id })) };
  assert.equal(core.graph.contentSha256, Evidence.create(reversed).graph.contentSha256);
  assert.notEqual(core.graph.sha256, core.graph.contentSha256);
  const context = { ExecutionModel: Model, TextEncoder, Uint8Array, Int32Array };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/value-flow.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/guard-obligations.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/failure-obligations.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/resource-risks.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/analysis-evidence.js'), 'utf8'), context);
  for (const graph of [fixture(), { nodes: [], edges: [], label: '𐀀é'.repeat(17000) }]) {
    const browser = context.AnalysisEvidence.create(graph, { rawText: JSON.stringify(graph) });
    const node = Evidence.create(graph);
    assert.equal(browser.graph.sha256, node.graph.sha256, 'browser UTF-8 hash matches Node, including chunk boundaries');
    assert.equal(browser.graph.contentSha256, node.graph.contentSha256);
  }
  assert.equal(core.provenance.sourceRevision.status, 'unknown');
  assert.equal(core.provenance.target.status, 'unknown');
  assert.equal(core.provenance.features.status, 'unknown');
  assert.equal(core.provenance.toolchain.status, 'unknown');
  assert.equal(core.provenance.sourceDigests.algorithm, 'fnv1a-64');
  assert.equal(core.describe('root').buildUnitId, 'unit-1');
});

test('requests snapshot nested inputs and replay rejects mismatched captures or versions', async () => {
  const core = Evidence.create(fixture());
  const input = { op: 'reachability', pins: ['sink', 'root', 'root'], roots: 'root',
    scope: { packageIds: ['pkg'], dependencies: 'none' }, page: { nodes: { limit: 1 } } };
  const prepared = core.prepare(input);
  const pending = core.analyze(prepared);
  input.pins.length = 0; input.scope.packageIds.push('mutated'); input.page.nodes.limit = 99;
  const result = await pending;
  assert.deepEqual(result.request.pins, ['root', 'sink']);
  assert.deepEqual(result.request.roots, ['root']);
  assert.deepEqual(result.request.scope.packageIds, ['pkg']);
  assert.equal(result.request.page.nodes.limit, 1);
  assert.equal(result.request.timeoutMs, 2000);
  const replayed = await core.analyze(core.prepare({ op: 'replay', replay: result.replay }));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.status, result.status);
  assert.deepEqual(replayed.activeCallTargets, result.activeCallTargets);
  const wrongGraph = fixture(); wrongGraph.nodes[0].source_location++;
  assert.throws(() => Evidence.create(wrongGraph).prepare({ op: 'replay', replay: result.replay }), { code: 'CAPTURE_MISMATCH' });
  const wrongVersion = structuredClone(result.replay); wrongVersion.versions.analysis = 'next';
  assert.throws(() => core.prepare({ op: 'replay', replay: wrongVersion }), { code: 'VERSION_MISMATCH' });
  assert.throws(() => core.prepare({ op: 'replay', replay: {} }), { code: 'INVALID_REPLAY' });
  assert.throws(() => core.prepare({ op: 'replay', replay: { ...result.replay, capture: {} } }), { code: 'CAPTURE_MISMATCH' });
  assert.throws(() => core.prepare({ op: 'reachability', pins: ['root'], page: { nodes: { limit: 0 } } }), { code: 'INVALID_PAGE' });
});

test('explicit-root coverage distinguishes disconnected gaps and reachable missing bodies', async () => {
  const graph = fixture();
  graph.nodes.push(flow('unrelated', [block('bb0', 'call', [{ target: 'bb1' }], { callee: 'missing' }), block('bb1')]));
  graph.nodes.push({ id: 'native-unrelated', attributes: { kind: 'function', language: 'native', native_call_coverage: 'partial' } });
  const core = Evidence.create(graph);
  const result = await query(core);
  assert.equal(result.status, 'exact');
  assert.equal(result.partialCoverage, false);
  assert.equal(result.queryCoverage.global.partial, true);
  assert.equal(result.queryCoverage.disconnected.unknownCalls, 1);
  const absent = await query(core, { pins: ['other'] });
  assert.equal(absent.status, 'impossible');
  assert.equal(absent.finding.definitiveNegative, true);
  graph.nodes[1] = flow('sink', [block('bb0', 'call', [{ target: 'bb1' }], { callee: 'missing' }), block('bb1')]);
  const incomplete = await query(Evidence.create(graph), { pins: ['other'] });
  assert.equal(incomplete.status, 'indeterminate');
  assert.equal(incomplete.finding.definitiveNegative, false);
  assert(incomplete.queryCoverage.gaps.items.some(g => g.kind === 'missing-call-target' && g.procedure === 'sink'));
  assert.match(incomplete.queryCoverage.disconnected.interpretation, /unknown effects/);
});

test('inferred roots retain unavailable entries while explicit roots isolate unrelated bodies', async () => {
  for (const unavailableFlow of ['{broken', JSON.stringify({ version: 1, function: 'bin::demo::main', entry: 'bb0', blocks: [] })]) {
    const entry = flow('bin::demo::main', []); entry.attributes.flow = unavailableFlow;
    const core = Evidence.create({ nodes: [flow('a', [block('bb0')]), flow('b', [block('bb0')]), entry], edges: [] });
    const inferred = await core.analyze(core.prepare({ op: 'reachability', pins: ['a', 'b'] }));
    assert.equal(inferred.status, 'indeterminate');
    assert.equal(inferred.partialCoverage, true);
    assert.equal(inferred.finding.classification, 'unknown');
    assert.equal(inferred.finding.definitiveNegative, false);
    assert(inferred.queryCoverage.gaps.items.some(g => g.kind === 'unavailable-body' && g.function === 'bin::demo::main'));
    assert.equal(inferred.queryCoverage.disconnected.unavailableBodies, 0);
    const explicit = await core.analyze(core.prepare({ op: 'reachability', pins: ['a', 'b'], roots: 'a' }));
    assert.equal(explicit.status, 'impossible');
    assert.equal(explicit.partialCoverage, false);
    assert.equal(explicit.finding.definitiveNegative, true);
    assert.equal(explicit.queryCoverage.global.unavailableBodies.total, 1);
    assert.equal(explicit.queryCoverage.disconnected.unavailableBodies, 1);
  }
});

test('malformed reachable flow, opaque operations and native calls cannot support negatives', async () => {
  for (const blocks of [
    [block('bb0', 'goto', [{ target: 'absent' }])],
    [block('bb0', 'opaque')],
    [block('bb0', 'future-operation')],
    [block('bb0', 'call', [{ target: 'bb1' }], { callee: 'sink', callback_args: [null] }), block('bb1')],
    [block('bb0', 'call', [{ target: 'bb1' }], { callee: 'ffi::read', native_call: { symbol: 'read', abi: 'C' } }), block('bb1')]
  ]) {
    const graph = fixture(); graph.nodes[0] = flow('root', blocks);
    const result = await query(Evidence.create(graph), { pins: ['other'] });
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.partialCoverage, true);
    assert.equal(result.finding.definitiveNegative, false);
    assert(result.queryCoverage.gaps.total > 0);
  }
  const malformed = fixture(); malformed.nodes[1].attributes.flow = '{broken';
  const missingBody = await query(Evidence.create(malformed));
  assert.equal(missingBody.status, 'indeterminate');
  assert.equal(missingBody.queryCoverage.global.unavailableBodies.total, 1);
  assert(missingBody.queryCoverage.gaps.items.some(g => g.kind === 'unavailable-body'));
  assert.throws(() => Evidence.create({ nodes: [null], edges: [] }), { code: 'INVALID_GRAPH' });
  assert.throws(() => Evidence.create({ nodes: [], edges: [null] }), { code: 'INVALID_GRAPH' });
  assert.throws(() => Evidence.create({ nodes: [flow('root', [null])], edges: [] }), { code: 'INVALID_GRAPH' });
});

test('legacy provenance stays unknown, malformed provenance stays visible, lists stay bounded', async () => {
  const graph = { nodes: Array.from({ length: 105 }, (_, i) => flow('f' + i, [block('bb0')])), edges: [],
    provenance: { source_revision: 'abc123', target_triple: 'aarch64-apple-darwin', features: [], toolchain: 'rustc 1.95' } };
  graph.nodes[0].attributes.source_digest = { bad: true };
  graph.nodes[0].attributes.target_artifacts = JSON.stringify(Array.from({ length: 105 }, (_, i) => '/artifact/' + i));
  const core = Evidence.create(graph), result = await core.analyze(core.prepare({ op: 'reachability', pins: ['f0'], roots: 'f0' }));
  assert.equal(core.provenance.sourceDigests.total, 104);
  assert.equal(core.provenance.sourceDigests.items.length, 100);
  assert.equal(core.provenance.sourceDigests.truncated, true);
  assert.equal(core.provenance.invalidRecords.total, 1);
  assert.equal(core.describe('f0').sourceDigest, null);
  assert.equal(core.describe('f0').targetArtifacts.items.length, 100);
  assert.equal(core.describe('f0').targetArtifacts.truncated, true);
  assert.equal(result.provenance.sourceRevision.items[0].value, 'abc123');
  assert.deepEqual(result.provenance.features.items[0].value.items, []);
  const legacy = flow('legacy', [block('bb0')]);
  for (const key of ['source_digest', 'package_id', 'unit_key', 'function_id']) delete legacy.attributes[key];
  const legacyFlow = JSON.parse(legacy.attributes.flow);
  delete legacyFlow.function_id;
  legacy.attributes.flow = JSON.stringify(legacyFlow);
  const old = Evidence.create({ nodes: [legacy], edges: [] });
  assert.equal(old.provenance.sourceDigests.status, 'unknown');
  assert.deepEqual(old.describe('legacy').unknownFields, ['packageId', 'buildUnitId', 'functionId', 'sourceDigest']);
});

test('compiler provenance uses captured IDs while graph identities stay distinct', () => {
  for (const identitySource of ['attribute', 'flow', 'none']) {
    const procedure = 'procedure-' + identitySource;
    const node = flow(procedure, [block('bb0')], { path: 'path-' + identitySource,
      display_path: 'display-' + identitySource, symbol_id: 'symbol-' + identitySource });
    node.id = 'raw-' + identitySource;
    delete node.attributes.function_id;
    const capturedFlow = JSON.parse(node.attributes.flow);
    delete capturedFlow.function_id;
    const compilerId = identitySource === 'none' ? null : 'compiler-' + identitySource;
    if (identitySource === 'attribute') node.attributes.function_id = compilerId;
    if (identitySource === 'flow') capturedFlow.function_id = compilerId;
    node.attributes.flow = JSON.stringify(capturedFlow);
    const core = Evidence.create({ nodes: [node], edges: [] });
    const identity = core.describe(procedure);
    assert.equal(identity.functionId, compilerId);
    assert.equal(identity.unknownFields.includes('functionId'), compilerId === null);
    assert.equal(identity.procedureId, procedure);
    assert.equal(identity.rawNodeId, node.id);
    assert.equal(core.model.procedures[0].symbol_id, node.attributes.symbol_id);
    assert.equal(core.model.procedures[0].display_path, node.attributes.display_path);
  }
});

test('pagination changes evidence completeness without changing the query verdict', async () => {
  const core = Evidence.create(fixture());
  const first = await query(core, { page: { limit: 1 } });
  const second = await query(core, { page: { offset: 1, limit: 1 } });
  const full = await query(core, { page: { limit: 100 } });
  assert.equal(first.status, 'exact'); assert.equal(second.status, first.status); assert.equal(full.status, first.status);
  assert.equal(first.completion.complete, true);
  assert.equal(first.completion.evidenceComplete, false);
  assert.equal(full.completion.evidenceComplete, true);
  assert.equal(second.queryCoverage.pagination.nodes.offset, 1);
  assert.equal(first.evidenceLinks.calls.items[0].classification, 'compiler-confirmed');
  assert(first.evidenceLinks.nodes.items.some(n => n.identity.evidencePath === '/nodes/0' && n.source.source_file === 'src/lib.rs'));
});

test('cancellation, elapsed time and summary work budget cannot become negative findings', async () => {
  const core = Evidence.create(fixture()), prepared = core.prepare({ op: 'reachability', pins: ['other'], roots: 'root', timeoutMs: 1 });
  const cancelled = await core.analyze(prepared, { cancelled: () => true });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.finding.definitiveNegative, false);
  assert.equal(cancelled.completion.cancelled, true);
  let ticks = 0;
  const timeout = await core.analyze(prepared, { now: () => ticks++ * 2 });
  assert.equal(timeout.status, 'cancelled'); assert.equal(timeout.completion.timedOut, true);
  assert.equal(timeout.finding.definitiveNegative, false);
  // Exercise the real wrapper's budget-result handling without running a 2M-state fixture.
  const context = { ExecutionModel: { build: Model.build, analyze: async () => ({ status: 'indeterminate', partialCoverage: true,
    diagnostics: ['Procedure summary budget reached; full model retained.'], roots: ['root'],
    activeNodeIds: [], activeEdgeIds: [], activeCallIds: [], activeCallTargets: [] }) }, TextEncoder, Uint8Array, Int32Array };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/value-flow.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/guard-obligations.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/failure-obligations.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/resource-risks.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/analysis-evidence.js'), 'utf8'), context);
  const budgetCore = context.AnalysisEvidence.create(fixture());
  const budget = await budgetCore.analyze(budgetCore.prepare({ op: 'reachability', pins: ['other'], roots: 'root' }));
  assert.equal(budget.completion.budgetExceeded, true); assert.equal(budget.completion.complete, false);
  assert.equal(budget.finding.definitiveNegative, false);
});
