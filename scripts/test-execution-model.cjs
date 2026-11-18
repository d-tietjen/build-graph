const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const Model = require('../src/execution-model.js');

function successor(target, kind = 'normal', label = 'next', action) {
  return { target, kind, label, ...(action ? { action } : {}) };
}
function block(id, kind, successors = [], extra = {}) {
  return { id, kind, label: kind + ' ' + id, source_file: 'src/lib.rs', source_location: 1,
    callee: null, successors, ...extra };
}
function call(id, callee, normal, extra = {}, unwind) {
  const successors = normal == null ? [] : [successor(normal, 'normal', 'return')];
  if (unwind) successors.push(successor(unwind, 'unwind', 'cleanup'));
  return block(id, 'call', successors, { callee, ...extra });
}
function fn(path, blocks) {
  return { id: path, source_file: 'src/lib.rs', source_location: 1,
    attributes: { kind: 'flow_function', path, crate: path.split('::')[0],
      flow: JSON.stringify({ version: 1, function: path, entry: 'bb0', blocks }) } };
}
function graph(...functions) { return { nodes: functions, edges: [] }; }
function withFunctionId(node, id) {
  const flow = JSON.parse(node.attributes.flow);
  flow.function_id = id;
  node.attributes.flow = JSON.stringify(flow);
  return node;
}
function readGraph(path) {
  const bytes = fs.readFileSync(path);
  return JSON.parse(bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes);
}
function active(result, type, id) { return result[type].includes(id); }

test('dependency package filters repeated compiler IDs and native symbols remain opaque', async () => {
  const a = withFunctionId(fn('dep[pkg-a]::parse', [block('bb0', 'return')]), 'shared-id');
  const b = withFunctionId(fn('dep[pkg-b]::parse', [block('bb0', 'return')]), 'shared-id');
  a.attributes.package_id = 'pkg-a'; b.attributes.package_id = 'pkg-b';
  a.attributes.display_path = b.attributes.display_path = 'dep::parse';
  const caller = fn('app::run', [
    call('bb0', 'dep[pkg-b]::parse', 'bb1', { callee_id: 'shared-id',
      callee_package_id: 'pkg-b' }),
    call('bb1', 'ffi::open', 'bb2', { native_call: { symbol: 'open', abi: 'C', libraries: ['ssl'] },
      native_target_ids: ['native-open'], callee_package_id: 'pkg-ssl' }, 'bb3'),
    block('bb2', 'return'), block('bb3', 'unwind')]);
  const native = { id: 'native-open', attributes: { kind: 'function', language: 'native',
    native_symbol: 'open', body_status: 'native_disassembly', package_id: 'pkg-ssl' } };
  const model = Model.build({ nodes: [caller, a, b, native], edges: [] });
  const calls = model.calls.filter(c => c.procedure === 'app::run');
  assert.deepEqual(calls[0].targets, ['dep[pkg-b]::parse']);
  assert.deepEqual(calls[1].targets, []);
  assert.equal(calls[1].boundaryKind, 'native_symbol');
  assert.deepEqual(calls[1].nativeTargetIds, ['native-open']);
  assert.equal(calls[1].normal.length, 1);
  assert.equal(calls[1].unwind.length, 1);
  assert.equal(model.procedures.some(p => p.id === 'native-open'), false);
  const route = await Model.analyze(model, ['app::run', 'dep[pkg-a]::parse'], { roots: 'app::run' });
  assert.equal(route.status, 'indeterminate');
});

