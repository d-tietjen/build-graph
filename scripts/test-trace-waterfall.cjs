const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const Flow = require('../src/execution-flow.js');
const Waterfall = require('../src/trace-waterfall.js');

function e(type, fn, depth, block, extra = {}) {
  return { type, function: fn, depth, block, label: type, source_file: 'src/main.rs',
    source_location: depth + 1, ...extra };
}
function trace(events, extra = {}) {
  return { events, functions: [...new Set(events.map(event => event.function))],
    reachedExit: true, complete: true, coveragePartial: false, reasons: [], ...extra };
}

test('nested sibling activations have distinct matched spans on a compiled-step axis', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('branch', 'A', 0, 'bb0', { branch: 'next', target: 'bb1' }),
    e('call', 'A', 0, 'bb1'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('branch', 'A', 0, 'bb1', { branch: 'next', target: 'bb2' }),
    e('return', 'A', 0, 'bb2')]);
  const p = Waterfall.project(t);
  assert.equal(p.steps, t.events.length);
  assert.equal(p.bars.length, 3);
  assert.equal(p.bars[0].start, 0);
  assert.equal(p.bars[0].end, 9);
  assert.deepEqual(p.bars.slice(1).map(b => [b.function, b.start, b.end, b.parentId]),
    [['B', 2, 3, p.bars[0].id], ['B', 6, 7, p.bars[0].id]]);
  assert.notEqual(p.bars[1].id, p.bars[2].id);
  assert.equal(p.counts.loops, 0, 'routing branch events do not create fake revisits');
});

test('recursion, callback, and loop revisits retain separate activation markers', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('goto', 'A', 0, 'bb0'),
    e('branch', 'A', 0, 'bb0', { branch: 'loop', target: 'bb0' }), e('goto', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb1'), e('enter', 'A', 1, 'bb0', { recursive: true, via: 'callback' }),
    e('return', 'A', 1, 'bb0'), e('return', 'A', 0, 'bb2')]));
  assert.equal(p.bars.length, 2);
  assert.notEqual(p.bars[0].id, p.bars[1].id);
  assert.equal(p.bars[1].parentId, p.bars[0].id);
  assert.equal(p.counts.loops, 1);
  assert.ok(p.markers.some(m => m.type === 'recursion'));
  assert.ok(p.markers.some(m => m.type === 'callback'));
});

test('unwind and unavailable child bodies close at their own caller continuations', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('unwind', 'B', 1, 'bb0'),
    e('branch', 'A', 0, 'bb0', { edgeKind: 'unwind', branch: 'cleanup' }),
    e('call', 'A', 0, 'bb1'), e('enter', 'C', 1, 'bb0'),
    e('body_unavailable', 'C', 1, 'bb0', { callee: 'C' }),
    e('branch', 'A', 0, 'bb1'), e('return', 'A', 0, 'bb2')],
  { coveragePartial: true, complete: false }));
  assert.equal(p.bars.find(b => b.function === 'B').outcome, 'unwind');
  assert.equal(p.bars.find(b => b.function === 'C').outcome, 'body unavailable / recorded continuation');
  assert.ok(p.markers.some(m => m.type === 'unwind_edge'));
  assert.equal(p.coveragePartial, true);
});

test('tail-call replacement and possible dispatch do not merge activations', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('tail_call', 'A', 0, 'bb0'),
    e('enter', 'B', 0, 'bb0', { via: 'possible-dispatch' }), e('return', 'B', 0, 'bb0')],
  { coveragePartial: true, complete: false }));
  assert.deepEqual(p.bars.map(b => b.outcome), ['tail call', 'return']);
  assert.notEqual(p.bars[0].id, p.bars[1].id);
  assert.equal(p.bars[1].via, 'possible-dispatch');
});

test('auxiliary unknown markers do not fake loops; bound leaves open span', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('opaque', 'A', 0, 'bb0', { label: 'Indirect or unknown callee' }),
    e('branch', 'A', 0, 'bb0', { branch: 'next' })],
  { reachedExit: false, complete: false, reasons: ['Step bound reached (3).'] }));
  assert.equal(p.counts.loops, 0);
  assert.ok(p.markers.some(m => m.type === 'unknown'));
  assert.equal(p.bars[0].outcome, 'open / truncated boundary');
  assert.match(p.reasons.join(' '), /Step bound/);
});

