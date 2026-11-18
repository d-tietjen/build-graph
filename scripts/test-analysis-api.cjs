const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const Analysis = require('../src/analysis-api.js');

test('entry/effect operations advertise additive bounded schemas and preserve replay', async () => {
  const raw = require('../tests/fixtures/entry-effects/fixture-graphs.cjs').fixture();
  const api = Analysis.create(raw);
  const capabilities = await api.query({ op: 'capabilities' });
  for (const op of ['entrypoints', 'effects', 'effectPaths', 'orderedPath']) assert(capabilities.operations.includes(op));
  assert.equal(capabilities.entryEffects.version, 1);
  assert.equal(capabilities.evidence.orderedPaths, true);
  const schema = await api.query({ op: 'schema' });
  assert.deepEqual(schema.schema.request.operations.effectPaths, ['entryId, effectId or function']);
  assert.deepEqual(schema.schema.request.operations.orderedPath, ['function or entryId', 'waypoints and/or target']);
  assert.equal(schema.schema.orderedPath.rootEntryCounts, true);
  assert.equal(schema.schema.reachability.pinsOrdered, false);
  const entries = await api.query({ op: 'entrypoints', kind: 'binary', page: { entries: { limit: 1 } } });
  assert.equal(entries.entries.items[0].kind, 'binary');
  const result = await api.query({ op: 'effectPaths', entryId: entries.entries.items[0].id,
    page: { effects: { limit: 1 }, witnesses: { limit: 1 } } });
  assert.equal(result.effects.items.length, 1); assert.equal(result.effects.truncated, true);
  assert.equal(result.witnesses.items.length, 1);
  const replay = await api.query({ op: 'replay', replay: result.replay });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.effects, result.effects);
});

function block(id, kind, successors = [], extra = {}) {
  return { id, kind, label: kind + ' ' + id, successors,
    source_file: 'src/lib.rs', source_location: 10, ...extra };
}
function edge(target, label = 'next', kind = 'normal') { return { target, label, kind }; }
function flow(id, symbol, packageId, blocks) {
  return { id: 'flow-' + id, source_file: 'src/lib.rs', source_location: 5,
    attributes: { kind: 'flow_function', path: id, crate: id.split('::')[0],
      symbol_id: symbol, package_id: packageId,
      flow: JSON.stringify({ version: 1, function: id, entry: 'bb0', blocks }) } };
}
function symbol(id, functionPath, packageId) {
  return { id, source_file: 'src/lib.rs', source_location: 3,
    attributes: { kind: 'function', path: functionPath, crate: functionPath.split('::')[0], package_id: packageId } };
}
function fixture() {
  const source = 'x::Entry', sink = 'y::Sink', other = 'x::Other';
  return { nodes: [
    { id: 'pkg-x', attributes: { kind: 'crate', crate: 'x', package_id: 'pkg-x',
      workspace_member: 'true', supply_chain_dependencies: JSON.stringify([{ package_id: 'pkg-y', name: 'y', kind: 'normal', target: null }]) } },
    { id: 'pkg-y', attributes: { kind: 'crate', crate: 'y', package_id: 'pkg-y', workspace_member: 'false' } },
    symbol('entry', source, 'pkg-x'), symbol('sink', sink, 'pkg-y'), symbol('other', other, 'pkg-x'),
    flow(source, 'entry', 'pkg-x', [
      block('bb0', 'branch', [edge('bb1', 'left'), edge('bb2', 'right')]),
      block('bb1', 'call', [edge('bb3', 'return'), edge('bb4', 'cleanup', 'unwind')], { callee: sink }),
      block('bb2', 'call', [edge('bb3')], { callee: 'external::register',
        callback_args: [{ index: 0, targets: [other], parameter: null }] }),
      block('bb3', 'goto', [edge('bb0', 'again'), edge('bb5', 'done')]),
      block('bb4', 'unwind'), block('bb5', 'return')]),
    flow(sink, 'sink', 'pkg-y', [block('bb0', 'return')]),
    flow(other, 'other', 'pkg-x', [block('bb0', 'return')])],
    edges: [{ source: 'entry', target: 'flow-' + source, relation: 'has_flow' },
      { source: 'sink', target: 'flow-' + sink, relation: 'has_flow' },
      { source: 'other', target: 'flow-' + other, relation: 'has_flow' }] };
}