test('canonical dependency paths disambiguate repeated IDs across units of one package', () => {
  const host = withFunctionId(fn('dep[pkg,host]::parse', [block('bb0', 'return')]), 'shared');
  const target = withFunctionId(fn('dep[pkg,target]::parse', [block('bb0', 'return')]), 'shared');
  host.attributes.package_id = target.attributes.package_id = 'pkg';
  host.attributes.display_path = target.attributes.display_path = 'dep::parse';
  const canonical = fn('app::canonical', [call('bb0', 'dep[pkg,target]::parse', 'bb1', {
    callee_id: 'shared', callee_package_id: 'pkg' }), block('bb1', 'return')]);
  const human = fn('app::human', [call('bb0', 'dep::parse', 'bb1', {
    callee_id: 'shared', callee_package_id: 'pkg' }), block('bb1', 'return')]);
  const model = Model.build(graph(host, target, canonical, human));
  assert.equal(model.procedures.find(p => p.id === 'dep[pkg,target]::parse').display_path,
    'dep::parse');
  assert.deepEqual(model.calls.find(c => c.procedure === 'app::canonical').targets,
    ['dep[pkg,target]::parse']);
  assert.deepEqual(model.calls.find(c => c.procedure === 'app::human').targets, []);
  assert.equal(model.calls.find(c => c.procedure === 'app::human').resolution, 'ambiguous');
});

test('unavailable native boundary leaves MIR reachability indeterminate', async () => {
  const start = fn('app::start', [block('bb0', 'return')]);
  const sink = fn('app::sink', [block('bb0', 'return')]);
  const native = { id: 'native-unknown', attributes: { kind: 'function', language: 'native',
    body_status: 'unavailable', native_boundary_kind: 'indirect_call',
    native_call_coverage: 'partial' } };
  const model = Model.build({ nodes: [start, sink, native], edges: [] });
  assert.equal(model.coverage.nativeSymbols.unavailable, 1);
  assert.equal(model.coverage.nativePartial, true);
  assert.equal(model.procedures.some(p => p.id === 'native-unknown'), false);
  const result = await Model.analyze(model, ['app::start', 'app::sink'], { roots: 'app::start' });
  assert.equal(result.status, 'indeterminate');
});

test('build retains every deep block, wide branch, and unwind successor', async () => {
  const deep = Array.from({ length: 201 }, (_, i) => i === 200 ? block('bb200', 'return') :
    block('bb' + i, 'goto', [successor('bb' + (i + 1))]));
  const wide = [block('bb0', 'branch', Array.from({ length: 101 }, (_, i) =>
    successor('bb' + (i + 1), 'normal', String(i))))];
  for (let i = 1; i <= 101; i++) wide.push(block('bb' + i, 'return'));
  const unwind = [call('bb0', 'x::Deep', 'bb1', {}, 'bb2'), block('bb1', 'return'), block('bb2', 'unwind')];
  const model = Model.build(graph(fn('x::Deep', deep), fn('x::Wide', wide), fn('x::Unwind', unwind)));
  assert.equal(model.counts.procedures, 3);
  assert.equal(model.counts.mirBlocks, 306);
  assert.equal(model.counts.mirSuccessors, 303);
  assert.equal(model.procedures.find(p => p.id === 'x::Deep').nodeIds.filter(id => id.includes('#bb')).length, 201);
  assert.equal(model.edges.filter(e => e.from === 'x::Wide#bb0').length, 101);
  assert.equal(model.calls.find(c => c.from === 'x::Unwind#bb0').unwind.length, 1);
  const selected = await Model.analyze(model, ['x::Deep'], { roots: ['x::Deep'] });
  assert.equal(selected.status, 'exact');
  assert.ok(active(selected, 'activeNodeIds', 'x::Deep#bb200'));
  assert.ok(active(selected, 'activeEdgeIds', 'x::Deep#bb199->x::Deep#bb200:0'));
});

test('long analysis yields to a newer query and cancels cleanly', async () => {
  const blocks = Array.from({ length: 3001 }, (_, i) => i === 3000 ? block('bb3000', 'return') :
    block('bb' + i, 'goto', [successor('bb' + (i + 1))]));
  const model = Model.build(graph(fn('x::Long', blocks)));
  let stale = false;
  setTimeout(() => { stale = true; }, 0);
  const result = await Model.analyze(model, ['x::Long'], { roots: ['x::Long'], cancelled: () => stale });
  assert.equal(result.status, 'cancelled');
  assert.equal(model.counts.mirBlocks, 3001);
});

