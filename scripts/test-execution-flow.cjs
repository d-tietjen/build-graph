const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const Flow = require('../src/execution-flow.js');
const Model = require('../src/execution-model.js');

function block(id, kind, next = [], extra = {}) {
  return { id, kind, label: kind + ' ' + id, source_file: 'src/main.rs', source_location: Number(id.replace(/\D/g, '')) + 10,
    callee: null, successors: next.map(x => typeof x === 'string' ? { target: x, label: 'next', kind: 'normal' } : x), ...extra };
}
function fn(path, blocks, extra = {}) {
  return { id: path, label: path, source_file: 'src/main.rs', source_location: 3,
    attributes: { kind: 'flow_function', path, crate: path.split('::')[0], flow: JSON.stringify({ version: 1, function: path, entry: 'bb0', blocks }), ...extra } };
}
function graph(...nodes) { return { nodes, edges: [] }; }
function call(id, callee, next) { return block(id, 'call', [next], { callee }); }
function ret(id = 'bb0') { return block(id, 'return'); }
function entries(trace) { return trace.events.filter(e => e.type === 'enter').map(e => e.function); }
function run(g, pins, opts = {}) { return Flow.explore(Flow.catalog(g), pins, opts); }

test('native symbol boundary retains evidence and recorded continuation without MIR entry', () => {
  const nativeCall = { symbol: 'open', abi: 'C', libraries: ['ssl'] };
  const g = graph(fn('app::run', [block('bb0', 'call', ['bb1'], {
    callee: 'ffi::open', native_call: nativeCall, native_target_ids: ['native-open'],
    callee_package_id: 'pkg-ssl' }), ret('bb1')]));
  const result = run(g, [], { root: 'app::run' });
  assert.equal(result.traces.length, 1);
  const boundary = result.traces[0].events.find(e => e.type === 'body_unavailable');
  assert.equal(boundary.boundaryKind, 'native_symbol');
  assert.equal(boundary.native_call.symbol, 'open');
  assert.deepEqual(boundary.native_target_ids, ['native-open']);
  assert.equal(result.traces[0].complete, false);
});

test('sequential calls preserve full order and source locations', () => {
  const g = graph(fn('x::A', [call('bb0', 'x::B', 'bb1'), call('bb1', 'x::C', 'bb2'), ret('bb2')]),
    fn('x::B', [ret()]), fn('x::C', [ret()]));
  const r = run(g, ['x::B', 'x::C']);
  assert.equal(r.traces.length, 1);
  assert.deepEqual(entries(r.traces[0]), ['x::A', 'x::B', 'x::C']);
  assert.equal(r.traces[0].events.find(e => e.type === 'call').source_location, 10);
  assert.equal(r.traces[0].events.find(e => e.type === 'call').source_file, 'src/main.rs');
  assert.equal(r.traces[0].complete, true);
});

test('pins are an unordered conjunction and exclude exclusive branches', () => {
  const g = graph(fn('x::A', [block('bb0', 'branch', [
    { target: 'bb1', label: 'true', kind: 'normal' }, { target: 'bb2', label: 'false', kind: 'normal' }]),
    call('bb1', 'x::B', 'bb3'), call('bb2', 'x::C', 'bb3'), ret('bb3')]), fn('x::B', [ret()]), fn('x::C', [ret()]));
  assert.equal(run(g, ['x::B', 'x::C']).traces.length, 0);
  assert.equal(run(g, ['x::C', 'x::B']).traces.length, 0);
  const traces = run(g, ['x::B']).traces;
  assert.equal(traces.length, 1);
  assert.ok(traces[0].events.some(e => e.type === 'branch' && e.branch === 'true'));
});

test('returns resume their callsite for two callers', () => {
  const g = graph(fn('x::A', [call('bb0', 'x::Shared', 'bb1'), call('bb1', 'x::AfterA', 'bb2'), ret('bb2')]),
    fn('x::X', [call('bb0', 'x::Shared', 'bb1'), call('bb1', 'x::AfterX', 'bb2'), ret('bb2')]),
    fn('x::Shared', [ret()]), fn('x::AfterA', [ret()]), fn('x::AfterX', [ret()]));
  const r = run(g, ['x::Shared']);
  assert.deepEqual(r.roots, ['x::A', 'x::X']);
  assert.equal(r.traces.length, 2);
  for (const t of r.traces) {
    const names = entries(t);
    assert.ok(names[0] === 'x::A' ? names.includes('x::AfterA') && !names.includes('x::AfterX')
      : names.includes('x::AfterX') && !names.includes('x::AfterA'));
  }
});