test('inventory and scoped functions retain package identities and bounded pages', async () => {
  const data = fixture();
  data.nodes.find(n => n.id === 'pkg-y').attributes.capture_summary = JSON.stringify({
    policy: 'workspace_and_compiler_reachable_dependencies', scopes: [{
      capture_scope: 'runtime_dependency', captured: 2, validated: 2, imported: 0 }] });
  const api = Analysis.create(data);
  const packages = await api.query({ op: 'packages', scope: { packageIds: ['pkg-x'], dependencies: 'direct' } });
  assert.deepEqual(packages.packages.items.map(p => p.id), ['pkg-x', 'pkg-y']);
  assert.equal(packages.packages.items[0].captureStatus, 'unknown');
  assert.equal(packages.packages.items[1].captureSummary.scopes[0].imported, 0);
  assert.equal(packages.dependencies.items[0].kind, 'normal');
  const functions = await api.query({ op: 'functions', scope: { packageIds: ['pkg-x'] }, page: { limit: 1 } });
  assert.equal(functions.functions.total, 2);
  assert.equal(functions.functions.nextOffset, 1);
  assert.equal(functions.functions.items[0].body.status, 'captured');
  const second = await api.query({ op: 'functions', scope: { packageIds: ['pkg-x'] }, page: { offset: 1, limit: 1 } });
  assert.notEqual(second.functions.items[0].id, functions.functions.items[0].id);
  assert.equal((await api.query({ op: 'functions', page: { limit: 101 } })).error.code, 'INVALID_PAGE');
  assert.equal((await api.query({ op: 'functions', page: 'bad' })).error.code, 'INVALID_PAGE');
  assert.equal((await api.query({ op: 'functions', page: { functions: 'bad' } })).error.code, 'INVALID_PAGE');
  assert.equal((await api.query({ op: 'nonesuch' })).error.code, 'UNKNOWN_OPERATION');
  const schema = await api.query({ op: 'schema' });
  assert(schema.schema.request.operations.reachability.includes('pins'));
});

test('function rows bind declaration-local paths to their exact captured procedure identities', async () => {
  const data = fixture();
  const bindings = [['entry', 'x::Entry', 'pkg-x', 'unit-x'], ['sink', 'y::Sink', 'pkg-y', 'unit-y']];
  for (const [id, procedure, packageId, unit] of bindings) {
    const declaration = data.nodes.find(n => n.id === id), body = data.nodes.find(n => n.id === 'flow-' + procedure);
    declaration.attributes.path = 'run'; declaration.attributes.display_path = 'shared::run';
    Object.assign(body.attributes, { display_path: 'shared::run', unit_key: unit,
      function_id: 'compiler-' + unit, source_digest: '0123456789abcdef' });
    const flow = JSON.parse(body.attributes.flow); flow.function_id = body.attributes.function_id;
    body.attributes.flow = JSON.stringify(flow);
  }
  const api = Analysis.create(data);
  for (const [id, procedure, packageId, unit] of bindings) {
    const listing = await api.query({ op: 'functions', scope: { packageIds: [packageId] } });
    const rows = listing.functions.items.filter(row => row.id === id); assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.path, 'run'); assert.equal(row.displayPath, 'shared::run');
    assert.equal(row.body.status, 'captured'); assert.equal(row.body.procedure, procedure); assert(row.body.blocks > 0);
    assert.equal(row.identity.rawNodeId, 'flow-' + procedure); assert.equal(row.identity.procedureId, procedure);
    assert.equal(row.identity.packageId, packageId); assert.equal(row.identity.buildUnitId, unit);
    assert.equal(row.identity.functionId, 'compiler-' + unit); assert.equal(row.identity.sourceDigest, '0123456789abcdef');
    assert.deepEqual(row.identity.source, { source_file: 'src/lib.rs', source_location: 5 });
    const neighbors = await api.query({ op: 'neighbors', function: id });
    assert.deepEqual(neighbors.center.body, row.body); assert.deepEqual(neighbors.center.identity, row.identity);
    const lookup = await api.query({ op: 'cfg', function: id });
    assert.equal(lookup.procedure, null); assert.deepEqual(lookup.boundary.body, row.body);
    assert.deepEqual(lookup.diagnostics, [`Captured MIR is available under procedure ID ${procedure}.`]);
    const cfg = await api.query({ op: 'cfg', function: row.body.procedure });
    assert.equal(cfg.procedure.id, procedure); assert.deepEqual(cfg.procedure.identity, row.identity); assert(cfg.nodes.total > 0);
  }
});

function identifiedFixture() {
  const data = fixture();
  for (const [id, procedure, tag] of [['entry', 'x::Entry', '1111111111111111'], ['sink', 'y::Sink', '2222222222222222']]) {
    const declaration = data.nodes.find(n => n.id === id), body = data.nodes.find(n => n.id === 'flow-' + procedure);
    declaration.attributes.path = 'run'; declaration.attributes.display_path = 'shared::run';
    body.source_file = 'captured/' + id + '.rs'; body.source_location = id === 'entry' ? 15 : 25;
    Object.assign(body.attributes, { unit_key: 'unit-' + id, function_id: 'compiler-' + id, source_digest: tag });
    const parsed = JSON.parse(body.attributes.flow); parsed.function_id = body.attributes.function_id;
    body.attributes.flow = JSON.stringify(parsed);
  }
  return data;
}

