'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { bindManifest } = require('../../../scripts/bind-entry-effects-adapter.cjs');
function block(id, callee, extra = {}) {
  return { id: 'bb' + id, kind: callee ? 'call' : 'return', callee: callee || null,
    successors: callee ? [{ target: 'bb' + (id + 1), kind: 'normal' }] : [],
    source_file: 'fixture.rs', source_location: id + 4, ...extra };
}
function standard(callee) {
  return { callee, callee_id: 'compiler:' + callee, callee_crate: 'std',
    callee_artifact: '/toolchain/lib/rustlib/fixture-target/lib/libstd-aabbcc.rlib' };
}
function callable(id, packageId, calls, extra = {}) {
  const attributes = { kind: 'function', path: id, crate: packageId, package_id: packageId,
    declaration_visibility: 'public', external_visibility: 'public', function_abi: '"Rust"',
    has_body: 'true', target_kind: '["lib"]', target_name: packageId, capture_scope: 'workspace', ...extra };
  attributes.source_absolute = '/fixtures/fixture.rs';
  const symbol = { id, source_file: 'fixture.rs', source_location: 3, attributes };
  if (calls == null) return [symbol];
  const blocks = calls.map((call, i) => typeof call === 'string' ? block(i, call) : block(i, call.callee, call));
  blocks.push(block(calls.length));
  return [symbol, { id: 'flow:' + id, source_file: 'fixture.rs', source_location: 3,
    attributes: { ...attributes, kind: 'flow_function', symbol_id: id,
      flow: JSON.stringify({ version: 1, function: id, function_id: attributes.function_id, entry: 'bb0', blocks }) } }];
}
function fixture() {
  const manifest = { schemaVersion: 1, adapters: [{ id: 'registration-framework', version: '1.0',
    entries: [{ id: 'cli', selector: { id: 'app::cli_handler' }, kind: 'cli-command' }],
    registrations: [{ id: 'http-handler', caller: { id: 'app::main' }, target: { id: 'app::reference_only' }, kind: 'registered-handler' }],
    summaries: [{ id: 'native-capability', selector: { id: 'native::known' }, effects: [{ category: 'native', operation: 'ffi-capability' }] }] }] };
  return { nodes: [
    { id: 'app-package', attributes: { kind: 'crate', crate: 'app', package_id: 'app', workspace_member: 'true',
      supply_chain_dependencies: JSON.stringify([{ package_id: 'api', name: 'api', kind: 'normal' }]), entry_effects: JSON.stringify(manifest) } },
    { id: 'api-package', attributes: { kind: 'crate', crate: 'api', package_id: 'api', workspace_member: 'true' } },
    ...callable('app::main', 'app', ['api::library_action', { callee: 'framework::register',
      callback_args: [{ index: 0, targets: ['app::reference_only'] }] },
      { callee: 'framework::invoke', callback_args: [{ index: 0, targets: ['app::invoked'] }] }, standard('std::process::Command::new')],
    { target_kind: '["bin"]', rustdoc_root_function: 'true', declaration_visibility: 'default', external_visibility: 'private' }),
    ...callable('api::library_action', 'api', ['dep::read_input']),
    ...callable('dep::read_input', 'dep', [standard('std::fs::read_to_string')]),
    ...callable('app::reference_only', 'app', [standard('std::net::TcpStream::connect')], { external_visibility: 'private' }),
    ...callable('app::invoked', 'app', [standard('std::env::var')], { external_visibility: 'private' }),
    ...callable('app::cli_handler', 'app', [standard('std::process::Command::status')], { external_visibility: 'private' }),
    ...callable('api::UnusedPublic::unused_method', 'api', [standard('std::fs::write')]),
    ...callable('api::private::public_method', 'api', [], { external_visibility: 'private' }),
    ...callable('api::exported_entry', 'api', ['api::library_action'], { function_abi: '{"C":{"unwind":false}}', export_symbol: 'api_entry' }),
    ...callable('api::foreign_declaration', 'api', null, { has_body: 'false', function_abi: '{"C":{"unwind":false}}' }),
    ...callable('framework::register', 'framework', []),
    ...callable('framework::invoke', 'framework', [{ callee: null, kind: 'call', callback_parameter: 0 }]),
    ...callable('native::known', 'native-producer', null, { language: 'native', body_status: 'unavailable' }),
    ...callable('app::open', 'app', [], { external_visibility: 'private' })], edges: [] };
}
function independent() {
  const raw = { nodes: [
    { id: 'host-package', attributes: { kind: 'crate', crate: 'host', package_id: 'host', workspace_member: 'true' } },
    ...callable('independent-host::host_callback', 'host', ['independent-host::custom_transport::emit']),
    ...callable('independent-host::custom_transport::emit', 'host', [], { external_visibility: 'private' })], edges: [] };
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'adapter-example', 'adapter.json'), 'utf8'));
  raw.nodes[0].attributes.entry_effects = JSON.stringify(bindManifest(raw, template, {
    $host_callback: { id: 'independent-host::host_callback' },
    $transport_emit: { id: 'independent-host::custom_transport::emit' }
  }));
  return raw;
}
function captureAdapters(raw, mainNodeId) {
  const handler = raw.nodes.find(n => n.label === 'callback_reference_only' && n.attributes.declaration_visibility);
  const cli = raw.nodes.find(n => n.label === 'cli_handler' && n.attributes.declaration_visibility);
  if (!handler || !cli) throw new Error('capture is missing fixture handler declarations');
  const carrier = raw.nodes.find(n => n.attributes.kind === 'crate');
  carrier.attributes.entry_effects = JSON.stringify({ schemaVersion: 1, adapters: [{
    id: 'offline-registration-fixture', version: '1',
    entries: [{ id: 'cli', selector: { id: cli.id }, kind: 'cli-command' }],
    registrations: [{ id: 'handler', caller: { id: mainNodeId }, target: { id: handler.id }, kind: 'registered-handler' }]
  }] });
  return raw;
}
module.exports = { fixture, independent, callable, block, standard, captureAdapters };
