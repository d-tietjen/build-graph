#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SupplyChain = require('../src/supply-chain.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'viewer.html'), 'utf8');
const output = fs.readFileSync(path.join(__dirname, '..', 'src', 'output.rs'), 'utf8');
assert.ok(html.includes('<script id="supply-chain-source">/*__SUPPLY_CHAIN_JS__*/</script>'));
assert.match(output, /include_str!\("supply-chain\.js"\)/);
assert.doesNotMatch(html, /id="filter-by"|id="supply-list"|id="supply-depth"/,
  'packages and source share one sidebar tree');

function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start + ' extraction markers');
  return html.slice(a, b);
}
const counts = { textContent: '' };
const context = { SupplyChain, Map, Set, PALETTE: ['#58a6ff'], DEFAULT_COLOR: '#8b949e',
  document: { getElementById(id) { assert.equal(id, 'counts'); return counts; } },
  kindOf(node) { return node.attributes.kind; },
  crateOf(node) { return node.attributes.crate || ''; },
  linkSourceId(link) { return link.sid || link.source; },
  linkTargetId(link) { return link.tid || link.target; }
};
vm.runInNewContext(
  between('function relCat(rel) {', '// Human label for a (relation, direction)') +
  between('function displaySourcePath(n) {', 'var G = null;') +
  between('var SUPPLY_INDEX = null;', 'function pinKey(pins)') +
  between('function buildG(data) {', 'function mergeGraph(prev, next) {'), context);

function crate(id, name, packageId, version, source, workspace, dependency) {
  return { id, label: name, source_file: name + '/Cargo.toml', attributes: {
    kind: 'crate', crate: name, package_id: packageId, version,
    package_source: source, workspace_member: String(workspace),
    supply_chain_dependencies: JSON.stringify(dependency ? [
      { package_id: dependency, name: dependency.toLowerCase(), kind: 'normal', target: null }
    ] : []) } };
}
function item(id, kind, crateName, packageId, sourceFile, extra = {}) {
  return { id, label: id, source_file: sourceFile || null, attributes: Object.assign({
    kind, crate: crateName, package_id: packageId || undefined
  }, extra) };
}
const raw = { nodes: [
  crate('appCrate', 'app', 'A', '1.0.0', null, true, 'B'),
  crate('depCrate', 'serde', 'B', '1.0.0', 'registry+example', false, 'C'),
  crate('leafCrate', 'serde', 'C', '2.0.0', 'git+https://example', false),
  crate('otherCrate', 'serde', 'E', '1.0.0', '/vendor/serde', false),
  crate('emptyCrate', 'empty', 'D', '0.1.0', 'registry+empty', false),
  item('appModule', 'module', 'app', null, 'crates/app/src/lib.rs'),
  item('appRich', 'function', 'app', null, 'crates/app/src/lib.rs'),
  item('appFlow', 'flow_function', 'app', 'A', 'crates/app/src/lib.rs',
    { path: 'app::f', symbol_id: 'appRich' }),
  item('depFn', 'function', 'serde', 'B', '/registry/serde/src/lib.rs'),
  item('leafFn', 'function', 'serde', 'C', '/git/serde/src/lib.rs'),
  item('ownedNative', 'function', '', 'B', null,
    { language: 'native', native_artifact: 'libcrypto.so' }),
  item('unownedNative', 'function', 'serde', null, null,
    { language: 'native', native_artifact: 'libcrypto.so' }),
  item('unresolvedNative', 'function', 'serde', null, null,
    { language: 'native', native_boundary_kind: 'unresolved_symbol',
      native_call_origin_artifact: 'libcrypto.so' }),
  item('unknownRust', 'function', 'serde', null, null),
  item('fakeStd', 'function', 'std', null, 'src/std.rs'),
  item('sysrootBoundary', 'function', 'core', null, null,
    { language: 'rust', native_artifact: '/toolchain/lib/rustlib/target/lib/libcore.rmeta' })
], edges: [] };
raw.nodes[0].attributes.capture_summary = JSON.stringify({
  policy: 'workspace_and_compiler_reachable_dependencies',
  scopes: [{ capture_scope: 'workspace', captured: 10, validated: 9, imported: 7 }]
});
context.setSupplyCatalog(raw);
const graph = context.buildG(raw);
const roots = new Map(graph.sourceTree.map(root => [root.key, root]));
function folder(key) {
  return graph.sourceTree.flatMap(root => root.children).find(node => node.key === key);
}
assert.equal(graph.byId.appFlow, undefined, 'rich-owned flow remains one callable');
assert.deepEqual(Array.from(roots.keys()), ['bucket:rust', 'bucket:library', 'bucket:dependencies'],
  'the primary source tree has exactly Rust, Library, and Dependencies top folders');