async function assertUnavailableCallable(api, id) {
  const listing = await api.query({ op: 'functions' }), row = listing.functions.items.find(item => item.id === id);
  assert(row, 'callable remains inventoried');
  assert.deepEqual(row.body, { status: 'unavailable', procedure: null, blocks: 0 });
  assert.equal(row.identity.procedureId, null); assert.equal(row.identity.rawNodeId, id);
  assert.deepEqual((await api.query({ op: 'neighbors', function: id })).center, row);
  const cfg = await api.query({ op: 'cfg', function: id });
  assert.equal(cfg.procedure, null); assert.deepEqual(cfg.boundary, row);
  assert.deepEqual(cfg.diagnostics, ['No unique captured MIR procedure is available for this callable.']);
  const missing = await api.query({ op: 'reachability', pins: [id], roots: 'x::Other' });
  assert.equal(missing.status, 'indeterminate'); assert.deepEqual(missing.missingPins, [id]);
  assert.deepEqual(missing.missingPinDetails, [row]);
  for (const result of [listing, cfg, missing]) {
    assert.equal(result.schemaVersion, 1); assert.equal(result.error, undefined);
    for (const key of ['graph', 'semantics', 'provenance', 'versions', 'request', 'replay', 'assumptions'])
      assert(Object.hasOwn(result, key), 'preserves response envelope ' + key);
    const replay = await api.query({ op: 'replay', replay: result.replay });
    assert.equal(replay.replayed, true); assert.equal(replay.operation, result.operation);
    assert.deepEqual(replay.request, result.request); assert.deepEqual(replay.graph, result.graph);
    if (result.operation === 'functions') assert.deepEqual(replay.functions, result.functions);
    if (result.operation === 'cfg') assert.deepEqual(replay.boundary, row);
    if (result.operation === 'reachability') assert.deepEqual(replay.missingPinDetails, [row]);
  }
  return row;
}

test('contradictory raw paths cannot transfer another package body or identity through shared function rows', async () => {
  const data = identifiedFixture();
  data.nodes.find(n => n.id === 'flow-x::Entry').attributes.path = 'y::Sink';
  const api = Analysis.create(data), entry = await assertUnavailableCallable(api, 'entry');
  assert.equal(entry.path, 'run'); assert.equal(entry.displayPath, 'shared::run');
  assert.equal(entry.packageId, 'pkg-x'); assert.equal(entry.identity.packageId, 'pkg-x');
  assert.equal(entry.identity.buildUnitId, null); assert.equal(entry.identity.functionId, null);
  assert.equal(entry.identity.sourceDigest, null);
  assert.deepEqual(entry.identity.source, { source_file: 'src/lib.rs', source_location: 3 });
  const sink = (await api.query({ op: 'neighbors', function: 'sink' })).center;
  assert.equal(sink.path, 'run'); assert.equal(sink.displayPath, 'shared::run');
  assert.equal(sink.body.status, 'captured'); assert.equal(sink.body.procedure, 'y::Sink');
  for (const [id, procedure, packageId, digest] of [
    ['entry', 'x::Entry', 'pkg-x', '1111111111111111'], ['sink', 'y::Sink', 'pkg-y', '2222222222222222']]) {
    const cfg = await api.query({ op: 'cfg', function: procedure });
    assert.equal(cfg.procedure.id, procedure); assert(cfg.nodes.total > 0);
    assert.equal(cfg.procedure.packageId, packageId); assert.deepEqual(cfg.procedure.ownership.packageIds, [packageId]);
    assert.equal(cfg.procedure.identity.rawNodeId, 'flow-' + procedure);
    assert.equal(cfg.procedure.identity.procedureId, procedure); assert.equal(cfg.procedure.identity.packageId, packageId);
    assert.equal(cfg.procedure.identity.buildUnitId, 'unit-' + id);
    assert.equal(cfg.procedure.identity.functionId, 'compiler-' + id); assert.equal(cfg.procedure.identity.sourceDigest, digest);
    assert.equal(cfg.procedure.identity.source.source_file, 'captured/' + id + '.rs');
    assert.deepEqual(cfg.procedure.identity.source, cfg.procedure.source);
    assert(cfg.nodes.items.every(node => node.identity.rawNodeId === 'flow-' + procedure));
    assert(cfg.edges.items.every(edge => edge.identity.rawNodeId === 'flow-' + procedure));
    assert(cfg.calls.items.every(call => call.identity.rawNodeId === 'flow-' + procedure));
    if (id === 'sink') assert.deepEqual(sink.identity, cfg.procedure.identity);
  }
});

test('a rejected first same-path body cannot lend provenance to the valid imported body', async () => {
  for (const rejected of ['invalid JSON', 'missing entry block']) {
    const data = identifiedFixture(), first = data.nodes.find(n => n.id === 'flow-x::Entry');
    first.attributes.path = 'y::Sink';
    const parsed = JSON.parse(first.attributes.flow); parsed.function = 'y::Sink'; parsed.entry = 'absent';
    first.attributes.flow = rejected === 'invalid JSON' ? '{broken' : JSON.stringify(parsed);
    const api = Analysis.create(data), entry = await assertUnavailableCallable(api, 'entry');
    assert.equal(entry.identity.packageId, 'pkg-x'); assert.equal(entry.identity.functionId, null);
    const sink = (await api.query({ op: 'neighbors', function: 'sink' })).center;
    const cfg = await api.query({ op: 'cfg', function: 'y::Sink' });
    assert.equal(sink.body.status, 'captured', rejected); assert.equal(sink.body.procedure, 'y::Sink');
    assert.deepEqual(sink.identity, cfg.procedure.identity);
    assert.equal(sink.identity.rawNodeId, 'flow-y::Sink'); assert.equal(sink.identity.packageId, 'pkg-y');
    assert.equal(sink.identity.functionId, 'compiler-sink'); assert.equal(sink.identity.buildUnitId, 'unit-sink');
    assert.equal(sink.identity.sourceDigest, '2222222222222222');
    assert.deepEqual(sink.identity.source, { source_file: 'captured/sink.rs', source_location: 25 });
    assert.deepEqual(cfg.procedure.ownership.packageIds, ['pkg-y']);
  }
});