test('repeated callsites invoke the same function twice', () => {
  const g = graph(fn('x::A', [call('bb0', 'x::B', 'bb1'), call('bb1', 'x::B', 'bb2'), ret('bb2')]), fn('x::B', [ret()]));
  assert.deepEqual(entries(run(g, ['x::B']).traces[0]), ['x::A', 'x::B', 'x::B']);
});

test('graph-owned trait dispatch adds a possible witness and retains the unresolved alternative', () => {
  const g = graph(fn('x::A', [call('bb0', 'x::Worker::get', 'bb1'), call('bb1', 'x::After', 'bb2'), ret('bb2')]),
    fn('x::Impl', [ret()]), fn('x::After', [ret()]));
  const index = Flow.catalog(g);
  Flow.applyModelTargets(index, { calls: [{ procedure: 'x::A', from: 'x::A#bb0',
    dispatchTargets: ['x::Impl'], possibleTargets: ['x::After'] }] });
  assert.ok(index.callers.get('x::Impl').has('x::A'));
  assert.ok(!index.functions.get('x::A').blocks.get('bb0').dispatch_targets.includes('x::After'));
  const result = Flow.explore(index, [], { root: 'x::A', maxPaths: 10 });
  const witnessed = result.traces.find(t => t.events.some(e => e.type === 'enter' &&
    e.function === 'x::Impl' && e.via === 'possible-dispatch'));
  assert.ok(witnessed);
  assert.ok(witnessed.events.some(e => e.type === 'enter' && e.function === 'x::After'));
  assert.equal(witnessed.coveragePartial, true);
  assert.ok(result.traces.some(t => !t.events.some(e => e.type === 'enter' && e.function === 'x::Impl')),
    'unresolved trait alternative remains visible');
});

test('compiled callee identity enters its body when the displayed path differs', () => {
  const body = fn('x::implementation::run', [ret()]);
  const flow = JSON.parse(body.attributes.flow); flow.function_id = 'body-id';
  body.attributes.flow = JSON.stringify(flow);
  const caller = fn('x::caller', [block('bb0', 'call', ['bb1'],
    { callee: 'x::alias::run', callee_id: 'body-id' }), ret('bb1')]);
  const g = graph(caller, body), index = Flow.catalog(g);
  Flow.applyModelTargets(index, Model.build(g));
  assert.ok(index.callers.get(body.id).has(caller.id));
  const result = Flow.explore(index, [body.id], { root: caller.id });
  assert.deepEqual(entries(result.traces[0]), [caller.id, body.id]);
  assert.equal(result.traces[0].coveragePartial, false);
});

test('mismatched callee identity cannot enter a same-path body', () => {
  const body = fn('x::run', [ret()]);
  const flow = JSON.parse(body.attributes.flow); flow.function_id = 'body-id';
  body.attributes.flow = JSON.stringify(flow);
  const caller = fn('x::caller', [block('bb0', 'call', ['bb1'],
    { callee: body.id, callee_id: 'other-id' }), ret('bb1')]);
  const g = graph(caller, body), index = Flow.catalog(g);
  Flow.applyModelTargets(index, Model.build(g));
  assert.ok(!index.callers.has(body.id));
  const result = Flow.explore(index, [], { root: caller.id });
  assert.ok(result.traces.every(function (trace) { return !entries(trace).includes(body.id); }));
  assert.ok(result.coverage.unavailableTargets.some(function (item) { return item.kind === 'identity mismatch'; }));
});

test('tail calls inherit their caller return continuation', () => {
  const g = graph(fn('x::A', [call('bb0', 'x::B', 'bb1'), ret('bb1')]),
    fn('x::B', [block('bb0', 'tail_call', [], { callee: 'x::C' })]), fn('x::C', [ret()]));
  const r = run(g, ['x::C']);
  assert.equal(r.traces.length, 1);
  assert.equal(r.traces[0].complete, true);
  assert.deepEqual(entries(r.traces[0]), ['x::A', 'x::B', 'x::C']);
});

test('loop and recursion bounds terminate with visible incomplete status', () => {
  const loop = run(graph(fn('x::Loop', [block('bb0', 'goto', ['bb0'])])), ['x::Loop'], { maxVisits: 2 });
  assert.equal(loop.traces.length, 1);
  assert.equal(loop.traces[0].complete, false);
  assert.match(loop.diagnostics.join(' '), /Visit bound/);
  const recursion = run(graph(fn('x::Recur', [call('bb0', 'x::Recur', 'bb1'), ret('bb1')])),
    ['x::Recur'], { maxDepth: 3 });
  assert.equal(recursion.traces.length, 1);
  assert.match(recursion.diagnostics.join(' '), /Call depth bound/);
});

