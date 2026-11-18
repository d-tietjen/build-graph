'use strict';
const { callable } = require('../entry-effects/fixture-graphs.cjs');
const { context, target, unit } = require('../build-supply-chain/fixture-graphs.cjs');
const Flow = require('../../../src/execution-flow.js');
const Model = require('../../../src/execution-model.js');
const CallGraph = require('../../../src/call-graph.js');
const EntryEffects = require('../../../src/entry-effects.js');
const Evidence = require('../../../src/analysis-evidence.js');
const CallPaths = require('../../../src/call-paths.js');
const Advisories = require('../../../src/advisory-exposure.js');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
function packageNode(id, name, version, source, dependencies = [], workspace = false) {
  return { id: 'package:' + id, attributes: { kind: 'crate', package_id: id, crate: name, version,
    package_source: source, workspace_member: String(workspace), supply_chain_dependencies: JSON.stringify(dependencies) } };
}
function fn(id, pkg, calls = [], extra = {}) {
  return callable(id, pkg, calls, { external_visibility: 'private', declaration_visibility: 'default',
    function_id: 'compiler:' + id, unit_key: 'unit:' + pkg, ...extra });
}
function fixture() {
  const buildName = 'build-script-build', buildSource = '/fixtures/build.rs', buildUnit = 'unit:application@1.0.0:build';
  const application = packageNode('application@1.0.0', 'application', '1.0.0', null, [
    { package_id: 'bridge@1.0.0', kind: 'normal', target: null },
    { package_id: 'parser@1.2.3', kind: 'build', target: 'cfg(unix)' }
  ], true);
  application.attributes.cargo_targets = JSON.stringify({ schemaVersion: 1,
    targets: [target(buildName, ['custom-build'], buildSource)] });
  application.attributes.build_units = JSON.stringify({ schemaVersion: 1,
    units: [unit(buildUnit, buildName, ['custom-build'], buildSource)] });
  const builder = fn('builder::main', 'application@1.0.0', ['parser::affected'], {
    target_name: buildName, target_kind: '["custom-build"]', target_src_path: buildSource,
    unit_key: buildUnit, build_context: JSON.stringify(context()), compiler_entry: 'compiler-main'
  }).map(n => { n.source_file = buildSource; n.attributes.source_absolute = buildSource; return n; });
  return { nodes: [
    application,
    packageNode('bridge@1.0.0', 'bridge', '1.0.0', registry, [{ package_id: 'parser@1.2.3', kind: 'normal', target: null }]),
    packageNode('parser@1.2.3', 'parser', '1.2.3', registry),
    packageNode('parser@2.0.0', 'parser', '2.0.0', registry),
    packageNode('fork@1.2.3', 'parser', '1.2.3', 'git+https://example.invalid/fork#123'),
    ...fn('application::main', 'application@1.0.0', ['bridge::left', 'bridge::right'], { target_kind: '["bin"]', rustdoc_root_function: 'true', compiler_entry: 'compiler-main' }),
    ...builder,
    ...fn('bridge::left', 'bridge@1.0.0', ['parser::affected', 'parser::affected']),
    ...fn('bridge::right', 'bridge@1.0.0', ['parser::affected']),
    ...fn('parser::affected', 'parser@1.2.3', ['parser::cycle']),
    ...fn('parser::cycle', 'parser@1.2.3', ['parser::affected']),
    ...fn('parser::unused', 'parser@1.2.3'),
    ...fn('newer::same_name', 'parser@2.0.0'),
    ...fn('fork::same_name', 'fork@1.2.3'),
    ...fn('application::reference_only', 'application@1.0.0', [{ callee: 'external::register', callback_args: [{ index: 0, targets: ['parser::unused'] }] }]),
    ...fn('application::invoke', 'application@1.0.0', ['bridge::callback', { callee: 'bridge::callback', callback_args: [{ index: 0, targets: ['parser::unused'] }] }]),
    ...fn('bridge::callback', 'bridge@1.0.0', [{ callee: null, kind: 'call', callback_parameter: 0 }]),
    ...fn('native::declaration', 'parser@1.2.3', null, { language: 'native', native_boundary_kind: 'ffi_symbol' })
  ], edges: [] };
}
function engines(raw = fixture()) {
  const model = Model.build(raw), flow = Flow.catalog(raw); Flow.applyModelTargets(flow, model);
  const callGraph = CallGraph.build(raw, flow), evidence = Evidence.create(raw, { model });
  const entries = EntryEffects.build(raw, { model, flow, callGraph });
  const paths = CallPaths.create(raw, { model, callGraph });
  const advisories = Advisories.create(raw, { paths, entries: entries.entries, buildExecution: entries.buildExecution, entryCoverage: entries.coverage, digest: Evidence.digest });
  return { paths, advisories, evidence, callGraph, model, entries };
}
const snapshot = () => JSON.parse(JSON.stringify(require('./advisories.json')));
// Generic correction controls: no product IDs or graph special cases.
function corridor(count = 186) {
  const raw = { nodes: [packageNode('a@1', 'a', '1.0.0', registry, [], true), packageNode('b@1', 'b', '1.0.0', registry)], edges: [] };
  for (let i = 0; i < count; i++) raw.nodes.push(...fn('corridor::' + i, i % 2 ? 'b@1' : 'a@1', i + 1 < count ? ['corridor::' + (i + 1)] : []));
  return raw;
}
function recursion(mode) {
  const raw = fixture(), calls = mode === 'direct' ? ['self::recursive'] : mode === 'callback' ? [{ callee: null, kind: 'call', callback_parameter: 0 }] :
    ['self::recursive', { callee: null, kind: 'call', callback_parameter: 0 }];
  raw.nodes.push(...fn('self::recursive', 'bridge@1.0.0', calls),
    ...fn('self::caller', 'bridge@1.0.0', [{ callee: 'self::recursive', callback_args: [{ index: 0, targets: ['self::recursive'] }] }]));
  return raw;
}
function coverageGraph(kind, reachable) {
  const raw = { nodes: [packageNode('known@1', 'known', '1.0.0', registry, [], true),
    ...fn('known::a', 'known@1', reachable ? ['known::b', 'gap::entry'] : ['known::b']), ...fn('known::b', 'known@1')], edges: [] };
  if (kind === 'none') return raw;
  const call = kind === 'callback' ? { callee: null, kind: 'call', callback_parameter: 0 } : kind === 'possible' ?
    { callee: null, kind: 'call', callee_targets: ['gap::target'] } : kind === 'native' ?
      { callee: 'foreign::f', kind: 'call', native_call: { symbol: 'foreign_f', abi: 'C' } } : kind === 'legacy' ?
        { callee: 'gap::target', callee_id: 'unmatched-compiler-symbol' } : { callee: 'uncaptured::target' };
  const gap = fn('gap::entry', 'known@1', kind === 'ownership' ? [] : [call]);
  if (kind === 'ownership') gap.forEach(n => { delete n.attributes.package_id; n.attributes.crate = 'uncatalogued'; });
  raw.nodes.push(...gap, ...fn('gap::target', 'known@1'));
  return raw;
}
// Preserve symbol/package/compiler ownership; replace only the accepted body's blocks.
function replaceBody(raw, id, kind, count = 1) {
  const node = raw.nodes.find(n => n.id === 'flow:' + id), body = JSON.parse(node.attributes.flow);
  body.blocks = Array.from({ length: count }, (_, i) => ({ id: 'bb' + i,
    kind: kind === 'missing-mir' ? 'opaque' : kind,
    label: kind === 'missing-mir' ? 'pre-optimization MIR unavailable' : kind + ' captured boundary',
    successors: [], source_file: 'fixture.rs', source_location: 3 + i }));
  body.entry = 'bb0'; node.attributes.flow = JSON.stringify(body); return raw;
}
function bodyGapGraph(kind, reachable) {
  const raw = coverageGraph('none', false), id = reachable ? 'known::b' : 'gap::body';
  if (!reachable) raw.nodes.push(...fn(id, 'known@1'));
  return replaceBody(raw, id, kind);
}
function inclusionGraph(rootless = false) {
  const raw = fixture();
  raw.nodes.push(packageNode('orphan@1', 'orphan', '1.0.0', registry, [{ package_id: 'parser@1.2.3', kind: 'normal', target: null }]),
    packageNode('second@1', 'second', '1.0.0', registry, [{ package_id: 'bridge@1.0.0', kind: 'normal', target: 'cfg(windows)' }], true));
  const parser = raw.nodes.find(n => n.attributes.kind === 'crate' && n.attributes.package_id === 'parser@1.2.3');
  parser.attributes.supply_chain_dependencies = JSON.stringify([{ package_id: 'bridge@1.0.0', kind: 'normal', target: null }]);
  if (rootless) raw.nodes.filter(n => n.attributes.kind === 'crate').forEach(n => { n.attributes.workspace_member = 'false'; });
  return raw;
}
function highCardinalitySnapshot() {
  const s = snapshot();
  s.advisories = [s.advisories[0]];
  s.advisories[0].affected = [{ package: { ecosystem: 'crates.io', name: 'parser' },
    ranges: Array.from({ length: 2400 }, (_, i) => ({ type: 'SEMVER', events: [{ fixed: '2.' + i + '.0' }, { introduced: '0' }] })) }];
  return s;
}
function byteCases() {
  const bad = snapshot(); bad.advisories = [{ id: 'bad', summary: 'x'.repeat(20000) }];
  const unsupported = snapshot(); unsupported.advisories = [{ ...unsupported.advisories[0], schema_version: '2.0.0' }];
  const unmatched = snapshot(); unmatched.advisories = [unmatched.advisories[1]];
  const cases = [bad, unsupported, unmatched].map(snapshot => ({ snapshot, budget: 1 }));
  for (const valid of [true, false]) {
    const s = snapshot(); s.advisories = [s.advisories[0]]; s.functionMappings = [{ schemaVersion: 1, advisoryId: s.advisories[0].id, packageId: 'parser@1.2.3',
      functionId: valid ? 'compiler:parser::affected' : 'absent-symbol', provenance: 'p'.repeat(16000) }];
    cases.push({ snapshot: s, budget: null, valid });
  }
  return cases;
}
module.exports = { fixture, engines, snapshot, fn, packageNode, registry, corridor, recursion, coverageGraph, replaceBody, bodyGapGraph, inclusionGraph, highCardinalitySnapshot, byteCases };