test('branch pins exclude exclusive arms and loops can revisit both arms', async () => {
  const left = fn('x::Left', [block('bb0', 'return')]);
  const right = fn('x::Right', [block('bb0', 'return')]);
  const fork = fn('x::Fork', [block('bb0', 'branch', [successor('bb1', 'normal', 'left'), successor('bb2', 'normal', 'right')]),
    call('bb1', 'x::Left', 'bb3'), call('bb2', 'x::Right', 'bb3'), block('bb3', 'return')]);
  const loop = fn('x::Loop', [block('bb0', 'branch', [successor('bb1', 'normal', 'left'), successor('bb2', 'normal', 'right')]),
    call('bb1', 'x::Left', 'bb3'), call('bb2', 'x::Right', 'bb3'),
    block('bb3', 'branch', [successor('bb0', 'normal', 'again'), successor('bb4', 'normal', 'done')]), block('bb4', 'return')]);
  const model = Model.build(graph(left, right, fork, loop));
  const exclusive = await Model.analyze(model, ['x::Left', 'x::Right'], { roots: ['x::Fork'] });
  assert.equal(exclusive.status, 'impossible');
  assert.deepEqual(exclusive.activeEdgeIds, []);
  const repeated = await Model.analyze(model, ['x::Left', 'x::Right'], { roots: ['x::Loop'] });
  assert.equal(repeated.status, 'exact');
  assert.ok(active(repeated, 'activeCallIds', 'x::Loop#bb1@call'));
  assert.ok(active(repeated, 'activeCallIds', 'x::Loop#bb2@call'));
  assert.ok(active(repeated, 'activeEdgeIds', 'x::Loop#bb3->x::Loop#bb0:0'));
});

test('one early pin retains both arms of 100 later decisions without path enumeration', async () => {
  const blocks = [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
    call('bb1', 'x::Early', 'bb3'), call('bb2', 'x::Skip', 'bb3')];
  for (let i = 0; i < 100; i++) {
    const base = 3 + i * 3, next = base + 3;
    blocks.push(block('bb' + base, 'branch', [successor('bb' + (base + 1)), successor('bb' + (base + 2))]));
    blocks.push(block('bb' + (base + 1), 'goto', [successor('bb' + next)]));
    blocks.push(block('bb' + (base + 2), 'goto', [successor('bb' + next)]));
  }
  blocks.push(block('bb303', 'return'));
  const model = Model.build(graph(fn('x::Decisions', blocks), fn('x::Early', [block('bb0', 'return')]),
    fn('x::Skip', [block('bb0', 'return')])));
  const result = await Model.analyze(model, ['x::Early'], { roots: ['x::Decisions'] });
  assert.equal(result.status, 'exact');
  assert.ok(!active(result, 'activeEdgeIds', 'x::Decisions#bb0->x::Decisions#bb2:1'));
  assert.ok(active(result, 'activeEdgeIds', 'x::Decisions#bb300->x::Decisions#bb301:0'));
  assert.ok(active(result, 'activeEdgeIds', 'x::Decisions#bb300->x::Decisions#bb302:1'));
});

test('deep call chain and recursive summaries converge without depth truncation', async () => {
  const chain = [];
  for (let i = 0; i < 31; i++) chain.push(fn('x::Chain' + i,
    i === 30 ? [block('bb0', 'return')] : [call('bb0', 'x::Chain' + (i + 1), 'bb1'), block('bb1', 'return')]));
  const chainModel = Model.build(graph(...chain));
  const deep = await Model.analyze(chainModel, ['x::Chain30'], { roots: ['x::Chain0'] });
  assert.equal(deep.status, 'exact');
  assert.ok(active(deep, 'activeCallIds', 'x::Chain29#bb0@call'));
  const recursive = fn('x::Recursive', [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
    block('bb1', 'return'), call('bb2', 'x::Recursive', 'bb3'), block('bb3', 'return')]);
  const root = fn('x::Root', [call('bb0', 'x::Recursive', 'bb1'), call('bb1', 'x::After', 'bb2'), block('bb2', 'return')]);
  const model = Model.build(graph(root, recursive, fn('x::After', [block('bb0', 'return')])));
  const terminal = await Model.analyze(model, ['x::Recursive', 'x::After'], { roots: ['x::Root'] });
  assert.equal(terminal.status, 'exact');
  assert.ok(active(terminal, 'activeCallIds', 'x::Recursive#bb2@call'));
  const noReturn = Model.build(graph(
    fn('x::NoReturnRoot', [call('bb0', 'x::NoReturnRec', 'bb1'), call('bb1', 'x::After', 'bb2'), block('bb2', 'return')]),
    fn('x::NoReturnRec', [call('bb0', 'x::NoReturnRec', null)]), fn('x::After', [block('bb0', 'return')])));
  const impossible = await Model.analyze(noReturn, ['x::After'], { roots: ['x::NoReturnRoot'] });
  assert.equal(impossible.status, 'impossible');
  const isolated = Model.build(graph(
    fn('x::CycleA', [call('bb0', 'x::CycleB', 'bb1'), block('bb1', 'return')]),
    fn('x::CycleB', [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
      block('bb1', 'return'), call('bb2', 'x::CycleA', 'bb3'), block('bb3', 'return')])));
  assert.equal(isolated.roots.disconnected.length, 1);
  const cycle = await Model.analyze(isolated, ['x::CycleB']);
  assert.equal(cycle.status, 'exact');
  assert.ok(active(cycle, 'activeNodeIds', 'x::CycleB#bb0'));
});

