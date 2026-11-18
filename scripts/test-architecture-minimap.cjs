const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { minimapGeometry, cosmosViewport, nearestMinimapNode } =
  require('../src/architecture-organization.js');

const asymmetric = [{ id: 'low', x: 0, y: 0 }, { id: 'right', x: 100, y: 20 },
  { id: 'high', x: 25, y: 80 }];
const cpu = minimapGeometry(asymmetric, 220, 130, 8, false);
const gpu = minimapGeometry(asymmetric, 220, 130, 8, true);
assert(cpu.project(asymmetric[0]).y < cpu.project(asymmetric[2]).y, 'CPU y grows downward');
assert(gpu.project(asymmetric[0]).y > gpu.project(asymmetric[2]).y,
  'Cosmos space y is inverted to match the visible main pane');
for (const point of asymmetric) {
  const back = gpu.invert(gpu.project(point));
  assert(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9);
}
const camera = cosmosViewport(([x, y]) => [30 + 2 * x, 250 - 2 * y], 200, 100);
assert.deepEqual(camera, { x0: -15, y0: 75, x1: 85, y1: 125 },
  'affine inverse yields both viewport axes with negative Cosmos y slope');
const miniRect = gpu.viewport({ x0: 0, y0: 0, x1: 100, y1: 80 });
assert(miniRect.width > 0 && miniRect.height > 0);
assert.equal(nearestMinimapNode(asymmetric, { x: 94, y: 23 }).id, 'right');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'viewer.html'), 'utf8');
const begin = html.indexOf('function mountArchitectureMinimap(stage, hooks) {');
const end = html.indexOf('// The writer bakes in the filename', begin);
assert(begin >= 0 && end > begin);
const frames = [], windowEvents = new Map();
let now = 0, reads = 0, viewport = { x0: 0, y0: 0, x1: 100, y1: 80 };
const navigations = [];
function element(tag) {
  const listeners = new Map();
  const commands = [];
  const ctx = new Proxy({ commands }, { get(target, key) {
    return key in target ? target[key] : (...args) => commands.push([key, ...args]);
  } });
  return {
    tag, children: [], listeners, commands, hidden: false,
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
    setAttribute() {},
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 220, height: 130 }; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    setPointerCapture() {}, releasePointerCapture() {}
  };
}
const stage = element('stage');
const context = {
  ArchitectureOrganization: { minimapGeometry },
  ARCH_MINIMAP: null, KIND_COLORS: { function: '#fff' }, DEFAULT_COLOR: '#fff',
  document: { createElement: element },
  window: { addEventListener(name, fn) { windowEvents.set(name, fn); },
    removeEventListener(name) { windowEvents.delete(name); } },
  performance: { now() { return now; } },
  requestAnimationFrame(fn) { frames.push(fn); }
};
vm.runInNewContext(html.slice(begin, end), context);
const map = context.mountArchitectureMinimap(stage, {
  positions() { reads++; return { low: { x: 0, y: 0 }, high: { x: 25, y: 80 } }; },
  viewport() { return viewport; },
  navigate(point) { navigations.push(point); },
  focusId() { return 'high'; }
});
const root = stage.children[0], base = root.children[1], overlay = root.children[2];
map.setGraph({ nodes: [{ id: 'low', kind: 'function' }, { id: 'high', kind: 'function' }] });
while (frames.length) frames.shift()();
assert.equal(reads, 1);
assert.equal(base.commands.filter(command => command[0] === 'fillRect').length, 3,
  'cached overview draws background and every node regardless of selection');
const firstViewport = overlay.commands.filter(command => command[0] === 'strokeRect').at(-1);
viewport = { x0: 20, y0: 10, x1: 50, y1: 40 };
map.refreshViewport();
assert.equal(reads, 1, 'camera changes redraw only the viewport, not all GPU positions');
assert.notDeepEqual(overlay.commands.filter(command => command[0] === 'strokeRect').at(-1),
  firstViewport, 'viewport rectangle follows camera pan and zoom');
map.refreshPositions(false);
assert.equal(frames.length, 0, 'GPU position samples are throttled during simulation');
now = 600; map.refreshPositions(false);
while (frames.length) frames.shift()();
assert.equal(reads, 2);
const event = { clientX: 110, clientY: 65, pointerId: 1, stopPropagation() {} };
overlay.listeners.get('pointerdown')(event);
assert.equal(navigations.length, 1);
overlay.listeners.get('pointermove')(event);
assert.equal(navigations.length, 1, 'drag navigation is throttled');
now = 700; overlay.listeners.get('pointermove')(event);
assert.equal(navigations.length, 2);
overlay.listeners.get('pointerup')(event);
assert.equal(navigations.length, 3, 'drag release reaches its final destination');
map.setActive(false);
assert.equal(root.hidden, true, 'minimap hides outside Architecture');
overlay.listeners.get('pointerdown')(event);
assert.equal(navigations.length, 3, 'hidden minimap cannot navigate');
map.destroy();
assert(root.removed && !windowEvents.has('resize'));
const replacement = context.mountArchitectureMinimap(stage, {
  positions() { return {}; }, viewport() { return viewport; }, navigate() {}
});
assert.equal(stage.children.filter(child => !child.removed).length, 1,
  'GPU fallback mounts one minimap rather than leaving a duplicate');
replacement.destroy();

console.log('architecture minimap geometry and behavior: ok');