test('unowned and synthetic vertices bind only the exact imported raw flow node', async () => {
  for (const [procedure, owner] of [['loose::Body', null], ['x::Entry::{closure#0}', 'entry']]) {
    const data = fixture(), actual = flow(procedure, owner, 'pkg-x', [block('bb0', 'return')]);
    const duplicate = JSON.parse(JSON.stringify(actual)); duplicate.id += '-duplicate';
    duplicate.source_file = 'other-body.rs';
    Object.assign(actual.attributes, { unit_key: 'actual-unit', source_digest: '1111111111111111' });
    Object.assign(duplicate.attributes, { unit_key: 'other-unit', source_digest: '2222222222222222' });
    data.nodes.push(actual, duplicate);
    const api = Analysis.create(data), rejected = await assertUnavailableCallable(api, duplicate.id);
    assert.equal(rejected.path, procedure); assert.equal(rejected.identity.rawNodeId, duplicate.id);
    assert.equal(rejected.identity.buildUnitId, 'other-unit'); assert.equal(rejected.identity.sourceDigest, '2222222222222222');
    assert.equal(rejected.identity.source.source_file, 'other-body.rs');
    const captured = (await api.query({ op: 'neighbors', function: actual.id })).center;
    const cfg = await api.query({ op: 'cfg', function: procedure });
    assert.equal(captured.body.status, 'captured'); assert.equal(captured.body.procedure, procedure);
    assert.equal(captured.identity.rawNodeId, actual.id); assert.equal(captured.identity.buildUnitId, 'actual-unit');
    assert.equal(captured.identity.sourceDigest, '1111111111111111');
    assert.deepEqual(captured.identity, cfg.procedure.identity);
  }
});

test('indistinguishable raw body claims and conflicting compiler identities remain unavailable', async () => {
  const data = fixture(), actual = flow('loose::Ambiguous', null, 'pkg-x', [block('bb0', 'return')]);
  const duplicate = JSON.parse(JSON.stringify(actual)); duplicate.id += '-duplicate';
  Object.assign(actual.attributes, { unit_key: 'unit-a', source_digest: '1111111111111111' });
  Object.assign(duplicate.attributes, { unit_key: 'unit-b', source_digest: '2222222222222222' });
  data.nodes.push(actual, duplicate);
  const api = Analysis.create(data);
  for (const id of [actual.id, duplicate.id]) await assertUnavailableCallable(api, id);
  const cfg = await api.query({ op: 'cfg', function: 'loose::Ambiguous' });
  assert.equal(cfg.procedure.id, 'loose::Ambiguous'); assert.equal(cfg.procedure.identity.rawNodeId, null);
  assert.equal(cfg.procedure.identity.buildUnitId, null); assert.equal(cfg.procedure.identity.sourceDigest, null);
  const conflict = identifiedFixture();
  conflict.nodes.find(n => n.id === 'flow-x::Entry').attributes.function_id = 'compiler-sink';
  const conflictingApi = Analysis.create(conflict);
  await assertUnavailableCallable(conflictingApi, 'entry');
  assert.equal((await conflictingApi.query({ op: 'cfg', function: 'x::Entry' })).procedure.identity.functionId, null);
});

test('multiple captured bodies on one callable do not select an arbitrary procedure', async () => {
  const data = fixture(), second = flow('x::Entry::unit-b', 'entry', 'pkg-x', [block('bb0', 'return')]);
  Object.assign(second.attributes, { display_path: 'x::Entry', unit_key: 'unit-b' });
  data.nodes.push(second); data.edges.push({ source: 'entry', target: second.id, relation: 'has_flow' });
  const api = Analysis.create(data), listing = await api.query({ op: 'functions', scope: { packageIds: ['pkg-x'] } });
  const row = listing.functions.items.find(item => item.id === 'entry');
  assert.deepEqual(row.body, { status: 'unavailable', procedure: null, blocks: 0 });
  assert.equal(row.identity.procedureId, null);
  assert.deepEqual((await api.query({ op: 'neighbors', function: 'entry' })).center.body, row.body);
  const lookup = await api.query({ op: 'cfg', function: 'entry' });
  assert.equal(lookup.procedure, null); assert.deepEqual(lookup.boundary.body, row.body);
  assert.deepEqual(lookup.diagnostics, ['No unique captured MIR procedure is available for this callable.']);
  const ordered = await api.query({ op: 'orderedPath', function: 'entry', target: { kind: 'procedure', id: 'y::Sink' } });
  assert.equal(ordered.status, 'indeterminate');
  assert(ordered.queryCoverage.selections.items.some(item => item.role === 'root' && item.status === 'ambiguous'));
  for (const procedure of ['x::Entry', 'x::Entry::unit-b'])
    assert.equal((await api.query({ op: 'cfg', function: procedure })).procedure.id, procedure);
});

