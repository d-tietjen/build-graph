const test = require('node:test');
const assert = require('node:assert/strict');
const View = require('../src/execution-model-view.js');

function procedure(id, blocks) {
  return { id, start: id + '@start', entry: id + '#' + blocks[0],
    nodeIds: [id + '@start', ...blocks.map(block => id + '#' + block), id + '@return'],
    crate: 'fixture', source_file: 'src/main.rs', source_location: 1 };
}
function nodesFor(p) {
  return p.nodeIds.map(id => ({ id, procedure: p.id, block: id.includes('#') ? id.split('#').pop() : null,
    kind: id.endsWith('@start') ? 'start' : id.endsWith('@return') ? 'return' : 'branch',
    label: id }));
}
function edge(id, from, to, kind = 'normal', callsite = null) {
  return { id, from, to, kind, label: kind, action: kind, callsite };
}

test('statechart layout keeps every state and transition, branch, loop, and separate entry region', () => {
  const a = procedure('bin::fixture::main', ['bb0', 'bb1', 'bb2']);
  const b = procedure('fixture::work', ['bb0']);
  const c = procedure('fixture::disconnected', ['bb0']);
  const model = { procedures: [a, b, c], nodes: [a, b, c].flatMap(nodesFor),
    edges: [
      edge('start-a', a.start, a.entry, 'start'),
      edge('branch-true', a.entry, a.id + '#bb1'),
      edge('branch-false', a.entry, a.id + '#bb2'),
      edge('loop', a.id + '#bb1', a.entry),
      edge('return-a', a.id + '#bb2', a.normalExit || a.id + '@return',
        'continuation', a.id + '#bb2@call'),
      edge('start-b', b.start, b.entry, 'start'),
      edge('return-b', b.entry, b.id + '@return', 'return'),
      edge('start-c', c.start, c.entry, 'start')],
    calls: [{ id: a.id + '#bb2@call', from: a.id + '#bb2', targets: [b.id], normal: ['return-a'], unwind: [] }],
    roots: { application: [a.id], disconnected: [c.id] }, counts: { procedures: 3, nodes: 11, edges: 8, calls: 1 } };
  const view = View.layout(model);
  assert.equal(view.procedures.length, 3);
  assert.equal(view.nodes.length, 11);
  assert.equal(view.edges.length, 8);
  assert.equal(view.layout.applicationProcedures, 2);
  assert.equal(view.layout.disconnectedProcedures, 1);
  assert.equal(a.section, 'application entry flow');
  assert.equal(c.section, 'disconnected or unknown entry');
  assert.ok(a.branchCount > 0 && a.loopCount > 0 && a.callCount === 1);
  assert.ok(view.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.ok(view.nodes.find(node => node.id === a.start).x < view.nodes.find(node => node.id === a.entry).x);
  assert.equal(view.edges.find(e => e.id === 'return-a').callsite, a.id + '#bb2@call');
  const groups = View.groupOverview(view);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), view.procedures.length);
  assert.ok(groups.some(group => group.title === a.id && group.representative === a.id));
  assert.ok(groups.some(group => group.section === 'disconnected or unknown entry' && group.count === 1));
});

test('an unequal-length acyclic join is not a loop; a selfedge has a visible arrow tip', () => {
  const p = procedure('bin::fixture::main', ['bb0', 'bb1', 'bb2', 'bb3']);
  const model = { procedures: [p], nodes: nodesFor(p), edges: [
    edge('start', p.start, p.entry, 'start'),
    edge('short', p.entry, p.id + '#bb1'),
    edge('long', p.entry, p.id + '#bb2'),
    edge('more', p.id + '#bb2', p.id + '#bb3'),
    edge('join', p.id + '#bb3', p.id + '#bb1'),
    edge('exit', p.id + '#bb1', p.id + '@return', 'return')],
  calls: [], roots: { application: [p.id], disconnected: [] }, counts: { procedures: 1 } };
  View.layout(model);
  assert.equal(p.loopCount, 0);
  assert.equal(model.edges.find(e => e.id === 'join').loopBack, undefined);
  const byId = new Map(model.nodes.map(n => [n.id, n]));
  for (const e of model.edges) {
    assert.ok(byId.get(e.to).x > byId.get(e.from).x, `acyclic edge ${e.id} advances right`);
  }
  const self = edge('self', p.id + '#bb3', p.id + '#bb3');
  model.edges.push(self);
  View.layout(model);
  assert.equal(p.loopCount, 1);
  assert.equal(self.loopBack, true);
  const state = model.nodes.find(n => n.id === p.id + '#bb3');
  const geometry = View.selfLoopGeometry(state, 1);
  assert.ok(geometry.x2 > state.x + 72, 'arrow tip is outside the rounded state');
  assert.ok(geometry.c2x > geometry.x2, 'loop curves outside the state before the tip');
});