test('unknown calls, opaque terminators, and yield report boundaries', () => {
  const g = graph(fn('x::A', [block('bb0', 'call', ['bb1'], { callee: null }),
    block('bb1', 'opaque', ['bb2']), block('bb2', 'yield', ['bb3']), ret('bb3')]));
  const r = run(g, ['x::A']);
  assert.equal(r.traces.length, 1);
  assert.equal(r.traces[0].complete, false);
  assert.ok(r.traces[0].events.some(e => e.type === 'opaque'));
  assert.match(r.diagnostics.join(' '), /Indirect|Opaque|Coroutine/);
});

test('compiler-proven unreachable branches are excluded from possible flows', () => {
  const branch = graph(fn('x::A', [block('bb0', 'branch', ['bb1', 'bb2']),
    ret('bb1'), block('bb2', 'unreachable')]));
  const b = run(branch, ['x::A']);
  assert.equal(b.traces.length, 1);
  assert.equal(b.traces[0].complete, true);
  assert.ok(!b.traces[0].events.some(e => e.block === 'bb2'));
  const opaque = graph(fn('x::A', [block('bb0', 'call', [
    { target: 'bb1', label: 'return', kind: 'normal' },
    { target: null, label: 'impossible unwind', kind: 'unwind', action: 'unreachable' }], { callee: null }), ret('bb1')]));
  const o = run(opaque, ['x::A']);
  assert.equal(o.traces.length, 1);
  assert.ok(!o.traces[0].events.some(e => e.branch === 'impossible unwind'));
});

test('empty, malformed, and missing data give diagnostics', () => {
  assert.equal(run(graph(), ['x::A']).traces.length, 0);
  const bad = fn('x::A', [block('bb0', 'goto', [null])]);
  const malformed = run(graph(bad), ['x::A']);
  assert.equal(malformed.incomplete, true);
  assert.match(malformed.diagnostics.join(' '), /Malformed/);
  const invalid = fn('x::B', [ret()]); invalid.attributes.flow = '{';
  const noSchema = run(graph(invalid), ['x::B']);
  assert.equal(noSchema.incomplete, true);
  assert.match(noSchema.diagnostics.join(' '), /Invalid flow JSON/);
});

test('path and state caps are visible and hard clamped', () => {
  const g = graph(fn('x::A', [block('bb0', 'branch', ['bb1', 'bb2']), ret('bb1'), ret('bb2')]));
  const r = run(g, ['x::A'], { maxPaths: 1, maxStates: 9999999 });
  assert.equal(r.traces.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.limits.maxStates, 60000);
  assert.match(r.diagnostics.join(' '), /Path cap/);
});

test('upstream entry inference includes known callers and cyclic boundaries', () => {
  const g = graph(fn('x::Root', [call('bb0', 'x::Target', 'bb1'), ret('bb1')]), fn('x::Target', [ret()]));
  assert.deepEqual(run(g, ['x::Target']).roots, ['x::Root']);
  assert.deepEqual(entries(run(g, ['x::Target']).traces[0]), ['x::Root', 'x::Target']);
  assert.deepEqual(run(g, ['x::Target'], { root: 'x::Target' }).roots, ['x::Target']);
  const cycle = graph(fn('x::A', [call('bb0', 'x::B', 'bb1'), ret('bb1')]),
    fn('x::B', [call('bb0', 'x::A', 'bb1'), call('bb1', 'x::Target', 'bb2'), ret('bb2')]),
    fn('x::Root', [call('bb0', 'x::Target', 'bb1'), ret('bb1')]), fn('x::Target', [ret()]));
  const roots = Flow.rootsFor(Flow.catalog(cycle), 'x::Target');
  assert.equal(roots.incomplete, true);
  assert.ok(roots.roots.includes('x::Root'));
  assert.ok(roots.roots.some(p => p === 'x::A' || p === 'x::B'));
});

test('explicit entry enumerates bounded paths without pins', () => {
  const g = graph(fn('x::Root', [block('bb0', 'branch', ['bb1', 'bb2']),
    call('bb1', 'x::Left', 'bb3'), call('bb2', 'x::Right', 'bb3'), ret('bb3')]),
    fn('x::Left', [ret()]), fn('x::Right', [ret()]));
  const r = run(g, [], { root: 'x::Root' });
  assert.deepEqual(r.roots, ['x::Root']);
  assert.equal(r.traces.length, 2);
  assert.ok(r.traces.every(t => t.complete));
  assert.deepEqual(r.traces.map(entries).map(path => path[1]).sort(), ['x::Left', 'x::Right']);
  assert.equal(run(g, []).traces.length, 0);
});