test('neighbors distinguish execution, registration reference, and unknown boundary across package scope', async () => {
  const api = Analysis.create(fixture());
  const result = await api.query({ op: 'neighbors', function: 'x::Entry',
    scope: { packageIds: ['pkg-x'] } });
  assert(result.outgoing.items.some(e => e.targetPath === 'y::Sink' && e.execution && e.crossesScope));
  assert(result.outgoing.items.some(e => e.targetPath === 'x::Other' && e.kind === 'candidate' && !e.execution));
  assert(result.outgoing.items.some(e => e.kind === 'boundary' && e.targetOwnership.status === 'unknown'));
  assert.equal(result.center.ownership.packageIds[0], 'pkg-x');
});

test('CFG pages retain all branch and loop edges and callsite matched continuations', async () => {
  const api = Analysis.create(fixture());
  const first = await api.query({ op: 'cfg', function: 'x::Entry', page: { edges: { limit: 2 } } });
  assert(first.edges.total > first.edges.items.length);
  const all = [];
  for (let offset = 0; offset < first.edges.total; offset += 2) {
    const result = await api.query({ op: 'cfg', function: 'x::Entry', page: { edges: { offset, limit: 2 } } });
    all.push(...result.edges.items);
  }
  assert(all.some(e => e.from === 'x::Entry#bb0' && e.to === 'x::Entry#bb1'));
  assert(all.some(e => e.from === 'x::Entry#bb0' && e.to === 'x::Entry#bb2'));
  assert(all.some(e => e.from === 'x::Entry#bb3' && e.to === 'x::Entry#bb0'));
  const call = first.calls.items.find(c => c.from === 'x::Entry#bb1');
  assert(call.normalContinuationIds.items.every(id => all.some(e => e.id === id && e.action === 'normal')));
  assert(call.unwindContinuationIds.items.every(id => all.some(e => e.id === id && e.action === 'unwind')));
});

test('reachability preserves underlying model status and states coverage limits', async () => {
  const graph = { nodes: [symbol('root', 'x::Root', 'pkg-x'), symbol('sink', 'x::Sink', 'pkg-x'),
    flow('x::Root', 'root', 'pkg-x', [block('bb0', 'call', [edge('bb1')], { callee: 'x::Sink' }), block('bb1', 'return')]),
    flow('x::Sink', 'sink', 'pkg-x', [block('bb0', 'return')])], edges: [] };
  const api = Analysis.create(graph);
  const result = await api.query({ op: 'reachability', pins: ['x::Root', 'x::Sink'], roots: ['x::Root'], page: { limit: 1 } });
  assert.equal(result.status, 'exact');
  assert.equal(result.pinsOrdered, false);
  assert.equal(result.reachabilityMode, 'unordered AND co-occurrence in captured structural execution');
  assert.equal(result.semantics.branchFeasibilitySolved, false);
  assert.equal(result.semantics.vulnerabilityAbsenceProven, false);
  assert(result.evidence.nodes.total > result.evidence.nodes.items.length);
  assert.equal(result.evidence.nodes.nextOffset, 1);
  assert.equal(result.evidence.calls.items[0].procedure, 'x::Root');
  assert.equal(result.evidence.calls.items[0].directKey, 'x::Sink');
  const missing = await api.query({ op: 'reachability', pins: ['x::Missing'], roots: 'x::Root' });
  assert.equal(missing.status, 'indeterminate');
  assert.deepEqual(missing.missingPins, ['x::Missing']);
  assert.equal((await api.query({ op: 'reachability', pins: ['x::Sink'], roots: 'x::Absent' })).error.code,
    'UNKNOWN_PROCEDURE');
  assert.equal((await api.query({ op: 'reachability', pins: ['x::Sink'], roots: [] })).error.code,
    'INVALID_ROOTS');
});

test('default-root API negatives remain unknown when an entry body is unavailable', async () => {
  const unavailable = { id: 'flow-entry', attributes: { kind: 'flow_function', path: 'bin::demo::main', flow: '{broken' } };
  const api = Analysis.create({ nodes: [flow('a', 'a', 'pkg-x', [block('bb0', 'return')]),
    flow('b', 'b', 'pkg-x', [block('bb0', 'return')]), unavailable], edges: [] });
  const inferred = await api.query({ op: 'reachability', pins: ['a', 'b'] });
  assert.equal(inferred.status, 'indeterminate');
  assert.equal(inferred.partialCoverage, true);
  assert.equal(inferred.finding.classification, 'unknown');
  assert.equal(inferred.finding.definitiveNegative, false);
  assert(inferred.queryCoverage.gaps.items.some(g => g.kind === 'unavailable-body' && g.function === 'bin::demo::main'));
  const explicit = await api.query({ op: 'reachability', pins: ['a', 'b'], roots: 'a' });
  assert.equal(explicit.status, 'impossible');
  assert.equal(explicit.partialCoverage, false);
  assert.equal(explicit.finding.definitiveNegative, true);
  assert.equal(explicit.queryCoverage.disconnected.unavailableBodies, 1);
});