test('group tiles retain every member identity for drill-down, including nonrepresentatives', () => {
  const model = { roots: { application: [] }, procedures: [
    { id: 'crate::plain', section: 'disconnected or unknown entry', crate: 'crate',
      stateCount: 5, transitionCount: 4, branchCount: 0, loopCount: 0 },
    { id: 'crate::branchy', section: 'disconnected or unknown entry', crate: 'crate',
      stateCount: 9, transitionCount: 11, branchCount: 2, loopCount: 1 }] };
  const groups = View.groupOverview(model);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].members, ['crate::plain', 'crate::branchy']);
  assert.equal(groups[0].representative, 'crate::branchy');
  assert.ok(groups[0].members.includes('crate::plain'));
});

test('minimap geometry covers every procedure and maps the camera viewport exactly', () => {
  const geometry = View.minimapGeometry([
    { x: -100, y: 20, width: 200, height: 100 },
    { x: 900, y: 720, width: 100, height: 80 }], 220, 130, 8);
  assert.deepEqual(geometry.bounds, { x: -100, y: 20, width: 1100, height: 780 });
  const first = geometry.project(-100, 20);
  const last = geometry.project(1000, 800);
  assert.ok(first.x >= 8 && first.y >= 8 && last.x <= 212 && last.y <= 122);
  const camera = { x: 40, y: -30, z: 0.8 };
  const viewport = geometry.viewport(camera, 800, 600);
  const topLeft = geometry.project(-camera.x / camera.z, -camera.y / camera.z);
  const bottomRight = geometry.project((800 - camera.x) / camera.z, (600 - camera.y) / camera.z);
  assert.deepEqual(viewport, { x: topLeft.x, y: topLeft.y,
    width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y });
  const center = geometry.invert((first.x + last.x) / 2, (first.y + last.y) / 2);
  assert.ok(Math.abs(center.x - 450) < 1e-9 && Math.abs(center.y - 410) < 1e-9);
});

function fakeExecutionDocument() {
  function element(tag) {
    const calls = [], listeners = {};
    const context = new Proxy({}, { get(_, key) { return (...args) => calls.push([key, ...args]); } });
    return { tag, calls, listeners, children: [], style: {}, classList: { add() {}, remove() {} },
      clientWidth: tag === 'canvas' ? 800 : 0, clientHeight: tag === 'canvas' ? 600 : 0,
      width: 0, height: 0, value: '', hidden: false,
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      replaceChildren() { this.children = []; }, setAttribute() {},
      addEventListener(name, fn) { listeners[name] = fn; },
      getContext() { return context; },
      getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 800, height: this.height || 600 }; },
      setPointerCapture() {}, releasePointerCapture() {} };
  }
  const ids = ['state-canvas', 'state-side', 'state-counts', 'state-status', 'state-render-counts',
    'state-pins', 'state-search', 'state-search-results', 'state-detail', 'state-reset',
    'state-fit-entries', 'state-fit-all'];
  const elements = Object.fromEntries(ids.map(id => [id, element(id === 'state-canvas' ? 'canvas' : 'div')]));
  const stage = element('div'); stage.appendChild(elements['state-canvas']);
  const doc = { getElementById(id) { return elements[id]; }, createElement: element };
  return { doc, elements, stage };
}