test('shared callee returns to its own callsite and ordered sibling calls count', async () => {
  const entry = fn('x::Entry', [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
    call('bb1', 'x::CallerA', 'bb3'), call('bb2', 'x::CallerB', 'bb3'), block('bb3', 'return')]);
  const a = fn('x::CallerA', [call('bb0', 'x::Shared', 'bb1'), call('bb1', 'x::AfterA', 'bb2'), block('bb2', 'return')]);
  const b = fn('x::CallerB', [call('bb0', 'x::Shared', 'bb1'), call('bb1', 'x::AfterB', 'bb2'), block('bb2', 'return')]);
  const model = Model.build(graph(entry, a, b, fn('x::Shared', [block('bb0', 'return')]),
    fn('x::AfterA', [block('bb0', 'return')]), fn('x::AfterB', [block('bb0', 'return')])));
  const result = await Model.analyze(model, ['x::Shared', 'x::AfterA'], { roots: ['x::Entry'] });
  assert.equal(result.status, 'exact');
  assert.ok(active(result, 'activeCallIds', 'x::CallerA#bb0@call'));
  assert.ok(active(result, 'activeCallIds', 'x::CallerA#bb1@call'));
  assert.ok(!active(result, 'activeCallIds', 'x::CallerB#bb0@call'));
  assert.ok(!active(result, 'activeNodeIds', 'x::AfterB#bb0'));
  assert.ok(!active(result, 'activeEdgeIds', 'x::Entry#bb0->x::Entry#bb2:1'));
  const siblings = fn('x::Siblings', [call('bb0', 'x::Shared', 'bb1'), call('bb1', 'x::AfterA', 'bb2'), block('bb2', 'return')]);
  const ordered = await Model.analyze(Model.build(graph(siblings, fn('x::Shared', [block('bb0', 'return')]),
    fn('x::AfterA', [block('bb0', 'return')]))), ['x::Shared', 'x::AfterA'], { roots: ['x::Siblings'] });
  assert.equal(ordered.status, 'exact');
});

