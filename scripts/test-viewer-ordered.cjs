/* Execute the actual emitted worker/fallback and ordered controls, including existing trace views. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Analysis = require('../src/analysis-api.js');
const { siblings, exclusive, crossPackageSummary, repeatedHelpers, proc } = require('../tests/fixtures/ordered-execution/fixture-graphs.cjs');
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
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 1)); assert(check(), 'expected viewer update'); }
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
async function harness(useWorker, raw = siblings(), html = template) {
  const elements = new Map(), blobs = new Map(), workers = [], ready = deferred(), messages = [], traceInputs = [], boundedSearches = [];
  let analyzerGate = null, catalogCount = 0;
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
    const actual = target.ExecutionModel.analyzeOrdered;
    target.ExecutionModel.analyzeOrdered = (...args) => {
      if (!analyzerGate) return actual(...args);
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
    get panel() { return get('ordered-path-content'); }, get diagnostics() { return get('waterfall-diagnostics'); },
    defer() { const gate = { started: deferred(), release: deferred() }; analyzerGate = gate; return gate; },
    async refresh(next = raw) { const before = catalogCount; ui.refresh(JSON.stringify(next)); await until(() => catalogCount > before); },
    inject(value) { assert(useWorker); workers[0].onmessage({ data: value }); } };
}
function button(root, text) { const found = descendants(root).find(el => el.tagName === 'button' && el.textContent === text); assert(found, text); return found; }
function click(el) { if (el.listeners.click) el.listeners.click(); else el.onclick(); }
function evidence(root) { const pre = descendants(root).find(el => el.tagName === 'pre'); return pre && JSON.parse(pre.textContent); }
const textOf = root => descendants(root).map(el => el.textContent).join('\n');
const request = () => ({ op: 'orderedPath', function: 'root', waypoints: [proc('source'), proc('sink')] });

for (const worker of [false, true]) {
  const transport = worker ? 'worker' : 'fallback';
  test(`${transport} ordered controls use shared API semantics, snapshots and replay`, async () => {
    const h = await harness(worker), input = request(), pending = h.ui.runOrderedQuery(input);
    input.waypoints.reverse();
    const browser = await pending, api = await Analysis.create(siblings(), { rawText: h.rawText }).query(request());
    for (const key of ['graph', 'versions', 'request', 'replay', 'resolved', 'witness', 'queryCoverage', 'finding', 'completion', 'semantics'])
      assert.deepEqual(normalized(browser[key]), api[key], key + ' parity');
    assert.equal(browser.status, 'exact'); assert.equal(evidence(h.panel).witness.rootProofId, browser.witness.rootProofId);
    const replay = await h.ui.queryOrdered({ op: 'replay', replay: browser.replay });
    assert.equal(replay.replayed, true); assert.deepEqual(normalized(replay.witness), api.witness);
    assert.equal(h.context.window.__flowPerf.worker, worker);
  });

  test(`${transport} actual form parses ordered/repeated events and exclusions`, async () => {
    const h = await harness(worker);
    h.ui.setOrderedRoot('function', 'root');
    const fields = descendants(h.panel), points = fields.find(el => el.attributes['aria-label'] === 'Ordered waypoints');
    const excluded = fields.find(el => el.attributes['aria-label'] === 'Excluded operations');
    points.value = 'procedure sink\nprocedure source'; excluded.value = '';
    click(button(h.panel, 'Run ordered query')); await until(() => evidence(h.panel));
    assert.equal(evidence(h.panel).finding.definitiveNegative, true);
    assert.deepEqual(evidence(h.panel).request.waypoints, [proc('sink'), proc('source')]);
    points.value = 'procedure source\nprocedure sink'; excluded.value = 'procedure source'; points.listeners.input();
    assert.equal(evidence(h.panel), undefined);
    click(button(h.panel, 'Run ordered query')); await until(() => evidence(h.panel));
    assert.equal(evidence(h.panel).finding.definitiveNegative, true);
    assert.deepEqual(h.context.STATE_UI.pins, ['retain-unordered-pin']);
  });

  test(`${transport} selected witness opens exact flamegraph/UML events and flow proof, without a new bounded search`, async () => {
    const h = await harness(worker), value = await h.ui.runOrderedQuery(request());
    assert(descendants(h.panel).some(el => el.tagName === 'a' && el.href.startsWith('vscode://file/fixture/')));
    click(button(h.elements.get('waterfall-select-row'), 'Merged stacks'));
    assert.equal(h.context.WATERFALL_UI.stats().flameLayout, 'merged');
    click(button(h.panel, 'Open flamegraph'));
    const flame = h.traceInputs[0]; assert(flame);
    assert.equal(flame.orderedEvidence.witness.rootProofId, value.witness.rootProofId);
    assert.deepEqual(flame.orderedEvidence.replayRequest.replay.request, normalized(value.request));
    assert.deepEqual(flame.traces[0].events.filter(e => e.type === 'enter').map(e => e.function), ['root', 'source', 'sink']);
    const continuation = flame.traces[0].events.find(e => e.continuationId);
    assert.equal(continuation.callsiteId, 'root#bb0@call'); assert.equal(continuation.continuationId, 'root#bb0->root#bb1:0');
    assert.equal(h.context.WATERFALL_UI.stats().flameLayout, 'order');
    assert.equal(h.context.WATERFALL_UI.stats().variants, 1);
    assert.equal(h.context.WATERFALL_UI.stats().markers.loops, 0, 'node arrival and its call event do not create a fake loop');
    assert.equal(h.messages.filter(m => m.type === 'waterfall_query').length, 0);
    assert.match(h.elements.get('waterfall-status').textContent, /STRUCTURAL ordered witness/);
    assert(evidence(h.diagnostics).witness.steps.some(s => s.callsiteId === continuation.callsiteId));
    click(button(h.panel, 'Open UML sequence')); assert.equal(h.context.WATERFALL_UI.stats().mode, 'sequence');
    const seq = h.context.TraceWaterfall.sequenceProject(h.traceInputs[1].traces[0]);
    assert.deepEqual(normalized(seq.messages.filter(m => m.type === 'call').map(m => m.to)), ['source', 'sink']);
    click(button(h.panel, 'Open execution flow')); assert(h.flowResults.length);
    const flow = h.flowResults.at(-1); assert(flow.activeCallIds.includes('root#bb0@call'));
    assert(flow.activeEdgeIds.includes('root#bb0->root#bb1:0')); assert.equal(h.focus.at(-1), 'root');
    assert.equal(evidence(h.elements.get('state-evidence')).witness.rootProofId, value.witness.rootProofId);
    assert.deepEqual(h.context.STATE_UI.pins, ['retain-unordered-pin']);
  });

  test(`${transport} conditions and exact identities survive the trace bridge`, async () => {
    const h = await harness(worker, exclusive());
    const value = await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', target: proc('source') });
    click(button(h.panel, 'Open UML sequence'));
    const branch = h.traceInputs[0].traces[0].events.find(e => e.edgeId === 'root#bb0->root#bb1:0');
    assert.equal(branch.branch, 'flag = true'); assert.equal(branch.predicate, 'flag');
    assert.equal(h.traceInputs[0].orderedEvidence.witness.rootProofId, value.witness.rootProofId);
  });

  test(`${transport} cross-package summary sources use the actual caller file and line in both evidence lists`, async () => {
    for (const attribute of ['source_absolute', 'target_src_path']) {
      const h = await harness(worker, crossPackageSummary(attribute));
      const value = await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', target: proc('callee') });
      const proof = evidence(h.panel), step = proof.witness.steps.find(s => s.kind === 'summary'); assert(step);
      const summary = proof.witness.summaries.find(s => s.id === step.summaryId); assert(summary);
      for (const item of [step, summary]) {
        assert.equal(item.procedure, 'callee'); assert.equal(item.identity.packageId, 'pkg-b');
        assert.equal(item.sourceProcedure, 'root'); assert.equal(item.sourceIdentity.packageId, 'pkg-a');
        assert.deepEqual(item.source, { source_file: 'src/lib.rs', source_location: 12, absolute_file: '/pkg-a/src/lib.rs' });
      }
      const row = descendants(h.panel).find(el => el.className === 'ordered-step' && el.textContent.includes('. summary · '));
      assert(descendants(row).some(el => el.tagName === 'a' && el.href === 'vscode://file/pkg-a/src/lib.rs:12'));
      click(button(h.panel, 'Open flamegraph'));
      const trace = h.traceInputs[0], projected = trace.traces[0].events.find(e => e.orderedStep === value.witness.steps.findIndex(s => s.kind === 'summary'));
      assert.equal(projected.source_file, '/pkg-a/src/lib.rs'); assert.equal(projected.source_location, 12);
      assert.deepEqual(evidence(h.diagnostics).witness.summaries, proof.witness.summaries);
    }
  });

  for (const loop of [false, true]) test(`${transport} ${loop ? 'loop' : 'sibling'} summary reuse mounts known helper invocations and proven returns`, async () => {
    const h = await harness(worker, repeatedHelpers(loop));
    const waypoints = loop ? [proc('source'), proc('source'), proc('source'), proc('sink')] : [proc('sink')];
    const value = await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', waypoints });
    assert.equal(value.status, 'exact'); assert.equal(value.witness.truncated, false);
    click(button(h.panel, 'Open flamegraph'));
    const trace = h.traceInputs[0].traces[0], sites = loop ? ['root#bb1@call', 'root#bb2@call'] : ['root#bb0@call', 'root#bb1@call'];
    const expectedSites = Array(loop ? 3 : 1).fill(sites).flat();
    const expectedContinuations = Array(loop ? 3 : 1).fill(loop ? ['root#bb1->root#bb2:0', 'root#bb2->root#bb3:0'] :
      ['root#bb0->root#bb1:0', 'root#bb1->root#bb2:0']).flat();
    assert.deepEqual(trace.events.filter(e => e.type === 'call' && e.callee === 'helper').map(e => e.callsiteId), expectedSites);
    assert.deepEqual(trace.events.filter(e => e.type === 'branch' && sites.includes(e.callsiteId)).map(e => e.continuationId), expectedContinuations);
    const frames = descendants(h.elements.get('waterfall-detail')).filter(el => el.tagName === 'rect' &&
      (el.attributes['aria-label'] || '').startsWith('Inspect and zoom helper ·'));
    assert.equal(frames.length, expectedSites.length);
    for (let i = 0; i < frames.length; i++) {
      assert(frames[i].attributes['aria-label'].includes('callsite ' + expectedSites[i]));
      assert(frames[i].attributes['aria-label'].includes('continuation ' + expectedContinuations[i]));
      assert(!/uncertain|unknown|unexpanded/.test(frames[i].attributes['aria-label']));
    }
    const summarized = frames.filter(el => el.attributes['aria-label'].includes('proven normal summary'));
    assert.equal(summarized.length, loop ? 3 : 1);
    click(summarized[0]); assert.match(textOf(h.elements.get('waterfall-info')), /proven normal summary/);
    assert(!/\(unexpanded target\)/.test(textOf(h.elements.get('waterfall-detail'))));
    click(button(h.panel, 'Open UML sequence'));
    const sequence = h.context.TraceWaterfall.sequenceProject(h.traceInputs[1].traces[0]);
    const calls = sequence.messages.filter(m => m.type === 'call' && m.to === 'helper');
    const returns = sequence.messages.filter(m => m.type === 'return' && m.from === 'helper');
    assert.deepEqual(normalized(calls.map(m => m.callsiteId)), expectedSites);
    assert.deepEqual(normalized(returns.map(m => m.continuationId)), expectedContinuations);
    assert.equal(returns.length, expectedSites.length);
    const known = returns.filter(m => m.summaryOutcome === 'normal'); assert.equal(known.length, loop ? 3 : 1);
    assert(known.every(m => m.summaryId && m.callsiteId === sites[1]));
    const mounted = textOf(h.elements.get('waterfall-detail'));
    assert.match(mounted, /return \(proven normal summary\)/); assert.match(mounted, /proven normal continuation/);
    assert(!/unexpanded target|unexpanded \/ bounded|callee not entered; no recorded return/.test(mounted));
    assert.equal(h.boundedSearches.length, 0); assert.equal(h.messages.filter(m => m.type === 'waterfall_query').length, 0);
  });

  test(`${transport} evidence-budget truncation stays visibly partial in the mounted view`, async () => {
    const h = await harness(worker, repeatedHelpers());
    const value = await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', target: proc('sink'), budgets: { maxEvidence: 1 } });
    assert.equal(value.status, 'exact'); assert.equal(value.witness.truncated, true);
    click(button(h.panel, 'Open flamegraph'));
    assert.equal(h.traceInputs[0].traces[0].complete, false);
    assert.equal(evidence(h.diagnostics).witness.truncated, true);
    assert.match(h.elements.get('waterfall-status').textContent, /evidence truncated/);
  });

  test(`${transport} actual top-level trace tab retains a selected proof; explicit entry, pins and reset explore ordinarily`, async () => {
    const h = await harness(worker, repeatedHelpers(true));
    h.context.WATERFALL_UI.setPins(['helper']);
    await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', waypoints: [proc('source'), proc('source'), proc('source'), proc('sink')] });
    click(button(h.panel, 'Open flamegraph'));
    const summarized = descendants(h.elements.get('waterfall-detail')).find(el => el.tagName === 'rect' &&
      (el.attributes['aria-label'] || '').includes('proven normal summary')); assert(summarized); click(summarized);
    const proof = evidence(h.diagnostics), status = h.elements.get('waterfall-status').textContent;
    const source = textOf(h.elements.get('waterfall-info')); assert.match(source, /\/fixture\/src\/lib\.rs:3/);
    const labels = textOf(h.elements.get('waterfall-head')), before = normalized(h.context.WATERFALL_UI.stats());
    for (const other of ['mode-architecture', 'mode-state']) {
      click(h.elements.get(other)); assert.equal(h.context.WATERFALL_UI.stats().active, false);
      click(h.elements.get('mode-waterfall')); await settle();
      assert.deepEqual(evidence(h.diagnostics), proof); assert.equal(h.elements.get('waterfall-status').textContent, status);
      assert.equal(textOf(h.elements.get('waterfall-head')), labels); assert.equal(textOf(h.elements.get('waterfall-info')), source);
      assert.deepEqual(normalized(h.context.WATERFALL_UI.stats()), before);
      click(h.elements.get('mode-waterfall')); await settle();
      assert.deepEqual(evidence(h.diagnostics), proof); assert.deepEqual(normalized(h.context.WATERFALL_UI.stats()), before);
      assert.equal(textOf(h.elements.get('waterfall-info')), source);
    }
    assert.equal(h.boundedSearches.length, 0); assert.equal(h.messages.filter(m => m.type === 'waterfall_query').length, 0);
    const actions = [() => h.elements.get('waterfall-entry').onchange(),
      () => h.context.WATERFALL_UI.setPins(['sink']), () => click(h.elements.get('waterfall-reset'))];
    for (const action of actions) {
      click(button(h.panel, 'Open flamegraph')); const count = h.boundedSearches.length;
      action(); assert.equal(h.context.WATERFALL_UI.hasWitness(), false); assert.equal(evidence(h.diagnostics), undefined);
      await until(() => h.boundedSearches.length > count);
      assert.equal(h.boundedSearches.at(-1).maxVisits, 2);
    }
    click(button(h.panel, 'Open flamegraph')); click(h.elements.get('mode-architecture'));
    const count = h.boundedSearches.length; h.context.WATERFALL_UI.setPins(['helper']);
    assert.equal(h.context.WATERFALL_UI.hasWitness(), false); assert.equal(evidence(h.diagnostics), undefined);
    click(h.elements.get('mode-waterfall')); await until(() => h.boundedSearches.length > count);
    assert.deepEqual(h.boundedSearches.at(-1).pins, ['helper']);
  });

  test(`${transport} capture changes, cancellation and errors invalidate evidence and fence stale ordered replies`, async () => {
    const h = await harness(worker); await h.ui.runOrderedQuery(request());
    const gate = h.defer(), stale = h.ui.runOrderedQuery(request()); const rejected = stale.catch(error => error);
    assert.equal(evidence(h.panel), undefined); await gate.started.promise;
    const accepted = await h.ui.runOrderedQuery({ ...request(), waypoints: [proc('source')] });
    gate.release.reject(new Error('stale-error')); await rejected; await settle();
    assert.equal(evidence(h.panel).witness.rootProofId, accepted.witness.rootProofId);
    assert(!descendants(h.panel).some(el => /stale-error/.test(el.textContent)));
    const failed = await h.ui.runOrderedQuery({ op: 'orderedPath', function: 'root', waypoints: [{ kind: 'invalid', id: 'sink' }] }).catch(error => error);
    assert(failed instanceof Error || failed.message); assert.equal(evidence(h.panel), undefined);
    await h.ui.runOrderedQuery(request()); click(button(h.panel, 'Open flamegraph')); assert(evidence(h.diagnostics));
    await h.refresh(); assert.equal(evidence(h.panel), undefined); assert.equal(evidence(h.diagnostics), undefined);
    const cancelGate = h.defer(), cancelled = h.ui.runOrderedQuery(request()).catch(error => error); await cancelGate.started.promise;
    click(button(h.panel, 'Cancel ordered query')); cancelGate.release.resolve(); await cancelled; await settle();
    assert.equal(evidence(h.panel), undefined);
  });

  test(`${transport} opening a proof fences an older bounded-waterfall result`, async () => {
    const h = await harness(worker); await h.ui.runOrderedQuery(request());
    if (worker) {
      h.ui.queryWaterfall({ root: 'root', pins: [], maxPaths: 1 });
      const old = h.messages.findLast(m => m.type === 'waterfall_query'); assert(old);
      h.inject({ type: 'waterfall_error', generation: old.generation, catalogToken: old.catalogToken, message: 'current bounded error' });
      assert.match(h.elements.get('waterfall-status').textContent, /current bounded error/);
      click(button(h.panel, 'Open flamegraph'));
      const before = evidence(h.diagnostics);
      h.inject({ type: 'waterfall_result', generation: old.generation, catalogToken: old.catalogToken,
        result: { traces: [], limits: {}, diagnostics: ['stale bounded result'] } });
      h.inject({ type: 'waterfall_error', generation: old.generation, catalogToken: old.catalogToken, message: 'stale bounded error' });
      await settle(); assert.deepEqual(evidence(h.diagnostics), before);
    } else {
      const original = h.context.ExecutionFlow.begin; let runs = 0;
      h.context.ExecutionFlow.begin = () => ({ done: false, run() { runs++; } });
      h.ui.queryWaterfall({ root: 'root', pins: [] }); await until(() => runs > 0);
      click(button(h.panel, 'Open flamegraph')); const before = evidence(h.diagnostics);
      await settle(); h.context.ExecutionFlow.begin = original;
      assert.deepEqual(evidence(h.diagnostics), before);
    }
  });
}

if (process.env.ORDERED_CAPTURE && process.env.ORDERED_HTML) for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} executes fresh emitted modules and exact witness view bridge`, async () => {
    const data = JSON.parse(fs.readFileSync(process.env.ORDERED_CAPTURE, 'utf8'));
    const html = fs.readFileSync(process.env.ORDERED_HTML, 'utf8');
    const h = await harness(worker, data, html), api = Analysis.create(data, { rawText: h.rawText });
    const packages = await api.query({ op: 'packages', page: { limit: 100 } });
    const matches = packages.packages.items.filter(p => p.name === 'ordered-fixture'); assert.equal(matches.length, 1);
    const pkg = matches[0], inventory = await api.query({ op: 'functions', scope: { packageIds: [pkg.id] }, page: { limit: 100 } });
    assert.equal(inventory.functions.truncated, false);
    const find = name => {
      const displayPath = 'ordered_fixture::' + name, rows = inventory.functions.items.filter(r => r.displayPath === displayPath);
      assert.equal(rows.length, 1, displayPath);
      const row = rows[0]; assert.equal(row.packageId, pkg.id); assert.equal(row.body.status, 'captured');
      assert(row.body.procedure, 'exact captured procedure ' + displayPath); return row.body.procedure;
    };
    const entry = find('ordered'), source = find('source'), sink = find('sink');
    const value = await h.ui.runOrderedQuery({ op: 'orderedPath', function: entry, waypoints: [proc(source), proc(sink)] });
    assert.equal(value.status, 'exact'); click(button(h.panel, 'Open UML sequence'));
    assert.equal(h.traceInputs[0].orderedEvidence.witness.rootProofId, value.witness.rootProofId);
    assert(h.traceInputs[0].traces[0].events.some(e => e.callsiteId));
    assert.equal((await h.ui.runOrderedQuery({ op: 'orderedPath', function: entry, waypoints: [proc(sink), proc(source)] })).status, 'impossible');
  });
}