test('execution minimap caches the full world, follows the viewport, and opens tile mode into detail', () => {
  const { doc, elements, stage } = fakeExecutionDocument();
  const oldWindow = global.window; global.window = { devicePixelRatio: 1 };
  try {
    const view = View.mount(doc, () => {});
    const minimap = stage.children.find(child => child.className === 'execution-minimap');
    assert.ok(minimap && minimap.hidden);
    const [head, base, overlay] = minimap.children;
    const procedures = [
      { id: 'a', crate: 'fixture', section: 'application entry flow', x: 0, y: 0,
        width: 200, height: 100, nodeIds: [], stateCount: 0, transitionCount: 0, branchCount: 0, loopCount: 0 },
      { id: 'b', crate: 'fixture', section: 'disconnected or unknown entry', x: 1800, y: 1200,
        width: 200, height: 100, nodeIds: [], stateCount: 0, transitionCount: 0, branchCount: 0, loopCount: 0 }];
    const model = { procedures, nodes: [], edges: [], calls: [],
      roots: { application: ['a'], disconnected: ['b'] },
      counts: { procedures: 2, mirBlocks: 0, mirSuccessors: 0 },
      coverage: { unavailableCallees: 0, unresolvedCalls: 0, opaqueBlocks: 0, missingMirStubs: 0 },
      layout: { applicationProcedures: 1, disconnectedProcedures: 1, branchStates: 0, loopTransitions: 0 } };
    view.setData(model);
    assert.equal(base.calls.filter(call => call[0] === 'fillRect').length, 3,
      'background and both procedure regions are cached once on data change');
    view.activate(true);
    assert.equal(minimap.hidden, false);
    assert.ok(overlay.calls.some(call => call[0] === 'strokeRect'), 'detail viewport is visible');
    const baseDraws = base.calls.length;
    view.focus('b');
    assert.equal(base.calls.length, baseDraws, 'moving the camera does not redraw every region');
    const zoom = view.stats().camera.z;
    view.fitAll();
    assert.equal(view.stats().overviewMode, true);
    assert.match(head.textContent, /World map/);
    const before = overlay.calls.filter(call => call[0] === 'strokeRect').length;
    const event = (clientX, clientY) => ({ clientX, clientY, pointerId: 1, stopPropagation() {} });
    overlay.listeners.pointerdown(event(190, 110));
    assert.equal(view.stats().overviewMode, false, 'minimap click enters the actual procedure world');
    assert.equal(view.stats().camera.z, zoom, 'navigation retains zoom');
    assert.ok(overlay.calls.filter(call => call[0] === 'strokeRect').length > before);
    const x = view.stats().camera.x;
    overlay.listeners.pointermove(event(90, 40));
    assert.notEqual(view.stats().camera.x, x, 'dragging pans the camera');
    overlay.listeners.pointerup(event(90, 40));
    view.activate(false);
    assert.equal(minimap.hidden, true);
  } finally { global.window = oldWindow; }
});