test('a MIR switch revisited through its routing edge is one real loop', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('branch', 'A', 0, 'bb0', { label: 'switch on flag' }),
    e('branch', 'A', 0, 'bb0', { branch: 'true', target: 'bb0', edgeKind: 'normal' }),
    e('branch', 'A', 0, 'bb0', { label: 'switch on flag' }),
    e('branch', 'A', 0, 'bb0', { branch: 'false', target: 'bb1', edgeKind: 'normal' }),
    e('return', 'A', 0, 'bb1')]));
  assert.equal(p.counts.loops, 1);
  assert.equal(p.counts.branches, 2);
});

test('every activation still on the stack at a bound is open, including nested callees', () => {
  const p = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('call', 'B', 1, 'bb0'),
    e('enter', 'C', 2, 'bb0'), e('goto', 'C', 2, 'bb0')],
  { reachedExit: false, complete: false, reasons: ['Step bound reached (3).'] }));
  assert.equal(p.bars.length, 3);
  assert.ok(p.bars.every(bar => bar.outcome === 'open / truncated boundary'));
});

test('flamegraph merges repeated siblings only under the same logical call stack', () => {
  const first = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb1'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb2'), e('enter', 'C', 1, 'bb0'),
    e('call', 'C', 1, 'bb0'), e('enter', 'B', 2, 'bb0'), e('return', 'B', 2, 'bb0'),
    e('return', 'C', 1, 'bb1'), e('return', 'A', 0, 'bb3')]));
  const second = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('return', 'A', 0, 'bb1')]));
  const root = Waterfall.aggregate([first, second]);
  const a = root.children[0], directB = a.children.find(node => node.function === 'B');
  const c = a.children.find(node => node.function === 'C');
  assert.equal(root.weight, first.steps + second.steps);
  assert.equal(a.weight, root.weight, 'one inclusive root activation per example');
  assert.equal(directB.invocations, 3);
  assert.equal(directB.traceCount, 2);
  assert.equal(c.children[0].function, 'B');
  assert.equal(c.children[0].invocations, 1);
  assert.notEqual(directB.id, c.children[0].id);
  assert.equal(a.selfSteps + a.children.reduce((n, child) => n + child.weight, 0), a.weight);
});

test('recursive frames remain separate depths and callback invocation keeps its route', () => {
  const projection = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'A', 1, 'bb0', { recursive: true }),
    e('call', 'A', 1, 'bb0'), e('enter', 'A', 2, 'bb0', { recursive: true, via: 'callback' }),
    e('return', 'A', 2, 'bb0'), e('return', 'A', 1, 'bb1'), e('return', 'A', 0, 'bb1')]));
  const root = Waterfall.aggregate([projection]);
  const first = root.children[0], second = first.children[0], third = second.children[0];
  assert.deepEqual([first.depth, second.depth, third.depth], [0, 1, 2]);
  assert.deepEqual([first.function, second.function, third.function], ['A', 'A', 'A']);
  assert.equal(third.via, 'callback');
  assert.equal(third.invocations, 1);
});

test('zero traces and unknown events produce no invented execution frame', () => {
  const empty = Waterfall.aggregate([]);
  assert.equal(empty.traceCount, 0);
  assert.equal(empty.weight, 0);
  assert.deepEqual(empty.children, []);
  const unknown = Waterfall.aggregate([Waterfall.project(trace([e('opaque', 'A', 0, 'bb0')],
    { reachedExit: false, complete: false }))]);
  assert.equal(unknown.weight, 1);
  assert.equal(unknown.selfSteps, 1);
  assert.equal(unknown.unknownCount, 1);
  assert.deepEqual(unknown.children, []);
});

test('unknown and truncated boundaries keep their compiled-step weights', () => {
  const projected = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0'),
    e('opaque', 'B', 1, 'bb0', { label: 'unknown callee' })],
  { reachedExit: false, complete: false, reasons: ['Step bound reached.'] }));
  const root = Waterfall.aggregate([projected]);
  const a = root.children[0], b = a.children[0];
  assert.equal(root.weight, 4);
  assert.equal(a.weight, 4);
  assert.equal(b.weight, 2);
  assert.equal(a.selfSteps, 2);
  assert.equal(b.unknownCount, 1);
  assert.equal(b.boundaryCount, 1);
  assert.equal(root.boundaryCount, 1);
});

