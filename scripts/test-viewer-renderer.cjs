#!/usr/bin/env node
// Exercise the Architecture GPU adapter with the Cosmos v1 setData/zoom/simulation contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'viewer.html'), 'utf8');
const refreshFunctionFocusStart = '\nfunction refreshFunctionFocus(';
const supplyBegin = html.indexOf('function supplyGraphVisibility(graph, scopeIds, focusIds) {');
const supplyEnd = html.indexOf(refreshFunctionFocusStart, supplyBegin);
assert.ok(supplyBegin >= 0 && supplyEnd > supplyBegin, 'supply visibility helper found');
const supplyHelper = html.slice(supplyBegin, supplyEnd);
const begin = html.indexOf('function bootCosmos(Graph) {');
const end = html.indexOf('// ---- CPU fallback', begin);
assert.ok(begin >= 0 && end > begin, 'GPU renderer source found');
const highlightStart = 'var ENTRY_EFFECT_ACTIVE = null, ENTRY_EFFECT_HIGHLIGHT_OWNER = null, ENTRY_EFFECT_HIGHLIGHT_CATALOG = 0;';
const highlightEnd = 'function setupEntryEffectsUI(query) {';
const highlightBegin = html.indexOf(highlightStart), highlightFinish = html.indexOf(highlightEnd, highlightBegin);
assert.ok(highlightBegin >= 0 && highlightFinish > highlightBegin, 'complete shared highlight lease source found');
assert.equal(highlightBegin, html.lastIndexOf(highlightStart), 'shared highlight globals have a unique boundary');
assert.equal(highlightFinish, html.lastIndexOf(highlightEnd), 'shared highlight helpers have a unique end boundary');
const highlightHelper = 'var SIDEBAR_NAV = null;\n' + html.slice(highlightBegin, highlightFinish);
for (const signature of ['function ownsEntryEffectHighlight(owner) {', 'function claimEntryEffectHighlight(actor, generation, panel) {',
  'function resetEntryEffectHighlight() {', 'function applyEntryEffectHighlight(result, owner) {'])
  assert.ok(highlightHelper.includes(signature), `actual shared lease definition found: ${signature}`);

function makeRenderer(fieldOverride) {
  const frames = [], timers = [], fits = [], details = [], buttons = new Map();
  const field = fieldOverride || { nodes: [{ id: 'field', kind: 'function', x: 1, y: 2 }], links: [] };
  const functions = { nodes: [{ id: 'fn', kind: 'function', x: 3, y: 4 }], links: [] };
  const stage = { firstChild: null, insertBefore() {}, appendChild() {} };
  const canvas = { addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0 }; } };
  const overlay = { textContent: '', style: {} };
  const context = {
    Graph: class {
      constructor(_canvas, config) { this.config = config; this.zoom = 1; this.starts = 0;
        this.linkCallbackRefreshes = 0; this.nodeCallbackRefreshes = 0; this.dataCalls = []; context.graph = this; }
      setData(nodes, links, runSimulation = true) {
        this.nodes = nodes; this.links = links; this.dataCalls.push({ runSimulation, positions: nodes.map(n => [n.x, n.y]) });
        this.nodeColors = nodes.map(n => this.config.nodeColor(n));
        this.linkColors = links.map(l => this.config.linkColor(l));
        if (runSimulation) this.start();
      }
      setConfig(config) {
        const nodeChanged = config.nodeColor && config.nodeColor !== this.config.nodeColor;
        const linkChanged = config.linkColor && config.linkColor !== this.config.linkColor;
        for (const key of ['linkColor', 'linkWidth'])
          if (config[key] && config[key] !== this.config[key]) this.linkCallbackRefreshes++;
        Object.assign(this.config, config);
        if (nodeChanged) { this.nodeCallbackRefreshes++; this.nodeColors = this.nodes.map(n => config.nodeColor(n)); }
        if (linkChanged) this.linkColors = this.links.map(l => config.linkColor(l));
      }
      getNodePositions() { return Object.fromEntries(this.nodes.map(n => [n.id, { x: n.x, y: n.y }])); }
      getZoomLevel() { return this.zoom; }
      zoomToNodeById(id, duration, scale, canZoomOut) {
        this.navigation = { id, duration, scale, canZoomOut };
      }
      fitView() { fits.push({ kind: 'all', nodes: this.nodes.map(n => n.id) }); }
      fitViewByNodeIds(ids) { fits.push({ kind: 'selected', nodes: ids.slice() }); }
      start() { this.starts++; }
      pause() {}
      unselectNodes() { this.selected = null; }
      selectNodesByIds(ids) { this.selected = ids.slice(); }
    },
    document: {
      createElement() { return canvas; },
      getElementById(id) { return id === 'stage' ? stage : id === 'overlay' ? overlay : null; }
    },
    window: {},
    G: field, ARCH_FIELD_G: field, ARCH_FUNCTION_G: functions,
    ArchitectureOrganization: require('../src/architecture-organization.js'),
    ARCH_ORGANIZATION: 'field', ARCH_ACTIVE: true, ARCH_FOCUS_ID: null,
    ARCH_FUNCTION_LAYOUT: 'network', ARCH_LAYOUT_SELECT: null,
    ARCH_FUNCTION_POSITIONS: { network: new Map([['field', { x: 1, y: 2 }]]),
      radial: new Map([['field', { x: 50, y: 60 }]]),
      tree: new Map([['field', { x: 100, y: 200 }]]) },
    ARCH_PIN_ACTIVE: null,
    KIND_COLORS: { function: '#ffffff' }, DEFAULT_COLOR: '#ffffff', EDGE_COLORS: { call: '#ffffff' },
    architectureNodeColor() { return '#ffffff'; },
    sizeOf() { return 2; }, recordedPinAnalysis() { return false; },
    linkSourceId(l) { return l.source; }, linkTargetId(l) { return l.target; },
    architectureLinkEnabled(l) { return !context.ARCH_EDGE_FILTER || context.ARCH_EDGE_FILTER.has(l.cat); },
    architectureLinkDirected(l) { return l.cat !== 'struct' && l.cat !== 'contains'; },
    setEngine() {}, applyCosmosSeed() {}, hideDetail() {}, showDetail(id) { details.push(id); }, hideTip() {}, showTip() {},
    controlBar() { return { appendChild(button) { buttons.set(button.textContent, button); } }; },
    mkbtn(label, fn) { return { textContent: label, onclick: fn }; },
    mountArchitectureMinimap(_stage, hooks) {
      context.minimapHooks = hooks;
      return { setGraph() {}, setVisibleIds(ids) { context.minimapVisibleIds = ids; },
        refreshPositions() {}, refreshViewport() {}, setActive() {} };
    },
    mountUI(api) { context.api = context.UIAPI = api; }, openInitialFocus() {},
    requestAnimationFrame(fn) { frames.push(fn); },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
    performance: { now() { return 1000; } },
  };
  const helpersBegin = html.indexOf('function rememberFunctionPositions(layout) {');
  const helpersEnd = html.indexOf('function functionFocusIds()', helpersBegin);
  vm.runInNewContext(supplyHelper + html.slice(helpersBegin, helpersEnd), context);
  vm.runInNewContext(html.slice(html.indexOf('function architectureNodeColor(n) {'), html.indexOf('function esc(s) {')), context);
  vm.runInNewContext(highlightHelper, context);
  vm.runInNewContext(html.slice(begin, end) + '\nbootCosmos(Graph);', context);
  function runFrame() { while (frames.length) frames.shift()(); }
  function runTimer(delay) { const i = timers.findIndex(t => t.delay === delay); assert.ok(i >= 0, `timer ${delay} pending`); timers.splice(i, 1)[0].fn(); }
  function userZoom() { context.graph.config.events.onZoom(null, true); }
  function simulationEnd() { context.graph.config.simulation.onEnd(); }
  return { context, fits, details, buttons, runFrame, runTimer, userZoom, simulationEnd };
}

