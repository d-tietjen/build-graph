const test = require('node:test');
const assert = require('node:assert/strict');
const FlowMap = require('../src/flow-map.js');

const ev = (type, fn, block, context = fn, extra = {}) =>
  ({ type, function: fn, block, context, depth: 0, label: block, ...extra });
const trace = (events, complete = true) => ({ events, complete, reasons: [] });

test('shared continuations merge after branches while caller contexts remain distinct', () => {
  const entry = ev('enter', 'x::Entry', 'bb0');
  const left = ev('branch', 'x::Entry', 'bb0', 'x::Entry', { branch: 'left', target: 'bb1' });
  const right = ev('branch', 'x::Entry', 'bb0', 'x::Entry', { branch: 'right', target: 'bb2' });
  const join = ev('return', 'x::Entry', 'bb3');
  const map = FlowMap.build([trace([entry, left, join]), trace([entry, right, join])]);
  assert.equal(map.nodes.filter(n => n.event.block === 'bb3').length, 1);
  const joinId = map.nodes.find(n => n.event.block === 'bb3').id;
  assert.equal(map.edges.filter(e => e.to === joinId).length, 2);
  const callers = FlowMap.build([trace([ev('enter', 'x::Shared', 'bb0', 'x::A@bb1')]),
    trace([ev('enter', 'x::Shared', 'bb0', 'x::B@bb1')])]);
  assert.equal(callers.nodes.filter(n => n.event.type === 'enter').length, 2);
});

test('loop and recursion revisit a node and become typed backedges', () => {
  const loop = FlowMap.build([trace([ev('enter', 'x::Loop', 'bb0'),
    ev('branch', 'x::Loop', 'bb1'), ev('branch', 'x::Loop', 'bb1')], false)]);
  assert.equal(loop.nodes.filter(n => n.event.block === 'bb1').length, 1);
  assert.ok(loop.edges.some(e => e.kind === 'loop'));
  const recursion = FlowMap.build([trace([ev('enter', 'x::Entry', 'bb0'),
    ev('enter', 'x::Recur', 'bb0', 'x::Entry > x::Recur', { depth: 1, via: 'call' }),
    ev('enter', 'x::Recur', 'bb0', 'x::Entry > x::Recur', { depth: 2, via: 'call', recursive: true })], false)]);
  assert.ok(recursion.edges.some(e => e.kind === 'recursion'));
  const callbackLoop = FlowMap.build([trace([ev('enter', 'x::Callback', 'bb0', 'x::Loop > x::Callback', { via: 'callback' }),
    ev('branch', 'x::Loop', 'bb1'),
    ev('enter', 'x::Callback', 'bb0', 'x::Loop > x::Callback', { via: 'callback' })], false)]);
  assert.ok(callbackLoop.edges.some(e => e.kind === 'loop'));
  assert.ok(!callbackLoop.edges.some(e => e.kind === 'recursion'));
});

test('external callback targets are reference edges without an executed enter', () => {
  const map = FlowMap.build([trace([ev('enter', 'x::A', 'bb0'),
    ev('call', 'x::A', 'bb1', 'x::A', { callback_reference: true, callback_candidates: ['x::Callback'] }),
    ev('opaque', 'x::A', 'bb1')], false)], { functions: new Map([['x::Callback', {
    source_file: 'src/callback.rs', source_location: 7 }]]) });
  assert.ok(map.edges.some(e => e.kind === 'candidate'));
  assert.ok(map.nodes.some(n => n.event.type === 'candidate' && n.event.function === 'x::Callback'));
  assert.equal(map.nodes.find(n => n.event.type === 'candidate').event.source_file, 'src/callback.rs');
  assert.ok(!map.nodes.some(n => n.event.type === 'enter' && n.event.function === 'x::Callback'));
});

test('recorded exit stays distinct from partial body coverage and bounded endpoints', () => {
  const partial = trace([ev('enter', 'x::A', 'bb0'), ev('body_unavailable', 'x::A', 'bb1')], false);
  partial.reachedExit = true; partial.coveragePartial = true;
  const bounded = trace([ev('enter', 'x::B', 'bb0'), ev('opaque', 'x::B', 'bb1')], false);
  bounded.reachedExit = false;
  const map = FlowMap.build([partial, bounded]);
  const exit = map.nodes.find(n => n.event.type === 'exit');
  const boundary = map.nodes.find(n => n.event.type === 'boundary');
  assert.equal(exit.event.label, 'recorded exit');
  assert.equal(exit.event.coveragePartial, true);
  assert.ok(boundary);
  assert.ok(!map.nodes.some(n => n.event.type === 'incomplete'));
});

test('large shared map ranks without stack overflow and culls the viewport', () => {
  const events = Array.from({ length: 20000 }, (_, i) => ev('branch', 'x::Long', 'bb' + i,
    'x::Long', { branch: String(i), target: 'bb' + (i + 1) }));
  const map = FlowMap.layout(FlowMap.build([trace(events)]), { direction: 'lr' });
  assert.ok(map.nodeCount > 20000);
  assert.ok(map.width > 1000000);
  const visible = FlowMap.visible(map, { x: 0, y: 0, width: 1200, height: 800 }, 1000);
  assert.ok(visible.nodes.length + visible.edges.length <= 1000);
  assert.ok(visible.nodes.length > 0);
  const crossing = FlowMap.visible({ nodes: [{ id: 0, x: -2000, y: 50 }, { id: 1, x: 2000, y: 50 }],
    edges: [{ from: 0, to: 1, kind: 'loop' }] }, { x: 0, y: 0, width: 800, height: 200 }, 1000);
  assert.equal(crossing.nodes.length, 0);
  assert.equal(crossing.edges.length, 1);
  const crowded = { nodes: Array.from({ length: 300 }, (_, id) => ({
    id, x: 50, y: 50, event: { function: id === 299 ? 'x::Pinned' : 'x::Other' } })), edges: [] };
  const culled = FlowMap.visible(crowded, { x: 0, y: 0, width: 800, height: 200 },
    { limit: 40, pins: ['x::Pinned'] });
  assert.equal(culled.nodes.length, 20);
  assert.ok(culled.nodes.some(n => n.event.function === 'x::Pinned'));
  assert.equal(culled.limited, true);
});