test('zoom lookup retains the selected frame and only its children', () => {
  const projected = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0'),
    e('call', 'B', 1, 'bb0'), e('enter', 'C', 2, 'bb0'),
    e('return', 'C', 2, 'bb0'), e('return', 'B', 1, 'bb1'),
    e('call', 'A', 0, 'bb1'), e('enter', 'D', 1, 'bb0'),
    e('return', 'D', 1, 'bb0'), e('return', 'A', 0, 'bb2')]));
  const root = Waterfall.aggregate([projected]);
  const a = root.children[0], b = a.children.find(node => node.function === 'B');
  const zoomed = Waterfall.frameAt(root, b.id);
  assert.equal(zoomed.parentId, a.id);
  assert.deepEqual(zoomed.children.map(node => node.function), ['C']);
  assert.equal(Waterfall.frameAt(root, a.id).children.length, 2,
    'going back restores both sibling stacks');
  assert.equal(Waterfall.frameAt(root, -1), null);
});

test('call order retains more than forty sequential and nested recorded invocations', () => {
  const events = [e('enter', 'entry', 0, 'bb0')];
  for (let i = 0; i < 42; i++) {
    events.push(e('call', 'entry', 0, 'bb' + i));
    events.push(e('enter', 'work::' + i, 1, 'bb0'));
    if (i === 20) {
      events.push(e('call', 'work::20', 1, 'bb1'));
      events.push(e('enter', 'deep', 2, 'bb0'));
      events.push(e('return', 'deep', 2, 'bb0'));
    }
    events.push(e('return', 'work::' + i, 1, 'bb2'));
  }
  events.push(e('body_unavailable', 'entry', 0, 'external1', { callee: 'external::one' }));
  events.push(e('branch', 'entry', 0, 'external1', { branch: 'next', target: 'bbEnd' }));
  events.push(e('body_unavailable', 'entry', 0, 'external2', { callee: 'external::two' }));
  events.push(e('branch', 'entry', 0, 'external2', { branch: 'next', target: 'bbEnd' }));
  events.push(e('return', 'entry', 0, 'bbEnd'));
  const projected = Waterfall.project(trace(events, { coveragePartial: true }));
  const order = Waterfall.orderedFrames(projected);
  const entry = order.children[0];
  assert.equal(projected.bars.length, 46, 'entry, forty-two work calls, nested call, two boundaries');
  assert.equal(entry.children.length, 44);
  assert.equal(entry.children[20].children[0].function, 'deep');
  assert.deepEqual(entry.children.slice(-2).map(node => node.function),
    ['external::one', 'external::two']);
  assert.ok(entry.children.every((node, i, all) => i === 0 || all[i - 1].start < node.start));
  function conserved(node) {
    assert.equal(node.weight, node.selfSteps + node.children.reduce((n, child) => n + child.weight, 0));
    node.children.forEach(conserved);
  }
  conserved(order);
  assert.equal(order.weight, events.length);
});

test('initial comparison selects the call-richest bounded variant with a stable first tie', () => {
  const one = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'), e('return', 'A', 0, 'bb1')]));
  const three = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb1'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb2'), e('enter', 'C', 1, 'bb0'), e('return', 'C', 1, 'bb0'),
    e('return', 'A', 0, 'bb3')]));
  const sameCount = Waterfall.project(trace([e('enter', 'A', 0, 'bb0'),
    e('body_unavailable', 'A', 0, 'bb1', { callee: 'X' }),
    e('body_unavailable', 'A', 0, 'bb2', { callee: 'Y' }),
    e('return', 'A', 0, 'bb3')]));
  assert.equal(Waterfall.richestVariantIndex([one, three, sameCount]), 1);
  assert.equal(Waterfall.richestVariantIndex([]), 0);
});

