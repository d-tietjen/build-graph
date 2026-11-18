#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'viewer.html'), 'utf8');
const start = html.indexOf('var GRAPH_SRC =');
const end = html.indexOf('var RELOAD_BUSY', start);
assert.ok(start >= 0 && end > start, 'external graph loader is present');
const countsStart = html.indexOf('function nativeEvidenceCount(');
const countsEnd = html.indexOf('function nativeEvidence(', countsStart);
assert.ok(countsStart >= 0 && countsEnd > countsStart);
const loader = html.slice(countsStart, countsEnd) + html.slice(start, end);

function harness(inline = '') {
  const requests = [];
  const overlay = { textContent: '', innerHTML: '' };
  const context = {
    Date: { now: () => 123 }, TextDecoder, Uint8Array, Promise,
    location: { protocol: 'http:' },
    document: { getElementById(id) {
      if (id === 'graph-data') return { textContent: inline };
      if (id === 'overlay') return overlay;
      throw new Error('unexpected element ' + id);
    } },
    fetch(url, options) {
      requests.push({ url, options });
      const bytes = new TextEncoder().encode('{"nodes":[{"id":"fresh"}],"edges":[]}');
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    }
  };
  vm.runInNewContext(loader, context);
  return { context, requests, overlay };
}

function loaded(context, opts) {
  return new Promise((resolve, reject) => context.loadData(resolve,
    Object.assign({ onError: reject }, opts)));
}