assert.ok(context.isToolchainArtifact('/toolchain/lib/rustlib/target/lib/libcore.rmeta'));
assert.equal(context.isToolchainArtifact('src/std.rs'), false,
  'a Rust source extension alone is not sysroot proof');
assert.ok(roots.get('bucket:rust').ids.includes('sysrootBoundary'));
assert.equal(roots.get('bucket:rust').ids.includes('fakeStd'), false);
assert.ok(roots.get('bucket:library').children.some(node => node.key === 'package:A'));
assert.ok(['package:B', 'package:C', 'package:D', 'package:E'].every(id =>
  roots.get('bucket:dependencies').children.some(node => node.key === id)));
assert.equal(folder('package:D').children.length, 0,
  'catalog package without captured source remains a folder, not a fake unknown file');
assert.equal(folder('package:A').label, 'app @ 1.0.0');
assert.ok(folder('package:A').ids.includes('appModule') &&
  folder('package:A').ids.includes('appRich'),
  'unique legacy workspace association groups rich nodes with its exact package root');
assert.equal(context.SUPPLY_INDEX.ownership(graph.byId.appRich).status, 'exact',
  'compiler-matched rich callable keeps its exact package identity');
assert.equal(context.SUPPLY_INDEX.ownership(graph.byId.appModule).status, 'legacy',
  'folder placement does not upgrade the module’s legacy provenance');
assert.match(folder('package:A').title, /10 captured \/ 7 imported/);
assert.match(folder('package:B').label, /serde @ 1\.0\.0 · registry\+example/);
assert.match(folder('package:E').label, /serde @ 1\.0\.0 · \/vendor\/serde/);
assert.equal(folder('package:C').label, 'serde @ 2.0.0',
  'provenance appears in row labels only for a name/version collision');
assert.ok(folder('package:B').ids.includes('ownedNative'),
  'exact-owned native function is nested under its dependency package');
assert.equal(folder('package:B').ids.includes('unownedNative'), false);
assert.ok(folder('native:libcrypto.so').ids.includes('unownedNative'));
assert.ok(folder('native-origin:libcrypto.so').ids.includes('unresolvedNative'),
  'unresolved target is grouped by call origin without claiming an implementation owner');
assert.match(folder('native-origin:libcrypto.so').title, /target implementation unknown/);
assert.ok(folder('unowned:serde').ids.includes('unknownRust'),
  'same crate name never assigns an unknown Rust node to either dependency version');
const depSource = folder('package:B').children.find(child => child.label === 'src');
assert.ok(depSource && depSource.children.some(child => child.label === 'lib.rs' &&
  child.ids.includes('depFn')), 'dependency files use the existing nested folder tree');
assert.equal(context.SUPPLY_INDEX.scope({ packageIds: ['A'], dependencies: 'direct' }).packageIds.includes('B'),
  true, 'underlying dependency scope API remains intact');