test('null continue successor propagates as return', () => {
  const g = graph(fn('x::A', [block('bb0', 'goto', [{ target: null, kind: 'normal', label: 'done', action: 'continue' }])]));
  assert.equal(run(g, ['x::A']).traces[0].complete, true);
});

test('unwind follows matching caller cleanup and crosses a caller without cleanup', () => {
  const unwindEdge = { target: 'bb2', label: 'cleanup', kind: 'unwind' };
  const g = graph(fn('x::A', [block('bb0', 'call', [
    { target: 'bb1', label: 'return', kind: 'normal' }, unwindEdge], { callee: 'x::B' }),
    ret('bb1'), ret('bb2')]), fn('x::B', [block('bb0', 'call', [
      { target: 'bb1', label: 'return', kind: 'normal' }], { callee: 'x::C' }), ret('bb1')]),
    fn('x::C', [block('bb0', 'unwind')]));
  const r = run(g, ['x::C'], { root: 'x::A', includeUnwind: true });
  assert.equal(r.traces.length, 1);
  assert.equal(r.traces[0].complete, true);
  assert.ok(r.traces[0].events.some(e => e.type === 'branch' && e.function === 'x::A' && e.branch === 'cleanup'));
  assert.ok(!r.traces[0].events.some(e => e.type === 'return' && e.function === 'x::B'));
});

test('bound and forwarded callback parameters execute in callsite order', () => {
  const g = graph(
    fn('x::Entry', [block('bb0', 'call', ['bb1'], { callee: 'x::Forward',
      callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] }),
      call('bb1', 'x::After', 'bb2'), ret('bb2')]),
    fn('x::Forward', [block('bb0', 'call', ['bb1'], { callee: 'x::Invoke',
      callback_args: [{ index: 0, targets: [], parameter: 0 }] }), ret('bb1')]),
    fn('x::Invoke', [block('bb0', 'call', ['bb1'], { callback_parameter: 0 }), ret('bb1')]),
    fn('x::Callback', [ret()]), fn('x::After', [ret()]));
  const r = run(g, ['x::Callback', 'x::After'], { root: 'x::Entry' });
  assert.equal(r.traces.length, 1);
  assert.deepEqual(entries(r.traces[0]), ['x::Entry', 'x::Forward', 'x::Invoke', 'x::Callback', 'x::After']);
  assert.equal(r.traces[0].events.find(e => e.function === 'x::Callback' && e.type === 'enter').via, 'callback');
  assert.equal(r.traces[0].complete, true);
});

test('finite fnptr choices and an unknown alternative remain distinct', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'call', ['bb1'], {
    callee_targets: ['x::Left', 'x::Right'], callback_unknown: true }), ret('bb1')]),
    fn('x::Left', [ret()]), fn('x::Right', [ret()]));
  const r = run(g, ['x::Entry'], { root: 'x::Entry' });
  assert.ok(r.traces.some(t => entries(t).includes('x::Left')));
  assert.ok(r.traces.some(t => entries(t).includes('x::Right')));
  assert.ok(r.traces.some(t => t.events.some(e => e.type === 'enter' && e.function === 'x::Left' && e.via === 'callback')));
  assert.ok(r.traces.some(t => t.events.some(e => e.type === 'opaque') && !t.complete));
});

test('external callback arguments are candidates, not proven invocation', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'call', ['bb1'], { callee: 'external::register',
    callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] }), ret('bb1')]),
    fn('x::Callback', [ret()]));
  assert.equal(run(g, ['x::Callback'], { root: 'x::Entry' }).traces.length, 0);
  const t = run(g, ['x::Entry'], { root: 'x::Entry' }).traces[0];
  assert.ok(t.events.some(e => e.callback_reference && e.callback_candidates.includes('x::Callback')));
  assert.ok(!entries(t).includes('x::Callback'));
});

