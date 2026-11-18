/* Run the actual viewer worker construction and main-thread fallback, without a renderer. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Analysis = require('../src/analysis-api.js');
const Model = require('../src/execution-model.js');

const src = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(src, 'viewer.html'), 'utf8');
const begin = html.indexOf('var FLOW_UI = null, STATE_UI = null, WATERFALL_UI = null;');
const end = html.indexOf('// ---- GPU renderer (Cosmos) ----', begin);
assert(begin >= 0 && end > begin);
const moduleIds = { 'flow-engine-source': 'execution-flow', 'flow-map-source': 'flow-map',
  'call-graph-source': 'call-graph', 'architecture-organization-source': 'architecture-organization',
  'execution-model-source': 'execution-model',
  'value-flow-source': 'value-flow', 'guard-obligations-source': 'guard-obligations', 'failure-obligations-source': 'failure-obligations', 'resource-risks-source': 'resource-risks', 'program-queries-source': 'program-queries', 'analysis-evidence-source': 'analysis-evidence', 'execution-model-view-source': 'execution-model-view',
  'supply-chain-source': 'supply-chain', 'call-paths-source': 'call-paths', 'advisory-exposure-source': 'advisory-exposure', 'entry-effects-source': 'entry-effects', 'analysis-snapshot-source': 'analysis-snapshot', 'revision-comparison-source': 'revision-comparison',
  'performance-measurements-source': 'performance-measurements',
  'comment-search-source': 'comment-search',
  'trace-waterfall-source': 'trace-waterfall' };

function fixture() {
  function flow(id, blocks) { return { id: 'flow-' + id, source_file: 'src/lib.rs', source_location: 4,
    attributes: { kind: 'flow_function', path: id, package_id: 'pkg', unit_key: 'unit', source_digest: '0123456789abcdef',
      flow: JSON.stringify({ version: 1, function: id, entry: 'bb0', blocks }) } }; }
  return { nodes: [flow('root', [{ id: 'bb0', kind: 'call', callee: 'sink', successors: [{ target: 'bb1' }] },
    { id: 'bb1', kind: 'return', successors: [] }]), flow('sink', [{ id: 'bb0', kind: 'return', successors: [] }])], edges: [] };
}
function element() { return { value: '', textContent: '', style: {}, children: [],
  classList: { remove() {}, add() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; },
  appendChild(child) { this.children.push(child); }, replaceChildren() { this.children.length = 0; } }; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(predicate(), 'expected viewer update');
}
function panelEvidence(h) { return JSON.parse(h.elements.get('state-evidence').children[1].textContent); }
function assertNoEvidence(h) {
  const panel = h.elements.get('state-evidence');
  assert.equal(panel.children.length, 1, 'previous finding and replay are removed');
  assert.equal(panel.children[0].textContent, 'Analysis evidence appears after a query');
}

async function harness(useWorker, analyzer) {
  const elements = new Map(), results = [], ready = deferred(), resultWaiters = [], catalogWaiters = [], blobs = new Map();
  const workerContexts = [];
  function getElement(id) {
    if (!elements.has(id)) {
      const node = element();
      if (moduleIds[id]) node.textContent = fs.readFileSync(path.join(src, moduleIds[id] + '.js'), 'utf8');
      elements.set(id, node);
    }
    return elements.get(id);
  }
  const context = { TextEncoder, Uint8Array, Int32Array, setTimeout, clearTimeout, performance,
    document: { getElementById: getElement, createElement: element }, window: {},
    ARCH_PIN_ANALYSIS: null, ARCH_PIN_ACTIVE: null, ARCH_ANALYSIS_KEY: '', CALL_UI: null,
    setFunctionProjection() {}, setFunctionAnalysis() {}, setArchitectureActive() {}, ensureArchitecture() {} };
  for (const id of Object.keys(moduleIds)) vm.runInNewContext(getElement(id).textContent, context);
  if (analyzer && !useWorker) context.ExecutionModel.analyze = analyzer;
  if (useWorker) {
    context.Blob = class { constructor(parts) { this.source = parts.join(''); } };
    context.URL = { createObjectURL(blob) { const id = 'blob:' + blobs.size; blobs.set(id, blob.source); return id; } };
    context.Worker = class {
      constructor(url) {
        const self = { postMessage: data => setImmediate(() => this.onmessage && this.onmessage({ data: structuredClone(data) })) };
        const worker = { self, TextEncoder, Uint8Array, Int32Array, setTimeout, clearTimeout };
        // Evaluate precisely the Blob that initialize() constructs, including its module list.
        vm.runInNewContext(blobs.get(url), worker);
        if (analyzer) worker.ExecutionModel.analyze = analyzer;
        workerContexts.push(worker); this.worker = worker;
      }
      postMessage(data) { const copy = structuredClone(data); setImmediate(() => this.worker.self.onmessage({ data: copy })); }
      terminate() { this.onmessage = null; }
    };
  }
  vm.runInNewContext(html.slice(begin, end), context);
  context.STATE_UI = { pins: [], setData() {
    const waiter = catalogWaiters.shift(); if (waiter) waiter.resolve();
  }, setAnalysis(result) {
    results.push(result); const waiter = resultWaiters.shift(); if (waiter) waiter.resolve(result);
  } };
  const raw = JSON.stringify(fixture(), null, 2);
  const ui = context.setupFlowUI(raw, ready.resolve);
  await ready.promise;
  return { context, ui, raw, elements, results, workerContexts,
    refresh(nextRaw) { const next = deferred(); catalogWaiters.push(next); ui.refresh(nextRaw); return next.promise; },
    next(pins) { const next = deferred(); resultWaiters.push(next); context.STATE_UI.pins = pins.slice(); ui.analyzeState(pins); return next.promise; } };
}

for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} uses the API evidence core through real viewer wiring`, async () => {
    const h = await harness(worker), pins = ['sink', 'root'];
    const pending = h.next(pins); pins.splice(0, pins.length, 'mutated-after-dispatch');
    const browser = await pending;
    const api = await Analysis.create(fixture(), { rawText: h.raw }).query({ op: 'reachability', pins: ['root', 'sink'] });
    for (const key of ['graph', 'versions', 'provenance', 'request', 'replay', 'queryCoverage', 'completion', 'finding', 'evidenceLinks'])
      assert.deepEqual(JSON.parse(JSON.stringify(browser[key])), api[key], key + ' matches API');
    assert.equal(browser.status, api.status);
    assert.equal(h.context.window.__flowPerf.worker, worker);
    assert(browser.activeNodeIds.length, 'legacy renderer IDs remain available');
    const panel = h.elements.get('state-evidence');
    assert.equal(panel.children[0].textContent, 'Analysis evidence and replay');
    assert.match(panel.children[1].textContent, /"replayRequest"/);
    assert.match(panel.children[1].textContent, /"buildUnitId": "unit"/);
    const replayed = await Analysis.create(fixture()).query({ op: 'replay', replay: browser.replay });
    assert.equal(replayed.status, browser.status);
    assert.equal(replayed.replayed, true);
  });

  test(`${worker ? 'worker' : 'fallback'} invalidates completed evidence for empty pins, new queries and captures`, async () => {
    const h = await harness(worker);
    const first = await h.next(['root', 'sink']);
    assert.deepEqual(panelEvidence(h).request.pins, ['root', 'sink']);
    h.context.STATE_UI.pins = []; h.ui.analyzeState([]);
    assertNoEvidence(h);
    const next = h.next(['sink']);
    assertNoEvidence(h);
    await next;
    assert.deepEqual(panelEvidence(h).request.pins, ['sink']);
    const changed = fixture(); changed.nodes = [changed.nodes[1]];
    changed.nodes[0].id = 'flow-replacement'; changed.nodes[0].attributes.path = 'replacement';
    const flow = JSON.parse(changed.nodes[0].attributes.flow); flow.function = 'replacement';
    changed.nodes[0].attributes.flow = JSON.stringify(flow);
    h.context.STATE_UI.pins = [];
    const refreshed = h.refresh(JSON.stringify(changed));
    assertNoEvidence(h);
    await refreshed;
    assertNoEvidence(h);
    const current = await h.next(['replacement']);
    assert.notEqual(current.graph.contentSha256, first.graph.contentSha256);
    assert.equal(panelEvidence(h).graph.contentSha256, current.graph.contentSha256);
    assert.deepEqual(panelEvidence(h).replayRequest.replay.request.pins, ['replacement']);
  });

  test(`${worker ? 'worker' : 'fallback'} clears evidence on errors and ignores stale rejections`, async () => {
    const pending = []; let delay = false;
    const h = await harness(worker, (model, pins, options) => {
      if (!delay) return Model.analyze(model, pins, options);
      const d = deferred(); pending.push(d);
      return d.promise.then(() => Model.analyze(model, pins, options));
    });
    await h.next(['root', 'sink']);
    delay = true;
    h.context.STATE_UI.pins = ['root']; h.ui.analyzeState(['root']);
    assertNoEvidence(h);
    await waitFor(() => pending.length === 1);
    const status = h.elements.get('state-status') || h.context.document.getElementById('state-status');
    pending[0].reject(new Error('current-query-error'));
    await waitFor(() => status.textContent.includes('current-query-error'));
    assertNoEvidence(h);
    h.context.STATE_UI.pins = ['root']; h.ui.analyzeState(['root']);
    await waitFor(() => pending.length === 2);
    delay = false;
    await h.next(['sink']);
    const accepted = panelEvidence(h);
    pending[1].reject(new Error('stale-query-error')); await settle();
    assert.deepEqual(panelEvidence(h), accepted, 'stale failure preserves current evidence');
    assert(!status.textContent.includes('stale-query-error'));
    delay = true;
    h.context.STATE_UI.pins = ['root']; h.ui.analyzeState(['root']);
    assertNoEvidence(h);
    await waitFor(() => pending.length === 3);
    h.ui.refresh('{broken');
    assertNoEvidence(h);
    const flowStatus = h.elements.get('flow-status');
    await waitFor(() => /Flow (?:worker|catalog) error:/.test(flowStatus.textContent));
    assertNoEvidence(h);
    status.textContent = 'current-capture';
    pending[2].reject(new Error('stale-capture-error')); await settle();
    assert.equal(status.textContent, 'current-capture');
    assertNoEvidence(h);
    assert.equal(h.results.length, 2);
  });
}

test('Rust output embeds the same shared core in both viewer and worker source', () => {
  const output = fs.readFileSync(path.join(src, 'output.rs'), 'utf8');
  assert.match(output, /include_str!\("analysis-evidence\.js"\)/);
  assert.match(output, /\.replace\(ANALYSIS_EVIDENCE_JS_PLACEHOLDER, ANALYSIS_EVIDENCE_JS\)/);
  assert.match(html, /id="analysis-evidence-source">\/\*__ANALYSIS_EVIDENCE_JS__\*\//);
});