function domNode(tagName) {
  const node = { tagName, children: [], listeners: {}, style: {}, className: '', textContent: '', value: '',
    attributes: {}, classList: { toggle(name, on) { this[name] = on; } },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    querySelector() { return domNode(); } };
  Object.defineProperty(node, 'innerHTML', { get() { return this.markup || ''; },
    set(value) { this.markup = value; this.children = []; } });
  return node;
}
const sidebar = Object.fromEntries(['cratelist', 'kindlist', 'search', 'edgekey',
  'architecture-controls'].map(id => [id, domNode()]));
const sideContext = { G: graph, UIAPI: null, ARCH_FOCUS_ID: null, Map, Set,
  ARCH_ORGANIZATION: 'field', ARCH_FUNCTION_LAYOUT: 'network',
  KIND_COLORS: { function: '#fff' }, DEFAULT_COLOR: '#fff',
  EDGE_COLORS: { call: '#fff', native_call: '#fff', dependency: '#fff', native_link: '#fff',
    contains: '#fff', use: '#fff', impl: '#fff', struct: '#fff' },
  document: { createElement: domNode, getElementById(id) { return sidebar[id]; },
    querySelectorAll(selector) {
      const box = selector.includes('cratelist') ? sidebar.cratelist : sidebar.kindlist;
      return box.children.filter(node => node.className.includes('row'));
    } },
  treeIcon() { return ''; }, hideDetail() {}, refreshFunctionFocus() {}
};
vm.runInNewContext(between('var ARCH_TREE_OVERRIDES =', 'var DETAIL_ID = null;') +
  between('function switchArchitectureOrganization(value, force) {', 'function linkSourceId(l)') +
  between('function mountUI(api) {', '// ---- node detail panel'), sideContext);
let selection = null, visibleIds = null, isolated = false;
const sideApi = { select(ids) { selection = Array.from(ids); }, clear() { selection = null; },
  setTreeVisibility(ids) { visibleIds = new Set(ids); }, setIsolation(value) { isolated = value; },
  setConnectionVisibility() {} };
sideContext.mountUI(sideApi);
const canonical = sideContext.G;
function controls() { return sidebar['architecture-controls']; }
function controlSelect(label) { return controls().children.find(node => node.tagName === 'select' &&
  node.getAttribute('aria-label') === label); }
assert.ok(controlSelect('Architecture preset') && controlSelect('Architecture layout'),
  'Preset and Layout are named native controls in the sidebar');
assert.equal(controls().children.filter(node => node.tagName === 'details').length, 2,
  'node and connection settings are collapsed below the folder tree controls');
controlSelect('Architecture preset').value = 'function';
controlSelect('Architecture preset').listeners.change();
assert.equal(sideContext.G, canonical, 'preset keeps one canonical graph object');
assert.ok(!visibleIds.has('appModule') && visibleIds.has('depFn') && visibleIds.has('sysrootBoundary'),
  'Function preset is a visibility mask and keeps dependency/sysroot functions');
controlSelect('Architecture preset').value = 'field';
controlSelect('Architecture preset').listeners.change();
assert.equal(sideContext.G, canonical);
assert.ok(visibleIds.has('appModule'), 'Field preset restores structural nodes');
function row(key) { return sidebar.cratelist.children.find(node => node.getAttribute('data-v') === key); }
function eye(key) { return row(key).children.find(node => node.className.startsWith('tree-eye')); }
function action(label) { return sidebar.cratelist.children[1].children.find(node => node.textContent === label); }
assert.ok(row('package:B') && row('package:C') && row('native:libcrypto.so'));
assert.ok(eye('bucket:rust') && eye('bucket:library') && eye('bucket:dependencies'),
  'every top folder has an eye control');
row('package:B').listeners.click();
assert.deepEqual(selection.sort(), Array.from(folder('package:B').ids).sort(),
  'clicking dependency folder selects only that exact package in the existing graph view');