{
  const field = { nodes: [{ id: 'entry', kind: 'function', x: 1, y: 2 },
    { id: 'effect', kind: 'function', x: 3, y: 4 }, { id: 'other', kind: 'function', x: 5, y: 6 }],
    links: [{ source: 'entry', target: 'effect', cat: 'call' }, { source: 'entry', target: 'other', cat: 'call' }] };
  const r = makeRenderer(field), originalNodes = field.nodes, originalLinks = field.links;
  const actor = {}, owner = r.context.claimEntryEffectHighlight(actor, 1);
  assert.equal(owner.actor, actor); assert.equal(owner.generation, 1);
  assert.equal(owner.catalog, r.context.ENTRY_EFFECT_HIGHLIGHT_CATALOG);
  assert.equal(r.context.ownsEntryEffectHighlight(owner), true);
  function rejectsLease(lease, label) {
    const active = r.context.ENTRY_EFFECT_ACTIVE, nodeColor = r.context.graph.config.nodeColor, linkColor = r.context.graph.config.linkColor;
    const nodeColors = r.context.graph.nodeColors, linkColors = r.context.graph.linkColors;
    for (const result of [{ activeNodeIds: ['other'], activeEdgePairs: ['entry\tother'] }, null]) {
      r.context.applyEntryEffectHighlight(result, lease);
      assert.equal(r.context.ENTRY_EFFECT_ACTIVE, active, `${label} cannot write or clear shared membership`);
      assert.equal(r.context.graph.config.nodeColor, nodeColor, `${label} cannot refresh node colors`);
      assert.equal(r.context.graph.config.linkColor, linkColor, `${label} cannot refresh link colors`);
      assert.equal(r.context.graph.nodeColors, nodeColors); assert.equal(r.context.graph.linkColors, linkColors);
    }
  }
  const beforeNodeCallback = r.context.graph.config.nodeColor;
  const beforeLinkCallback = r.context.graph.config.linkColor;
  r.context.applyEntryEffectHighlight({ activeNodeIds: ['entry', 'effect'], activeEdgePairs: ['entry\teffect'] }, owner);
  assert.notEqual(r.context.graph.config.nodeColor, beforeNodeCallback, 'fresh wrapper refreshes Cosmos node color buffer');
  assert.notEqual(r.context.graph.config.linkColor, beforeLinkCallback, 'fresh wrapper refreshes Cosmos link color buffer');
  assert.deepEqual(r.context.graph.nodeColors, ['#ffffff', '#ffffff', '#30363d']);
  assert.deepEqual(r.context.graph.linkColors, ['#58a6ff', '#252b33']);
  assert.equal(field.nodes, originalNodes); assert.equal(field.links, originalLinks);
  rejectsLease(undefined, 'unowned caller');
  const nextOwner = r.context.claimEntryEffectHighlight(actor, 2);
  assert.equal(nextOwner.actor, actor); assert.equal(nextOwner.generation, 2);
  assert.equal(r.context.ownsEntryEffectHighlight(owner), false);
  r.context.applyEntryEffectHighlight({ activeNodeIds: ['entry', 'effect'], activeEdgePairs: ['entry\teffect'] }, nextOwner);
  rejectsLease(owner, 'stale generation lease');
  rejectsLease({ ...nextOwner }, 'copied actor/generation/catalog lease');
  r.context.applyEntryEffectHighlight(null, nextOwner);
  assert.deepEqual(r.context.graph.nodeColors, ['#ffffff', '#ffffff', '#ffffff']);
  assert.deepEqual(r.context.graph.linkColors, ['#ffffff', '#ffffff']);
  r.context.applyEntryEffectHighlight({ activeNodeIds: ['entry', 'effect'], activeEdgePairs: ['entry\teffect'] }, nextOwner);
  const catalog = nextOwner.catalog;
  r.context.resetEntryEffectHighlight();
  assert.equal(r.context.ENTRY_EFFECT_HIGHLIGHT_CATALOG, catalog + 1);
  assert.equal(r.context.ENTRY_EFFECT_HIGHLIGHT_OWNER, null); assert.equal(r.context.ENTRY_EFFECT_ACTIVE, null);
  assert.equal(r.context.ownsEntryEffectHighlight(nextOwner), false);
  assert.deepEqual(r.context.graph.nodeColors, ['#ffffff', '#ffffff', '#ffffff']);
  assert.deepEqual(r.context.graph.linkColors, ['#ffffff', '#ffffff']);
  rejectsLease(nextOwner, 'prior capture lease after reset');
  const freshOwner = r.context.claimEntryEffectHighlight(actor, 2);
  assert.equal(freshOwner.catalog, catalog + 1);
  r.context.applyEntryEffectHighlight({ activeNodeIds: ['entry', 'effect'], activeEdgePairs: ['entry\teffect'] }, freshOwner);
  assert.deepEqual(r.context.graph.nodeColors, ['#ffffff', '#ffffff', '#30363d']);
  assert.deepEqual(r.context.graph.linkColors, ['#58a6ff', '#252b33']);
  rejectsLease(nextOwner, 'prior capture lease after a fresh claim');
  assert.equal(field.nodes, originalNodes); assert.equal(field.links, originalLinks);
}

{
  const r = makeRenderer();
  r.runTimer(3000); r.runTimer(6000); r.runTimer(10000);
  const before = r.fits.length;
  r.userZoom(); // A user zooms out while the first Field layout is still building.
  r.simulationEnd(); r.runFrame();
  assert.equal(r.fits.length, before + 1, 'final Field fit follows the completed v1 simulation');
  assert.deepEqual(r.fits.at(-1).nodes, ['field']);
  r.simulationEnd(); r.runFrame();
  assert.equal(r.fits.length, before + 1, 'later zoom is not overridden by repeated completion events');
}

{
  const r = makeRenderer();
  r.context.switchArchitectureLayout('tree');
  r.runFrame();
  assert.equal(r.context.G, r.context.ARCH_FIELD_G, 'layout uses the canonical graph object');
  assert.equal(r.context.graph.dataCalls.at(-1).runSimulation, false,
    'Tree sends Cosmos static coordinates without starting force');
  assert.deepEqual(r.context.graph.dataCalls.at(-1).positions, [[100, 200]]);
  const before = r.fits.length;
  r.userZoom(); r.runFrame();
  assert.equal(r.fits.length, before, 'manual zoom after static layout fit stays untouched');
  r.context.switchArchitectureLayout('radial'); r.runFrame();
  assert.equal(r.context.graph.dataCalls.at(-1).runSimulation, false);
  assert.deepEqual(r.context.graph.dataCalls.at(-1).positions, [[50, 60]]);
  assert.deepEqual(r.fits.at(-1).nodes, ['field']);
  r.context.switchArchitectureLayout('network'); r.runFrame();
  assert.equal(r.context.graph.dataCalls.at(-1).runSimulation, true);
  assert.deepEqual(r.context.graph.dataCalls.at(-1).positions, [[1, 2]]);
  const afterNetwork = r.fits.length;
  r.userZoom(); r.runFrame();
  r.runTimer(4500); r.runFrame();
  assert.equal(r.fits.length, afterNetwork + 1,
    'current Network layout fits after settling even if the user zoomed during build');
  assert.deepEqual(r.fits.at(-1).nodes, ['field']);
}

{
  const r = makeRenderer();
  r.simulationEnd(); r.runFrame();
  const before = r.fits.length;
  r.userZoom();
  r.runTimer(3000); r.runTimer(6000); r.runTimer(10000);
  r.runFrame();
  assert.equal(r.fits.length, before, 'initial interim timers cannot override a post-completion zoom');
}

{
  const r = makeRenderer();
  assert.ok(r.context.graph.config.linkWidthScale >= 0.6, 'existing GPU links remain visible at overview fit');
  assert.equal(r.context.graph.config.linkArrows({ cat: 'native_call' }), true,
    'proven native calls retain direction');
  assert.equal(r.context.graph.config.linkArrows({ cat: 'struct' }), false,
    'structural links remain visually distinct from directed calls');
}