test('named unavailable bodies keep recorded local order without diagnostic spam', () => {
  const g = graph(fn('x::Entry', [call('bb0', 'std::Vec::clear', 'bb1'),
    call('bb1', 'std::io::Read::read_exact', 'bb2'), call('bb2', 'x::After', 'bb3'), ret('bb3')]),
  fn('x::After', [ret()]));
  const r = run(g, ['x::After'], { root: 'x::Entry' });
  assert.equal(r.traces.length, 1);
  assert.deepEqual(entries(r.traces[0]), ['x::Entry', 'x::After']);
  assert.equal(r.traces[0].reachedExit, true);
  assert.equal(r.traces[0].coveragePartial, true);
  assert.equal(r.traces[0].complete, false);
  assert.equal(r.coverage.unavailableCount, 2);
  assert.equal(r.traces[0].events.filter(e => e.type === 'body_unavailable').length, 2);
  assert.ok(!r.diagnostics.some(d => d.includes('std::')));
});

test('step budget counts MIR blocks, not successor or synthetic return routing', () => {
  const g = graph(fn('x::Entry', [call('bb0', 'std::Vec::clear', 'bb1'),
    call('bb1', 'x::After', 'bb2'), ret('bb2')]),
  fn('x::After', [block('bb0', 'goto', [
    { target: null, kind: 'normal', label: 'done', action: 'continue' }])]));
  const exact = run(g, ['x::After'], { root: 'x::Entry', maxSteps: 4 });
  assert.equal(exact.traces.length, 1);
  assert.equal(exact.traces[0].reachedExit, true);
  assert.equal(exact.traces[0].coveragePartial, true);
  assert.ok(!exact.diagnostics.some(d => d.startsWith('Step bound')));
  const short = run(g, ['x::After'], { root: 'x::Entry', maxSteps: 3 });
  assert.ok(short.diagnostics.some(d => d.startsWith('Step bound')));
  assert.ok(!short.traces.some(t => t.reachedExit));
});

test('normal scope omits unwind; opt-in preserves recorded cleanup', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'call', [
    { target: 'bb1', label: 'return', kind: 'normal' },
    { target: 'bb2', label: 'cleanup', kind: 'unwind' }], { callee: 'std::io::read' }),
  ret('bb1'), ret('bb2')]));
  const normal = run(g, ['x::Entry'], { root: 'x::Entry' });
  const both = run(g, ['x::Entry'], { root: 'x::Entry', includeUnwind: true });
  assert.equal(normal.traces.length, 1);
  assert.ok(!normal.traces[0].events.some(e => e.branch === 'cleanup'));
  assert.equal(both.traces.length, 2);
  assert.ok(both.traces.some(t => t.events.some(e => e.branch === 'cleanup')));
  assert.ok(both.traces.every(t => t.coveragePartial));
});

test('opt-in unwind explores normal return before cleanup without dropping either', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'call', [
    { target: 'bb1', label: 'return', kind: 'normal' },
    { target: 'bb2', label: 'cleanup', kind: 'unwind' }], { callee: 'std::io::read' }),
  call('bb1', 'x::After', 'bb3'), ret('bb2'), ret('bb3')]), fn('x::After', [ret()]));
  const first = run(g, ['x::Entry'], { root: 'x::Entry', includeUnwind: true, maxPaths: 1 });
  assert.equal(first.traces.length, 1);
  assert.ok(entries(first.traces[0]).includes('x::After'));
  assert.ok(!first.traces[0].events.some(e => e.branch === 'cleanup'));
  const all = run(g, ['x::Entry'], { root: 'x::Entry', includeUnwind: true, maxPaths: 5 });
  assert.equal(all.traces.length, 2);
  assert.ok(all.traces.some(t => t.events.some(e => e.branch === 'cleanup')));
});

test('opt-in keeps default DFS order among normal alternatives', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'assert', [
    { target: 'bb1', label: 'loop', kind: 'normal' },
    { target: 'bb2', label: 'return', kind: 'normal' },
    { target: 'bb3', label: 'cleanup', kind: 'unwind' }]),
  block('bb1', 'goto', ['bb1']), ret('bb2'), ret('bb3')]));
  for (const includeUnwind of [false, true]) {
    const first = run(g, ['x::Entry'], { root: 'x::Entry', includeUnwind, maxPaths: 1, maxVisits: 1 });
    assert.equal(first.traces.length, 1);
    assert.ok(first.traces[0].events.some(e => e.branch === 'return'));
    assert.ok(!first.traces[0].events.some(e => e.branch === 'loop' || e.branch === 'cleanup'));
  }
  const all = run(g, ['x::Entry'], { root: 'x::Entry', includeUnwind: true, maxPaths: 5, maxVisits: 1 });
  assert.ok(all.traces.some(t => t.events.some(e => e.branch === 'cleanup')));
});