assert.equal(row('package:B').classList.sel, true);
assert.equal(isolated, true, 'folder selection isolates its members');
row('package:B').listeners.click();
assert.equal(selection, null, 'clicking selected dependency folder clears the facet');
assert.equal(isolated, false);
row('package:B').listeners.click();
sideContext.switchArchitectureOrganization('function');
assert.equal(sideContext.G, graph, 'Function preset retains the canonical graph');
assert.deepEqual(selection.sort(), Array.from(folder('package:B').ids).sort(),
  'package folder selection survives the preset without changing members');
assert.equal(row('package:B').classList.sel, true);
assert.equal(isolated, true);
sideContext.switchArchitectureOrganization('field');
assert.equal(row('package:B').classList.sel, true, 'source focus survives a return to Field');
const kindRow = sidebar.kindlist.children.find(node => node.getAttribute('data-v') === 'function');
kindRow.listeners.click();
assert.deepEqual(selection.sort(), Array.from(graph.idsByKind.function).sort(),
  'existing kind filter remains available in the same sidebar');

action('Hide all').listeners.click();
assert.equal(selection, null, 'Hide all clears source/kind focus');
assert.equal(visibleIds.size, 0, 'Hide all leaves the graph empty while tree rows remain usable');
assert.equal(sideContext.ARCH_TREE_OVERRIDES.size, 3);
eye('package:B').listeners.click({ stopPropagation() {} });
assert.deepEqual(Array.from(visibleIds).sort(), Array.from(folder('package:B').ids).sort(),
  'a nested eye reveals its subtree even while Dependencies is off');
assert.equal(row('bucket:dependencies').children.at(-1).getAttribute('aria-pressed'), 'mixed');
eye('bucket:dependencies').listeners.click({ stopPropagation() {} });
assert.ok(visibleIds.has('leafFn'), 'parent eye shows all descendants');
eye('bucket:dependencies').listeners.click({ stopPropagation() {} });
assert.equal(visibleIds.size, 0, 'turning parent off clears a nested on override');

row('package:B').listeners.click();
assert.equal(isolated, true);
assert.ok(visibleIds.has('depFn') && visibleIds.has('ownedNative'),
  'clicking a hidden folder temporarily reveals its focused nodes');
row('package:B').listeners.click();
assert.equal(visibleIds.size, 0, 'second click restores the manual eye settings');
assert.equal(isolated, false);
action('Show all').listeners.click();
assert.equal(sideContext.ARCH_TREE_OVERRIDES.size, 0);
assert.equal(visibleIds.size, graph.nodes.length, 'Show all restores every canonical node');
assert.equal(selection, null, 'Show all clears folder focus');

row('package:B').listeners.click();
assert.ok(sideContext.ARCH_SOURCE_REVEAL_IDS.has('depFn'),
  'folder focus temporarily reveals its members');
eye('package:B').listeners.click({ stopPropagation() {} });
assert.ok(!visibleIds.has('depFn') && !visibleIds.has('ownedNative'),
  'explicitly hiding a focused folder removes its temporary reveal');
assert.equal(sideContext.ARCH_SOURCE_REVEAL_IDS, null,
  'hiding the whole focused folder clears its temporary reveal');
row('package:B').listeners.click();
assert.ok(visibleIds.has('depFn'), 'clicking the hidden folder reveals it again');
row('package:B').listeners.click();
assert.ok(!visibleIds.has('depFn'), 'clearing focus restores the manual eye setting');
action('Show all').listeners.click();

row('package:B').children[0].listeners.click({ stopPropagation() {} });
row('package:B:src').children[0].listeners.click({ stopPropagation() {} });
action('Hide all').listeners.click();
row('package:B:src/lib.rs').listeners.click();
assert.deepEqual(Array.from(visibleIds), ['depFn'],
  'clicking a hidden source file temporarily reveals only that file’s callable');
row('package:B:src/lib.rs').listeners.click();
assert.equal(visibleIds.size, 0);

console.log('viewer unified package/source visibility: prepared');