{
  const r = makeRenderer();
  const pinState = { nodeIds: new Set(['field']) };
  r.context.ARCH_PIN_ACTIVE = pinState;
  r.context.api.select(['field']);
  r.context.api.setSupplyChainScope(['field']);
  assert.deepEqual(Array.from(r.context.graph.selected), ['field'], 'GPU supply scope composes with existing selection');
  r.buttons.get('fit').onclick();
  assert.deepEqual(Array.from(r.fits.at(-1).nodes), ['field'], 'GPU fit button respects the scoped view');
  r.context.api.setSupplyChainScope([]);
  assert.deepEqual(Array.from(r.context.graph.selected), [], 'empty scope isolates every GPU node');
  assert.equal(r.context.graph.config.linkColor({ source: 'field', target: 'outside', cat: 'call' }),
    'rgba(0,0,0,0)', 'GPU hidden links have transparent color even when antialiased at zero width');
  r.context.graph.config.events.onNodeMouseOver({ id: 'field' });
  r.context.graph.config.events.onClick({ id: 'field' });
  assert.deepEqual(r.details, [], 'hidden GPU node cannot open detail');
  const before = r.fits.length;
  r.context.api.fitSelection();
  r.buttons.get('fit').onclick();
  assert.equal(r.fits.length, before, 'empty scope does not fit the unrelated full graph');
  r.context.api.setSupplyChainScope(null);
  assert.deepEqual(Array.from(r.context.graph.selected), ['field'], 'clearing scope restores prior selection');
  r.context.graph.config.events.onClick({ id: 'field' });
  assert.deepEqual(r.details, ['field'], 'visible GPU node remains selectable');
  assert.equal(r.context.ARCH_PIN_ACTIVE, pinState, 'scope changes preserve pin proof state');
}

{
  const field = { nodes: [{ id: 'field', kind: 'function', x: 1, y: 2 },
    { id: 'hidden', kind: 'function', x: 10, y: 20 }],
  links: [{ source: 'field', target: 'hidden', cat: 'call' }] };
  const r = makeRenderer(field);
  const pinState = { nodeIds: new Set(['hidden']) };
  r.context.ARCH_PIN_ACTIVE = pinState;
  r.context.api.select(['hidden']);
  r.context.api.setTreeVisibility(['field']);
  assert.deepEqual(Array.from(r.context.graph.selected), [],
    'GPU tree visibility masks a selected hidden node without changing selection state');
  assert.equal(r.context.graph.config.nodeSize(field.nodes[1]), 0);
  assert.equal(r.context.graph.config.nodeColor(field.nodes[1]), 'rgba(0,0,0,0)',
    'GPU alpha hides nodes even if Cosmos clamps zero size');
  assert.equal(r.context.graph.config.linkWidth(field.links[0]), 0);
  assert.equal(r.context.graph.config.linkColor(field.links[0]), 'rgba(0,0,0,0)');
  r.context.graph.config.events.onClick(field.nodes[1]);
  assert.deepEqual(r.details, [], 'hidden GPU node cannot be clicked');
  assert.deepEqual(Array.from(r.context.minimapVisibleIds), ['field']);
  r.buttons.get('fit').onclick();
  assert.deepEqual(Array.from(r.fits.at(-1).nodes), ['field'], 'GPU fit excludes hidden nodes');
  r.context.api.setTreeVisibility([]);
  assert.equal(r.context.graph.config.nodeColor(field.nodes[0]), 'rgba(0,0,0,0)');
  const before = r.fits.length;
  r.buttons.get('fit').onclick();
  assert.equal(r.fits.length, before, 'Hide all cannot fit hidden GPU data');
  r.context.api.setTreeVisibility(['field']);
  r.context.ARCH_FUNCTION_POSITIONS.tree = new Map([
    ['field', { x: 100, y: 200 }], ['hidden', { x: 300, y: 400 }]]);
  r.context.switchArchitectureLayout('tree');
  assert.deepEqual(Array.from(r.context.minimapVisibleIds), ['field'],
    'tree visibility survives GPU layout changes on the same graph');
  assert.equal(r.context.G, field, 'layout never swaps the canonical dataset');
  r.context.api.setTreeVisibility(['field', 'hidden']);
  const previousColor = r.context.graph.config.linkColor;
  const previousWidth = r.context.graph.config.linkWidth;
  const refreshed = r.context.graph.linkCallbackRefreshes;
  r.context.ARCH_EDGE_FILTER = new Set(); r.context.api.setConnectionVisibility();
  assert.notEqual(r.context.graph.config.linkColor, previousColor,
    'Cosmos receives a new color callback when connection visibility changes');
  assert.notEqual(r.context.graph.config.linkWidth, previousWidth,
    'Cosmos receives a new width callback when connection visibility changes');
  assert.equal(r.context.graph.linkCallbackRefreshes, refreshed + 2,
    'identity-cached link buffers refresh for both color and width');
  assert.equal(r.context.graph.config.linkWidth(field.links[0]), 0,
    'connection toggle hides the link without deleting its endpoints');
  assert.equal(field.links.length, 1, 'connection toggle never mutates canonical links');
  assert.equal(r.context.ARCH_PIN_ACTIVE, pinState, 'eye changes preserve AND-pin state');
}

{
  const r = makeRenderer();
  r.context.ARCH_FOCUS_ID = 'field';
  const pinState = { nodeIds: new Set(['field']), edgePairs: new Set() };
  r.context.ARCH_PIN_ACTIVE = pinState;
  r.context.api.select(['field']); r.context.api.setIsolation(true);
  r.context.graph.zoom = 2;
  r.context.minimapHooks.navigate({ x: 1, y: 2 }, [{ id: 'field', x: 1, y: 2 }]);
  assert.deepEqual(r.context.graph.navigation, { id: 'field', duration: 0, scale: 2, canZoomOut: true },
    'GPU minimap uses public nearest-node navigation at the existing zoom');
  assert.deepEqual(r.context.graph.selected, ['field'], 'minimap navigation does not change selection');
  assert.equal(r.context.graph.zoom, 2);
  const beforeStarts = r.context.graph.starts;
  r.context.switchArchitectureLayout('tree');
  const treeData = r.context.graph.dataCalls.at(-1);
  assert.equal(treeData.runSimulation, false, 'Cosmos v1 receives static setData for Tree');
  assert.deepEqual(treeData.positions, [[100, 200]], 'Tree coordinates reach the same canvas');
  assert.equal(r.context.graph.starts, beforeStarts, 'Tree never starts GPU force');
  assert.deepEqual(r.context.graph.selected, ['field'], 'Tree retains the focused function');
  assert.equal(r.context.ARCH_FOCUS_ID, 'field');
  assert.equal(r.context.ARCH_PIN_ACTIVE, pinState, 'Tree preserves AND-pin analysis state');
  r.runFrame();
  assert.equal(r.fits.at(-1).kind, 'selected', 'Tree auto-fits current isolation');
  const pauseButton = r.buttons.get('pause');
  pauseButton.onclick(); pauseButton.onclick();
  r.context.api.setActive();
  assert.equal(r.context.graph.starts, beforeStarts, 'resume/reactivation cannot start Tree force');
  r.context.switchArchitectureLayout('network');
  assert.equal(r.context.graph.dataCalls.at(-1).runSimulation, true);
  assert.deepEqual(r.context.graph.dataCalls.at(-1).positions, [[1, 2]],
    'Network restores its positions rather than using Tree coordinates');
  assert.deepEqual(r.context.graph.selected, ['field']);
  assert.equal(r.context.ARCH_PIN_ACTIVE, pinState, 'Network return preserves AND-pin analysis state');
  r.runFrame();
  assert.equal(r.fits.at(-1).kind, 'selected', 'Network switch also fits isolation');
  r.context.switchArchitectureLayout('tree');
  assert.equal(r.context.G, r.context.ARCH_FIELD_G, 'preset/layout round trips keep one graph object');
}

{
  const r = makeRenderer();
  r.context.switchArchitectureLayout('radial'); r.runFrame();
  r.context.switchArchitectureLayout('network'); r.runFrame();
  r.context.switchArchitectureLayout('tree'); r.runFrame();
  const before = r.fits.length;
  r.runTimer(4500); r.runFrame();
  assert.equal(r.fits.length, before, 'a stale Network completion cannot refit Tree');
}

{
  const r=makeRenderer(),starts=r.context.graph.starts,fits=r.fits.length;
  r.context.MEASUREMENT_HEAT={nodes:new Map([['field','#profile']]),edges:new Map()};r.context.api.refreshRouteEdges();assert.deepEqual(r.context.graph.nodeColors,['#profile']);
  r.context.MEASUREMENT_HEAT={nodes:new Map([['field','#benchmark']]),edges:new Map()};r.context.api.refreshRouteEdges();assert.deepEqual(r.context.graph.nodeColors,['#benchmark']);
  r.context.MEASUREMENT_HEAT=null;r.context.api.refreshRouteEdges();assert.deepEqual(r.context.graph.nodeColors,['#ffffff']);assert.equal(r.context.graph.starts,starts);assert.equal(r.fits.length,fits);
}