test('scoped reachability retains cross-package intermediary instead of pruning proof', async () => {
  const graph = { nodes: [
    { id: 'pkg-a', attributes: { kind: 'crate', crate: 'a', package_id: 'pkg-a', workspace_member: 'true' } },
    { id: 'pkg-b', attributes: { kind: 'crate', crate: 'b', package_id: 'pkg-b', workspace_member: 'false' } },
    symbol('start', 'a::Start', 'pkg-a'), symbol('middle', 'b::Middle', 'pkg-b'), symbol('sink', 'a::Sink', 'pkg-a'),
    flow('a::Start', 'start', 'pkg-a', [block('bb0', 'call', [edge('bb1')], { callee: 'b::Middle' }), block('bb1', 'return')]),
    flow('b::Middle', 'middle', 'pkg-b', [block('bb0', 'call', [edge('bb1')], { callee: 'a::Sink' }), block('bb1', 'return')]),
    flow('a::Sink', 'sink', 'pkg-a', [block('bb0', 'return')])], edges: [] };
  const result = await Analysis.create(graph).query({ op: 'reachability', pins: ['a::Start', 'a::Sink'],
    roots: 'a::Start', scope: { packageIds: ['pkg-a'] } });
  assert.equal(result.status, 'exact');
  assert.equal(result.scope.role, 'evidence context only; full captured graph analyzed');
  assert(result.scope.outsideScopeEvidenceNodes > 0);
  assert(result.evidence.nodes.items.some(n => n.procedure === 'b::Middle' && n.outsideScope));
  assert(result.evidence.calls.items.some(c => c.procedure === 'b::Middle' && c.outsideScope));
});

test('all API operations expose provenance and replay the captured request', async () => {
  const graph = fixture();
  const raw = graph.nodes.find(n => n.id === 'flow-x::Entry');
  Object.assign(raw.attributes, { source_digest: '0123456789abcdef', unit_key: 'compiler-unit', target_name: 'app', target_src_path: 'src/lib.rs' });
  const api = Analysis.create(graph);
  for (const request of [{ op: 'capabilities' }, { op: 'schema' }, { op: 'packages' }, { op: 'functions' },
    { op: 'neighbors', function: 'x::Entry' }, { op: 'cfg', function: 'x::Entry' },
    { op: 'reachability', pins: ['x::Entry'], roots: 'x::Entry' },
    { op: 'orderedPath', function: 'x::Entry', waypoints: [{ kind: 'procedure', id: 'x::Entry' }] }]) {
    const result = await api.query(request);
    assert.equal(result.error, undefined);
    assert.equal(result.graph.contentSha256.length, 64);
    assert.equal(result.graph.digestFormat, 'canonical-json-v1');
    assert.equal(result.provenance.sourceRevision.status, 'unknown');
    assert.equal(result.versions.analysis, 'structural-and-v1');
    assert(result.assumptions.length);
    const replay = await api.query({ op: 'replay', replay: result.replay });
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation, request.op);
    assert.deepEqual(replay.request, result.request);
  }
  const cfg = await api.query({ op: 'cfg', function: 'x::Entry' });
  assert.equal(cfg.procedure.identity.buildUnitId, 'compiler-unit');
  assert.equal(cfg.nodes.items.find(n => n.block === 'bb0').identity.sourceDigest, '0123456789abcdef');
  assert.equal(cfg.calls.items[0].identity.evidencePath, '/nodes/5');
  assert.equal(cfg.calls.items[0].source.source_file, 'src/lib.rs');
  for (const call of cfg.calls.items) for (const id of [...call.normalContinuationIds.items, ...call.unwindContinuationIds.items])
    assert(cfg.edges.items.some(edge => edge.id === id && edge.callsite === call.id && edge.from === call.from),
      'continuations retain caller callsite identity');
  const result = await api.query({ op: 'reachability', pins: ['x::Entry'], roots: 'x::Entry', page: { limit: 1 } });
  assert.equal(result.finding.definitiveNegative, false);
  assert.equal(result.queryCoverage.pagination.nodes.limit, 1);
  const changed = fixture(); changed.nodes[0].label = 'different capture';
  assert.equal((await Analysis.create(changed).query({ op: 'replay', replay: result.replay })).error.code, 'CAPTURE_MISMATCH');
});

test('API snapshots async request inputs and preserves malformed evidence as unknown', async () => {
  const api = Analysis.create(fixture());
  const request = { op: 'reachability', pins: ['x::Entry'], roots: ['x::Entry'],
    scope: { packageIds: ['pkg-x'] }, page: { nodes: { limit: 1 } } };
  const pending = api.query(request);
  request.pins.push('x::Missing'); request.roots[0] = 'bad'; request.scope.packageIds.push('pkg-y'); request.page.nodes.limit = 100;
  const result = await pending;
  assert.deepEqual(result.request.pins, ['x::Entry']);
  assert.deepEqual(result.request.scope.packageIds, ['pkg-x']);
  assert.equal(result.evidence.nodes.limit, 1);
  const native = Analysis.create({ nodes: [{ id: 'native', attributes: { kind: 'function', language: 'native',
    native_direct_calls: '{bad', native_link_libraries: '["ok",false]', native_call_diagnostics: '[null]' } }], edges: [] });
  const row = (await native.query({ op: 'neighbors', function: 'native' })).center;
  assert.equal(row.nativeDirectCalls.status, 'invalid');
  assert.match(row.nativeDirectCalls.diagnostic, /unknown/);
  assert.equal(row.nativeCallDiagnostics.invalidRecords, 1);
  assert.equal(row.nativeLinkLibraries.status, 'invalid');
  assert.throws(() => Analysis.create({ nodes: [null], edges: [] }), { code: 'INVALID_GRAPH' });
});

