/* Execute actual emitted guard controls, Blob worker and fallback. Deferred until source review. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Analysis = require('../src/analysis-api.js');
const F = require('../tests/fixtures/guard-obligations/fixture-graphs.cjs');
const simple = () => F.scenario().raw;
const capture = require('../tests/fixtures/guard-obligations/capture-model.cjs');
const src = path.join(__dirname, '..', 'src');
const template = fs.readFileSync(path.join(src, 'viewer.html'), 'utf8');
const modules = { 'flow-engine-source': 'execution-flow', 'flow-map-source': 'flow-map', 'call-graph-source': 'call-graph',
  'architecture-organization-source': 'architecture-organization', 'execution-model-source': 'execution-model',
  'value-flow-source': 'value-flow', 'guard-obligations-source': 'guard-obligations', 'failure-obligations-source': 'failure-obligations', 'resource-risks-source': 'resource-risks', 'program-queries-source': 'program-queries', 'analysis-evidence-source': 'analysis-evidence', 'supply-chain-source': 'supply-chain', 'call-paths-source': 'call-paths', 'advisory-exposure-source': 'advisory-exposure', 'entry-effects-source': 'entry-effects', 'analysis-snapshot-source': 'analysis-snapshot', 'revision-comparison-source': 'revision-comparison',
  'performance-measurements-source': 'performance-measurements',
  'comment-search-source': 'comment-search',
  'execution-model-view-source': 'execution-model-view', 'trace-waterfall-source': 'trace-waterfall' };
function element(tag = 'div') {
  const el = { tagName: tag, value: '', textContent: '', style: {}, attributes: {}, listeners: {}, children: [], clientWidth: 980,
    classList: { add() {}, remove() {}, toggle() {} }, parentElement: { clientWidth: 980 },
    setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener(key, fn) { this.listeners[key] = fn; },
    querySelectorAll() { return []; }, querySelector(selector) { return this.children.find(c => c && typeof c === 'object' &&
      (selector === '.muted' ? c.className === 'muted' : c.tagName === selector)) || null; },
    appendChild(child) { this.children.push(child); if (child && typeof child === 'object') child.parentElement = this; return child; },
    replaceChildren(...children) { this.children.length = 0; children.forEach(child => this.appendChild(child)); } };
  Object.defineProperty(el, 'options', { get() { return this.children.filter(c => c.tagName === 'option'); } });
  return el;
}
const descendants = el => [el, ...el.children.filter(c => c && typeof c === 'object').flatMap(descendants)];
const normalized = value => JSON.parse(JSON.stringify(value));
// API objects and browser disclosures share a JSON contract; compare both complete wire payloads.
const assertWireEqual = (actual, expected, message) => assert.deepEqual(normalized(actual), normalized(expected), message);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 1)); assert(check(), 'expected viewer update'); }
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
async function harness(useWorker, raw = simple(), html = template) {
  const elements = new Map(), blobs = new Map(), workers = [], ready = deferred(), messages = [], traceInputs = [], boundedSearches = [];
  let analyzerGate = null, catalogCount = 0, analysisStart = null; const analysisRuns = [];
  function get(id) {
    if (!elements.has(id)) {
      const el = element();
      if (id === 'waterfall-head') { el.appendChild(element('strong')); const description = element('div'); description.className = 'muted'; el.appendChild(description); }
      if (modules[id]) {
        const expected = fs.readFileSync(path.join(src, modules[id] + '.js'), 'utf8');
        if (html !== template) {
          const inline = html.match(new RegExp('<script\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
          assert(inline, 'emitted module ' + id); assert.equal(inline[1], expected, 'current emitted bytes ' + id); el.textContent = inline[1];
        } else el.textContent = expected;
      }
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const context = { TextEncoder, Uint8Array, Int32Array, setTimeout, clearTimeout, performance, window: {},
    document: { getElementById: get, createElement: element, createElementNS: (_, tag) => element(tag) },
    ARCH_PIN_ANALYSIS: null, ARCH_PIN_ACTIVE: null, ARCH_ANALYSIS_KEY: '', CALL_UI: null,
    setFunctionProjection() {}, setFunctionAnalysis() {}, setArchitectureActive() {}, ensureArchitecture() {} };
  for (const id of Object.keys(modules)) vm.runInNewContext(get(id).textContent, context);
  function gateAnalyzer(target) {
    const actual = target.GuardObligations.analyze;
    target.GuardObligations.analyze = (...args) => {
      if (!analyzerGate) { if (analysisStart) analysisStart(); return actual(...args).then(value => { analysisRuns.push(value); return value; }); }
      const gate = analyzerGate; analyzerGate = null; gate.started.resolve();
      return gate.release.promise.then(() => actual(...args));
    };
  }
  function observeBoundedSearch(target) {
    const actual = target.ExecutionFlow.begin;
    target.ExecutionFlow.begin = (...args) => { boundedSearches.push(normalized(args[2] || {})); return actual(...args); };
  }
  gateAnalyzer(context);
  observeBoundedSearch(context);
  if (useWorker) {
    context.Blob = class { constructor(parts) { this.source = parts.join(''); } };
    context.URL = { createObjectURL(blob) { const key = 'blob:' + blobs.size; blobs.set(key, blob.source); return key; } };
    context.Worker = class {
      constructor(url) {
        this.context = { TextEncoder, Uint8Array, Int32Array, setTimeout, clearTimeout,
          self: { postMessage: data => setImmediate(() => this.onmessage && this.onmessage({ data: structuredClone(data) })) } };
        vm.runInNewContext(blobs.get(url), this.context); gateAnalyzer(this.context); observeBoundedSearch(this.context); workers.push(this);
      }
      postMessage(value) { const copy = structuredClone(value); messages.push(copy); setImmediate(() => this.context.self.onmessage({ data: copy })); }
      terminate() { this.onmessage = null; }
    };
  }
  const begin = html.indexOf('var FLOW_UI = null, STATE_UI = null, WATERFALL_UI = null;');
  const end = html.indexOf('// ---- GPU renderer (Cosmos) ----', begin); assert(begin >= 0 && end > begin);
  vm.runInNewContext(html.slice(begin, end), context);
  const flowResults = [], focus = [];
  context.STATE_UI = { pins: ['retain-unordered-pin'], setData() { catalogCount++; }, hasProcedure() { return true; },
    setAnalysis(value) { flowResults.push(value); }, focus(path) { focus.push(path); }, activate() {} };
  context.WATERFALL_UI = context.TraceWaterfall.mount(context.document, { query: value => context.FLOW_UI.queryWaterfall(value),
    activate: () => context.FLOW_UI.activateWaterfall(false), back() {}, pin() {}, canPin() { return true; } });
  const original = context.WATERFALL_UI.openWitness;
  context.WATERFALL_UI.openWitness = (value, mode) => { traceInputs.push(normalized(value)); original(value, mode); };
  const inline = html !== template && html.match(/<script\b[^>]*\bid="graph-data"[^>]*>([\s\S]*?)<\/script>/);
  const rawText = inline ? inline[1] : JSON.stringify(raw);
  if (html !== template) { assert(inline); assert.deepEqual(JSON.parse(rawText), raw); assert(!/\/\*__(?:EXECUTION_MODEL_JS|ANALYSIS_EVIDENCE_JS|TRACE_WATERFALL_JS)__\*\//.test(html)); }
  const ui = context.setupFlowUI(rawText, ready.resolve); context.FLOW_UI = ui; await ready.promise;
  return { ui, context, elements, workers, messages, traceInputs, boundedSearches, rawText, flowResults, focus,
    get catalogCount() { return catalogCount; }, analysisRuns, onAnalyzeStart(callback) { analysisStart = callback; }, get panel() { return get('guard-obligations-content'); }, get diagnostics() { return get('waterfall-diagnostics'); },
    defer() { const gate = { started: deferred(), release: deferred() }; analyzerGate = gate; return gate; },
    async refresh(next = raw) { const before = catalogCount; ui.refresh(JSON.stringify(next)); await until(() => catalogCount > before); },
    inject(value) { assert(useWorker); workers[0].onmessage({ data: value }); } };
}
function button(root, text) { const found = descendants(root).find(el => el.tagName === 'button' && el.textContent === text); assert(found, text); return found; }
function click(el) { if (el.listeners.click) el.listeners.click(); else el.onclick(); }
function evidence(root) { const pre = descendants(root).find(el => el.tagName === 'pre'); return pre && JSON.parse(pre.textContent); }
const textOf = root => descendants(root).map(el => el.textContent).join('\n');
function assertParity(value, api, name) {
  for (const key of ['graph','versions','request','replay','witnesses','queryCoverage','finding','completion','semantics','assumptions']) assertWireEqual(value[key], api[key], name + ' ' + key);
}
for (const worker of [false,true]) {
  const transport = worker ? 'worker' : 'fallback';
  test(`${transport}: the shared capture helper preserves copied origins and isolates a contradictory ID`, async () => {
    for (const kind of ['direct','copied','targets-direct','targets-copied']) {
      const item = F.capturePointer(kind), { raw } = item, request = capture.request(raw, 'direct_pointer');
      assert.deepEqual(request, item.request, 'same exact policy from either compiler target form');
      const h = await harness(worker, raw);
      const positive = await h.ui.runGuardQuery(request), api = await Analysis.create(raw, { rawText: h.rawText }).query(request);
      assertParity(positive, api, kind + ' pointer positive'); assert.equal(positive.status, 'supported-compliant');
      click(button(h.panel, 'Open execution flow'));
      assertWireEqual(h.flowResults.at(-1).activeCallIds, positive.witnesses.items.flatMap(w => w.steps).map(s => s.callsiteId).filter(Boolean), kind + ' exact pointer prefix');
      assert(h.flowResults.at(-1).activeCallIds.includes(request.model.rules[0].operation.call));
      click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, positive.witnesses, kind + ' pointer positive replay');
      const changed = capture.pointerContradiction(raw); await h.refresh(changed);
      const negative = await h.ui.runGuardQuery(request), changedApi = await Analysis.create(changed, { rawText: JSON.stringify(changed) }).query(request);
      assertParity(negative, changedApi, kind + ' pointer contradiction'); assert.equal(negative.status, 'indeterminate');
      assert.equal(negative.finding.supportedCompliantPath, false); assert.equal(negative.witnesses.total, 0);
      assert(negative.queryCoverage.gaps.some(g => g.kind === 'contradictory-or-unproven-function-pointer'));
      click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, negative.witnesses, kind + ' pointer contradiction replay');
      assertWireEqual(evidence(h.panel).queryCoverage, negative.queryCoverage, kind + ' pointer contradiction replay coverage');
    }
  });
  test(`${transport}: reviewed call boundaries preserve typed certainty and exact pointer/arity identity`, async () => {
    for (const item of F.reviewCases()) {
      const h = await harness(worker, item.raw), value = await h.ui.runGuardQuery(item.request);
      const api = await Analysis.create(item.raw, { rawText: h.rawText }).query(item.request);
      assertParity(value, api, item.name); assert.equal(value.status, item.status, item.name);
      assert.equal(value.finding.supportedCompliantPath, !item.gap, item.name);
      assert.equal(value.partialCoverage, !!item.gap, item.name);
      if (item.gap) { assert.equal(value.witnesses.total, 0, item.name); assert(value.queryCoverage.gaps.some(g => g.kind === item.gap), item.name); }
      click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      const replay = evidence(h.panel); assertWireEqual(replay.witnesses, api.witnesses, item.name + ' replay');
      assertWireEqual(replay.queryCoverage, api.queryCoverage, item.name + ' replay coverage');
    }
  });
  test(`${transport}: paired policy forms, exact flow/source actions, API and replay parity`, async () => {
    for (const item of F.cases()) {
      const h = await harness(worker, item.raw), input = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Declarative guard-obligation request');
      input.value = JSON.stringify(item.request); input.listeners.input(); click(button(h.panel, 'Run guard query'));
      await until(() => evidence(h.panel));
      const value = evidence(h.panel), api = await Analysis.create(item.raw, { rawText: h.rawText }).query(item.request);
      assertParity(value, api, item.name); assert.equal(value.finding.candidateBypass, item.bypass, item.name);
      assert(textOf(h.panel).includes('declared-access')); assert(textOf(h.panel).includes('Policy correctness'));
      assert(descendants(h.panel).some(el => el.tagName === 'a' && el.href.includes('/fixture/')), item.name + ' source owner');
      click(button(h.panel, 'Open execution flow'));
      const opened = h.flowResults.at(-1), calls = value.witnesses.items.flatMap(w => w.steps).map(s => s.callsiteId).filter(Boolean);
      assertWireEqual(opened.activeCallIds, calls, item.name + ' exact prefix calls');
      assert(opened.activeCallIds.includes(item.request.model.rules[0].operation.call)); assert.equal(h.context.STATE_UI.pins[0], 'retain-unordered-pin');
      const disclosure = evidence(h.elements.get('state-evidence')); assertWireEqual(disclosure.witnesses, value.witnesses); assertWireEqual(disclosure.assumptions, value.assumptions);
      click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, api.witnesses, item.name + ' replay');
      assert.equal(h.context.window.__flowPerf.worker, worker);
    }
  });
  test(`${transport}: request/capture snapshots, cancellation and stale successes/errors`, async () => {
    const h = await harness(worker), item = F.scenario(), request = item.request, pending = h.ui.runGuardQuery(request);
    request.model.rules[0].id = 'mutated'; const value = await pending; assert.equal(value.rules[0].id, 'declared-access');
    const gate = h.defer(), old = h.ui.runGuardQuery(F.scenario('fail-open').request); old.catch(() => {}); await gate.started.promise;
    click(button(h.panel, 'Cancel guard query')); await assert.rejects(old, /cancelled/); assert.equal(evidence(h.panel), undefined);
    gate.release.resolve(); await settle(); assert.equal(evidence(h.panel), undefined);
    const staleGate = h.defer(), stale = h.ui.runGuardQuery(F.request()); stale.catch(() => {}); await staleGate.started.promise;
    const current = await h.ui.runGuardQuery(F.request()); staleGate.release.reject(new Error('stale-guard-error')); await assert.rejects(stale); await settle();
    assertWireEqual(evidence(h.panel), current); assert(!textOf(h.panel).includes('stale-guard-error'));
    const snapshot = structuredClone(current); await h.refresh(); assert.equal(evidence(h.panel), undefined);
    const replay = await h.ui.queryGuards({ op: 'replay', replay: snapshot.replay }); assertWireEqual(replay.witnesses, snapshot.witnesses);
    const changed = F.scenario().raw; F.update(changed, 'root', f => { delete f.guard_facts; }); await h.refresh(changed);
    await assert.rejects(h.ui.runGuardQuery({ op: 'replay', replay: snapshot.replay }), /digest/);
    assert.equal(evidence(h.panel), undefined);
    const unknown = await h.ui.runGuardQuery(F.request()); assert.equal(unknown.status, 'indeterminate'); assert.equal(unknown.finding.supportedCompliantPath, false);
    const input = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Declarative guard-obligation request'); input.value = '{'; click(button(h.panel, 'Run guard query'));
    assert.equal(evidence(h.panel), undefined); assert(textOf(h.panel).includes('Guard query error:'));
    if (worker) {
      h.inject({ type: 'guard_result', catalogToken: 1, requestId: 1, result: snapshot });
      h.inject({ type: 'guard_error', catalogToken: 1, requestId: 1, message: 'stale-injected-error' });
      assert.equal(evidence(h.panel), undefined); assert(!textOf(h.panel).includes('stale-injected-error'));
    }
  });
  test(`${transport}: real in-flight cancellation and operation-owned displayed evidence`, async () => {
    const h = await harness(worker);
    const started = deferred(); h.onAnalyzeStart(started.resolve);
    const pending = h.ui.runGuardQuery(F.request()); pending.catch(() => {}); await started.promise;
    h.ui.cancelGuards(); await assert.rejects(pending); await settle(); assert.equal(evidence(h.panel), undefined);
    h.onAnalyzeStart(null);
    await h.ui.runGuardQuery(F.request()); click(button(h.panel, 'Open execution flow'));
    const before = h.flowResults.length;
    // A newer structural/pin result owns the canvas. Cancelling guards cannot clear it.
    h.ui.analyzeState(['root']); await until(() => h.flowResults.length > before);
    const pins = h.flowResults.at(-1), disclosure = evidence(h.elements.get('state-evidence'));
    h.ui.cancelGuards(); assert.equal(h.flowResults.at(-1), pins); assertWireEqual(evidence(h.elements.get('state-evidence')), disclosure);
    // Conversely, cancellation of the older value panel cannot clear a guard witness.
    await h.ui.runGuardQuery(F.request()); click(button(h.panel, 'Open execution flow'));
    const guard = h.flowResults.at(-1); h.ui.cancelValues(); assert.equal(h.flowResults.at(-1), guard);
    assert.match(h.elements.get('state-status').textContent, /DECLARED GUARD witness/);
  });
  test(`${transport}: relative sources stay relative under the accepted owner`, async () => {
    const item = F.scenario();
    F.update(item.raw, 'root', f => { f.blocks.forEach(b => { b.source_file = 'src/lib.rs'; }); });
    const rejected = structuredClone(item.raw.nodes[0]); rejected.id = 'rejected'; rejected.source_file = '/wrong.rs'; rejected.attributes.flow = '{'; item.raw.nodes.unshift(rejected);
    const h = await harness(worker, item.raw), value = await h.ui.runGuardQuery(item.request);
    const roots = value.witnesses.items.flatMap(w => w.steps).filter(s => s.procedure === 'root' && s.kind !== 'assignment');
    assert(roots.every(s => s.sourceIdentity.rawNodeId === 'flow:root' && s.source.absolute_file === null));
    assert(textOf(h.panel).includes('relative source')); assert(!descendants(h.panel).some(el => el.href && el.href.includes('wrong.rs')));
  });
}
if (process.env.GUARD_CAPTURE) test('actual generated HTML: every declared capture case through both emitted transports and forms', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.GUARD_CAPTURE)), emitted = fs.readFileSync(process.env.GUARD_HTML || path.join(path.dirname(process.env.GUARD_CAPTURE), 'graph.html'), 'utf8');
  assert(!emitted.includes('/*__GUARD_OBLIGATIONS_JS__*/'));
  for (const worker of [false,true]) {
    const h = await harness(worker, raw, emitted), api = Analysis.create(raw, { rawText: h.rawText });
    for (const [name] of capture.cases) {
      const q = capture.request(raw, name), input = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Declarative guard-obligation request');
      input.value = JSON.stringify(q); input.listeners.input(); click(button(h.panel, 'Run guard query')); await until(() => evidence(h.panel));
      const value = evidence(h.panel), direct = await api.query(q); capture.assertResult(name, value); assertParity(value, direct, name);
      assert.equal(value.graph.contentSha256, direct.graph.contentSha256);
      if (value.witnesses.items.length) {
        assert(descendants(h.panel).some(el => el.tagName === 'a' && el.href.startsWith('vscode://file/')), name + ' captured source');
        click(button(h.panel, 'Open execution flow'));
        assert(h.flowResults.at(-1).activeCallIds.includes(q.model.rules[0].operation.call), name + ' exact protected operation');
        assertWireEqual(evidence(h.elements.get('state-evidence')).request, value.request);
      }
      click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, direct.witnesses, name + ' emitted replay');
    }
    // Retain the actual emitted module bytes, then replace the capture through
    // the real UI lifecycle with an isolated contradictory compiler fact.
    const changed = capture.pointerContradiction(raw); await h.refresh(changed);
    const q = capture.request(changed, 'direct_pointer'), input = descendants(h.panel).find(el => el.attributes['aria-label'] === 'Declarative guard-obligation request');
    input.value = JSON.stringify(q); input.listeners.input(); click(button(h.panel, 'Run guard query')); await until(() => evidence(h.panel));
    const value = evidence(h.panel), direct = await Analysis.create(changed, { rawText: JSON.stringify(changed) }).query(q);
    assertParity(value, direct, 'emitted direct pointer contradiction'); assert.equal(value.status, 'indeterminate');
    assert.equal(value.finding.supportedCompliantPath, false); assert.equal(value.witnesses.total, 0);
    assert(value.queryCoverage.gaps.some(g => g.kind === 'contradictory-or-unproven-function-pointer'));
    click(button(h.panel, 'Replay guard query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
    assertWireEqual(evidence(h.panel).queryCoverage, direct.queryCoverage, 'emitted direct pointer contradiction replay');
  }
});
