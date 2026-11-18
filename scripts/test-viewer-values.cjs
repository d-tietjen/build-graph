/* Execute actual emitted value controls, Blob worker and fallback. Deferred until source review. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Analysis = require('../src/analysis-api.js');
const F = require('../tests/fixtures/value-flow/fixture-graphs.cjs');
const { simple, model, parameterFailures, externalRoot } = require('../tests/fixtures/value-flow/fixture-graphs.cjs');
const capture = require('../tests/fixtures/value-flow/capture-model.cjs');
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
    const actual = target.ValueFlow.analyze;
    target.ValueFlow.analyze = (...args) => {
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
    get catalogCount() { return catalogCount; }, analysisRuns, onAnalyzeStart(callback) { analysisStart = callback; }, get panel() { return get('value-flow-content'); }, get diagnostics() { return get('waterfall-diagnostics'); },
    defer() { const gate = { started: deferred(), release: deferred() }; analyzerGate = gate; return gate; },
    async refresh(next = raw) { const before = catalogCount; ui.refresh(JSON.stringify(next)); await until(() => catalogCount > before); },
    inject(value) { assert(useWorker); workers[0].onmessage({ data: value }); } };
}
function button(root, text) { const found = descendants(root).find(el => el.tagName === 'button' && el.textContent === text); assert(found, text); return found; }
function click(el) { if (el.listeners.click) el.listeners.click(); else el.onclick(); }
function evidence(root) { const pre = descendants(root).find(el => el.tagName === 'pre'); return pre && JSON.parse(pre.textContent); }
const textOf = root => descendants(root).map(el => el.textContent).join('\n');
const request = () => model();
function assertEndpointCalls(value, q, name) {
  const steps = value.witnesses.items.flatMap(w => w.steps);
  for (const [kind, rule] of [['source', q.model.sources[0]], ['sink', q.model.sinks[0]]]) {
    const step = steps.find(s => s.kind === kind && s[kind + 'Id'] === rule.id);
    assert(step, name + ' ' + kind); assert.equal(step.callsiteId, rule.at.call, name + ' exact ' + kind + ' call');
    assertWireEqual(step.endpoint, { ...rule.at, fields: rule.at.fields || [] }, name + ' exact ' + kind + ' endpoint');
  }
}
function assertValueDisclosure(h, value, name) {
  const keys = ['graph', 'versions', 'request', 'provenance', 'captureDiagnostics', 'completion', 'finding',
    'queryCoverage', 'assumptions', 'evidenceLinks', 'witnesses', 'witness', 'resolved', 'semantics'];
  const expected = Object.fromEntries(keys.map(key => [key, value[key]]));
  expected.replayRequest = { op: 'replay', replay: value.replay };
  assertWireEqual(evidence(h.elements.get('state-evidence')), expected, name + ' complete flow disclosure');
}
function assertApiValue(browser, api, name) {
  // The public API adds its explicit scope wrapper to the complete shared payload.
  assert.equal(Object.hasOwn(browser, 'scope'), false, name + ' shared payload has no scope wrapper');
  assertWireEqual({ ...browser, scope: null }, api, name + ' complete API payload');
}

for (const worker of [false, true]) {
  const transport = worker ? 'worker' : 'fallback';
  test(`${transport} value requests have API, replay, source and immutable-model parity`, async () => {
    const h = await harness(worker), input = request(), pending = h.ui.runValueQuery(input);
    input.model.sources[0].id = 'mutated';
    const browser = await pending, api = await Analysis.create(simple(), { rawText: h.rawText }).query(request());
    for (const key of ['graph','versions','request','replay','witnesses','queryCoverage','finding','completion','semantics'])
      assertWireEqual(browser[key], api[key], key);
    assert.equal(browser.finding.candidateInfluence, true); assert.equal(evidence(h.panel).finding.candidateInfluence, true);
    assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href.includes('/fixture/')));
    click(button(h.panel, 'Open execution flow'));
    assert(h.flowResults.at(-1).activeNodeIds.includes('root#bb0')); assert.equal(h.focus.at(-1), 'root');
    assert.match(h.elements.get('state-status').textContent, /VALUE witness/);
    const disclosure = evidence(h.elements.get('state-evidence')); assertWireEqual(disclosure.witnesses, browser.witnesses);
    const replay = await h.ui.queryValues({ op: 'replay', replay: browser.replay });
    assert.equal(replay.replayed, true); assertWireEqual(replay.witnesses, api.witnesses);
    assert.equal(h.context.window.__flowPerf.worker, worker);
  });
  test(`${transport} direct endpoint form routes disclose and highlight both exact callsites`, async () => {
    for (const kind of ['direct', 'field', 'reference', 'bypass']) for (const clean of [false, true]) {
      const { raw, request: q } = F.endpointRoute(kind, clean), h = await harness(worker, raw);
      const input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
      input.value = JSON.stringify(q); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
      const browser = evidence(h.panel), api = await Analysis.create(raw, { rawText: h.rawText }).query(q);
      assertApiValue(browser, api, kind);
      assert.equal(browser.finding.candidateInfluence, !clean, kind); assert.equal(browser.partialCoverage, false, kind);
      if (clean) { assert.equal(browser.status, 'not-found', kind); continue; }
      assertEndpointCalls(browser, q, kind);
      const endpointSteps = browser.witnesses.items.flatMap(w => w.steps).filter(s => ['source', 'sink'].includes(s.kind));
      for (const step of endpointSteps) {
        assert.equal(step.sourceIdentity.rawNodeId, 'flow:root', kind); assert.equal(step.source.source_file, '/fixture/root.rs', kind);
        assert(textOf(h.panel).includes(step.callsiteId), kind + ' displayed callsite');
      }
      assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href === 'vscode://file/fixture/root.rs:10'), kind + ' captured owner source link');
      click(button(h.panel, 'Open execution flow'));
      const opened = h.flowResults.at(-1), calls = [q.model.sources[0].at.call, q.model.sinks[0].at.call];
      assertWireEqual(opened.activeCallIds, calls, kind + ' exact highlighted endpoint calls');
      assertWireEqual(opened.activeCallTargets, [], kind + ' no inferred target');
      for (const call of calls) assert(opened.activeNodeIds.includes(call.slice(0, -5)), kind + ' endpoint node');
      assertValueDisclosure(h, browser, kind);
      click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, api.witnesses, kind + ' replay');
    }
    const external = externalRoot(), h = await harness(worker, external.raw), value = await h.ui.runValueQuery(external.request);
    assert(value.finding.candidateInfluence);
    assert(value.witnesses.items.flatMap(w => w.steps).every(s => !Object.hasOwn(s, 'callsiteId')), 'procedure endpoints invent no callsite');
    click(button(h.panel, 'Open execution flow'));
    assertWireEqual(h.flowResults.at(-1).activeCallIds, []); assertWireEqual(h.flowResults.at(-1).activeCallTargets, []);
  });
  test(`${transport} VF-1 malformed parameters and direct arity gaps retain possible source labels`, async () => {
    for (const { name, raw } of parameterFailures()) {
      const h = await harness(worker, raw), browser = await h.ui.runValueQuery(request());
      const api = await Analysis.create(raw, { rawText: h.rawText }).query(request());
      for (const key of ['status','partialCoverage','capability','witnesses','queryCoverage','finding','completion'])
        assertWireEqual(browser[key], api[key], `${name}: ${key}`);
      assert.equal(browser.status, 'indeterminate', name); assert.equal(browser.partialCoverage, true, name);
      assert.equal(browser.finding.candidateInfluence, true, name);
      assert(browser.queryCoverage.gaps.some(g => g.procedure === 'relay' && g.detail === 'root#bb1@call'), name);
      assert(browser.witnesses.items.some(w => w.sourceId === 'untrusted' && w.classification === 'possible' &&
        w.steps.some(s => s.kind === 'unknown-propagation')), name);
      assert(browser.witnesses.items.some(w => w.classification === 'unknown'), name);
      assert.equal(evidence(h.panel).status, 'indeterminate', name);
    }
  });
  test(`${transport} zero-parameter bodies, swapped controls and external root parameters retain API parity`, async () => {
    const external = externalRoot();
    for (const { raw, q, expected } of [
      { raw: simple(), q: request(), expected: true },
      { raw: simple(true), q: request(), expected: false },
      { raw: external.raw, q: external.request, expected: true }
    ]) {
      const h = await harness(worker, raw), browser = await h.ui.runValueQuery(q);
      const api = await Analysis.create(raw, { rawText: h.rawText }).query(q);
      assert.equal(browser.status, expected ? 'influenced' : 'not-found');
      assert.equal(browser.partialCoverage, false); assert.equal(browser.finding.candidateInfluence, expected);
      assertWireEqual(browser.witnesses, api.witnesses);
      assertWireEqual(browser.queryCoverage, api.queryCoverage);
      assert.equal(browser.completion.complete, true);
    }
  });
  test(`${transport} opaque reference transfers preserve possible inputs, clean controls and field parity`, async () => {
    for (const { name, raw, request: q, expected, partial, copied, readFact, unknownReason = 'unsupported-reference' } of F.referenceTransferCases()) {
      const h = await harness(worker, raw), input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
      input.value = JSON.stringify(q); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
      const value = evidence(h.panel), api = await Analysis.create(raw, { rawText: h.rawText }).query(q);
      assertApiValue(value, api, name); assert.equal(value.finding.candidateInfluence, expected, name);
      assert.equal(value.partialCoverage, partial, name); assert.equal(value.completion.complete, true, name);
      assert.equal(value.status, partial ? 'indeterminate' : expected ? 'influenced' : 'not-found', name);
      if (partial) assert(value.queryCoverage.gaps.some(g => g.kind === unknownReason && g.procedure === 'root' && (!readFact || g.detail === readFact)), name);
      if (copied) assert(value.queryCoverage.gaps.some(g => g.kind === 'unsupported-reference-copy' && g.procedure === 'root'), name);
      if (expected) {
        assertEndpointCalls(value, q, name);
        const witness = value.witnesses.items.find(w => w.sourceId === 'untrusted');
        assert.equal(witness.classification, partial ? 'possible' : 'modeled', name);
        assert(witness.steps.every(s => s.procedure === 'root' && s.sourceProcedure === 'root' && s.contextId === witness.contextId), name + ' current caller proof');
        assert(witness.steps.some(s => s.kind === 'transformation' && s.callsiteId === 'root#bb1@call' && s.summaryId === 'declared-transfer'), name);
        if (partial) {
          assert(witness.steps.some(s => s.kind === 'unknown-propagation' && s.reason === unknownReason && (!readFact || s.factId === readFact)), name);
          assert(!witness.steps.some(s => s.kind === 'reference-alias'), name + ' no invented precise referent');
          if (copied) assert(witness.steps.some(s => s.kind === 'unknown-propagation' && s.reason === 'unsupported-reference-copy'), name);
        }
        click(button(h.panel, 'Open execution flow'));
        assertWireEqual([...new Set(h.flowResults.at(-1).activeCallIds)], ['root#bb0@call', 'root#bb1@call', 'root#bb2@call'], name + ' exact calls');
        assertValueDisclosure(h, value, name);
      } else assert(!value.witnesses.items.some(w => w.sourceId === 'untrusted'), name + ' unrelated source stays separate');
      click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, api.witnesses, name + ' replay');
    }
  });
  test(`${transport} actual value form, sanitizer edits, errors and replay buttons use shared engine`, async () => {
    const h = await harness(worker), input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
    input.value = JSON.stringify(request()); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
    assert.equal(evidence(h.panel).status, 'influenced');
    const sanitized = request(); sanitized.model.summaries = [{ id: 'clean', version: 1, call: 'root#bb1@call', kind: 'sanitize', from: [], to: 'result', referenceEffects: 'none' }];
    input.value = JSON.stringify(sanitized); input.listeners.input(); assert.equal(evidence(h.panel), undefined);
    click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel)); assert.equal(evidence(h.panel).status, 'not-found');
    click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
    input.value = '{}'; input.listeners.input(); click(button(h.panel, 'Run value query'));
    await until(() => /Value query error/.test(textOf(h.panel))); assert.equal(evidence(h.panel), undefined);
  });
  test(`${transport} cancel, capture replacement and stale success/error lifecycle fences value evidence`, async () => {
    const h = await harness(worker); await h.ui.runValueQuery(request());
    const gate = h.defer(), pending = h.ui.runValueQuery(request()).catch(e => e); await gate.started.promise;
    h.ui.cancelValues(); gate.release.resolve(); await pending; await settle(); assert.equal(evidence(h.panel), undefined);
    const staleGate = h.defer(), stale = h.ui.runValueQuery(request()).catch(e => e); await staleGate.started.promise;
    await h.ui.runValueQuery(request()); const expected = evidence(h.panel);
    staleGate.release.reject(new Error('stale-value-failure')); await stale; await settle();
    assert.deepEqual(evidence(h.panel), expected); assert(!textOf(h.panel).includes('stale-value-failure'));
    const captureGate = h.defer(), old = h.ui.runValueQuery(request()).catch(e => e); await captureGate.started.promise;
    await h.refresh(); captureGate.release.resolve(); await old; await settle(); assert.equal(evidence(h.panel), undefined);
  });
}
for (const worker of [false, true]) {
  const transport = worker ? 'worker' : 'fallback';
  test(`${transport} confirmed review cases use actual value form, proof disclosure, replay and flow edges`, async () => {
    for (const { name, raw, request: q, expected, partial, possibleSink } of F.reviewCases()) {
      const h = await harness(worker, raw), input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
      input.value = JSON.stringify(q); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
      const value = evidence(h.panel), api = await Analysis.create(raw, { rawText: h.rawText }).query(q);
      assert.equal(value.finding.candidateInfluence, expected, name); assert.equal(value.partialCoverage, partial, name);
      assertWireEqual(value.witnesses, api.witnesses, name);
      if (possibleSink) assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.classification === 'possible' &&
        w.steps.at(-1).kind === 'sink' && w.steps.at(-1).endpoint.call === q.model.sinks[0].at.call &&
        w.steps.some(s => s.kind === 'source' && s.sourceIdentity.rawNodeId === 'flow:root')), name + ' source-bearing selected caller sink');
      if (name.startsWith('VF-8')) { assert.equal(value.completion.complete, true, name); assert(value.completion.states < 200, name); }
      if (name.startsWith('VF-9 reference')) assert.equal(value.status, 'indeterminate', name);
      if (expected) {
        click(button(h.panel, 'Open execution flow'));
        const opened = h.flowResults.at(-1); assert(opened.activeNodeIds.length, name);
        assertWireEqual(evidence(h.elements.get('state-evidence')).witnesses, value.witnesses, name);
        if (name.startsWith('VF-4')) assert(!opened.witnesses.items.flatMap(w => w.steps).some(s => s.kind === 'argument-to-parameter' && s.callsiteId === 'root#bb1@call'));
        if (name.startsWith('VF-14')) {
          const View = h.context.ExecutionModelView, calls = new Set(opened.activeCallIds), targets = new Set(opened.activeCallTargets);
          assert(View.callEdgeActive('root#bb1@call', 'write', calls, targets));
          assert(!View.callEdgeActive('root#bb1@call', 'unrelated-target', calls, targets));
          assert(opened.witnesses.items.flatMap(w => w.steps).some(s => s.kind === 'reference-return' && s.target === 'write' && s.contextId));
        }
        if (name.startsWith('VF-13')) assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href === 'vscode://file/fixture/root.rs:3'));
      }
      if (name.startsWith('VF-9') && !name.startsWith('VF-9 reference')) { click(button(h.panel, 'Open execution flow')); const active = h.flowResults.at(-1).activeCallTargets; assert.equal(active.includes('root#bb0@call->make'), expected, name); assert(!active.includes('root#bb0@call->empty'), name); }
      click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, value.witnesses, name + ' replay');
    }
  });
  test(`${transport} VF-12 stale panels preserve the current operation, pins, layout and replay disclosure`, async () => {
    const h = await harness(worker), layoutGeneration = h.catalogCount, ordered = { op: 'orderedPath', function: 'root', target: { kind: 'procedure', id: 'sensitive' } };
    await h.ui.runValueQuery(request()); click(button(h.panel, 'Open execution flow'));
    await h.ui.runOrderedQuery(ordered); const orderedPanel = h.elements.get('ordered-path-content'); click(button(orderedPanel, 'Open execution flow'));
    let current = h.flowResults.at(-1), disclosure = evidence(h.elements.get('state-evidence')), count = h.flowResults.length;
    const valueInput = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request'); valueInput.listeners.input();
    assert.equal(h.flowResults.length, count); assert.equal(h.flowResults.at(-1), current); assert.deepEqual(evidence(h.elements.get('state-evidence')), disclosure);
    await h.ui.runValueQuery(request()); click(button(h.panel, 'Open execution flow'));
    current = h.flowResults.at(-1); disclosure = evidence(h.elements.get('state-evidence')); count = h.flowResults.length;
    descendants(orderedPanel).find(e => e.attributes['aria-label'] === 'Ordered path root').listeners.input();
    assert.equal(h.flowResults.length, count); assert.equal(h.flowResults.at(-1), current); assert.deepEqual(evidence(h.elements.get('state-evidence')), disclosure);
    h.ui.analyzeState(['root', 'sensitive']); await until(() => h.flowResults.at(-1) !== current);
    current = h.flowResults.at(-1); disclosure = evidence(h.elements.get('state-evidence')); count = h.flowResults.length;
    h.ui.cancelValues(); await settle();
    assert.equal(h.flowResults.length, count); assert.equal(h.flowResults.at(-1), current); assert.deepEqual(evidence(h.elements.get('state-evidence')), disclosure);
    assert.deepEqual(h.context.STATE_UI.pins, ['retain-unordered-pin']); assert.equal(h.catalogCount, layoutGeneration); assert(disclosure.replayRequest.replay);
  });
  test(`${transport} VF-10 real in-flight high-cardinality cancellation reaches the shared solver`, async () => {
    for (const kind of ['references', 'proofs']) {
      const { raw, request: q } = F.cardinality(kind), h = await harness(worker, raw);
      h.onAnalyzeStart(() => { h.onAnalyzeStart(null); setTimeout(() => h.ui.cancelValues(), 0); });
      const pending = h.ui.runValueQuery(q).catch(e => e); await pending;
      await until(() => h.analysisRuns.length); assert(h.analysisRuns[0].completion.cancelled, kind);
      assert.equal(evidence(h.panel), undefined, kind);
    }
  });
  test(`${transport} VF-13 relative declaration and rejected owner never invent source links`, async () => {
    const item = externalRoot(), rejected = structuredClone(item.raw.nodes[0]); rejected.id = 'rejected-owner'; rejected.attributes.flow = '{'; rejected.source_file = '/wrong.rs'; item.raw.nodes.unshift(rejected);
    F.update(item.raw, 'root', f => { f.value_facts.locals[1].source_file = 'src/lib.rs'; });
    const h = await harness(worker, item.raw), value = await h.ui.runValueQuery(item.request);
    const source = value.witnesses.items.flatMap(w => w.steps).find(s => s.kind === 'source');
    assert.equal(source.sourceIdentity.rawNodeId, 'flow:root'); assert.equal(source.source.absolute_file, null);
    assert(textOf(h.panel).includes('src/lib.rs:3')); assert(!descendants(h.panel).some(e => e.href && e.href.includes('wrong.rs')));
  });
}
if (process.env.VALUE_CAPTURE) test('fresh emitted capture modules prove dependency value propagation in actual worker and fallback', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.VALUE_CAPTURE));
  const emitted = fs.readFileSync(process.env.VALUE_HTML || path.join(path.dirname(process.env.VALUE_CAPTURE), 'graph.html'), 'utf8');
  for (const worker of [false, true]) {
    const h = await harness(worker, raw, emitted), q = capture.request(raw, 'positive');
    const value = await h.ui.runValueQuery(q), api = await Analysis.create(raw, { rawText: h.rawText }).query(q);
    assert(value.finding.candidateInfluence); assertWireEqual(value.witnesses, api.witnesses);
    assert.equal(value.graph.contentSha256, api.graph.contentSha256);
    assert(value.witnesses.items.some(w => w.steps.some(s => s.procedure === capture.procedure(raw, 'value_dependency::relay'))));
    assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href.startsWith('vscode://file/')));
    click(button(h.panel, 'Open execution flow')); assert(h.flowResults.at(-1).activeNodeIds.length);
    const replay = await h.ui.queryValues({ op: 'replay', replay: value.replay }); assertWireEqual(replay.witnesses, api.witnesses);
    await h.ui.runValueQuery(capture.request(raw, 'swapped')); assert.equal(evidence(h.panel).finding.candidateInfluence, false);
    for (const name of ['field_positive', 'references', 'bypass']) {
      const q = capture.request(raw, name), input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
      input.value = JSON.stringify(q); input.listeners.input(); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
      const direct = await Analysis.create(raw, { rawText: h.rawText }).query(q), value = evidence(h.panel);
      assertApiValue(value, direct, name + ' emitted'); assert(value.finding.candidateInfluence, name);
      assertEndpointCalls(value, q, name);
      assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href.startsWith('vscode://file/')), name + ' emitted source');
      click(button(h.panel, 'Open execution flow'));
      assertWireEqual(h.flowResults.at(-1).activeCallIds, [q.model.sources[0].at.call, q.model.sinks[0].at.call], name + ' emitted exact endpoint calls');
      assertWireEqual(h.flowResults.at(-1).activeCallTargets, [], name + ' no emitted target guess');
      assertValueDisclosure(h, value, name + ' emitted');
      click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, direct.witnesses, name + ' emitted replay');
    }
    {
      const q = capture.request(raw, 'strings'), input = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Declarative value-flow request');
      input.value = JSON.stringify(q); input.listeners.input(); click(button(h.panel, 'Run value query')); await until(() => evidence(h.panel));
      const direct = await Analysis.create(raw, { rawText: h.rawText }).query(q), value = evidence(h.panel);
      assertApiValue(value, direct, 'strings emitted'); assert.equal(value.finding.candidateInfluence, true);
      assert.equal(value.status, 'indeterminate'); assert.equal(value.partialCoverage, true); assert.equal(value.completion.complete, true);
      assertEndpointCalls(value, q, 'strings emitted');
      const witness = value.witnesses.items.find(w => w.sourceId === 'untrusted');
      assert.equal(witness.classification, 'possible');
      assert(witness.steps.some(s => s.kind === 'unknown-propagation' && s.reason === 'unsupported-reference' && s.factId === 'bb1:s0'));
      assert(witness.steps.some(s => s.kind === 'transformation' && s.summaryId === 'configured-string-transform' && s.callsiteId === q.model.summaries[0].call));
      assert(witness.steps.every(s => s.procedure === q.function && s.contextId === witness.contextId));
      assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href.startsWith('vscode://file/')), 'strings emitted source');
      click(button(h.panel, 'Open execution flow'));
      assertWireEqual([...new Set(h.flowResults.at(-1).activeCallIds)], [q.model.sources[0].at.call, q.model.summaries[0].call, q.model.sinks[0].at.call], 'strings emitted exact calls');
      assertWireEqual(h.flowResults.at(-1).activeCallTargets, [], 'strings no invented referent target');
      assertValueDisclosure(h, value, 'strings emitted');
      click(button(h.panel, 'Replay value query')); await until(() => evidence(h.panel) && evidence(h.panel).replayed);
      assertWireEqual(evidence(h.panel).witnesses, direct.witnesses, 'strings emitted replay');
    }
    for (const [name, expected, partial] of capture.reviewedCases) {
      const q = capture.request(raw, name), value = await h.ui.runValueQuery(q), direct = await Analysis.create(raw, { rawText: h.rawText }).query(q);
      assert.equal(value.finding.candidateInfluence, expected, name); assert.equal(value.partialCoverage, partial, name); assertWireEqual(value.witnesses, direct.witnesses, name);
      capture.assertReviewed(raw, name, normalized(value));
      if (expected) { click(button(h.panel, 'Open execution flow')); assert(h.flowResults.at(-1).activeNodeIds.length, name); }
      if (name === 'reused_proof') { const outer = capture.procedure(raw, 'value_dependency::outer'), body = raw.nodes.map(n => { try { return JSON.parse((n.attributes || {}).flow); } catch (_) { return null; } }).find(f => f && f.function === q.function); const sites = body.blocks.filter(b => b.callee === outer).map(b => q.function + '#' + b.id + '@call'); assert.equal(sites.length, 2); const steps = value.witnesses.items.flatMap(w => w.steps); assert(!steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === sites[0])); assert(steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === sites[1] && s.parameter === 1)); }
      if (name === 'parameter_source') assert(descendants(h.panel).some(e => e.tagName === 'a' && /:\d+$/.test(e.href)));
      const replayed = await h.ui.queryValues({ op: 'replay', replay: value.replay }); assertWireEqual(replayed.witnesses, direct.witnesses, name + ' emitted replay');
    }
  }
});