test('repeated same callee and unresolved callsites remain distinct in call order', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb1'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb2'), e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb3'), e('opaque', 'A', 0, 'bb3'),
    e('branch', 'A', 0, 'bb3', { branch: 'next' }),
    e('call', 'A', 0, 'bb4'), e('opaque', 'A', 0, 'bb4'),
    e('branch', 'A', 0, 'bb4', { branch: 'next' }),
    e('return', 'A', 0, 'bb5')]);
  const p = Waterfall.project(t), children = Waterfall.orderedFrames(p).children[0].children;
  assert.deepEqual(children.map(node => node.function),
    ['B', 'B', '(unknown target)', '(unknown target)']);
  assert.equal(new Set(children.map(node => node.id)).size, 4);
  assert.deepEqual(children.map(node => node.start), [2, 5, 8, 11]);
  assert.ok(children.slice(2).every(node => node.uncertain && node.weight === 1));
  assert.equal(p.bars.filter(bar => bar.synthetic).length, 2);
});

test('unavailable captured stub has one activation and no synthetic duplicate', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('body_unavailable', 'B', 1, 'bb0', { callee: 'B' }),
    e('branch', 'A', 0, 'bb0', { branch: 'next' }), e('return', 'A', 0, 'bb1')],
  { coveragePartial: true });
  const p = Waterfall.project(t), seq = Waterfall.sequenceProject(t, p);
  assert.equal(p.bars.filter(bar => bar.function === 'B').length, 1);
  assert.equal(p.bars.filter(bar => bar.synthetic).length, 0);
  assert.equal(seq.messages.filter(m => m.type === 'call' && m.to === 'B').length, 1);
  assert.equal(seq.messages.filter(m => m.type === 'return' && m.from === 'B').length, 0);
  assert.equal(seq.messages.filter(m => m.type === 'continuation' && m.from === 'B').length, 1);
});

test('synthetic boundaries preserve callsite source and never manufacture sequence returns', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'),
    e('body_unavailable', 'A', 0, 'bb1', { callee: 'missing::B', source_location: 42 }),
    e('branch', 'A', 0, 'bb1', { branch: 'next' }),
    e('call', 'A', 0, 'bb2', { source_location: 75 }),
    e('opaque', 'A', 0, 'bb2'),
    e('branch', 'A', 0, 'bb2', { branch: 'next' }),
    e('return', 'A', 0, 'bb3')], { coveragePartial: true });
  const p = Waterfall.project(t), synthetic = p.bars.filter(bar => bar.synthetic);
  const seq = Waterfall.sequenceProject(t, p);
  assert.deepEqual(synthetic.map(bar => [bar.function, bar.start, bar.end, bar.source_location]),
    [['missing::B', 1, 1, 42], ['(unknown target)', 4, 4, 75]]);
  assert.equal(seq.messages.filter(m => m.type === 'opaque_call').length, 2);
  assert.equal(seq.messages.filter(m => m.type === 'continuation').length, 2);
  assert.equal(seq.messages.filter(m => m.type === 'return' &&
    (m.from === 'missing::B' || m.from === '(unknown target)')).length, 0);
  assert.equal(seq.activations.filter(a => a.synthetic).length, 2);
  assert.equal(Waterfall.aggregate([p]).weight, t.events.length);
});

test('Flow depth bounds retain the final recorded callee without duplicating entered bodies', () => {
  function node(path, blocks) {
    return { id: path, source_file: 'src/main.rs', source_location: 3,
      attributes: { kind: 'flow_function', path,
        flow: { version: 1, function: path, entry: 'bb0', blocks } } };
  }
  function call(callee) {
    return { id: 'bb0', kind: 'call', callee, source_file: 'src/main.rs',
      source_location: 42, successors: [{ target: 'bb1', label: 'next', kind: 'normal' }] };
  }
  const ret = id => ({ id, kind: 'return', successors: [] });
  const index = Flow.catalog({ nodes: [
    node('x::A', [call('x::B'), ret('bb1')]),
    node('x::B', [call('x::C'), ret('bb1')]),
    node('x::C', [ret('bb0')])
  ] });
  for (const [limit, names] of [[1, ['x::A', 'x::B']], [2, ['x::A', 'x::B', 'x::C']]]) {
    const result = Flow.explore(index, [], { root: 'x::A', maxDepth: limit });
    assert.equal(result.traces.length, 1);
    assert.match(result.traces[0].reasons.join(' '), /Call depth bound/);
    const p = Waterfall.project(result.traces[0]);
    assert.deepEqual(p.bars.map(bar => bar.function), names);
    assert.equal(p.bars.filter(bar => bar.synthetic).length, 1);
    const bounded = p.bars[p.bars.length - 1];
    assert.equal(bounded.outcome, 'unexpanded / bounded call');
    assert.equal(bounded.source_location, 42);
    assert.equal(bounded.start, bounded.end);
    const seq = Waterfall.sequenceProject(result.traces[0], p);
    assert.ok(seq.messages.some(m => m.to === bounded.function && /unexpanded/.test(m.label)));
    assert.equal(seq.messages.some(m => m.type === 'return'), false);
    assert.equal(Waterfall.orderedFrames(p).weight, p.steps);
  }
});