{
  const frames = [], baseRects = [], overlayEvents = new Map(), navigations = [];
  const baseCtx = new Proxy({}, { get(_target, key) {
    return key === 'fillRect' ? (...args) => baseRects.push(args) : () => {};
  } });
  const overlayCtx = new Proxy({}, { get() { return () => {}; } });
  let canvases = 0;
  const context = {
    Map,
    ArchitectureOrganization: require('../src/architecture-organization.js'),
    KIND_COLORS: { function: '#fff' }, DEFAULT_COLOR: '#fff',
    performance: { now() { return 1000; } }, requestAnimationFrame(fn) { frames.push(fn); },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { createElement(tag) {
      if (tag !== 'canvas') return { appendChild() {}, setAttribute() {}, remove() {} };
      const index = canvases++;
      return { width: 220, height: 130, className: '', setAttribute() {},
        getContext() { return index === 0 ? baseCtx : overlayCtx; },
        addEventListener(name, fn) { if (index === 1) overlayEvents.set(name, fn); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 220, height: 130 }; } };
    } }, ARCH_MINIMAP: null
  };
  const start = html.indexOf('function mountArchitectureMinimap(stage, hooks) {');
  const finish = html.indexOf('// The writer bakes in the filename', start);
  assert.ok(start >= 0 && finish > start);
  vm.runInNewContext(html.slice(start, finish), context);
  const mini = context.mountArchitectureMinimap({ appendChild() {} }, {
    positions() { return new Map([['a', { x: 10, y: 10 }], ['b', { x: 90, y: 80 }]]); },
    viewport() { return { x0: 0, y0: 0, x1: 100, y1: 100 }; },
    focusId() { return 'b'; }, navigate(_point, points) { navigations.push(Array.from(points, p => p.id)); }
  });
  mini.setGraph({ nodes: [{ id: 'a', kind: 'function' }, { id: 'b', kind: 'function' }] });
  while (frames.length) frames.shift()();
  assert.equal(baseRects.filter(rect => rect[2] === 1.6).length, 2);
  baseRects.length = 0;
  mini.setVisibleIds(['a']);
  assert.equal(baseRects.filter(rect => rect[2] === 1.6).length, 1,
    'minimap draws only eye-visible nodes');
  overlayEvents.get('pointerdown')({ stopPropagation() {}, pointerId: 1, clientX: 90, clientY: 80 });
  assert.deepEqual(navigations.at(-1), ['a'], 'minimap navigation ignores hidden nodes');
  mini.setVisibleIds([]);
  const before = navigations.length;
  overlayEvents.get('pointerdown')({ stopPropagation() {}, pointerId: 1, clientX: 90, clientY: 80 });
  assert.equal(navigations.length, before, 'Hide all disables minimap navigation');
}

