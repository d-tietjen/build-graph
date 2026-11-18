'use strict';
const { callable, standard } = require('../entry-effects/fixture-graphs.cjs');
const context = () => ({ schemaVersion: 1, target_triple: 'same-host-and-target', features: [],
  profile: { 'opt-level': '0' }, test: false });
function target(name, kind, src) { return { name, kind, src_path: src, crate_types: kind, required_features: [] }; }
function unit(key, name, kind, src) { return { unit_key: key, target_name: name, target_kind: kind,
  target_src_path: src, context: context() }; }
function pkg(id, name, targets = [], units = [], dependencies = []) {
  return { id: 'package:' + id, attributes: { kind: 'crate', crate: name, package_id: id, version: id.split('@')[1],
    workspace_member: 'true', cargo_targets: JSON.stringify({ schemaVersion: 1, targets }),
    build_units: JSON.stringify({ schemaVersion: 1, units }), supply_chain_dependencies: JSON.stringify(dependencies) } };
}
function body(path, packageId, key, name, kind, src, calls = [], entry) {
  return callable(path, packageId, calls, { target_name: name, target_kind: JSON.stringify(kind), target_src_path: src,
    unit_key: key, function_id: 'compiler:' + path, compiler_entry: entry,
    build_context: JSON.stringify(context()), declaration_visibility: 'default', external_visibility: 'private' })
    .map(n => { n.source_file = src; n.attributes.source_absolute = src; return n; });
}
function fixture() {
  const app = 'app@1', shared = 'shared@1', macros = 'macros@1';
  const appTargets = [target('app', ['bin'], '/fixture/app.rs'), target('build-script-build', ['custom-build'], '/fixture/build.rs')];
  const appUnits = [unit('app-unit', 'app', ['bin'], '/fixture/app.rs'), unit('build-unit', 'build-script-build', ['custom-build'], '/fixture/build.rs')];
  const sharedUnits = ['host-unit', 'target-unit', 'reused-unit'].map(key => unit(key, 'shared', ['lib'], '/fixture/shared.rs'));
  const appPkg = pkg(app, 'app', appTargets, appUnits, [
    { package_id: shared, name: 'shared', kind: 'build', target: null },
    { package_id: shared, name: 'shared', kind: 'normal', target: null },
    { package_id: macros, name: 'macros', kind: 'normal', target: null },
    { package_id: 'duplicate@1', name: 'one', kind: 'build', target: 'cfg(target_os = "none")' },
    { package_id: 'duplicate@2', name: 'two', kind: 'normal', target: 'cfg(unix)' },
    { package_id: 'duplicate@1', name: 'dev_one', kind: 'dev', target: null }
  ]);
  appPkg.attributes.cargo_build_evidence = JSON.stringify({ schemaVersion: 1, artifacts: [{ package_id: app,
    target_name: 'app', target_kind: ['bin'], target_src_path: '/fixture/app.rs', filenames: ['/fixture/target/app'],
    features: [], profile: { test: false }, fresh: true }], scripts: [{ package_id: app,
    linked_libs: ['static=fixture_native'], linked_paths: ['native=/fixture/out'], out_dir: '/fixture/out',
    environment_names: ['FIXTURE_BUILD_DECLARATION'] }] });
  const raw = { nodes: [appPkg,
    pkg(shared, 'shared', [target('shared', ['lib'], '/fixture/shared.rs')], sharedUnits),
    pkg(macros, 'macros', [target('macros', ['proc-macro'], '/fixture/macro.rs')], [unit('macro-unit', 'macros', ['proc-macro'], '/fixture/macro.rs')]),
    pkg('missing@1', 'missing', [target('missing-build', ['custom-build'], '/fixture/missing.rs')]),
    pkg('duplicate@1', 'duplicate'), pkg('duplicate@2', 'duplicate'),
    ...body('app::main', app, 'app-unit', 'app', ['bin'], '/fixture/app.rs', ['shared::target_probe', 'shared::both_probe'], 'compiler-main'),
    ...body('builder::main', app, 'build-unit', 'build-script-build', ['custom-build'], '/fixture/build.rs',
      ['shared::host_probe', 'shared::both_probe', standard('std::process::Command::status')], 'compiler-main'),
    ...body('macros::emit', macros, 'macro-unit', 'macros', ['proc-macro'], '/fixture/macro.rs', [standard('std::net::TcpStream::connect')], 'proc-macro-export'),
    ...body('shared::host_probe', shared, 'host-unit', 'shared', ['lib'], '/fixture/shared.rs', [standard('std::fs::write')]),
    ...body('shared::target_probe', shared, 'target-unit', 'shared', ['lib'], '/fixture/shared.rs', [standard('std::fs::read')]),
    ...body('shared::both_probe', shared, 'reused-unit', 'shared', ['lib'], '/fixture/shared.rs', [standard('std::env::var_os')]),
    ...body('builder::nested::main', app, 'build-unit', 'build-script-build', ['custom-build'], '/fixture/build.rs'),
    ...body('app::generated', app, 'app-unit', 'app', ['bin'], '/fixture/app.rs'),
    { id: 'native-in-out-dir', attributes: { kind: 'native_library', native_artifact: '/fixture/out/libfixture_native.a',
      native_link_name: 'fixture_native', linking_package_id: app, package_id: app } }
  ], edges: [] };
  const generated = raw.nodes.find(n => n.id === 'flow:app::generated');
  generated.source_file = '/fixture/out/generated.rs'; generated.attributes.source_reference_kind = 'cargo-out-dir-reference';
  return raw;
}
function legacyFixture() {
  const raw = fixture();
  for (const node of raw.nodes.filter(n => ['builder::main', 'flow:builder::main'].includes(n.id))) {
    delete node.attributes.compiler_entry; delete node.attributes.build_context;
  }
  return raw;
}
function registrationFixture() {
  const raw = fixture();
  raw.nodes[0].attributes.entry_effects = JSON.stringify({ schemaVersion: 1, adapters: [{
    id: 'phase-reference', version: '1', registrations: [{ id: 'application-only',
      caller: { id: 'builder::main' }, target: { id: 'shared::target_probe' } }]
  }] });
  return raw;
}
function callbackFixture() {
  const raw = fixture();
  function calls(path, replacements) {
    const node = raw.nodes.find(n => n.id === 'flow:' + path), flow = JSON.parse(node.attributes.flow);
    const pair = body(path, node.attributes.package_id, node.attributes.unit_key, node.attributes.target_name,
      JSON.parse(node.attributes.target_kind), node.attributes.target_src_path, replacements);
    flow.blocks = JSON.parse(pair[1].attributes.flow).blocks; node.attributes.flow = JSON.stringify(flow);
  }
  calls('builder::main', [{ callee: 'shared::forward', callback_args: [{ index: 0, targets: ['builder::host_only'] }] }]);
  calls('app::main', [{ callee: 'shared::forward', callback_args: [{ index: 0, targets: ['app::target_only'] }] }]);
  raw.nodes.push(
    ...body('shared::forward', 'shared@1', 'reused-unit', 'shared', ['lib'], '/fixture/shared.rs',
      [{ callee: 'shared::invoke', callback_args: [{ index: 0, targets: [], parameter: 0 }] }]),
    ...body('shared::invoke', 'shared@1', 'reused-unit', 'shared', ['lib'], '/fixture/shared.rs',
      [{ callee: null, kind: 'call', callback_parameter: 0 }]),
    ...body('builder::host_only', 'app@1', 'build-unit', 'build-script-build', ['custom-build'], '/fixture/build.rs',
      [standard('std::fs::write'), standard('std::process::Command::status'), standard('std::env::var_os')]),
    ...body('app::target_only', 'app@1', 'app-unit', 'app', ['bin'], '/fixture/app.rs', [standard('std::fs::read')])
  );
  return raw;
}
function emptyCallbackFixture(kind, format) {
  const raw = kind === 'ordinary' ? fixture() : callbackFixture();
  const node = raw.nodes.find(n => n.id === 'flow:' + (kind === 'ordinary' ? 'app::main' : 'shared::invoke'));
  const flow = JSON.parse(node.attributes.flow);
  if (format === 'omitted') delete flow.blocks[0].callback_args;
  else flow.blocks[0].callback_args = format === 'null' ? null : [];
  node.attributes.flow = JSON.stringify(flow);
  return raw;
}
const bindingCases = [
  { name: 'omitted certainty', row: { index: 0, targets: ['app::target_only'] }, precise: true },
  { name: 'false certainty and null parameter', row: { index: 0, targets: ['app::target_only'], unknown: false, parameter: null }, precise: true },
  { name: 'true uncertainty', row: { index: 0, targets: ['app::target_only'], unknown: true }, precise: true, usedUnknown: true },
  { name: 'null certainty', row: { index: 0, targets: ['app::target_only'], unknown: null }, invalid: true, usedUnknown: true },
  { name: 'numeric certainty', row: { index: 0, targets: ['app::target_only'], unknown: 0 }, invalid: true, usedUnknown: true },
  { name: 'string targets', row: { index: 0, targets: 'app::target_only', unknown: false }, invalid: true, usedUnknown: true },
  { name: 'object targets for known callee', row: { index: 0, targets: {}, unknown: false }, objectTargets: true, invalid: true, usedUnknown: true },
  { name: 'object targets for unavailable callee', row: { index: 0, targets: {}, unknown: false }, callee: 'uncaptured::register', objectTargets: true, invalid: true },
  { name: 'string reference collection', references: 'invalid', precise: true },
  { name: 'object reference collection', references: {}, precise: true },
  { name: 'valid reference collection', references: [{ kind: 'trait_method_reference', index: 0, targets: [{ function: 'builder::host_only' }] }], referenceTarget: 'builder::host_only', precise: true },
  { name: 'empty targets', row: { index: 0, targets: [], unknown: false }, usedUnknown: true },
  { name: 'malformed target element', row: { index: 0, targets: ['app::target_only', null] }, invalid: true, usedUnknown: true },
  { name: 'invalid parameter', row: { index: 0, targets: ['app::target_only'], parameter: '0' }, invalid: true, usedUnknown: true },
  { name: 'negative parameter', row: { index: 0, targets: ['app::target_only'], parameter: -1 }, invalid: true, usedUnknown: true },
  { name: 'duplicate app then host', rows: [{ index: 0, targets: ['app::target_only'] }, { index: 0, targets: ['builder::host_only'] }], invalid: true, usedUnknown: true },
  { name: 'duplicate host then app', rows: [{ index: 0, targets: ['builder::host_only'] }, { index: 0, targets: ['app::target_only'] }], invalid: true, usedUnknown: true },
  { name: 'null raw certainty', rawUnknown: null, precise: true, invalid: true },
  { name: 'numeric raw certainty', rawUnknown: 0, precise: true, invalid: true },
  { name: 'false raw certainty', rawUnknown: false, precise: true },
  { name: 'true raw uncertainty', rawUnknown: true, precise: true, invalid: true },
  { name: 'malformed argument list', rows: 'invalid', invalid: true, usedUnknown: true },
  { name: 'object argument list', rows: {}, invalid: true, usedUnknown: true },
  { name: 'omitted argument list for used callback', omitRows: true, usedUnknown: true },
  { name: 'empty argument list for used callback', rows: [], usedUnknown: true },
  { name: 'null argument list for used callback', rows: null, usedUnknown: true },
  { name: 'invalid invocation parameter', invocationParameter: '0', usedUnknown: true },
  { name: 'unowned duplicate body', duplicate: true, precise: true }
];
function bindingFixture(spec) {
  const raw = callbackFixture(), node = raw.nodes.find(n => n.id === 'flow:app::main');
  const flow = JSON.parse(node.attributes.flow), call = flow.blocks[0];
  if (Object.hasOwn(spec, 'callee')) {
    call.callee = spec.callee;
    delete call.callee_id; delete call.callee_targets; delete call.callback_parameter;
  }
  if (spec.row) call.callback_args = [spec.row];
  if (Object.hasOwn(spec, 'references')) call.callback_references = spec.references;
  if (spec.rows !== undefined) call.callback_args = spec.rows;
  if (spec.omitRows) delete call.callback_args;
  if (Object.hasOwn(spec, 'rawUnknown')) call.callback_unknown = spec.rawUnknown;
  node.attributes.flow = JSON.stringify(flow);
  if (Object.hasOwn(spec, 'invocationParameter')) {
    const invocation = raw.nodes.find(n => n.id === 'flow:shared::invoke'), body = JSON.parse(invocation.attributes.flow);
    body.blocks[0].callback_parameter = spec.invocationParameter; invocation.attributes.flow = JSON.stringify(body);
  }
  if (spec.duplicate) {
    const rejected = JSON.parse(JSON.stringify(node)); rejected.id = 'rejected-duplicate-app-body';
    const body = JSON.parse(rejected.attributes.flow); body.blocks[0].callback_unknown = null;
    rejected.attributes.flow = JSON.stringify(body); raw.nodes.push(rejected);
  }
  return raw;
}
function contextFixture(size = 10, controls = false) {
  const raw = callbackFixture(), root = raw.nodes.find(n => n.id === 'flow:app::main'), flow = JSON.parse(root.attributes.flow);
  const args = Array.from({ length: size }, (_, index) => ({ index, targets: ['budget::A'], parameter: null, unknown: false }));
  flow.blocks[0].callee = 'budget::F0'; flow.blocks[0].callback_args = args; root.attributes.flow = JSON.stringify(flow);
  for (let i = 0; i <= size; i++) {
    const calls = i === size ? [] : ['A', 'B'].map(choice => ({ callee: 'budget::F' + (i + 1),
      callback_args: args.map((_, index) => index === i ? { index, targets: ['budget::' + choice], parameter: null, unknown: false } :
        { index, targets: [], parameter: index, unknown: false }) }));
    if (controls && i === 0) calls.push({ callee: 'budget::F0', callback_args: args.map((_, index) => ({ index, targets: [], parameter: index })) });
    const pair = body('budget::F' + i, 'shared@1', 'reused-unit', 'shared', ['lib'], '/fixture/shared.rs', calls);
    if (controls && i === 0) {
      const bodyFlow = JSON.parse(pair[1].attributes.flow);
      bodyFlow.blocks[bodyFlow.blocks.length - 1].kind = 'goto';
      bodyFlow.blocks[bodyFlow.blocks.length - 1].successors = [{ target: 'bb0', kind: 'normal' }];
      pair[1].attributes.flow = JSON.stringify(bodyFlow);
    }
    raw.nodes.push(...pair);
  }
  for (const name of ['A', 'B']) raw.nodes.push(...body('budget::' + name, 'shared@1', 'reused-unit', 'shared', ['lib'], '/fixture/shared.rs'));
  return raw;
}
module.exports = { fixture, legacyFixture, registrationFixture, callbackFixture, emptyCallbackFixture, bindingCases, bindingFixture, contextFixture, pkg, unit, target, context };