test('API exposes exact native calls and package-owned opaque boundaries', async () => {
  const nativeCall = { symbol: 'open', abi: 'C', libraries: ['ssl'] };
  const graph = { nodes: [
    { id: 'app-pkg', attributes: { kind: 'crate', crate: 'app', package_id: 'pkg-app', workspace_member: 'true' } },
    { id: 'ssl-pkg', attributes: { kind: 'crate', crate: 'ssl', package_id: 'pkg-ssl', workspace_member: 'false' } },
    symbol('caller', 'app::run', 'pkg-app'),
    flow('app::run', 'caller', 'pkg-app', [
      block('bb0', 'call', [edge('bb1'), edge('bb2', 'cleanup', 'unwind')], {
        callee: 'ffi::open', native_call: nativeCall, native_target_ids: ['native-open'],
        callee_package_id: 'pkg-ssl', callee_abi: 'C' }),
      block('bb1', 'call', [edge('bb3')], { callee: 'ffi::missing',
        native_call: { symbol: 'missing', abi: 'C', libraries: ['ssl'] },
        callee_package_id: 'pkg-ssl' }),
      block('bb2', 'unwind'), block('bb3', 'return')]),
    { id: 'native-open', label: 'open', attributes: { kind: 'function', language: 'native',
      native_symbol: 'open', native_artifact: '/libssl.a', package_id: 'pkg-ssl',
      body_status: 'native_disassembly', native_call_coverage: 'partial',
      native_analysis_scope: 'direct_disassembly',
      native_direct_calls: JSON.stringify(Array.from({ length: 105 }, (_, i) => ({
        address: String(i), symbol: 'close', target_id: 'native-close', evidence: 'disassembly',
        source_artifact: '/libssl.a' }))),
      native_call_diagnostics: JSON.stringify(Array.from({ length: 103 }, (_, i) => ({
        address: String(i), reason: 'indirect_or_unknown_target' }))) } }
  ], edges: [] };
  graph.nodes.find(n => n.id === 'flow-app::run').attributes.display_path = 'human::run';
  const api = Analysis.create(graph);
  const listing = await api.query({ op: 'functions', scope: { packageIds: ['pkg-ssl'] } });
  assert.equal(listing.coverage.nativeSymbols.disassembled, 1);
  assert.deepEqual(listing.functions.items.map(row => row.body.status).sort(),
    ['native_disassembly', 'unavailable']);
  const nativeRow = listing.functions.items.find(row => row.id === 'native-open');
  assert.equal(nativeRow.nativeDirectCalls.total, 105);
  assert.equal(nativeRow.nativeDirectCalls.items.length, 100);
  assert.equal(nativeRow.nativeDirectCalls.truncated, true);
  assert.equal(nativeRow.nativeCallDiagnostics.total, 103);
  assert.equal(nativeRow.nativeCallDiagnostics.items.length, 100);
  assert.equal(nativeRow.nativeCallCoverage, 'partial');
  assert.equal(nativeRow.nativeDirectCalls.items[0].targetId, 'native-close');
  const callerRow = await api.query({ op: 'neighbors', function: 'app::run' });
  assert.equal(callerRow.center.displayPath, 'human::run');
  const neighbors = await api.query({ op: 'neighbors', function: 'app::run',
    scope: { packageIds: ['pkg-app'] } });
  assert(neighbors.outgoing.items.some(row => row.kind === 'native_call' && row.crossesPackage &&
    row.nativeCall.symbol === 'open'));
  assert(neighbors.outgoing.items.some(row => row.kind === 'boundary' && row.crossesScope &&
    row.boundaryKind === 'native_symbol'));
  const cfg = await api.query({ op: 'cfg', function: 'app::run' });
  assert(cfg.calls.items.some(call => call.nativeCall && call.normalContinuationIds.total === 1 &&
    call.unwindContinuationIds.total === 1));
  const nativeCfg = await api.query({ op: 'cfg', function: 'native-open' });
  assert.equal(nativeCfg.boundary.body.status, 'native_disassembly');
  assert.equal(nativeCfg.nodes.total, 0);
  const reachability = await api.query({ op: 'reachability', pins: ['app::run', 'native-open'], roots: 'app::run' });
  assert.equal(reachability.status, 'indeterminate');
  assert.equal(reachability.missingPinDetails[0].boundaryKind, 'native_symbol');
});