async function verifyCPUColors() {
  const timers = [], fitted = [], minimapEvents = [];
  function element(tag) {return {tagName:tag,textContent:'',value:'',style:{},attributes:{},children:[],listeners:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.listeners[k]=v;},appendChild(v){this.children.push(v);return v;},replaceChildren(){this.children.length=0;}};}
  const measurementPanel=element('div');
  const canvasEvents = new Map(), details = [], drawnLines = [], drawnNodes = [];
  let forceStarts = 0;
  const field = { nodes: [{ id: 'field', kind: 'function', x: 1, y: 2 },
    { id: 'outside', kind: 'function', x: 20, y: 30 }],
  links: [{ source: 'field', target: 'outside', cat: 'call' }], byId: {} };
  const functions = { nodes: [{ id: 'fn', kind: 'function', x: 3, y: 4 }], links: [], byId: {} };
  field.byId.field = field.nodes[0]; field.byId.outside = field.nodes[1];
  functions.byId.fn = functions.nodes[0];
  const ctx = new Proxy({}, { get(target, key) {
    if (key === 'lineTo') return (...args) => { drawnLines.push(args); };
    if (key === 'arc') return (...args) => { drawnNodes.push({ color: target.fillStyle, args }); };
    return target[key] || (() => {});
  } });
  const canvas = { style: {}, addEventListener(name, fn) { canvasEvents.set(name, fn); },
    getContext() { return ctx; }, getBoundingClientRect() { return { left: 0, top: 0 }; } };
  const stage = { firstChild: null, clientWidth: 1000, clientHeight: 700, insertBefore() {}, appendChild() {} };
  const chain = new Proxy({}, { get(_target, key) { return key === 'tick' ? (() => {}) : (() => chain); } });
  class Transform {
    constructor(x = 0, y = 0, k = 1) { this.x = x; this.y = y; this.k = k; }
    translate(x, y) { return new Transform(this.x + x, this.y + y, this.k); }
    scale(k) { return new Transform(this.x, this.y, this.k * k); }
  }
  function zoom() { return zoom; }
  zoom.scaleExtent = zoom.on = () => zoom;
  zoom.transform = (_selection, transform) => fitted.push(transform);
  const context = {
    G: field, ARCH_FIELD_G: field, ARCH_FUNCTION_G: functions,
    ARCH_ORGANIZATION: 'field', ARCH_FUNCTION_LAYOUT: 'network', ARCH_ACTIVE: true,
    ARCH_FOCUS_ID: null, ARCH_LAYOUT_SELECT: null, ENTRY_EFFECT_ACTIVE: null,
    ARCH_FUNCTION_POSITIONS: { network: new Map([['field', { x: 1, y: 2 }], ['outside', { x: 20, y: 30 }]]),
      radial: new Map([['field', { x: 50, y: 60 }], ['outside', { x: 70, y: 80 }]]),
      tree: new Map([['field', { x: 100, y: 200 }], ['outside', { x: 300, y: 400 }]]) },
    document: { createElement(tag) { return tag==='canvas'?canvas:element(tag); }, getElementById(id) {
      return id === 'stage' ? stage : id === 'overlay' ? { style: {} } : id === 'measurements-content' ? measurementPanel : null;
    } },
    window: { devicePixelRatio: 1, addEventListener() {} },
    d3: {
      zoomIdentity: new Transform(), zoom() { return zoom; },
      select() { return { call(fn, arg) { fn(this, arg); return this; }, on() { return this; } }; },
      quadtree() { return { x() { return this; }, y() { return this; },
        addAll(items) { this.items = items; return this; },
        find() { return this.items[0] || null; } }; },
      forceSimulation() { forceStarts++; return chain; },
      forceLink() { return chain; }, forceManyBody() { return chain; },
      forceX() { return chain; }, forceY() { return chain; }
    },
    performance: { now() { return 0; } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
    setEngine() {}, showTip() {}, hideTip() {}, hideDetail() {}, showDetail(id) { details.push(id); },
    KIND_COLORS: { function: '#fff' }, DEFAULT_COLOR: '#fff', EDGE_COLORS: {},
    architectureNodeColor() { return '#fff'; },
    sizeOf() { return 2; }, recordedPinAnalysis() { return false; },
    linkSourceId(link) { return link.source; }, linkTargetId(link) { return link.target; },
    architectureLinkEnabled(link) { return !context.ARCH_EDGE_FILTER || context.ARCH_EDGE_FILTER.has(link.cat); },
    architectureLinkDirected(link) { return link.cat === 'call' || link.cat === 'native_call'; },
    controlBar() { return { appendChild() {} }; }, mkbtn(label) { return { textContent: label }; },
    mountArchitectureMinimap(_stage, hooks) {
      context.minimapHooks = hooks;
      return { setGraph() {minimapEvents.push('graph');}, setVisibleIds(ids) { context.minimapVisibleIds = ids; },
        refreshPositions() {minimapEvents.push('positions');}, refreshViewport() {minimapEvents.push('viewport');}, setActive() {} };
    },
    mountUI(api) { context.api = context.UIAPI = api; }, openInitialFocus() {}
  };
  const helpersBegin = html.indexOf('function rememberFunctionPositions(layout) {');
  const helpersEnd = html.indexOf('function functionFocusIds()', helpersBegin);
  const canvasBegin = html.indexOf('function bootCanvas() {');
  const canvasEnd = html.indexOf('var STARTED = false', canvasBegin);
  vm.runInNewContext(html.slice(html.indexOf('function architectureNodeColor(n) {'), html.indexOf('function esc(s) {')), context);
  vm.runInNewContext(supplyHelper + html.slice(helpersBegin, helpersEnd) + html.slice(canvasBegin, canvasEnd) +
    '\nbootCanvas();', context);
  context.switchArchitectureLayout('tree');
  const fitBefore = fitted.length;
  assert.equal(field.nodes[0].x, 100);
  assert(fitBefore > 1, 'CPU Tree fits after applying its positions');
  const currentScale = fitted.at(-1).k;
  context.minimapHooks.navigate({ x: 100, y: 200 });
  assert.equal(fitted.at(-1).k, currentScale, 'CPU minimap pans without changing zoom');
  assert.equal(fitted.at(-1).x, 500 - 100 * currentScale);
  assert.equal(fitted.at(-1).y, 350 - 200 * currentScale);
  while (timers.length) timers.shift().fn();
  assert.equal(forceStarts, 0, 'stale Field ticks cannot run in CPU Tree');
  context.api.setActive(false); context.api.setActive(true);
  assert.equal(forceStarts, 0, 'CPU Tree reactivation does not start force');
  context.ARCH_FOCUS_ID = 'field';
  context.api.select(['field']); context.api.setIsolation(true);
  const pinState = { nodeIds: new Set(['field']) };
  context.ARCH_PIN_ACTIVE = pinState;
  context.api.setSupplyChainScope(['field']);
  context.api.setSupplyChainScope([]);
  canvasEvents.get('mousemove')({ clientX: 0, clientY: 0 });
  canvasEvents.get('click')();
  assert.deepEqual(details, [], 'hidden CPU node is excluded from hit testing');
  const emptyFits = fitted.length;
  context.api.fitSelection();
  assert.equal(fitted.length, emptyFits, 'empty CPU scope does not fit the full graph');
  context.api.setSupplyChainScope(null);
  canvasEvents.get('mousemove')({ clientX: 0, clientY: 0 });
  canvasEvents.get('click')();
  assert.deepEqual(details, ['field'], 'visible CPU node remains selectable');
  context.api.fitSelection();
  assert(fitted.length > emptyFits, 'clearing CPU scope restores prior focus fit');
  assert.equal(context.ARCH_PIN_ACTIVE, pinState, 'CPU scope changes preserve pin proof state');
  context.switchArchitectureLayout('network');
  assert.equal(field.nodes[0].x, 1, 'CPU Network restores its own coordinates');
  assert(fitted.length > fitBefore, 'CPU layout switch fits the retained isolation');
  context.switchArchitectureLayout('tree');
  assert.equal(field.nodes[0].x, 100, 'CPU Tree positions survive a focused round trip');
  assert.equal(forceStarts, 0, 'focused layout switching does not start CPU force');
  drawnLines.length = 0;
  context.api.setTreeVisibility(['field']);
  assert.equal(drawnLines.length, 0, 'CPU drops an edge incident on a hidden node');
  assert.deepEqual(Array.from(context.minimapVisibleIds), ['field']);
  context.api.setTreeVisibility([]);
  const detailsBefore = details.length, fitsBefore = fitted.length;
  canvasEvents.get('mousemove')({ clientX: 0, clientY: 0 }); canvasEvents.get('click')();
  context.api.fitSelection();
  assert.equal(details.length, detailsBefore, 'hidden CPU nodes leave the hit tree');
  assert.equal(fitted.length, fitsBefore, 'Hide all cannot fit hidden CPU data');
  assert.equal(context.minimapVisibleIds.size, 0);
  context.api.clear(); context.api.setIsolation(false);
  drawnLines.length = 0;
  context.api.setTreeVisibility(['field', 'outside']);
  assert.ok(drawnLines.length > 0, 'Show all restores CPU incident edge drawing');
  drawnLines.length = 0;
  context.ARCH_EDGE_FILTER = new Set(); context.api.setConnectionVisibility();
  assert.equal(drawnLines.length, 0, 'CPU connection mask suppresses drawing');
  assert.equal(field.links.length, 1);
  assert.equal(context.ARCH_PIN_ACTIVE, pinState);
  context.ARCH_EDGE_FILTER = null; context.api.setConnectionVisibility();
  drawnNodes.length = 0;
  context.ENTRY_EFFECT_ACTIVE = { nodes: new Set(['field']), edges: new Set(['field\toutside']) };
  context.api.refreshRouteEdges();
  assert(drawnNodes.some(n => n.color === '#fff'), 'CPU route keeps selected callable color');
  assert(drawnNodes.some(n => n.color === '#30363d'), 'CPU route ghosts other callables without deleting them');
  context.ENTRY_EFFECT_ACTIVE = null; drawnNodes.length = 0; context.api.refreshRouteEdges();
  assert(!drawnNodes.some(n => n.color === '#30363d'), 'CPU route clear restores graph colors');
  assert.equal(field.nodes.length, 2); assert.equal(field.links.length, 1);

  // Start and finish an ordinary Network layout, then exercise the real import
  // panel against the real CPU renderer. No route or scope branch paints nodes.
  context.ARCH_FOCUS_ID=null;context.switchArchitectureLayout('network');
  while(timers.length)timers.shift().fn();assert.equal(forceStarts,1,'initial ordinary CPU layout finished');
  const F=require('../tests/fixtures/performance-measurements/fixture-graphs.cjs'),Measurements=require('../src/performance-measurements.js'),Evidence=require('../src/analysis-evidence.js');
  const q=F.request(),b=F.benchmark();b.target={nodeId:'outside'};
  q.input.sources=[{id:'bench',format:'generic-benchmark-v1',text:JSON.stringify({schemaVersion:1,benchmarks:[b]})},
    {id:'cpu',format:'folded-stacks-v1',unit:'samples',weightKind:'samples',text:'field-frame;outside-frame 1\nfield-frame 3\n',frameIdentities:{'field-frame':{target:{nodeId:'field'},inlined:false,provenance:'Explicit test identity'},'outside-frame':{target:{nodeId:'outside'},inlined:false,provenance:'Explicit test identity'}}}];
  const engine=Measurements.create({capture:{contentSha256:Evidence.digest(F.graph())},functions:()=>field.nodes.map(n=>({id:n.id})),edges:[{source:'field',target:'outside',kind:'call'}]});
  context.AnalysisSnapshot=require('../src/analysis-snapshot.js');
  const measurementBegin=html.indexOf('var SIDEBAR_NAV = null;');
  vm.runInNewContext(html.slice(measurementBegin,highlightBegin),context);
  const ui=context.setupMeasurementsUI(request=>engine.query(request),()=>{});
  const results=measurementPanel.children.find(e=>e.className==='sidebar-results');
  const dataset=results.children.flatMap(e=>e.children).find(e=>e.attributes['aria-label']==='Measured dataset');
  assert(dataset);const positions=field.nodes.map(n=>[n.x,n.y]),fits=fitted.length,minimap=minimapEvents.length,filter=new Set(['call']);
  context.ARCH_EDGE_FILTER=filter;
  const colors=()=>Object.fromEntries(field.nodes.map(n=>[n.id,drawnNodes.filter(p=>p.args[0]===n.x&&p.args[1]===n.y).at(-1).color]));
  drawnNodes.length=0;await ui.run(q);assert.deepEqual(colors(),{field:'rgb(255,70,40)',outside:'rgb(255,160,85)'},'import updates actual settled CPU fill colors');
  drawnNodes.length=0;dataset.value='benchmark:0';dataset.listeners.change();assert.deepEqual(colors(),{field:'#fff',outside:'rgb(255,70,40)'},'benchmark switch replaces actual CPU palette');
  drawnNodes.length=0;dataset.value='profile:0';dataset.listeners.change();assert.deepEqual(colors(),{field:'rgb(255,70,40)',outside:'rgb(255,160,85)'},'profile switch restores actual CPU palette');
  drawnNodes.length=0;ui.reset();assert.deepEqual(colors(),{field:'#fff',outside:'#fff'},'clear restores actual CPU kind colors');
  assert.deepEqual(field.nodes.map(n=>[n.x,n.y]),positions);assert.equal(fitted.length,fits);assert.equal(forceStarts,1);assert.equal(timers.length,0);assert.equal(minimapEvents.length,minimap);assert.equal(context.ARCH_PIN_ACTIVE,pinState);assert.equal(context.ARCH_EDGE_FILTER,filter);assert.deepEqual(Array.from(context.minimapVisibleIds),['field','outside']);
  await ui.run(q);const owner={nodes:new Set(['field']),edges:new Set(['field\toutside'])};context.ENTRY_EFFECT_ACTIVE=owner;drawnNodes.length=0;context.api.refreshRouteEdges();
  assert.deepEqual(colors(),{field:'rgb(255,70,40)',outside:'#30363d'},'independent route keeps measured membership and ghosts other nodes');
  drawnNodes.length=0;ui.reset();assert.equal(context.ENTRY_EFFECT_ACTIVE,owner);assert.deepEqual(colors(),{field:'#fff',outside:'#30363d'});
}
const pendingCPUColors=verifyCPUColors();