test('local opaque stub returns only through a recorded callsite continuation', () => {
  const stub = fn('x::Stub', [block('bb0', 'opaque')]);
  const g = graph(fn('x::Entry', [call('bb0', 'x::Stub', 'bb1'),
    call('bb1', 'x::After', 'bb2'), ret('bb2')]), stub, fn('x::After', [ret()]));
  const r = run(g, ['x::Stub', 'x::After'], { root: 'x::Entry' });
  assert.equal(r.traces.length, 1);
  assert.deepEqual(entries(r.traces[0]), ['x::Entry', 'x::Stub', 'x::After']);
  assert.equal(r.traces[0].reachedExit, true);
  assert.equal(r.traces[0].coveragePartial, true);
  assert.ok(r.traces[0].events.some(e => e.type === 'body_unavailable' && e.function === 'x::Stub'));
  const root = run(graph(stub), ['x::Stub'], { root: 'x::Stub' });
  assert.equal(root.traces[0].reachedExit, false);
  const diverging = run(graph(fn('x::NoReturn', [block('bb0', 'call', [], { callee: 'x::Stub' })]), stub),
    ['x::NoReturn'], { root: 'x::NoReturn' });
  assert.ok(!diverging.traces.some(t => t.reachedExit));
  const cleanup = graph(fn('x::Caller', [block('bb0', 'call', [
    { target: 'bb1', label: 'return', kind: 'normal' },
    { target: 'bb2', label: 'cleanup', kind: 'unwind' }], { callee: 'x::Stub' }),
  ret('bb1'), ret('bb2')]), stub);
  const optedIn = run(cleanup, ['x::Stub'], { root: 'x::Caller', includeUnwind: true });
  assert.ok(optedIn.traces.some(t => t.events.some(e => e.branch === 'cleanup') && t.coveragePartial));
});

test('known callback plus unknown provenance keeps an incomplete alternative', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'call', ['bb1'], { callee: 'x::Invoke',
    callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null, unknown: true }] }), ret('bb1')]),
    fn('x::Invoke', [block('bb0', 'call', ['bb1'], { callback_parameter: 0 }), ret('bb1')]),
    fn('x::Callback', [ret()]));
  const r = run(g, ['x::Entry'], { root: 'x::Entry' });
  assert.ok(r.traces.every(t => entries(t).includes('x::Invoke')));
  assert.ok(r.traces.some(t => entries(t).includes('x::Callback')));
  assert.ok(r.traces.some(t => t.events.some(e => e.type === 'opaque' && e.function === 'x::Invoke') && !t.complete));
  const merged = graph(fn('x::Merged', [block('bb0', 'call', ['bb1'], {
    callee_targets: ['x::Callback'], callback_parameter: 0 }), ret('bb1')]),
    fn('x::Callback', [ret()]));
  const m = run(merged, ['x::Merged'], { root: 'x::Merged' });
  assert.ok(m.traces.some(t => entries(t).includes('x::Callback')));
  assert.ok(m.traces.some(t => t.events.some(e => e.type === 'opaque') && !t.complete));
  const forwarded = graph(fn('x::Entry', [block('bb0', 'call', ['bb1'], { callee: 'x::Invoke',
    callback_args: [{ index: 0, targets: ['x::Callback'], parameter: 0 }] }), ret('bb1')]),
    fn('x::Invoke', [block('bb0', 'call', ['bb1'], { callback_parameter: 0 }), ret('bb1')]),
    fn('x::Callback', [ret()]));
  const f = run(forwarded, ['x::Entry'], { root: 'x::Entry' });
  assert.ok(f.traces.some(t => entries(t).includes('x::Callback')));
  assert.ok(f.traces.some(t => t.events.some(e => e.type === 'opaque' && e.function === 'x::Invoke')));
});

test('callsite context distinguishes shared callee from different callers', () => {
  const g = graph(fn('x::Entry', [block('bb0', 'branch', ['bb1', 'bb2']),
    call('bb1', 'x::One', 'bb3'), call('bb2', 'x::Two', 'bb3'), ret('bb3')]),
    fn('x::One', [call('bb0', 'x::Shared', 'bb1'), ret('bb1')]),
    fn('x::Two', [call('bb0', 'x::Shared', 'bb1'), ret('bb1')]), fn('x::Shared', [ret()]));
  const r = run(g, ['x::Shared'], { root: 'x::Entry' });
  assert.equal(r.traces.length, 2);
  const contexts = r.traces.map(t => t.events.find(e => e.type === 'enter' && e.function === 'x::Shared').context);
  assert.notEqual(contexts[0], contexts[1]);
});