test('first external graph fetch bypasses a previously cached graph.json', async () => {
  const { context, requests } = harness();
  const result = await loaded(context, { raw: true });
  assert.match(result, /"fresh"/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'graph.json?t=123');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('external gzip name and existing query survive fresh initial and refresh fetches', async () => {
  const { context, requests } = harness();
  context.GRAPH_SRC = 'graph.json.gz?capture=v13';
  await loaded(context);
  await loaded(context, { forceFetch: true, noStore: true, raw: true });
  assert.deepEqual(requests.map(request => request.url), [
    'graph.json.gz?capture=v13&t=123', 'graph.json.gz?capture=v13&t=123'
  ]);
  assert.ok(requests.every(request => request.options.cache === 'no-store'));
});

test('inline graph data stays inline unless a refresh explicitly forces fetch', async () => {
  const { context, requests } = harness('{"nodes":[{"id":"inline"}],"edges":[]}');
  const result = await loaded(context);
  assert.equal(result.nodes[0].id, 'inline');
  assert.equal(requests.length, 0);
  await loaded(context, { forceFetch: true, noStore: true });
  assert.equal(requests.length, 1);
});

test('external fetch errors still report the graph URL and call onError', async () => {
  const { context, requests, overlay } = harness();
  context.GRAPH_SRC = 'graph.json.gz';
  context.fetch = (url, options) => {
    requests.push({ url, options });
    return Promise.reject(new Error('offline'));
  };
  await assert.rejects(loaded(context), /offline/);
  assert.match(overlay.textContent, /could not load graph.json.gz: offline/);
});

test('sidebar icons switch panels with clicks and keyboard while keeping panel state', () => {
  const start = html.indexOf('function mountSidebarNavigation(');
  const end = html.indexOf('var MEASUREMENT_HEAT', start);
  assert.ok(start >= 0 && end > start, 'sidebar navigation helper found');
  const markup = html.slice(html.indexOf('<div id="sidebar-nav"'), html.indexOf('<div id="state-side"'));
  const tabs = Array.from(markup.matchAll(/<button id="(sidebar-[^"]+)"[^>]*aria-label="([^"]+)" aria-controls="([^"]+)"/g),
    ([, id, label, panel]) => ({
      id, panel, listeners: {}, attributes: { 'aria-controls': panel, 'aria-label': label },
      getAttribute(name) { return this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      focus() { this.focused = true; }
    }));
  assert.equal(tabs.length, 13);
  const side = { scrollTop: 27 };
  const title = { textContent: 'Graph controls' };
  const panels = new Map(tabs.map((tab, index) => {
    assert.ok(html.includes('id="' + tab.panel + '"'), 'tab controls a real panel');
    return [tab.panel, { id: tab.panel, hidden: index !== 0 }];
  }));
  const doc = { getElementById(id) {
    if (id === 'side') return side;
    if (id === 'sidebar-title') return title;
    if (id === 'sidebar-nav') return { querySelectorAll: () => tabs };
    return panels.get(id);
  } };
  const context = {};
  vm.runInNewContext(html.slice(start, end), context);
  const changes = [];
  const open = context.mountSidebarNavigation(doc, panel => changes.push(panel));
  const active = () => Array.from(panels.values()).filter(panel => !panel.hidden).map(panel => panel.id);
  const comments = tabs.find(tab => tab.panel === 'comments-panel');
  assert.deepEqual(active(), ['graph-panel']);
  comments.listeners.click();
  assert.deepEqual(active(), ['comments-panel']);
  assert.equal(title.textContent, 'Comments and documentation');
  assert.equal(comments.title, 'Comments and documentation');
  assert.equal(comments.attributes['aria-selected'], 'true');
  assert.equal(comments.tabIndex, 0);
  assert.equal(side.scrollTop, 0);
  side.scrollTop = 85;
  let prevented = false;
  comments.listeners.keydown({ key: 'Home', preventDefault() { prevented = true; } });
  assert.deepEqual(active(), ['graph-panel']);
  assert.equal(title.textContent, 'Graph controls');
  assert.equal(side.scrollTop, 27);
  assert.ok(prevented && tabs[0].focused);
  open('comments-panel');
  assert.equal(side.scrollTop, 85);
  open('ordered-path-panel');
  assert.deepEqual(active(), ['ordered-path-panel']);
  assert.equal(comments.tabIndex, -1);
  assert.deepEqual(changes, ['comments-panel', 'graph-panel', 'comments-panel', 'ordered-path-panel']);
});

test('each analysis tab intersects its data scope with the current graph filters', () => {
  const begin = html.indexOf('var FIELD_PANEL =');
  const end = html.indexOf('function mountSidebarNavigation(', begin);
  assert.ok(begin >= 0 && end > begin);
  const linksStart = html.indexOf('function architectureLinkEnabled(');
  const linksEnd = html.indexOf('function architectureLinkDirected(', linksStart);
  const context = {
    FIELD_SCOPE: null, ARCH_EDGE_FILTER: null, linkSourceId: link => link.source, linkTargetId: link => link.target
  };
  vm.runInNewContext(html.slice(begin, end) + html.slice(linksStart, linksEnd), context);
  const graph = { byId: {
    app: { kind: 'package', packageId: 'application' },
    dep: { kind: 'package', packageId: 'dependency' },
    run: { kind: 'function', path: 'app::run', bodyStatus: 'captured_mir', source_file: 'app.rs' },
    helper: { kind: 'method', path: 'app::helper', flowPaths: ['helper::monomorphized'] },
    boundary: { kind: 'boundary' },
    type: { kind: 'struct', source_file: 'app.rs' }
  } };
  assert.equal(Object.keys(context.FIELD_PANELS).length, 12);
  const base = new Set(['app', 'dep', 'run', 'helper', 'type']);
  const scope = (panel, evidence) => context.fieldScope(graph, panel, evidence, base);
  assert.equal(scope('graph-panel'), null);
  assert.deepEqual(Array.from(scope('advisory-panel').visible), ['app', 'dep']);
  assert.deepEqual(Array.from(scope('comments-panel').visible), ['run', 'type']);
  assert.deepEqual(Array.from(scope('call-paths-panel').visible), ['run', 'helper']);
  assert.deepEqual(Array.from(scope('ordered-path-panel').visible), ['run']);
  assert.deepEqual(Array.from(scope('advisory-panel', { nodes: new Set(['package:dependency']) }).visible), ['dep']);
  assert.deepEqual(Array.from(scope('comments-panel', { nodes: new Set(['type']) }).visible), ['type']);
  context.FIELD_SCOPE = scope('call-paths-panel', {
    nodes: new Set(['app::run', 'helper::monomorphized', 'boundary']),
    pairs: new Set(['run\thelper'])
  });
  assert.deepEqual(Array.from(context.FIELD_SCOPE.visible), ['run', 'helper']);
  assert.ok(context.architectureLinkEnabled({ source: 'run', target: 'helper', cat: 'call' }));
  assert.ok(!context.architectureLinkEnabled({ source: 'helper', target: 'run', cat: 'call' }));
  assert.ok(!context.architectureLinkEnabled({ source: 'run', target: 'helper', cat: 'contains' }));
  context.ARCH_EDGE_FILTER = new Set(['contains']);
  assert.ok(!context.architectureLinkEnabled({ source: 'run', target: 'helper', cat: 'call' }));
  assert.deepEqual(Array.from(base), ['app', 'dep', 'run', 'helper', 'type']);
  let activations = 0;
  Object.assign(context, { G: null, ARCH_ACTIVE: false, applyTreeVisibility() {},
    FLOW_UI: { activateArchitecture() { activations++; } } });
  context.showFieldPanel('comments-panel');
  assert.equal(activations, 0, 'early tabs do not start a second graph load');
  context.G = graph;
  context.showFieldPanel('comments-panel');
  assert.equal(activations, 1, 'reselecting a tab returns to Field from a drilldown');
});

for (const external of [false, true]) test(`Architecture bootstrap uses ${external ? 'the worker URL' : 'inline data'}`, () => {
  const begin = html.lastIndexOf('function openArchitecture(parsed) {');
  const end = html.indexOf('</script>', begin);
  assert.ok(begin >= 0 && end > begin, 'final graph bootstrap callback found');
  const actions = [];
  const data = { nodes: [{ id: 'fresh' }], edges: [] };
  const { context, requests } = harness(external ? '' : JSON.stringify(data));
  Object.assign(context, {
    location: { protocol: 'http:', href: 'http://localhost/graph.html' },
    URL,
    Worker: function () {},
    setSupplyCatalog(data) { actions.push('catalog:' + data.nodes.length); },
    setupFlowUI(capture, ready, workerSource) {
      assert.equal(typeof ready, 'function');
      assert.match(workerSource, /function displayCapture/);
      if (external) {
        assert.equal(capture.url, 'http://localhost/graph.json?t=123');
        actions.push('worker');
        queueMicrotask(() => capture.onArchitecture(data));
      } else assert.equal(capture, JSON.stringify(data));
      return { activateArchitecture() { actions.push('activate'); } }; },
    buildG(data) { actions.push('build:' + data.nodes.length); return { nodes: data.nodes }; },
    seedLayout(graph) { actions.push('seed:' + graph.nodes.length); },
    setEngine() {}
  });
  vm.runInContext('"use strict";\nvar G = null, ARCH_FIELD_G = null, FLOW_UI = null, ARCH_ACTIVE = false;\n' +
    html.slice(begin, end), context);
  return Promise.resolve().then(() => {
    assert.deepEqual(actions, [...(external ? ['worker'] : []), 'catalog:1', 'build:1', 'seed:1', 'activate']);
    assert.equal(requests.length, 0);
    assert.equal(context.G, context.ARCH_FIELD_G);
    assert.equal(context.G.nodes[0].id, 'fresh');
  });
});

test('worker transport preserves Field topology and native evidence counts', () => {
  const { context } = harness();
  const nodes = [
    { id: 'method', label: 'method', source_file: 'src/lib.rs', source_location: 10,
      attributes: { kind: 'method', crate: 'app', path: 'app::method', package_id: 'app' } },
    { id: 'body', label: 'body', attributes: { kind: 'flow_function', symbol_id: 'method', flow: 'body data' } },
    { id: 'native', label: 'native', attributes: { kind: 'function', language: 'native',
      native_direct_calls: '[{"symbol":"one"},{"symbol":"two"}]', native_call_diagnostics: '[]' } }
  ];
  const edges = [{ source: 'body', target: 'native', relation: 'native_calls', weight: 1 },
    { source: 'method', target: 'outside-capture', relation: 'uses' }];
  const packed = context.displayCapture({ nodes, edges });
  assert.equal(packed.edges.byteLength, edges.length * 3 * 4);
  const result = context.expandDisplayCapture(packed);
  assert.deepEqual(Array.from(result.nodes, n => n.id), nodes.map(n => n.id));
  assert.deepEqual({ ...result.nodes[0].attributes }, nodes[0].attributes);
  assert.equal(result.nodes[1].attributes.symbol_id, 'method');
  assert.equal(nodes[1].attributes.flow, 'body data');
  assert.equal(result.nodes[1].attributes.flow, undefined);
  assert.equal(result.nodes[2].attributes.native_direct_calls, 2);
  assert.equal(result.nodes[2].attributes.native_call_diagnostics, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.edges)), edges.map(({ source, target, relation }) => ({ source, target, relation })));
});