test('procedure scope keeps model and pins intact while restricting browsing and marking boundary calls', () => {
  const { doc, elements, stage } = fakeExecutionDocument();
  const oldWindow = global.window; global.window = { devicePixelRatio: 1 };
  try {
    const view = View.mount(doc, () => {});
    const procedures = Array.from({ length: 32 }, (_, i) => ({
      id: 'p' + i, crate: 'fixture', section: 'disconnected or unknown entry',
      x: i * 300, y: 0, width: 200, height: 100, nodeIds: i ? [] : ['n0'],
      stateCount: i ? 0 : 1, transitionCount: 0, branchCount: 0, loopCount: 0 }));
    const model = { procedures,
      nodes: [{ id: 'n0', procedure: 'p0', x: 60, y: 70, block: 'bb0', kind: 'call', label: 'call' }],
      edges: [], calls: [{ id: 'c0', procedure: 'p0', from: 'n0', targets: ['p31'], unknown: true }],
      roots: { application: [], disconnected: ['p0'] },
      counts: { procedures: 32, mirBlocks: 1, mirSuccessors: 0 },
      coverage: { unavailableCallees: 0, unresolvedCalls: 1, opaqueBlocks: 0, missingMirStubs: 0 },
      layout: { applicationProcedures: 0, disconnectedProcedures: 32, branchStates: 0, loopTransitions: 0 } };
    view.setData(model); view.activate(true); view.pin('p31');
    view.setAnalysis({ status: 'exact', activeNodeIds: ['n0'], activeEdgeIds: [],
      activeCallIds: ['c0'], activeCallTargets: [] });
    const minimap = stage.children.find(child => child.className === 'execution-minimap');
    const [, base, overlay] = minimap.children;
    const baseRects = base.calls.filter(call => call[0] === 'fillRect').length;
    const allowed = procedures.slice(0, 31).map(p => p.id);
    view.setProcedureFilter(allowed);
    assert.equal(model.procedures.length, 32);
    assert.deepEqual(model.calls[0].targets, ['p31']);
    assert.equal(model.counts.procedures, 32);
    assert.deepEqual(view.pins, ['p31']);
    assert.equal(view.stats().status, 'exact');
    assert.deepEqual(view.stats().scope, { active: true, procedures: 31,
      outsideTargets: 1, unknownCallsites: 1, outsidePins: 1 });
    assert.match(elements['state-status'].textContent, /1 AND pins outside scope \(analysis covers full model\)/);
    assert.match(elements['state-pins'].children[0].textContent, /outside scope/);
    assert.match(elements['state-render-counts'].textContent, /1 targets outside scope/);
    assert.ok(elements['state-canvas'].calls.some(call => call[0] === 'fillText' && /outside scope: p31/.test(call[1])));
    assert.ok(elements['state-canvas'].calls.some(call => call[0] === 'fillText' && /body\/target unknown/.test(call[1])));
    assert.equal(base.calls.filter(call => call[0] === 'fillRect').length - baseRects, 33,
      'filtered minimap still draws all 32 regions and its background');
    view.fitAll();
    const group = view.stats().overviewTiles.find(tile => tile.kind === 'group');
    assert.equal(group.count, 31);
    const click = (target, x, y) => {
      const event = { clientX: x, clientY: y, pointerId: 1, stopPropagation() {} };
      target.listeners.pointerdown(event); target.listeners.pointerup(event);
    };
    click(elements['state-canvas'], group.x + 5, group.y + 5);
    assert.equal(view.stats().overviewView, 'members');
    assert.equal(view.stats().overviewTiles.filter(tile => tile.kind === 'member').length, 30);
    const next = view.stats().overviewTiles.find(tile => tile.title === 'Next →');
    click(elements['state-canvas'], next.x + 5, next.y + 5);
    assert.deepEqual(view.stats().overviewTiles.filter(tile => tile.kind === 'member').map(tile => tile.id), ['p30']);
    view.focus('p31');
    assert.equal(view.stats().overviewMode, true, 'an excluded procedure cannot be focused');
    const geometry = View.minimapGeometry(procedures, 220, 130, 8);
    const outside = geometry.project(procedures[31].x + 100, 50);
    click(overlay, outside.x, outside.y);
    assert.equal(view.stats().scope.procedures, 31, 'minimap navigation does not reset scope');
    click(elements['state-canvas'], 400, 300);
    assert.deepEqual(view.pins, ['p31'], 'excluded procedure cannot be hit on the detail canvas');
    view.setProcedureFilter([]);
    assert.equal(view.stats().scope.procedures, 0);
    assert.equal(view.stats().overviewMode, true);
    assert.deepEqual(view.stats().overviewTiles, []);
    assert.match(elements['state-render-counts'].textContent, /0 procedure regions/);
    assert.match(elements['state-search-results'].textContent, /No procedures in current scope/);
    assert.deepEqual(view.pins, ['p31']);
    view.setProcedureFilter(null);
    assert.equal(view.stats().scope.active, false);
    assert.equal(view.stats().scope.procedures, 32);
    assert.deepEqual(view.pins, ['p31']);
    assert.equal(view.stats().status, 'exact');
  } finally { global.window = oldWindow; }
});