test('wide branches cap pending states without losing a truncation signal', () => {
  const successors = Array.from({ length: 6000 }, (_, i) => ({ target: 'bb' + (i + 1), label: String(i), kind: 'normal' }));
  const blocks = [block('bb0', 'branch', successors)];
  for (let i = 1; i <= 6000; i++) blocks.push(ret('bb' + i));
  const r = run(graph(fn('x::Wide', blocks)), ['x::Wide'], { maxPaths: 1 });
  assert.equal(r.truncated, true);
  assert.match(r.diagnostics.join(' '), /Pending-state cap/);
});

function fixtureIndex() {
  const raw = fs.readFileSync(process.env.BUILD_GRAPH_FIXTURE_GRAPH);
  const data = JSON.parse(raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw);
  return Flow.catalog(data);
}

if (process.env.BUILD_GRAPH_FIXTURE_GRAPH) test('actual rustc driver graph preserves fixture execution order', () => {
  const index = fixtureIndex();
  function path(name) {
    const key = 'execution_flow_fixture::' + name;
    assert.ok(index.functions.has(key), `missing fixture MIR function ${key}`);
    return key;
  }
  const entry = path('entry'), before = path('before'), left = path('left'), right = path('right'), shared = path('shared'), after = path('after');
  const r = Flow.explore(index, [entry, before, after], { root: entry, maxPaths: 80, maxSteps: 160, maxVisits: 2, maxDepth: 12 });
  assert.ok(r.traces.length >= 2, r.diagnostics.join(' '));
  for (const t of r.traces) {
    const names = entries(t);
    const beforeAt = names.indexOf(before), afterAt = names.indexOf(after), sharedAt = names.indexOf(shared);
    assert.ok(beforeAt >= 0 && beforeAt < sharedAt && sharedAt < afterAt, names.join(' → '));
    assert.equal(names.includes(left), !names.includes(right));
    assert.ok(t.events.some(e => e.source_file && e.source_location));
  }
  assert.equal(Flow.explore(index, [left, right], { root: entry }).traces.length, 0);
});

if (process.env.BUILD_GRAPH_FIXTURE_GRAPH) test('binary and library identities stay distinct in actual MIR flows', () => {
  const index = fixtureIndex();
  const libMain = 'execution_flow_fixture::main', binMain = 'bin::execution_flow_fixture::main';
  const libShared = 'execution_flow_fixture::shared', binShared = 'bin::execution_flow_fixture::shared';
  for (const key of [libMain, binMain, libShared, binShared]) {
    assert.ok(index.functions.has(key), `missing canonical MIR function ${key}`);
  }
  assert.ok(index.functions.get(libMain).source_file.endsWith('src/main.rs'));
  assert.ok(index.functions.get(libShared).source_file.endsWith('src/main.rs'));
  assert.ok(index.functions.get(binMain).source_file.endsWith('src/bin/collision.rs'));
  assert.ok(index.functions.get(binShared).source_file.endsWith('src/bin/collision.rs'));
  const binCallees = Array.from(index.functions.get(binMain).blocks.values()).map(b => b.callee);
  assert.ok(binCallees.includes(binShared));
  assert.ok(!binCallees.includes(libShared));
  const libCallees = Array.from(index.functions.get(libMain).blocks.values()).map(b => b.callee);
  assert.ok(libCallees.includes(libShared));
  assert.ok(!libCallees.includes(binShared));
  const collision = Flow.explore(index, [], { root: binMain });
  assert.ok(collision.traces.length > 0, collision.diagnostics.join(' '));
  assert.ok(collision.traces.some(t => entries(t).includes(binShared)));
  const runnerMain = 'bin::execution_flow_runner::main';
  const before = 'bin::execution_flow_runner::binary_before';
  const after = 'bin::execution_flow_runner::binary_after';
  const entry = 'execution_flow_fixture::entry';
  for (const key of [runnerMain, before, entry, after]) {
    assert.ok(index.functions.has(key), `missing canonical MIR function ${key}`);
  }
  const runner = Flow.explore(index, [before, entry, after], { root: runnerMain });
  assert.ok(runner.traces.length > 0, runner.diagnostics.join(' '));
  for (const trace of runner.traces) {
    const names = entries(trace);
    assert.ok(names.indexOf(before) < names.indexOf(entry) && names.indexOf(entry) < names.indexOf(after), names.join(' → '));
  }
});