test('streamed captures preserve nested records, UTF-8 and the original digest for plain and gzip input', async () => {
  const text = JSON.stringify({ meta: { revision: '☕🌱', delimiters: '"}],:\\' },
    edges: [{ source: 'x', target: 'y', weights: [1, 2] }], nodes: [{ id: 'x' }, { id: 'y' }], output_tokens: 0 });
  const original = Buffer.from(text);
  const sha256 = createHash('sha256').update(original).digest('hex');
  for (const bytes of [original, gzipSync(original)]) {
    const { context } = harness();
    Object.assign(context, { ReadableStream, DecompressionStream, AnalysisEvidence: require('../src/analysis-evidence.js'),
      fetch: async () => ({
        ok: true, body: new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          }
        }),
        arrayBuffer() { throw new Error('stream must not allocate the complete response'); }
      })
    });
    const { data, sha256: actual } = await context.readWorkerCapture('http://localhost/graph.json');
    assert.equal(JSON.stringify(data), text);
    assert.equal(actual, sha256);
  }
  const { context } = harness();
  for (const invalid of ['{"nodes":[1,]}', '{"nodes":[],"edges":[', '{"nodes":[],"edges":[]} more']) {
    const parser = context.captureParser();
    assert.throws(() => { for (const char of invalid) parser.append(char); parser.finish(); }, /Invalid|Unexpected/);
  }
});