test('UML sequence matches repeated sibling calls to distinct activations and returns', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('return', 'B', 1, 'bb0'),
    e('call', 'A', 0, 'bb1'), e('enter', 'B', 1, 'bb0'),
    e('return', 'B', 1, 'bb0'), e('return', 'A', 0, 'bb2')]);
  const seq = Waterfall.sequenceProject(t);
  const calls = seq.messages.filter(m => m.type === 'call');
  const returns = seq.messages.filter(m => m.type === 'return');
  assert.deepEqual(seq.participants.map(p => p.id), ['A', 'B']);
  assert.deepEqual(calls.map(m => [m.from, m.to, m.step]),
    [['A', 'B', 2], ['A', 'B', 5]]);
  assert.deepEqual(returns.map(m => [m.from, m.to, m.step]),
    [['B', 'A', 3], ['B', 'A', 6]]);
  assert.notEqual(calls[0].activationId, calls[1].activationId);
  assert.deepEqual(returns.map(m => m.activationId), calls.map(m => m.activationId));
});

test('UML recursion uses one lifeline with nested distinct activation offsets', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'A', 1, 'bb0', { recursive: true }),
    e('return', 'A', 1, 'bb0'), e('return', 'A', 0, 'bb1')]);
  const seq = Waterfall.sequenceProject(t);
  assert.deepEqual(seq.participants.map(p => p.id), ['A']);
  assert.deepEqual(seq.activations.map(a => a.recursiveOffset), [0, 1]);
  assert.equal(seq.messages.find(m => m.type === 'call').from, 'A');
  assert.equal(seq.messages.find(m => m.type === 'return').to, 'A');
});

test('UML tail replacement and unwind do not invent a matched return', () => {
  const tail = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('tail_call', 'A', 0, 'bb0'), e('enter', 'B', 0, 'bb0'),
    e('return', 'B', 0, 'bb0')]));
  assert.ok(tail.messages.some(m => m.type === 'tail_call' && m.from === 'A' && m.to === 'B'));
  assert.equal(tail.messages.filter(m => m.type === 'return').length, 0);
  const unwind = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0'),
    e('unwind', 'B', 1, 'bb0'), e('return', 'A', 0, 'bb1')]));
  assert.ok(unwind.messages.some(m => m.type === 'unwind' && m.from === 'B' && m.to === 'A'));
  assert.equal(unwind.messages.some(m => m.type === 'return' && m.from === 'B'), false);
});

test('UML callback invocation differs from a callback reference', () => {
  const invoked = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', 'B', 1, 'bb0', { via: 'callback' }),
    e('return', 'B', 1, 'bb0'), e('return', 'A', 0, 'bb1')]));
  assert.equal(invoked.messages.find(m => m.type === 'call').label, 'callback invocation');
  const referenced = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0', { callback_reference: true }),
    e('opaque', 'A', 0, 'bb0', { label: 'Indirect or unknown callee' }),
    e('branch', 'A', 0, 'bb0', { branch: 'next', target: 'bb1' }),
    e('return', 'A', 0, 'bb1')]));
  assert.equal(referenced.messages.some(m => m.label === 'callback invocation'), false);
  assert.ok(referenced.messages.some(m => m.type === 'opaque_call' && m.to === '(unknown target)'));
  assert.ok(referenced.notes.some(n => /invocation not proven/.test(n.label)));
});

test('UML selected guards and observed loop revisits remain distinct', () => {
  const seq = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('branch', 'A', 0, 'bb0', { label: 'switch' }),
    e('branch', 'A', 0, 'bb0', { branch: 'true', target: 'bb0' }),
    e('goto', 'A', 0, 'bb0'), e('return', 'A', 0, 'bb1')]));
  assert.ok(seq.fragments.some(f => f.type === 'guard' && /selected true/.test(f.label)));
  assert.ok(seq.fragments.some(f => f.type === 'loop' && f.step === 3));
  assert.equal(seq.fragments.some(f => f.type === 'loop' && f.step === 2), false,
    'routing branch alone does not establish a loop revisit');
});

