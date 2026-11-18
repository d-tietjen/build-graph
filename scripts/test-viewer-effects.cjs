/* Actual viewer worker/fallback, inventory interactions and API parity. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const Analysis = require('../src/analysis-api.js');
const { fixture, callable } = require('../tests/fixtures/entry-effects/fixture-graphs.cjs');
const src = path.join(__dirname, '..', 'src'), html = fs.readFileSync(path.join(src, 'viewer.html'), 'utf8');
const begin = html.indexOf('var FLOW_UI = null, STATE_UI = null, WATERFALL_UI = null;');
const end = html.indexOf('// ---- GPU renderer (Cosmos) ----', begin);
const modules = { 'flow-engine-source': 'execution-flow', 'flow-map-source': 'flow-map',
  'call-graph-source': 'call-graph', 'architecture-organization-source': 'architecture-organization',
  'execution-model-source': 'execution-model',
  'value-flow-source': 'value-flow', 'guard-obligations-source': 'guard-obligations', 'failure-obligations-source': 'failure-obligations', 'resource-risks-source': 'resource-risks', 'program-queries-source': 'program-queries', 'analysis-evidence-source': 'analysis-evidence', 'supply-chain-source': 'supply-chain', 'call-paths-source': 'call-paths', 'advisory-exposure-source': 'advisory-exposure', 'entry-effects-source': 'entry-effects', 'analysis-snapshot-source': 'analysis-snapshot', 'revision-comparison-source': 'revision-comparison',
  'performance-measurements-source': 'performance-measurements',
  'comment-search-source': 'comment-search',
  'test-candidates-source': 'test-candidates',
  'execution-model-view-source': 'execution-model-view', 'trace-waterfall-source': 'trace-waterfall' };
function element(tag = 'div') {
  return { tagName: tag, textContent: '', value: '', style: {}, children: [], attributes: {}, listeners: {},
    classList: { remove() {}, add() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    querySelectorAll() { return []; }, appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children.length = 0; } };
}
async function until(predicate, message = 'expected viewer entry/effect update') {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(predicate(), typeof message === 'function' ? message() : message);
}
function descendants(element) { return [element].concat(element.children.flatMap(descendants)); }
async function harness(useWorker, data = fixture(), options = {}) {
  const documentHtml = options.html || html;
  const elements = new Map(), blobs = new Map(), workers = new Set(), timers = new Set(); let ready = false;
  function schedule(callback, delay, ...args) {
    const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer); return timer;
  }
  function cancel(timer) { timers.delete(timer); clearTimeout(timer); }
  function get(id) {
    if (!elements.has(id)) { const el = element();
      if (modules[id]) {
        const expected = fs.readFileSync(path.join(src, modules[id] + '.js'), 'utf8');
        if (options.html) {
          const script = documentHtml.match(new RegExp('<script\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
          assert(script, 'emitted module: ' + id);
          assert.equal(script[1], expected, 'emitted module bytes: ' + id);
          el.textContent = script[1];
        } else el.textContent = expected;
      }
      elements.set(id, el); }
    return elements.get(id);
  }
  let refreshes = 0;
  const context = { TextEncoder, Uint8Array, Int32Array, setTimeout: schedule, clearTimeout: cancel, performance,
    document: { getElementById: get, createElement: element }, window: {},
    ARCH_PIN_ANALYSIS: null, ARCH_PIN_ACTIVE: null, ARCH_ANALYSIS_KEY: '', CALL_UI: null,
    UIAPI: { refreshRouteEdges() { refreshes++; } }, setFunctionProjection() {}, setFunctionAnalysis() {},
    setArchitectureActive() {}, ensureArchitecture() {} };
  for (const id of Object.keys(modules)) vm.runInNewContext(get(id).textContent, context);
  if (useWorker) {
    context.Blob = class { constructor(parts) { this.source = parts.join(''); } };
    context.URL = { createObjectURL(blob) { const key = 'blob:' + blobs.size; blobs.set(key, blob.source); return key; } };
    context.Worker = class {
      constructor(url) {
        this.terminated = false; workers.add(this);
        this.context = { self: { postMessage: data => setImmediate(() => this.onmessage && this.onmessage({ data: structuredClone(data) })) },
          TextEncoder, Uint8Array, Int32Array, setTimeout: schedule, clearTimeout: cancel };
        vm.runInNewContext(blobs.get(url), this.context);
      }
      postMessage(data) { const copied = structuredClone(data); setImmediate(() => { if (!this.terminated) this.context.self.onmessage({ data: copied }); }); }
      terminate() { this.terminated = true; this.onmessage = null; workers.delete(this); }
    };
  }
  const wiringBegin = documentHtml.indexOf('var FLOW_UI = null, STATE_UI = null, WATERFALL_UI = null;');
  const wiringEnd = documentHtml.indexOf('// ---- GPU renderer (Cosmos) ----', wiringBegin);
  assert(wiringBegin >= 0 && wiringEnd > wiringBegin, 'emitted viewer wiring');
  vm.runInNewContext(documentHtml.slice(wiringBegin, wiringEnd), context);
  let delayed = null, panelUI, emptyEntriesReady = false;
  const pending = [], setup = context.setupEntryEffectsUI;
  context.setupEntryEffectsUI = function (query) {
    panelUI = setup(request => {
      const actual = query(request); // Always cross the real worker/fallback boundary.
      actual.then(value => { if (request.op === 'entrypoints' && value.entries && value.entries.total === 0) emptyEntriesReady = true; }, () => {});
      if (!delayed || !delayed(request)) return actual;
      let resolve, reject;
      const gate = new Promise((a, b) => { resolve = a; reject = b; });
      pending.push({ request, resolve, reject });
      return Promise.all([actual, gate]).then(([result]) => result);
    });
    return panelUI;
  };
  context.STATE_UI = { pins: [], setData() {}, setAnalysis() {} };
  const inline = options.html && documentHtml.match(/<script\b[^>]*\bid="graph-data"[^>]*>([\s\S]*?)<\/script>/);
  const raw = inline ? inline[1] : JSON.stringify(data);
  if (options.html) {
    assert(inline, 'emitted inline capture');
    assert.deepEqual(JSON.parse(raw), data, 'emitted graph carries this capture identity');
    assert(!/\/\*__(?:GRAPH_DATA|ENTRY_EFFECTS_JS|EXECUTION_MODEL_JS|ARCHITECTURE_ORGANIZATION_JS)__\*\//.test(documentHtml), 'emitted placeholders replaced');
  }
  let ui;
  try {
    ui = context.setupFlowUI(raw, () => { ready = true; });
    await until(() => {
      const status = get('flow-status').textContent;
      if (/^Flow (?:catalog|worker) error:/.test(status)) throw new Error(status);
      return ready;
    }, () => 'viewer catalog initialization timed out: ' + get('flow-status').textContent);
    await until(() => descendants(get('entry-effects-content')).some(e => e.attributes['aria-label'] === 'Entries' && e.children.length > 1) ||
      options.allowEmptyEntries === true && emptyEntriesReady);
  } catch (error) {
    workers.forEach(worker => worker.terminate()); timers.forEach(clearTimeout); timers.clear(); blobs.clear();
    throw error;
  }
  return { ui, context, elements, raw, pending, dispose() { workers.forEach(worker => worker.terminate()); timers.forEach(clearTimeout); timers.clear(); blobs.clear(); }, defer(predicate) { delayed = predicate; }, get panelUI() { return panelUI; }, get refreshes() { return refreshes; }, get panel() { return get('entry-effects-content'); } };
}
function normalized(value) { return JSON.parse(JSON.stringify(value)); }
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} harness rejects catalog initialization failures`, async () => {
    await assert.rejects(harness(worker, { nodes: null, edges: [] }), {
      message: `Flow ${worker ? 'worker' : 'catalog'} error: graph requires nodes and edges arrays`
    });
  });

  test(`${worker ? 'worker' : 'fallback'} shares bounded versioned entry/effect and replay queries with API`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const inventory = await h.ui.queryEntryEffects({ op: 'entrypoints', page: { limit: 100 } });
    const main = inventory.entries.items.find(e => e.kind === 'binary'); assert(main);
    const request = { op: 'effectPaths', entryId: main.id, includePossible: false, page: { limit: 100 } };
    const browser = await h.ui.queryEntryEffects(request), agent = await api.query(request);
    for (const key of ['graph', 'versions', 'request', 'replay', 'provenance', 'entries', 'effects', 'nodes', 'edges', 'witnesses', 'coverage', 'finding', 'completion', 'semantics'])
      assert.deepEqual(normalized(browser[key]), agent[key], key + ' parity');
    assert(browser.activeNodeIds.includes('dep::read_input'));
    assert(browser.activeEdgePairs.length > 0);
    const replayed = await h.ui.queryEntryEffects({ op: 'replay', replay: browser.replay });
    assert.equal(replayed.replayed, true); assert.deepEqual(normalized(replayed.effects), agent.effects);
  });

  test(`${worker ? 'worker' : 'fallback'} snapshots selected-function requests and nested replay inputs at dispatch`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const request = { op: 'effectPaths', function: 'app::invoked', includePossible: false,
      page: { nodes: { limit: 1 } } };
    const original = normalized(request), agent = await api.query(original);
    const pending = h.ui.queryEntryEffects(request);
    request.function = 'missing-callable'; request.page.nodes.limit = 100;
    const browser = await pending;
    for (const key of ['graph', 'versions', 'request', 'replay', 'provenance', 'entries', 'effects', 'nodes', 'edges', 'witnesses', 'coverage', 'finding', 'completion', 'semantics'])
      assert.deepEqual(normalized(browser[key]), agent[key], key + ' snapshot parity');
    assert.deepEqual(normalized(browser.request), original);
    assert.equal(browser.nodes.limit, 1);
    assert(browser.effects.items.some(effect => effect.category === 'sensitive-data'));
    const replayRequest = { op: 'replay', replay: normalized(browser.replay) };
    const replayAgent = await api.query(normalized(replayRequest));
    const replayPending = h.ui.queryEntryEffects(replayRequest);
    replayRequest.replay.request.function = 'missing-callable';
    replayRequest.replay.request.page.nodes.limit = 100;
    replayRequest.replay.capture.contentSha256 = 'changed-after-dispatch';
    const replayed = await replayPending;
    assert.equal(replayed.replayed, true);
    for (const key of ['request', 'replay', 'entries', 'effects', 'nodes', 'edges', 'witnesses', 'finding', 'completion'])
      assert.deepEqual(normalized(replayed[key]), replayAgent[key], key + ' replay snapshot parity');
  });

  test(`${worker ? 'worker' : 'fallback'} rejects non-JSON requests through a promise`, async () => {
    const h = await harness(worker), cyclic = { op: 'effectPaths', function: 'app::invoked' };
    cyclic.page = cyclic;
    for (const request of [cyclic, { op: 'effectPaths', function: 'app::invoked', page: { nodes: { limit: 1n } } }]) {
      let pending;
      assert.doesNotThrow(() => { pending = h.ui.queryEntryEffects(request); });
      assert.equal(typeof pending.then, 'function');
      await assert.rejects(pending, { code: 'INVALID_REQUEST', message: 'request must be JSON serializable' });
    }
  });

  test(`${worker ? 'worker' : 'fallback'} inventory and graph selection show sources and ghost routes without modifying pins`, async () => {
    const h = await harness(worker);
    h.context.STATE_UI.pins = ['keep-this-pin'];
    const entrySelect = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Entries');
    const binaryOption = entrySelect.children.find(e => e.textContent.startsWith('binary'));
    assert(binaryOption, 'entry selection does not require function search');
    entrySelect.value = binaryOption.value; entrySelect.listeners.change();
    await until(() => h.context.ENTRY_EFFECT_ACTIVE && h.context.ENTRY_EFFECT_ACTIVE.nodes.has('dep::read_input'));
    assert.deepEqual(h.context.STATE_UI.pins, ['keep-this-pin']); assert(h.refreshes > 0);
    const links = descendants(h.panel).filter(e => e.tagName === 'a');
    assert(links.some(e => e.href.startsWith('vscode://file/fixtures/fixture.rs:')));
    assert(descendants(h.panel).some(e => /Structural routes only/.test(e.textContent)));
    const evidence = routeEvidence(h); assert(evidence);
    assert.match(JSON.stringify(evidence), /"replayRequest"/); assert.match(JSON.stringify(evidence), /"adapter"/);
    const clear = descendants(h.panel).find(e => e.textContent === 'Clear route highlight'); clear.listeners.click();
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    h.ui.selectEntryNode('api::exported_entry');
    await until(() => h.context.ENTRY_EFFECT_ACTIVE && h.context.ENTRY_EFFECT_ACTIVE.nodes.has('api::exported_entry'));
    const before = h.context.ENTRY_EFFECT_ACTIVE;
    h.ui.refresh(JSON.stringify({ nodes: [], edges: [] }));
    assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null, 'capture refresh removes completed route evidence');
    assert(before.nodes.size > 0);
    assert.deepEqual(h.context.STATE_UI.pins, ['keep-this-pin']);
  });
}

function routeEvidence(h) {
  return descendants(h.panel).filter(el => el.tagName === 'pre').map(el => JSON.parse(el.textContent))
    .find(evidence => evidence.request && evidence.request.op === 'effectPaths' &&
      evidence.replayRequest && evidence.replayRequest.op === 'replay') || null;
}
function noRoute(h) {
  assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
  assert.equal(routeEvidence(h), null);
}
function chooseBinary(h) {
  const select = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Entries');
  select.value = select.children.find(el => el.textContent.startsWith('binary')).value;
  select.listeners.change();
}
function category(h, value) {
  const select = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Effect category');
  select.value = value; select.listeners.change();
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 10)); }
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} clears category and node evidence synchronously across current errors`, async () => {
    const h = await harness(worker); chooseBinary(h);
    await until(() => routeEvidence(h));
    h.defer(() => true);
    category(h, 'network'); noRoute(h);
    assert.equal(h.panelUI.request.category, 'network');
    assert.deepEqual(h.pending.map(p => p.request.op).sort(), ['buildInventory', 'effectPaths', 'effects', 'entrypoints']);
    h.pending.find(p => p.request.op === 'effects').reject(new Error('current-inventory-error'));
    h.pending.find(p => p.request.op === 'effectPaths').reject(new Error('current-route-error'));
    h.pending.find(p => p.request.op === 'entrypoints').resolve();
    h.pending.find(p => p.request.op === 'buildInventory').resolve();
    await until(() => descendants(h.panel).some(el => /current-(?:inventory|route)-error/.test(el.textContent)));
    noRoute(h); assert.equal(h.panelUI.request, null);
    h.defer(null); category(h, '');
    await until(() => routeEvidence(h));
    h.defer(request => !!request.function);
    h.ui.selectEntryNode('missing-callable'); noRoute(h); assert.equal(h.panelUI.request, null);
    h.pending[h.pending.length - 1].reject(new Error('current-node-error'));
    await until(() => descendants(h.panel).some(el => /current-node-error/.test(el.textContent)));
    noRoute(h);
    h.defer(null); h.ui.selectEntryNode('app::invoked'); noRoute(h);
    await until(() => routeEvidence(h));
    assert.equal(h.panelUI.request.function, 'app::invoked');
    assert.equal(routeEvidence(h).request.function, 'app::invoked');
    assert(descendants(h.panel).some(el => /selected-function.*entry status unknown/.test(el.textContent)));
    assert(h.context.ENTRY_EFFECT_ACTIVE.nodes.has('app::invoked'));
    h.ui.selectEntryNode('missing-callable');
    await until(() => descendants(h.panel).some(el => /No captured callable/.test(el.textContent)));
    noRoute(h); assert.equal(h.panelUI.request, null);
  });

  test(`${worker ? 'worker' : 'fallback'} inventory paging preserves pending routes and stale success/error cannot replace current evidence`, async () => {
    const raw = fixture();
    for (let i = 0; i < 105; i++) raw.nodes.push(...callable('paging::' + i, 'paging', [], {
      declaration_visibility: 'default', external_visibility: 'private' }));
    const h = await harness(worker, raw); h.context.STATE_UI.pins = ['keep'];
    h.defer(request => request.op === 'effectPaths'); chooseBinary(h); noRoute(h);
    const pendingRoute = h.pending[0];
    const next = descendants(h.panel).find(el => el.textContent === 'Next entries'); assert(next);
    next.listeners.click(); pendingRoute.resolve();
    await until(() => routeEvidence(h));
    assert(h.context.ENTRY_EFFECT_ACTIVE.nodes.has('dep::read_input'), 'inventory paging did not cancel route');
    category(h, 'network'); noRoute(h); const staleSuccess = h.pending[h.pending.length - 1];
    category(h, 'filesystem'); noRoute(h); h.pending[h.pending.length - 1].resolve();
    await until(() => routeEvidence(h));
    const accepted = routeEvidence(h); assert.equal(accepted.request.category, 'filesystem');
    staleSuccess.resolve(); await settle(); assert.deepEqual(routeEvidence(h), accepted);
    category(h, 'network'); const staleError = h.pending[h.pending.length - 1];
    category(h, 'filesystem'); h.pending[h.pending.length - 1].resolve();
    await until(() => routeEvidence(h)); const latest = routeEvidence(h);
    staleError.reject(new Error('stale-category-error')); await settle();
    assert.deepEqual(routeEvidence(h), latest);
    assert(!descendants(h.panel).some(el => /stale-category-error/.test(el.textContent)));
    assert.deepEqual(h.context.STATE_UI.pins, ['keep']);
  });

  test(`${worker ? 'worker' : 'fallback'} capture/model replacement fences delayed route and node results`, async () => {
    const h = await harness(worker); chooseBinary(h); await until(() => routeEvidence(h));
    const oldSha = routeEvidence(h).graph.contentSha256;
    h.defer(request => request.op === 'effectPaths' || !!request.function);
    category(h, 'network'); const oldRoute = h.pending[h.pending.length - 1];
    h.ui.selectEntryNode('app::main'); const oldNode = h.pending[h.pending.length - 1]; noRoute(h);
    const replacement = fixture();
    replacement.nodes[0].attributes.entry_effects = replacement.nodes[0].attributes.entry_effects.replace('1.0', '2.0');
    h.defer(null); h.ui.refresh(JSON.stringify(replacement)); noRoute(h); assert.equal(h.panelUI.request, null);
    oldRoute.resolve(); oldNode.reject(new Error('stale-model-node-error'));
    await until(() => descendants(h.panel).some(el => el.attributes['aria-label'] === 'Entries' && el.children.length > 1));
    category(h, ''); chooseBinary(h); await until(() => routeEvidence(h));
    const fresh = routeEvidence(h); assert.notEqual(fresh.graph.contentSha256, oldSha);
    await settle(); assert.deepEqual(routeEvidence(h), fresh);
    assert(!descendants(h.panel).some(el => /stale-model-node-error/.test(el.textContent)));
    h.defer(request => request.op === 'effectPaths'); category(h, 'network');
    const invalidated = h.pending[h.pending.length - 1]; h.ui.refresh('{broken'); noRoute(h);
    invalidated.reject(new Error('stale-capture-route-error')); await settle(); noRoute(h);
  });
}

test('Rust output embeds the shared model and both renderers retain route ghosts', () => {
  const output = fs.readFileSync(path.join(src, 'output.rs'), 'utf8');
  assert.match(output, /include_str!\("entry-effects\.js"\)/);
  assert.match(output, /\.replace\(ENTRY_EFFECTS_JS_PLACEHOLDER, ENTRY_EFFECTS_JS\)/);
  assert.match(html, /id="entry-effects-source">\/\*__ENTRY_EFFECTS_JS__\*\//);
  assert.match(html, /if \(ENTRY_EFFECT_ACTIVE\) return ENTRY_EFFECT_ACTIVE.edges.has/);
  assert.match(html, /ctx.globalAlpha = ENTRY_EFFECT_ACTIVE \? 0\.08/);
  assert.match(html, /ENTRY_EFFECT_ACTIVE\.nodes\.has\(n.id\)/);
});

if (process.env.ENTRY_EFFECT_CAPTURE) test('real offline capture traverses the actual browser worker boundary', async () => {
  const bytes = fs.readFileSync(process.env.ENTRY_EFFECT_CAPTURE);
  const raw = JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
  for (const worker of [false, true]) {
    const h = await harness(worker, raw, { html: fs.readFileSync(process.env.ENTRY_EFFECT_HTML || path.join(path.dirname(process.env.ENTRY_EFFECT_CAPTURE), 'graph.html'), 'utf8') }), inventory = await h.ui.queryEntryEffects({ op: 'entrypoints', page: { limit: 100 } });
    const main = inventory.entries.items.find(e => e.kind === 'binary'); assert(main);
    const result = await h.ui.queryEntryEffects({ op: 'effectPaths', entryId: main.id, includePossible: false });
    assert(result.effects.items.some(e => e.category === 'filesystem'));
    assert(result.nodes.items.some(e => /read_input$/.test(e.path)));
  }
});

if (process.env.ENTRY_EFFECT_ADAPTER_CAPTURE) test('bound independent capture replays through emitted worker and fallback modules', async () => {
  const { readCapture } = require('./bind-entry-effects-adapter.cjs');
  const raw = readCapture(process.env.ENTRY_EFFECT_ADAPTER_CAPTURE);
  const emitted = fs.readFileSync(process.env.ENTRY_EFFECT_ADAPTER_HTML || path.join(path.dirname(process.env.ENTRY_EFFECT_ADAPTER_CAPTURE), 'graph.html'), 'utf8');
  for (const worker of [false, true]) {
    const h = await harness(worker, raw, { html: emitted }), api = Analysis.create(raw, { rawText: h.raw });
    const inventory = await h.ui.queryEntryEffects({ op: 'entrypoints', kind: 'host-callback' });
    const host = inventory.entries.items[0]; assert(host);
    assert(raw.nodes.some(node => node.id === host.nodeId));
    const request = { op: 'effectPaths', entryId: host.id, includePossible: false };
    const browser = await h.ui.queryEntryEffects(request), agent = await api.query(request);
    assert(browser.effects.items.some(effect => effect.operation === 'host-transport-send'));
    assert.deepEqual(normalized(browser.effects), agent.effects);
    const replay = await h.ui.queryEntryEffects({ op: 'replay', replay: browser.replay });
    assert.equal(replay.replayed, true); assert.deepEqual(normalized(replay.effects), agent.effects);
  }
});

module.exports = { harness, descendants, until, normalized, element };