test('the execution worker loads the capture once and posts Architecture before indexing', async () => {
  const { context } = harness();
  const start = html.indexOf('function flowWorkerMain() {');
  const end = html.indexOf('function showAnalysisEvidence(', start);
  assert.ok(start >= 0 && end > start);
  const graph = { nodes: [{ id: 'body', attributes: { flow: 'retained in worker' } }], edges: [] };
  const model = { procedures: [{ id: 'p', nodeIds: ['p#bb0'] }],
    nodes: new Array(32769).fill({ id: 'p#bb0', procedure: 'p' }), edges: [{ from: 'p#bb0', to: 'p#bb1' }],
    calls: [{ id: 'call', procedure: 'p', targets: ['target'], condition: 'only needed by the statechart' }] };
  const messages = [];
  let reads = 0;
  Object.assign(context, {
    self: { postMessage(message) { messages.push(message); } },
    async readWorkerCapture(url) {
      assert.equal(url, 'http://localhost/graph.json?t=123');
      reads++;
      return { data: graph, sha256: 'bytes' };
    },
    ExecutionFlow: {
      catalog(data) {
        assert.equal(messages[0].type, 'architecture');
        assert.equal(data.nodes[0].attributes.flow, 'retained in worker');
        return { functions: new Map(), calls: new Map() };
      },
      applyModelTargets() {}
    },
    ExecutionModel: { build: () => model },
    ExecutionModelView: { layout: model => model },
    AnalysisEvidence: { create(data, options) {
      assert.equal(data, graph);
      assert.equal(options.sha256, 'bytes');
      assert.equal(options.deferIndexes, true);
      return { graph: { contentSha256: 'capture', sha256: 'bytes' } };
    } },
    CallGraph: { build: () => ({ nodes: [], edges: [] }), layout: graph => graph },
    EntryEffects: { build: () => ({}) },
    CallPaths: { create: () => ({}) },
    AdvisoryExposure: { create: () => ({}) },
    CommentSearch: { create: () => ({}) },
    PerformanceMeasurements: { create: () => ({}) },
    AnalysisSnapshot: { admitCapture() { throw new Error('revision indexing should be lazy'); } }
  });
  vm.runInContext(html.slice(start, end) + '\nflowWorkerMain();', context);
  await context.self.onmessage({ data: { type: 'init', generation: 1, url: 'http://localhost/graph.json?t=123' } });
  assert.equal(reads, 1);
  assert.deepEqual(messages.map(message => message.type), ['architecture', 'ready']);
  assert.equal(messages[0].graph.nodes[0].attributes.flow, undefined);
  assert.equal(messages[1].revisionCapture, 'capture');
  assert.equal(messages[1].deferredStatechart, true);
  assert.equal(messages[1].statechart.nodes.length, 0);
  assert.equal(messages[1].statechart.procedures[0].nodeIds, undefined);
  assert.equal(messages[1].statechart.calls[0].targets[0], 'target');
  assert.equal(messages[1].statechart.calls[0].condition, undefined);
  await context.self.onmessage({ data: { type: 'statechart_request', generation: 0 } });
  assert.equal(messages.length, 2, 'stale requests cannot attach another capture');
  await context.self.onmessage({ data: { type: 'statechart_request', generation: 1 } });
  assert.equal(messages[2].type, 'statechart_ready');
  assert.equal(messages[2].statechart, model);
});

test('flow view starts a single transfer and replays queued actions against complete data', () => {
  const start = html.indexOf('function deferStatechart(');
  const end = html.indexOf('var SIDEBAR_NAV = null;', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(html.slice(start, end), context);
  const events = [], pins = [];
  const view = context.deferStatechart({
    setData(model) { events.push('install:' + model.nodes.length); },
    hasProcedure: () => false,
    activate(active) { events.push('active:' + active); },
    focus(id) { events.push('focus:' + id); },
    pin(id) { pins.push(id); events.push('pin:' + id); },
    setAnalysis() { events.push('analysis'); },
    get pins() { return pins.slice(); }
  });
  view.defer([{ id: 'p' }], () => events.push('request'));
  assert.equal(view.hasProcedure('p'), true);
  assert.deepEqual(events, []);
  view.setAnalysis({});
  view.focus('p');
  view.activate(true);
  view.pin('p', () => events.push('pinned'));
  assert.deepEqual(events, ['request', 'active:true']);
  view.setData({ nodes: [{ id: 'p#0' }] });
  assert.deepEqual(events, ['request', 'active:true', 'install:1', 'analysis', 'focus:p', 'pin:p', 'pinned']);
  assert.deepEqual(view.pins, ['p']);
});