test('callback bindings stay specific to each caller and forwarding is precise', async () => {
  const wrapper = fn('x::Wrapper', [call('bb0', null, 'bb1', { callback_parameter: 0 }), block('bb1', 'return')]);
  const forward = fn('x::Forward', [call('bb0', 'x::Wrapper', 'bb1',
    { callback_args: [{ index: 0, targets: [], parameter: 0 }] }), block('bb1', 'return')]);
  const a = fn('x::CallerA', [call('bb0', 'x::Forward', 'bb1',
    { callback_args: [{ index: 0, targets: ['x::CallbackA'], parameter: null }] }),
    call('bb1', 'x::AfterA', 'bb2'), block('bb2', 'return')]);
  const b = fn('x::CallerB', [call('bb0', 'x::Forward', 'bb1',
    { callback_args: [{ index: 0, targets: ['x::CallbackB'], parameter: null }] }),
    call('bb1', 'x::AfterB', 'bb2'), block('bb2', 'return')]);
  const entry = fn('x::Entry', [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
    call('bb1', 'x::CallerA', 'bb3'), call('bb2', 'x::CallerB', 'bb3'), block('bb3', 'return')]);
  const model = Model.build(graph(entry, a, b, forward, wrapper,
    fn('x::CallbackA', [block('bb0', 'return')]), fn('x::CallbackB', [block('bb0', 'return')]),
    fn('x::AfterA', [block('bb0', 'return')]), fn('x::AfterB', [block('bb0', 'return')])));
  const impossible = await Model.analyze(model, ['x::CallbackA', 'x::AfterB'], { roots: ['x::Entry'] });
  assert.equal(impossible.status, 'impossible');
  const aRoute = await Model.analyze(model, ['x::CallbackA', 'x::AfterA'], { roots: ['x::Entry'] });
  assert.equal(aRoute.status, 'exact');
  assert.ok(active(aRoute, 'activeCallTargets', 'x::Wrapper#bb0@call->x::CallbackA'));
  assert.ok(!active(aRoute, 'activeCallTargets', 'x::Wrapper#bb0@call->x::CallbackB'));
  assert.ok(!active(aRoute, 'activeNodeIds', 'x::AfterB#bb0'));
});

test('normal and unwind continuations match the callsite; noreturn cannot reach after', async () => {
  const callee = fn('x::Callee', [block('bb0', 'branch', [successor('bb1'), successor('bb2')]),
    block('bb1', 'return'), block('bb2', 'unwind')]);
  const root = fn('x::Root', [call('bb0', 'x::Callee', 'bb1', {}, 'bb2'),
    call('bb1', 'x::AfterNormal', 'bb3'), call('bb2', 'x::AfterUnwind', 'bb3'), block('bb3', 'return')]);
  const model = Model.build(graph(root, callee, fn('x::AfterNormal', [block('bb0', 'return')]),
    fn('x::AfterUnwind', [block('bb0', 'return')])));
  const normal = await Model.analyze(model, ['x::Callee', 'x::AfterNormal'], { roots: ['x::Root'] });
  const unwind = await Model.analyze(model, ['x::Callee', 'x::AfterUnwind'], { roots: ['x::Root'] });
  assert.equal(normal.status, 'exact'); assert.equal(unwind.status, 'exact');
  assert.ok(active(normal, 'activeEdgeIds', 'x::Root#bb0->x::Root#bb1:0'));
  assert.ok(!active(normal, 'activeEdgeIds', 'x::Root#bb0->x::Root#bb2:1'));
  assert.ok(active(unwind, 'activeEdgeIds', 'x::Root#bb0->x::Root#bb2:1'));
  const noReturn = Model.build(graph(fn('x::NoReturnRoot', [call('bb0', 'x::Forever', 'bb1'),
    call('bb1', 'x::After', 'bb2'), block('bb2', 'return')]),
    fn('x::Forever', [block('bb0', 'goto', [successor('bb0')])]), fn('x::After', [block('bb0', 'return')])));
  const impossible = await Model.analyze(noReturn, ['x::After'], { roots: ['x::NoReturnRoot'] });
  assert.equal(impossible.status, 'impossible');
  const prefix = await Model.analyze(noReturn, ['x::Forever'], { roots: ['x::NoReturnRoot'] });
  assert.equal(prefix.status, 'exact');
  assert.ok(active(prefix, 'activeEdgeIds', 'x::Forever#bb0->x::Forever#bb0:0'));
});

test('unknown external callbacks stay candidates and recorded continuation is partial', async () => {
  const model = Model.build(graph(fn('x::Root', [call('bb0', 'external::register', 'bb1',
    { callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] }),
    call('bb1', 'x::After', 'bb2'), block('bb2', 'return')]),
  fn('x::Callback', [block('bb0', 'return')]), fn('x::After', [block('bb0', 'return')])));
  const callsite = model.calls.find(c => c.from === 'x::Root#bb0');
  assert.deepEqual(callsite.targets, []);
  assert.deepEqual(callsite.unavailableTargets, ['external::register']);
  const candidate = await Model.analyze(model, ['x::Callback'], { roots: ['x::Root'] });
  assert.equal(candidate.status, 'indeterminate');
  assert.ok(!active(candidate, 'activeNodeIds', 'x::Callback#bb0'));
  const after = await Model.analyze(model, ['x::After'], { roots: ['x::Root'] });
  assert.equal(after.status, 'indeterminate');
  assert.ok(active(after, 'activeEdgeIds', 'x::Root#bb0->x::Root#bb1:0'));
  assert.equal(after.partialCoverage, true);
});