test('UML unknown bodies get opaque lifelines and recorded continuation only', () => {
  const named = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('body_unavailable', 'A', 0, 'bb0', { callee: 'external::B' }),
    e('branch', 'A', 0, 'bb0', { branch: 'next', target: 'bb1' }),
    e('return', 'A', 0, 'bb1')], { coveragePartial: true }));
  assert.ok(named.participants.some(p => p.id === 'external::B' && p.opaque));
  assert.ok(named.messages.some(m => m.type === 'opaque_call' && m.to === 'external::B'));
  assert.ok(named.messages.some(m => m.type === 'continuation' && m.from === 'external::B'));
  assert.equal(named.messages.some(m => m.type === 'return' && m.from === 'external::B'), false);
  const unknown = Waterfall.sequenceProject(trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('opaque', 'A', 0, 'bb0'),
    e('branch', 'A', 0, 'bb0', { branch: 'next', target: 'bb1' }),
    e('return', 'A', 0, 'bb1')]));
  assert.ok(unknown.participants.some(p => p.id === '(unknown target)' && p.opaque));
  assert.ok(unknown.messages.some(m => m.type === 'continuation' && m.from === '(unknown target)'));
});

test('UML variants remain separate ordered examples', () => {
  const variant = callee => trace([e('enter', 'A', 0, 'bb0'),
    e('call', 'A', 0, 'bb0'), e('enter', callee, 1, 'bb0'),
    e('return', callee, 1, 'bb0'), e('return', 'A', 0, 'bb1')]);
  const first = Waterfall.sequenceProject(variant('B'));
  const second = Waterfall.sequenceProject(variant('C'));
  assert.deepEqual(first.messages.filter(m => m.type === 'call').map(m => m.to), ['B']);
  assert.deepEqual(second.messages.filter(m => m.type === 'call').map(m => m.to), ['C']);
  assert.equal(first.participants.some(p => p.id === 'C'), false);
  assert.equal(second.participants.some(p => p.id === 'B'), false);
});

test('UML bound ends open activations without causal return or continuation', () => {
  const t = trace([e('enter', 'A', 0, 'bb0'), e('call', 'A', 0, 'bb0'),
    e('enter', 'B', 1, 'bb0'), e('goto', 'B', 1, 'bb0')],
  { reachedExit: false, complete: false, reasons: ['Step bound reached.'] });
  const seq = Waterfall.sequenceProject(t);
  assert.ok(seq.activations.every(a => a.outcome === 'open / truncated boundary'));
  assert.equal(seq.messages.filter(m => m.type === 'return' || m.type === 'continuation').length, 0);
  assert.equal(seq.notes.filter(n => /no recorded return/.test(n.label)).length, 2);
});

if (process.env.BUILD_GRAPH_FIXTURE_GRAPH) test('actual MIR traces project invoked callbacks and loop revisits', () => {
  const raw = fs.readFileSync(process.env.BUILD_GRAPH_FIXTURE_GRAPH);
  const data = JSON.parse(raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw);
  const index = Flow.catalog(data), entry = 'execution_flow_fixture::callback_entry';
  const invoked = 'execution_flow_fixture::invoke_callback';
  assert.ok(index.functions.has(entry) && index.functions.has(invoked));
  const result = Flow.explore(index, [entry], { root: entry, maxPaths: 200,
    maxSteps: 180, maxVisits: 2, maxDepth: 16 });
  assert.ok(result.traces.length > 0, result.diagnostics.join(' '));
  const projections = result.traces.map(Waterfall.project);
  assert.ok(projections.some(p => p.bars.some(b => b.via === 'callback') &&
    p.markers.some(m => m.type === 'callback')), 'proven callback invocation must create an activation');
  assert.ok(projections.some(p => p.bars.filter(b => b.function === invoked).length >= 2),
    'loop reinvocation must create distinct spans');
  assert.ok(projections.some(p => p.counts.loops > 0), 'revisited MIR block must have a loop marker');
  assert.ok(projections.some(p => !p.reachedExit && p.bars.some(b => b.outcome === 'open / truncated boundary')),
    'bounded path must show its open activation');
});