{
  const ArchitectureOrganization = require('../src/architecture-organization.js');
  const counts = { textContent: 'Field counts' };
  const endpointCalls = [];
  const detail = {
    innerHTML: '', style: {},
    querySelector(selector) {
      if (selector === '.close') return {};
      if (selector === '#function-actions')
        return { appendChild(button) { detail.actions.push(button); } };
      return { appendChild() {} };
    },
    actions: []
  };
  const context = {
    ArchitectureOrganization,
    ARCH_MODEL: null, ARCH_PIN_ANALYSIS: null, ARCH_PIN_ACTIVE: null, ARCH_ANALYSIS_KEY: '',
    ARCH_ORGANIZATION: 'field', ARCH_ORG_SELECT: null, ARCH_FOCUS_ID: null,
    ARCH_FUNCTION_LAYOUT: 'network', ARCH_FUNCTION_POSITIONS: { network: new Map(), tree: new Map() },
    ARCH_PROJECTION: null, ARCH_FUNCTION_G: null, SUPPLY_INDEX: null,
    STATE_UI: { pins: [], hasProcedure() { return true; } },
    FLOW_UI: { setCallEndpoint(kind, id) { endpointCalls.push([kind, id]); } },
    UIAPI: { fitSelection() {} },
    document: {
      getElementById(id) { return id === 'counts' ? counts : id === 'detail' ? detail : null; },
      createElement() { return { textContent: '', className: '' }; }
    },
    buildG(data) {
      const nodes = data.nodes.map(n => ({ id: n.id, label: n.label, kind: n.attributes.kind,
        crate: n.attributes.crate, source_file: n.source_file, source_location: n.source_location }));
      return { nodes, byId: Object.fromEntries(nodes.map(n => [n.id, n])),
        links: data.edges.map(e => ({ source: e.source, target: e.target, cat: e.relation === 'calls' ? 'call' : 'reference' })) };
    },
    installUnifiedGraph() {},
    refreshFunctionFocus() {},
    recordedPinAnalysis() { return !!context.ARCH_PIN_ANALYSIS; },
    esc(value) { return String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'); },
    mkbtn(label, onclick) { return { textContent: label, onclick }; }
  };
  function assertEndpointActions(id) {
    assert.deepEqual(detail.actions.map(button => button.textContent),
      ['Use as call-path start', 'Use as call-path destination'],
      'unavailable MIR allows only graph endpoints; no pin, entry-effect, ordered-path, flamegraph, UML, or execution-flow actions');
    endpointCalls.length = 0;
    detail.actions.forEach(button => button.onclick());
    assert.deepEqual(endpointCalls, [['from', id], ['to', id]],
      'actual buttons dispatch the projected endpoint ID with start/destination intent');
  }
  const projectBegin = html.indexOf('function setFunctionProjection(overview, model) {');
  const projectEnd = html.indexOf('function functionFocusIds()', projectBegin);
  const focusEnd = html.indexOf(refreshFunctionFocusStart, projectEnd);
  const detailBegin = html.indexOf('\nfunction showFunctionDetail(');
  const detailEnd = html.indexOf('\nfunction showDetail(', detailBegin);
  assert.ok(projectBegin >= 0 && projectEnd > projectBegin && focusEnd > projectEnd &&
    detailBegin >= 0 && detailEnd > detailBegin);
  const helpersBegin = html.indexOf('function rememberFunctionPositions(layout) {');
  const metadataBegin = html.indexOf('function supplyPackageType(pkg) {');
  const metadataEnd = html.indexOf('function supplyCaptureDescription(pkg)', metadataBegin);
  vm.runInNewContext(html.slice(metadataBegin, metadataEnd) +
    html.slice(projectBegin, projectEnd) + html.slice(helpersBegin, focusEnd) +
    html.slice(detailBegin, detailEnd), context);
  const overview = {
    nodes: [
      { id: 'body', kind: 'function', label: 'entry', crate: 'app', path: 'app::entry', x: 0, y: 0, flowPaths: ['app::entry'] },
      { id: 'boundary', kind: 'boundary', label: 'Uncaptured foo', crate: 'external',
        path: 'external::foo', calleeId: 'opaque-symbol-id',
        calleePaths: ['external::foo', 'external::foo::<T>'], x: 50, y: 50, flowPaths: [] },
      { id: 'method', kind: 'method', label: 'visit', crate: 'app', path: 'app::Selected::visit',
        x: 60, y: 70, flowPaths: ['app::Selected::visit'] },
      { id: 'native', kind: 'function', label: 'EVP_Digest', crate: 'crypto',
        path: 'native::EVP_Digest', language: 'native', body_status: 'native_disassembly',
        native_symbol: 'EVP_Digest', native_artifact: 'libcrypto.so',
        native_direct_calls: JSON.stringify([{ symbol: 'helper', evidence: 'disassembly' }]),
        native_call_diagnostics: '[]', native_call_coverage: 'partial',
        native_analysis_scope: 'direct call instructions only', x: 80, y: 80, flowPaths: [] },
      { id: 'ffiBoundary', kind: 'function', label: 'missing_native', crate: '',
        path: 'native:missing_native', display_path: 'missing_native', boundaryKind: 'native_symbol',
        native_boundary_kind: 'ffi_symbol', package_role: 'ffi_declaration',
        native_declaration_package_id: 'appPkg', native_abi: 'C', package_id: 'appPkg',
        language: 'native', body_status: 'unavailable', native_symbol: 'missing_native',
        x: 90, y: 90, flowPaths: [] }
    ],
    edges: [
      { source: 'body', target: 'boundary', kind: 'boundary', callsites: [{ id: 'call1' }] },
      { source: 'body', target: 'method', kind: 'candidate',
        referenceKind: 'trait_method_reference', callsites: [{ id: 'call1', source_file: 'src/lib.rs',
          source_location: 23, reference: { kind: 'trait_method_reference', index: 1,
            receiver_type: 'app::Selected', trait: 'app::Visitor', trait_id: 'opaque-trait-id',
            target_function_id: 'opaque-method-id' } }] },
      { source: 'body', target: 'native', kind: 'native_call', execution: true,
        callsites: [{ id: 'native-call', native_call: { symbol: 'EVP_Digest', abi: 'C', libraries: ['crypto'] } }] },
      { source: 'body', target: 'native', kind: 'call', execution: true,
        callsites: [{ id: 'other-call' }] },
      { source: 'body', target: 'ffiBoundary', kind: 'boundary', boundaryKind: 'native_symbol',
        callsites: [{ id: 'call2', native_call: { symbol: 'missing_native', abi: 'C', libraries: [] } }] }
    ],
    aliases: [['app::entry', 'body'], ['app::Selected::visit', 'method']],
    boundaryCallsites: [['call1', 'boundary'], ['call2', 'ffiBoundary']]
  };
  const model = { nodes: [{ id: 'block1', procedure: 'app::entry' }],
    calls: [{ id: 'call1', procedure: 'app::entry', from: 'block1' },
      { id: 'call2', procedure: 'app::entry', from: 'block1' }] };
  context.setFunctionProjection(overview, model);
  const boundary = context.ARCH_FUNCTION_G.byId.boundary;
  assert.equal(boundary.kind, 'boundary', 'boundary is not labeled as a captured function');
  assert.deepEqual(Array.from(boundary.flowPaths), [], 'boundary identity has no captured MIR procedure');
  assert.deepEqual(Array.from(boundary.calleePaths), ['external::foo', 'external::foo::<T>']);
  assert.equal(boundary.calleeId, 'opaque-symbol-id', 'opaque ID is retained for identity');
  assert.equal(context.ARCH_FUNCTION_G.links[0].cat, 'boundary', 'known named call has its own grey edge');
  assert.equal(context.ARCH_FUNCTION_G.links[1].cat, 'trait_reference',
    'trait capability reference has a distinct nonexecution edge');
  assert.equal(context.ARCH_FUNCTION_G.links.find(l => l.target === 'native').cat, 'native_call',
    'proven native call remains a directed execution edge');
  assert.deepEqual(context.ARCH_FUNCTION_G.links.filter(l => l.target === 'native').map(l => l.cat).sort(),
    ['call', 'native_call'], 'parallel alternatives to one target remain separate projected links');
  context.G = context.ARCH_FUNCTION_G;
  context.showFunctionDetail('boundary');
  assert.match(detail.innerHTML, /Body unavailable · named MIR callee/);
  assert.match(detail.innerHTML, /external::foo::&lt;T&gt;/);
  assert.doesNotMatch(detail.innerHTML, /opaque-symbol-id/, 'opaque ID is not shown as a human callee');
  assertEndpointActions(boundary.id);
  context.showFunctionDetail('method');
  assert.match(detail.innerHTML, /No captured callers/);
  assert.match(detail.innerHTML, /trait callback capability reference\(s\); invocation unproven/);
  assert.match(detail.innerHTML, /receiver app::Selected · trait app::Visitor/);
  assert.match(detail.innerHTML, /passed by app::entry at src\/lib\.rs:23/);
  assert.doesNotMatch(detail.innerHTML, /opaque-trait-id|opaque-method-id|index 1/);
  assert.equal(context.ARCH_PROJECTION.edges.find(e => e.target === 'method').execution, false);
  detail.actions = [];
  context.showFunctionDetail('native');
  assert.match(detail.innerHTML, /native\/system · package owner unknown/);
  assert.match(detail.innerHTML, /native disassembly captured · MIR unavailable/);
  assert.match(detail.innerHTML, /native symbol EVP_Digest/);
  assert.match(detail.innerHTML, /artifact libcrypto\.so/);
  assert.match(detail.innerHTML, /1 identified direct native call\(s\) from disassembly/);
  assert.match(detail.innerHTML, /partial native call scan; absence of identified calls does not prove no calls/);
  assert.match(detail.innerHTML, /scan scope: direct call instructions only/);
  assertEndpointActions(context.ARCH_FUNCTION_G.byId.native.id);
  detail.actions = [];
  context.showFunctionDetail('ffiBoundary');
  assert.match(detail.innerHTML, /FFI declaration · implementation unavailable/);
  assert.match(detail.innerHTML, /Rust declaration in exact package appPkg · native implementation package unknown/);
  assert.match(detail.innerHTML, /FFI symbol declaration · native implementation unavailable · MIR unavailable/);
  assert.match(detail.innerHTML, /ABI C/);
  assert.doesNotMatch(detail.innerHTML, /artifact libcrypto/,
    'Rust declaration package does not imply a native implementation artifact');
  assert.match(detail.innerHTML, /FFI symbol missing_native · ABI C/);
  assertEndpointActions(context.ARCH_FUNCTION_G.byId.ffiBoundary.id);
  context.STATE_UI.pins = ['app::entry'];
  context.ARCH_PIN_ANALYSIS = { status: 'exact' };
  context.ARCH_PIN_ACTIVE = ArchitectureOrganization.activeProjection(model,
    { activeNodeIds: ['block1'], activeCallTargets: [] }, context.ARCH_PROJECTION.aliases,
    context.ARCH_PROJECTION.boundaryCallsites);
  assert.deepEqual(Array.from(context.functionFocusIds()).sort(), ['body', 'boundary', 'ffiBoundary'],
    'active callsite keeps unavailable Rust/native callees visible without adding body proof');
  assert.equal(context.functionEdgeActive('body\tboundary'), true, 'boundary context edge stays visible');
  assert.equal(context.functionEdgeActive('body\tmethod'), false, 'trait reference is excluded from exact call proof');
  assert.equal(context.ARCH_PIN_ACTIVE.nodeIds.has('method'), false,
    'trait reference alone does not prove method execution');
  assert.equal(context.functionEdgeActive('body\tother'), false, 'unrelated edges stay filtered');
  detail.actions = [];
  context.showFunctionDetail('boundary');
  assert.match(detail.innerHTML, /1 functions on captured routes satisfying shared AND pins/);
  assert.match(detail.innerHTML, /2 named callees with unavailable bodies shown as callsite context/);
  assertEndpointActions(boundary.id);
}

{
  const begin = html.indexOf('function buildG(data) {');
  const end = html.indexOf('function mergeGraph(prev, next) {', begin);
  const catBegin = html.indexOf('function relCat(rel) {');
  const catEnd = html.indexOf('// Human label for a (relation, direction)', catBegin);
  const colorBegin = html.indexOf('function architectureNodeColor(n) {');
  const colorEnd = html.indexOf('function esc(s)', colorBegin);
  const metadataBegin = html.indexOf('function supplyPackageType(pkg) {');
  const metadataEnd = html.indexOf('function supplyCaptureDescription(pkg)', metadataBegin);
  const seedBegin = html.indexOf('function seedLayout(G) {');
  const seedEnd = html.indexOf('// Map the arbitrary-scale', seedBegin);
  assert.ok(begin >= 0 && end > begin && catBegin >= 0 && catEnd > catBegin &&
    colorBegin >= 0 && colorEnd > colorBegin && seedBegin >= 0 && seedEnd > seedBegin &&
    metadataBegin >= 0 && metadataEnd > metadataBegin);
  const counts = { textContent: '' };
  const context = { Map, Set, SUPPLY_INDEX: null, PALETTE: ['#fff'], KIND_COLORS: { function: '#ff7b72',
    package: '#a371f7', native_library: '#56d4dd' }, DEFAULT_COLOR: '#8b949e',
    document: { getElementById() { return counts; } },
    kindOf(n) { return n.attributes.kind; }, crateOf(n) { return n.attributes.crate || ''; },
    linkSourceId(l) { return l.sid || l.source; }, linkTargetId(l) { return l.tid || l.target; },
    buildSourceTree() { return []; } };
  vm.runInNewContext(html.slice(catBegin, catEnd) + html.slice(colorBegin, colorEnd) +
    html.slice(metadataBegin, metadataEnd) +
    html.slice(begin, end) + html.slice(seedBegin, seedEnd), context);
  const raw = { nodes: [
    { id: 'pkg-v1', label: 'serde', attributes: { kind: 'crate', crate: 'serde',
      package_id: 'registry#serde@1', version: '1.0.0', workspace_member: 'false' } },
    { id: 'pkg-v2', label: 'serde', attributes: { kind: 'crate', crate: 'serde',
      package_id: 'registry#serde@2', version: '2.0.0', workspace_member: 'false' } },
    { id: 'rich', label: 'run', attributes: { kind: 'function', crate: 'serde' } },
    { id: 'flow-rich', label: 'run', attributes: { kind: 'flow_function', crate: 'serde',
      package_id: 'registry#serde@1', symbol_id: 'rich', path: 'pkg1::run', display_path: 'serde::run' } },
    { id: 'closure', label: '{closure#0}', attributes: { kind: 'flow_function', crate: 'serde',
      package_id: 'registry#serde@1', symbol_id: 'rich', path: 'pkg1::run::{closure#0}' } },
    { id: 'flow-only', label: 'visit', attributes: { kind: 'flow_function', crate: 'serde',
      package_id: 'registry#serde@2', path: 'pkg2::visit', display_path: 'serde::visit' } },
    { id: 'lib', label: 'libcrypto.so', attributes: { kind: 'native_library', crate: '',
      native_artifact: 'libcrypto.so' } },
    { id: 'native', label: 'EVP_Digest', attributes: { kind: 'function', crate: '',
      language: 'native', native_symbol: 'EVP_Digest', native_artifact: 'libcrypto.so',
      body_status: 'native_disassembly',
      native_direct_calls: JSON.stringify([{ symbol: 'internal_helper', evidence: 'disassembly' }]),
      native_call_diagnostics: JSON.stringify([{ symbol: 'indirect' }]),
      native_call_coverage: 'partial', native_analysis_scope: 'direct instructions',
      native_instruction_set_status: 'recognized' } },
    { id: 'ffi', label: 'missing_native', attributes: { kind: 'function', crate: 'libc',
      language: 'native', body_status: 'unavailable', native_boundary_kind: 'ffi_symbol',
      package_role: 'ffi_declaration', native_declaration_package_id: 'registry#serde@1',
      package_id: 'registry#serde@1', native_symbol: 'missing_native', native_abi: 'C' } }
  ], edges: [
    { source: 'pkg-v1', target: 'pkg-v2', relation: 'depends_on' },
    { source: 'pkg-v2', target: 'flow-only', relation: 'contains' },
    { source: 'pkg-v1', target: 'flow-rich', relation: 'contains' },
    { source: 'rich', target: 'flow-rich', relation: 'has_flow' },
    { source: 'flow-rich', target: 'flow-only', relation: 'calls' },
    { source: 'rich', target: 'flow-only', relation: 'calls' },
    { source: 'flow-rich', target: 'native', relation: 'native_calls' },
    { source: 'flow-rich', target: 'ffi', relation: 'native_calls' },
    { source: 'native', target: 'flow-only', relation: 'native_calls' },
    { source: 'pkg-v2', target: 'lib', relation: 'links_native' }
  ] };
  const graph = context.buildG(raw);
  assert.equal(graph.nodes.length, 8, 'rich-owned flow does not duplicate its callable node');
  assert.equal(graph.byId['flow-rich'], undefined);
  assert.equal(graph.byId.closure.flowOnly, true, 'closure sharing owner symbol stays distinct');
  assert.equal(graph.byId.rich.packageId, 'registry#serde@1',
    'authoritative flow link supplies exact owner where rich symbol lacks it');
  assert.equal(graph.byId.rich.displayPath, 'serde::run');
  assert.equal(graph.byId['flow-only'].flowOnly, true);
  assert.equal(graph.byId['flow-only'].displayPath, 'serde::visit');
  assert.equal(graph.byId['pkg-v1'].kind, 'package');
  assert.equal(graph.byId.lib.kind, 'native_library');
  assert.equal(graph.byId.native.language, 'native');
  assert.equal(context.packageDescription(graph.byId.ffi), 'FFI declaration · implementation unavailable');
  assert.match(context.declarationDescription(graph.byId.ffi),
    /Rust declaration in exact package registry#serde@1 · native implementation package unknown/);
  assert.equal(graph.byId.ffi.nativeArtifact, null,
    'FFI declaration has no inferred implementation artifact');
  assert.match(context.nativeEvidence(graph.byId.native), /1 identified direct native call\(s\).*1 recorded unresolved/);
  assert.match(context.nativeAnalysisDescription(graph.byId.native), /absence of identified calls does not prove no calls/);
  assert.match(context.nativeAnalysisDescription({ kind: 'native_library',
    nativeInstructionSetStatus: 'unsupported', nativeDiagnostic: 'ISA not decoded' }),
    /instruction set unsupported; native internal calls not analyzed · ISA not decoded/);
  assert.notEqual(graph.byId['pkg-v1'].layoutGroup, graph.byId['pkg-v2'].layoutGroup,
    'same-name versions seed in distinct exact package groups');
  context.seedLayout(graph);
  assert.notEqual(graph.byId['pkg-v1'].cax, graph.byId['pkg-v2'].cax);
  assert.equal(context.architectureNodeColor(graph.byId.native), '#ffa657');
  assert.equal(context.architectureNodeColor(graph.byId['pkg-v2']), '#a371f7');
  assert.equal(graph.links.filter(l => l.source === 'rich' && l.target === 'flow-only' && l.rel === 'calls').length,
    1, 'direct calls remain unique after flow-owner remapping');
  assert.ok(graph.links.some(l => l.source === 'rich' && l.target === 'native' && l.cat === 'native_call'));
  assert.ok(graph.links.some(l => l.source === 'native' && l.target === 'flow-only' && l.cat === 'native_call'));
  assert.ok(graph.links.some(l => l.source === 'pkg-v1' && l.target === 'pkg-v2' &&
    l.cat === 'dependency' && l.cross), 'same-name versions have distinct exact package boundaries');
  assert.ok(graph.links.some(l => l.source === 'pkg-v2' && l.target === 'lib' && l.cat === 'native_link'));
  assert.ok(graph.links.some(l => l.source === 'pkg-v1' && l.target === 'rich' && l.cat === 'contains'));
  assert.equal(graph.links.some(l => l.rel === 'has_flow'), false);
  assert.equal(graph.links.some(l => l.source === 'pkg-v1' && l.target === 'pkg-v2' && l.cat === 'call'), false,
    'Cargo dependency is not presented as a function call');
  const legacy = context.buildG({ nodes: [{ id: 'legacy', label: 'old',
    attributes: { kind: 'function', crate: 'old_crate' } }], edges: [] });
  context.seedLayout(legacy);
  assert.equal(legacy.nodes.length, 1, 'older captures without package/native metadata remain renderable');
  assert.equal(legacy.byId.legacy.layoutGroup, 'old_crate');
}

{
  const context = { Map, Set,
    linkSourceId(link) { return link.sid || link.source; },
    linkTargetId(link) { return link.tid || link.target; } };
  const keyBegin = html.indexOf('function edgeKey(l) {');
  const keyEnd = html.indexOf('function buildG(data) {', keyBegin);
  const mergeBegin = html.indexOf('function mergeGraph(prev, next) {');
  const mergeEnd = html.indexOf('function diffNeedsRenderer(diff)', mergeBegin);
  assert.ok(keyBegin >= 0 && keyEnd > keyBegin && mergeBegin >= 0 && mergeEnd > mergeBegin);
  vm.runInNewContext(html.slice(keyBegin, keyEnd) + html.slice(mergeBegin, mergeEnd), context);
  const node = id => ({ id, label: id, kind: 'function', crate: 'app', x: 1, y: 2 });
  const edge = (target, kind, cat, extra = {}) => ({ source: 'a', target, sid: 'a', tid: target,
    rel: 'calls', kind, cat, ...extra });
  const prior = { nodes: [node('a'), node('b'), node('opaque')], byId: {}, links: [
    edge('b', 'call', 'call', { execution: true }),
    edge('b', 'callback', 'candidate', { execution: true, uncertain: true }),
    edge('opaque', 'boundary', 'boundary', { bodyUnavailable: false })] };
  prior.nodes.forEach(item => { prior.byId[item.id] = item; });
  const next = { nodes: [node('a'), node('b'), node('opaque')], links: [
    edge('b', 'call', 'call', { execution: true, callsites: [{ id: 'direct' }] }),
    edge('b', 'callback', 'candidate', { execution: true, uncertain: true,
      callsites: [{ id: 'possible' }] }),
    edge('opaque', 'boundary', 'boundary', { execution: true, bodyUnavailable: true,
      native_call: { symbol: 'opaque' }, calleeAbi: 'C', callsites: [{ id: 'opaque-call' }] })] };
  next.nodes[0].architecturePath = 'app::a';
  const merged = context.mergeGraph(prior, next).graph;
  assert.equal(merged.links.length, 3);
  assert.notEqual(merged.links[0], merged.links[1],
    'same-pair direct and callback alternatives retain distinct live objects');
  assert.deepEqual(Array.from(merged.links.slice(0, 2), link => link.kind), ['call', 'callback']);
  assert.equal(merged.links[1].uncertain, true);
  assert.equal(merged.links[2].bodyUnavailable, true);
  assert.equal(merged.links[2].native_call.symbol, 'opaque');
  assert.equal(merged.links[2].calleeAbi, 'C');
  assert.equal(merged.byId.a.architecturePath, 'app::a');
}

pendingCPUColors.then(()=>console.log('viewer renderer contract: passed'),error=>{console.error(error);process.exitCode=1;});