test('possible trait dispatch uses graph-owned implementation links, not same-name guesses', async () => {
  const implFlow = fn('x::<impl::Owner as api::Worker>::get', [block('bb0', 'return')]);
  const unrelatedFlow = fn('x::impl::Unrelated::get', [block('bb0', 'return')]);
  const root = fn('x::Root', [call('bb0', 'x::api::Worker::get', 'bb1'), block('bb1', 'return')]);
  const rich = (id, kind, path) => ({ id, attributes: { kind, path, crate: 'x' } });
  const g = graph(root, implFlow, unrelatedFlow,
    rich('trait', 'trait', 'api::Worker'), rich('declaration', 'method', 'api::Worker::get'),
    rich('owner', 'struct', 'impl::Owner'), rich('implementation', 'method', 'impl::Owner::get'),
    rich('unrelated', 'struct', 'impl::Unrelated'), rich('unrelated-get', 'method', 'impl::Unrelated::get'));
  g.edges = [
    { source: 'trait', target: 'declaration', relation: 'has_method' },
    { source: 'owner', target: 'trait', relation: 'implements' },
    { source: 'owner', target: 'implementation', relation: 'has_method' },
    { source: 'implementation', target: implFlow.id, relation: 'has_flow' },
    { source: 'unrelated', target: 'unrelated-get', relation: 'has_method' },
    { source: 'unrelated-get', target: unrelatedFlow.id, relation: 'has_flow' }
  ];
  const model = Model.build(g), dispatch = model.calls.find(c => c.from === 'x::Root#bb0');
  assert.deepEqual(dispatch.targets, [implFlow.id]);
  assert.deepEqual(dispatch.dispatchTargets, [implFlow.id]);
  assert.equal(dispatch.possibleDispatch, true);
  assert.equal(dispatch.unknown, true);
  assert.ok(!dispatch.targets.includes(unrelatedFlow.id));
  const filtered = await Model.analyze(model, [implFlow.id], { roots: ['x::Root'] });
  assert.equal(filtered.status, 'indeterminate');
  assert.ok(active(filtered, 'activeCallTargets', 'x::Root#bb0@call->' + implFlow.id));
  assert.ok(!active(filtered, 'activeNodeIds', unrelatedFlow.id + '#bb0'));
});

test('opaque callee identity wins over a differing display path', () => {
  const target = withFunctionId(fn('x::implementation::run', [block('bb0', 'return')]), 'opaque-1');
  const caller = fn('x::caller', [call('bb0', 'x::alias::run', 'bb1', { callee_id: 'opaque-1' }),
    block('bb1', 'return')]);
  const model = Model.build(graph(caller, target));
  assert.deepEqual(model.calls[0].targets, [target.id]);
  assert.equal(model.calls[0].resolution, 'idMatched');
  assert.equal(model.calls[0].unknown, false);
  assert.equal(model.coverage.callsiteResolution.idMatched, 1);
  assert.equal(model.coverage.bodyMapping.importedBlocks, 3);
});

test('duplicate opaque identity remains ambiguous even when display text matches', () => {
  const a = withFunctionId(fn('x::a::run', [block('bb0', 'return')]), 'shared-id');
  const b = withFunctionId(fn('x::b::run', [block('bb0', 'return')]), 'shared-id');
  const caller = fn('x::caller', [call('bb0', a.id, 'bb1', { callee_id: 'shared-id' }),
    block('bb1', 'return')]);
  const model = Model.build(graph(caller, a, b));
  assert.deepEqual(model.calls[0].targets, []);
  assert.deepEqual(model.calls[0].ambiguousTargets[0].candidates, [a.id, b.id]);
  assert.equal(model.calls[0].resolution, 'ambiguous');
  assert.equal(model.coverage.callsiteResolution.ambiguous, 1);
});