test('FFI callsite names native boundary while retaining Rust normal and unwind continuations', () => {
  const { doc, elements } = fakeExecutionDocument();
  const oldWindow = global.window; global.window = { devicePixelRatio: 1 };
  try {
    const view = View.mount(doc, () => {});
    const p = procedure('app::invoke_native', ['bb0']);
    p.nodeIds.push(p.id + '@unwind');
    const callId = p.id + '#bb0@call';
    const model = { procedures: [p], nodes: nodesFor(p).concat({ id: p.id + '@unwind',
      procedure: p.id, block: null, kind: 'unwind', label: 'Unwind' }),
      edges: [edge('start', p.start, p.entry, 'start'),
        edge('normal', p.entry, p.id + '@return', 'continuation', callId),
        edge('unwind', p.entry, p.id + '@unwind', 'unwind', callId)],
      calls: [{ id: callId, procedure: p.id, from: p.entry, targets: [], unknown: true,
        nativeCall: { symbol: 'EVP_Digest', abi: 'C', libraries: ['crypto'] },
        nativeTargetIds: ['native:EVP_Digest'], calleeArtifact: 'libcrypto.so',
        normal: ['normal'], unwind: ['unwind'] }],
      roots: { application: [p.id], disconnected: [] },
      counts: { procedures: 1, mirBlocks: 1, mirSuccessors: 2 },
      coverage: { unavailableCallees: 1, unresolvedCalls: 0, opaqueBlocks: 0, missingMirStubs: 0 } };
    View.layout(model);
    view.setData(model); view.activate(true); view.focus(p.id);
    const labels = elements['state-canvas'].calls.filter(call => call[0] === 'fillText').map(call => call[1]);
    assert.ok(labels.some(label => /FFI EVP_Digest · ABI C · native MIR unavailable/.test(label)),
      'canvas marks the native symbol without claiming a C/MIR procedure: ' + JSON.stringify(labels));
    assert.equal(labels.some(label => /body\/target unknown/.test(label)), false,
      'known FFI boundary uses a specific label');
    assert.equal(model.procedures.length, 1, 'native target does not become a fabricated MIR procedure');
    assert.deepEqual(model.calls[0].normal, ['normal']);
    assert.deepEqual(model.calls[0].unwind, ['unwind']);
    const camera = view.stats().camera, block = model.nodes.find(node => node.id === p.entry);
    const event = { clientX: camera.x + block.x * camera.z,
      clientY: camera.y + block.y * camera.z, pointerId: 1, stopPropagation() {} };
    elements['state-canvas'].listeners.pointerdown(event);
    elements['state-canvas'].listeners.pointerup(event);
    const details = elements['state-detail'].children.map(child => child.textContent).join(' ');
    assert.match(details, /FFI callsite · symbol EVP_Digest · ABI C/);
    assert.match(details, /artifact libcrypto\.so/);
    assert.match(details, /1 normal and 1 unwind continuations remain at this Rust callsite/);
  } finally { global.window = oldWindow; }
});

test('value reference-effect evidence activates the actual renderer call-edge contract', async () => {
  const Analysis = require('../src/analysis-api.js'), F = require('../tests/fixtures/value-flow/fixture-graphs.cjs');
  const { raw, request } = F.referenceWrite(), value = await Analysis.create(raw).query(request);
  const steps = value.witnesses.items.flatMap(w => w.steps), calls = new Set(steps.map(s => s.callsiteId).filter(Boolean));
  const targets = new Set(steps.filter(s => s.callsiteId && s.target).map(s => s.callsiteId + '->' + s.target));
  assert(steps.some(s => s.kind === 'reference-return' && s.target === 'write'));
  assert(View.callEdgeActive('root#bb1@call', 'write', calls, targets));
  assert(!View.callEdgeActive('root#bb1@call', 'other', calls, targets));
  assert(!View.callEdgeActive('other-call', 'write', calls, targets));
});