if (process.env.BUILD_GRAPH_FIXTURE_GRAPH) test('actual MIR callback bindings, aliases, and loop boundaries', () => {
  const index = fixtureIndex();
  const key = name => 'execution_flow_fixture::' + name;
  const get = name => {
    const path = key(name), item = index.functions.get(path);
    assert.ok(item, `missing fixture MIR function ${path}`);
    return item;
  };
  const find = (item, predicate, label) => {
    const found = Array.from(item.blocks.values()).find(predicate);
    assert.ok(found, `missing ${label} in ${item.path}`);
    return found;
  };
  const entry = get('callback_entry'), named = get('named_callback'), alternate = get('alternate_callback');
  const forward = get('forward_callback'), invoke = get('invoke_callback');
  const generic = get('invoke_generic'), closureBody = get('closure_body');
  const closure = index.functions.get(key('callback_entry::{closure#0}'));
  assert.ok(closure, 'missing fixture closure MIR body');

  const indirect = find(entry, b => Array.isArray(b.callee_targets) && b.callee_targets.length === 2, 'finite fnptr call');
  assert.deepEqual(indirect.callee_targets.slice().sort(), [named.path, alternate.path].sort());
  assert.equal(indirect.callback_unknown, undefined);
  const forwarded = find(entry, b => b.callee === forward.path, 'forwarded callback call');
  assert.deepEqual(forwarded.callback_args, [{ index: 0, targets: [alternate.path, named.path], parameter: null }]);
  const genericCall = find(entry, b => b.callee === generic.path, 'generic closure call');
  assert.deepEqual(genericCall.callback_args, [{ index: 0, targets: [closure.path], parameter: null }]);
  assert.equal(find(forward, b => b.callee === invoke.path, 'forwarding call').callback_args[0].parameter, 0);
  assert.equal(find(invoke, b => b.kind === 'call', 'fnptr parameter invocation').callback_parameter, 0);
  assert.equal(find(generic, b => b.kind === 'call', 'Fn parameter invocation').callback_parameter, 0);
  assert.ok(Array.from(closure.blocks.values()).some(b => b.callee === closureBody.path));
  assert.ok(Array.from(entry.blocks.values()).some(b => b.callee === invoke.path &&
    b.callback_args.some(arg => arg.targets.includes(named.path))), 'missing callback in loop body');
  assert.ok(Array.from(entry.blocks.values()).some(b => (b.successors || []).some(s =>
    s.target && /^bb\d+$/.test(s.target) && Number(s.target.slice(2)) <= Number(b.id.slice(2)))),
    'missing MIR loop backedge');

  const explored = Flow.explore(index, [entry.path], { root: entry.path, maxPaths: 256, maxSteps: 180,
    maxVisits: 2, maxDepth: 16 });
  assert.ok(explored.traces.length > 0, explored.diagnostics.join(' '));
  const paths = explored.traces.map(entries);
  assert.ok(paths.some(p => p.includes(named.path) && p.includes(closureBody.path)));
  assert.ok(paths.some(p => p.includes(alternate.path) && p.includes(closureBody.path)));
  assert.ok(paths.some(p => p.indexOf(named.path) < p.indexOf(forward.path) &&
    p.indexOf(forward.path) < p.indexOf(generic.path) && p.indexOf(generic.path) < p.indexOf(closureBody.path)));
  assert.ok(paths.some(p => p.filter(name => name === invoke.path).length >= 2), 'loop did not reinvoke callback wrapper');
  assert.ok(explored.traces.some(t => !t.complete), 'loop bound did not mark an incomplete path');

  const aliased = get('aliased_callback_entry');
  const stale = find(aliased, b => b.kind === 'call' && b.callback_unknown, 'unknown call after mutable alias');
  assert.ok(!stale.callee_targets || stale.callee_targets.length === 0);
  const aliasTrace = Flow.explore(index, [aliased.path], { root: aliased.path });
  assert.ok(aliasTrace.traces.some(t => !t.complete && t.events.some(e => e.type === 'opaque')));
  assert.ok(aliasTrace.traces.every(t => !entries(t).includes(named.path)));

  const aliasForward = get('aliased_forward_callback_entry');
  const direct = find(aliasForward, b => b.callee === invoke.path, 'known wrapper call after mutable alias');
  assert.equal(direct.callback_unknown, undefined);
  assert.deepEqual(direct.callback_args, [{ index: 0, targets: [], parameter: null, unknown: true }]);
  const forwardedAlias = Flow.explore(index, [aliasForward.path], { root: aliasForward.path });
  assert.ok(forwardedAlias.traces.length > 0);
  assert.ok(forwardedAlias.traces.every(t => entries(t).includes(invoke.path)));
  assert.ok(forwardedAlias.traces.some(t => !t.complete && t.events.some(e =>
    e.type === 'opaque' && e.function === invoke.path)));
});