test('long native target IDs round trip through evidence and neighbors lookup', async () => {
  const targetId = 'native::' + 'f'.repeat(1200);
  const graph = { nodes: [
    { id: 'native-source', label: 'helper', attributes: { kind: 'function', language: 'native',
      native_symbol: 'helper', native_artifact: '/a/lib.a', body_status: 'native_disassembly',
      native_direct_calls: JSON.stringify([{ address: '10', symbol: 'helper', target_id: targetId,
        evidence: 'disassembly', source_artifact: '/a/lib.a' }]) } },
    { id: targetId, label: 'helper', attributes: { kind: 'function', language: 'native',
      native_symbol: 'helper', native_artifact: '/b/lib.a', body_status: 'native_disassembly' } },
    { id: 'unknown-native', label: 'indirect call', attributes: { kind: 'function',
      language: 'native', body_status: 'unavailable', native_boundary_kind: 'indirect_call',
      native_call_coverage: 'partial' } }
  ], edges: [{ source: 'native-source', target: targetId, relation: 'native_calls' },
    { source: 'native-source', target: 'unknown-native', relation: 'native_calls' }] };
  const api = Analysis.create(graph);
  const sourceResult = await api.query({ op: 'neighbors', function: 'native-source' });
  assert.equal(sourceResult.center.nativeDirectCalls.items[0].targetId, targetId);
  assert(sourceResult.outgoing.items.some(edge => edge.target === targetId && edge.kind === 'native_call'));
  const targetResult = await api.query({ op: 'neighbors', function: targetId });
  assert.equal(targetResult.center.id, targetId);
  assert.equal(targetResult.center.displayPath, 'helper');
  assert(targetResult.incoming.items.some(edge => edge.source === 'native-source'));
  const unknown = await api.query({ op: 'neighbors', function: 'unknown-native' });
  assert.equal(unknown.center.boundaryKind, 'indirect_call');
  assert.equal(unknown.center.body.status, 'unavailable');
  assert.equal(unknown.coverage.nativePartial, true);
});

test('FFI symbol endpoint scopes to declaration package while implementation stays unknown', async () => {
  const ffi = { id: 'ffi-symbol-open', label: 'open', attributes: {
    kind: 'function', language: 'native', body_status: 'unavailable',
    native_boundary_kind: 'ffi_symbol', native_symbol: 'open', native_abi: 'C',
    package_role: 'ffi_declaration', native_declaration_package_id: 'pkg-libc',
    native_link_libraries: JSON.stringify(['c']), native_call_origin_flow_id: 'flow-app::run',
    native_callsite_block: 'bb0', native_call_evidence: 'compiler_mir_ffi_call',
    native_resolution: 'unresolved', native_call_coverage: 'partial' } };
  const graph = { nodes: [
    { id: 'pkg-app', attributes: { kind: 'crate', crate: 'app', package_id: 'pkg-app', workspace_member: 'true' } },
    { id: 'pkg-libc', attributes: { kind: 'crate', crate: 'libc', package_id: 'pkg-libc', workspace_member: 'false' } },
    symbol('caller', 'app::run', 'pkg-app'),
    flow('app::run', 'caller', 'pkg-app', [block('bb0', 'call', [edge('bb1')], {
      callee: 'libc::open', callee_package_id: 'pkg-libc', native_target_ids: [ffi.id],
      native_resolution: 'unresolved', native_call: { symbol: 'open', abi: 'C', libraries: ['c'] } }),
      block('bb1', 'return')]), ffi
  ], edges: [{ source: 'flow-app::run', target: ffi.id, relation: 'native_calls' }] };
  const api = Analysis.create(graph);
  const scoped = await api.query({ op: 'functions', scope: { packageIds: ['pkg-libc'] } });
  assert.deepEqual(scoped.functions.items.map(row => row.id), [ffi.id]);
  const row = scoped.functions.items[0];
  assert.deepEqual(row.ownership, { status: 'unknown', packageIds: [] });
  assert.deepEqual(row.implementationOwnership, { status: 'unknown', packageIds: [] });
  assert.deepEqual(row.packageAssociation, { role: 'ffi_declaration', status: 'exact',
    packageIds: ['pkg-libc'] });
  assert.equal(row.nativeDeclarationPackageId, 'pkg-libc');
  assert.equal(row.nativeAbi, 'C');
  assert.deepEqual(row.nativeLinkLibraries.items, ['c']);
  const neighbors = await api.query({ op: 'neighbors', function: 'app::run' });
  const callEdge = neighbors.outgoing.items.find(e => e.target === ffi.id);
  assert.equal(callEdge.kind, 'native_call');
  assert.equal(callEdge.crossesPackage, null);
  assert.deepEqual(callEdge.targetImplementationOwnership, { status: 'unknown', packageIds: [] });
  const cfg = await api.query({ op: 'cfg', function: 'app::run' });
  assert.deepEqual(cfg.calls.items[0].nativeTargetIds.items, [ffi.id]);
  assert.equal(cfg.calls.items[0].nativeResolution, 'unresolved');
  assert.deepEqual(cfg.calls.items[0].targets.items, []);
  assert.equal((await api.query({ op: 'cfg', function: ffi.id })).boundary.body.status, 'unavailable');
  assert.equal(cfg.coverage.nativePartial, true);
});

test('CLI reads gzip by magic and serves multiple JSON-lines requests from one graph load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-analysis-'));
  try {
    const file = path.join(dir, 'captured.data');
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(fixture())));
    const run = spawnSync(process.execPath, [path.join(__dirname, 'query-analysis.cjs'), '--graph', file, '--jsonl'],
      { input: '{"op":"capabilities"}\n{"op":"functions","page":{"limit":1}}\n', encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].graph.sha256, lines[1].graph.sha256);
    assert.equal(lines[1].functions.limit, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