test('an unmatched opaque ID cannot claim a different identified body by text', () => {
  const target = withFunctionId(fn('x::run', [block('bb0', 'return')]), 'body-id');
  const caller = fn('x::caller', [call('bb0', target.id, 'bb1', { callee_id: 'other-id' }),
    block('bb1', 'return')]);
  const model = Model.build(graph(caller, target));
  assert.deepEqual(model.calls[0].targets, []);
  assert.equal(model.calls[0].resolution, 'unresolved');
  assert.equal(model.calls[0].idMismatch, true);
  assert.equal(model.coverage.callsiteResolution.idMismatch, 1);
});

test('an unmatched opaque ID can retain a legacy text candidate only as uncertain', () => {
  const target = fn('x::run', [block('bb0', 'return')]);
  const caller = fn('x::caller', [call('bb0', target.id, 'bb1', { callee_id: 'new-id' }),
    block('bb1', 'return')]);
  const model = Model.build(graph(caller, target));
  assert.deepEqual(model.calls[0].targets, [target.id]);
  assert.equal(model.calls[0].legacyUnverified, true);
  assert.equal(model.calls[0].unknown, true);
  assert.equal(model.coverage.callsiteResolution.legacyUnverified, 1);
});

test('type alias follows graph ownership without matching an unrelated same-name method', () => {
  const target = fn('x::<api::Real>::run', [block('bb0', 'return')]);
  const unrelated = fn('x::<api::Else>::run', [block('bb0', 'return')]);
  const caller = fn('x::caller', [call('bb0', 'x::api::Alias::run', 'bb1'), block('bb1', 'return')]);
  const rich = (id, kind, path) => ({ id, attributes: { kind, path, crate: 'x' } });
  const g = graph(caller, target, unrelated,
    rich('alias', 'type_alias', 'api::Alias'), rich('real', 'struct', 'api::Real'),
    rich('method', 'method', 'api::Real::run'), rich('else', 'struct', 'api::Else'),
    rich('else-method', 'method', 'api::Else::run'));
  g.edges = [
    { source: 'alias', target: 'real', relation: 'aliases' },
    { source: 'real', target: 'method', relation: 'has_method' },
    { source: 'method', target: target.id, relation: 'has_flow' },
    { source: 'else', target: 'else-method', relation: 'has_method' },
    { source: 'else-method', target: unrelated.id, relation: 'has_flow' }
  ];
  const model = Model.build(g);
  assert.deepEqual(model.calls[0].targets, [target.id]);
  assert.equal(model.calls[0].resolution, 'aliasMatched');
  assert.equal(model.calls[0].unknown, false);
  assert.equal(model.coverage.callsiteResolution.aliasMatched, 1);
});


if (process.env.BUILD_GRAPH_FIXTURE_GRAPH) test('compiled fixture yields the full finite callback and loop model', async () => {
  const input = readGraph(process.env.BUILD_GRAPH_FIXTURE_GRAPH);
  const model = Model.build(input);
  const rawFlows = input.nodes.filter(n => n.attributes && n.attributes.kind === 'flow_function')
    .map(n => JSON.parse(n.attributes.flow));
  assert.equal(model.counts.procedures, rawFlows.length);
  assert.equal(model.counts.mirBlocks, rawFlows.reduce((sum, f) => sum + f.blocks.length, 0));
  assert.equal(model.counts.mirSuccessors, rawFlows.reduce((sum, f) => sum + f.blocks.reduce((s, b) => s + b.successors.length, 0), 0));
  const entry = 'execution_flow_fixture::callback_entry';
  const closure = entry + '::{closure#0}';
  assert.ok(model.procedures.some(p => p.id === closure));
  assert.ok(model.calls.some(c => c.procedure === entry &&
    c.callbackArgs.some(arg => arg.targets && arg.targets.includes(closure))));
  assert.ok(model.edges.some(e => e.procedure === entry && e.to === entry + '#bb8' && e.from === entry + '#bb13'));
  const result = await Model.analyze(model, [closure], { roots: [entry] });
  assert.ok(active(result, 'activeNodeIds', closure + '#bb0'));
});
