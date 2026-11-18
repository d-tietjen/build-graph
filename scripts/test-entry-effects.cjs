'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const Flow = require('../src/execution-flow.js');
const Model = require('../src/execution-model.js');
const CallGraph = require('../src/call-graph.js');
const Entries = require('../src/entry-effects.js');
const Evidence = require('../src/analysis-evidence.js');
const Analysis = require('../src/analysis-api.js');
const { fixture, independent, callable, block, standard, captureAdapters } = require('../tests/fixtures/entry-effects/fixture-graphs.cjs');

function core(raw) {
  const flow = Flow.catalog(raw), model = Model.build(raw);
  Flow.applyModelTargets(flow, model);
  return Entries.build(raw, { flow, model, callGraph: CallGraph.build(raw, flow) });
}
function entry(index, path, kind) { return index.entries.find(e => e.path === path && e.kind === kind); }

test('entry inventory distinguishes target/API/export evidence, registrations and disconnected roots', () => {
  const index = core(fixture());
  const main = entry(index, 'app::main', 'binary');
  assert.equal(main.certainty, 'possible'); assert.equal(main.externalEntry, false);
  assert.match(main.provenance.mechanism, /compiler entry identity.*unproven/);
  assert.equal(main.packageId, 'app'); assert.equal(main.buildPhase, 'runtime');
  assert.equal(main.source.source_file, 'fixture.rs'); assert.match(main.discoveryMechanism, /target/);
  assert(entry(index, 'api::UnusedPublic::unused_method', 'library-api'), 'unused public methods remain API entries');
  assert(!entry(index, 'api::private::public_method', 'library-api'), 'public inside private module is not an exposed API');
  assert.equal(entry(index, 'app::reference_only', 'registered-handler').certainty, 'possible');
  assert.equal(entry(index, 'app::cli_handler', 'cli-command').certainty, 'modeled');
  const ffi = entry(index, 'api::exported_entry', 'ffi'), declaration = entry(index, 'api::foreign_declaration', 'ffi');
  assert.equal(ffi.externalEntry, true); assert.equal(ffi.certainty, 'observed');
  assert.equal(declaration.externalEntry, false); assert.equal(declaration.certainty, 'possible');
  assert.equal(entry(index, 'app::open', 'disconnected-root').externalEntry, false);
  assert.equal(index.coverage.externalEntryInventoryComplete, false);
});

test('exact reusable summaries distinguish configuration from effects and unknown native bodies', () => {
  const index = core(fixture());
  for (const category of ['filesystem', 'network', 'process', 'sensitive-data', 'native'])
    assert(index.effects.some(e => e.category === category && e.certainty === 'modeled'), category);
  assert(!index.effects.some(e => e.path === 'app::open' && e.category === 'filesystem'));
  assert(!index.effects.some(e => /Command::new/.test(e.path) && e.category === 'process'));
  assert(index.effects.some(e => e.path === 'api::foreign_declaration' && e.category === 'native' && e.certainty === 'unknown'));
  assert(index.effects.some(e => e.path === 'native::known' && e.operation === 'additional-effects-unavailable'));
});

test('forward and reverse structural slices retain cross-package intermediaries, callbacks and cycles', () => {
  const raw = fixture(), flow = raw.nodes.find(n => n.id === 'flow:dep::read_input');
  const body = JSON.parse(flow.attributes.flow);
  body.blocks[1] = block(1, null, { kind: 'goto', successors: [{ target: 'bb0' }, { target: 'bb2' }] });
  body.blocks.push(block(2)); flow.attributes.flow = JSON.stringify(body);
  const index = core(raw), main = entry(index, 'app::main', 'binary');
  const route = index.route({ entryId: main.id, includePossible: false });
  assert(route.effects.some(e => e.category === 'filesystem'));
  assert(route.effects.some(e => e.category === 'sensitive-data'), 'captured callback invocation is retained');
  assert(route.nodes.some(n => n.packageId === 'dep'));
  assert(route.edges.some(e => e.kind === 'callback'));
  assert(route.edges.some(e => e.kind === 'loop'));
  assert(!route.effects.some(e => e.category === 'network'), 'reference-only callback does not execute');
  assert(!route.effects.some(e => e.category === 'process'), 'uninvoked CLI and configured Command do not launch');
  const fsEffect = route.effects.find(e => e.category === 'filesystem');
  const reverse = index.route({ effectId: fsEffect.id, includePossible: false });
  assert(reverse.entries.some(e => e.id === main.id));
  assert(reverse.entries.some(e => e.kind === 'ffi' && e.externalEntry));
  assert(reverse.witnesses.some(w => w.nodeIds.includes('dep::read_input')));
  assert.equal(reverse.finding.absenceProven, false); assert.equal(reverse.semantics.orderedExecution, false);
});

test('possible reference routes remain explicitly nonexecution and never establish absence', () => {
  const index = core(fixture()), main = entry(index, 'app::main', 'binary');
  const possible = index.route({ entryId: main.id, includePossible: true });
  const network = possible.effects.find(e => e.category === 'network');
  assert(network); assert.equal(network.routeCertainty, 'possible-reference-or-entry');
  assert(possible.witnesses.some(w => w.effectId === network.id && w.includesReference && w.certainty === 'possible'));
  assert(possible.edges.some(e => e.kind === 'registration' && !e.execution));
  const no = index.route({ entryId: main.id, effectId: network.id, includePossible: false });
  assert.equal(no.effects.length, 0); assert.equal(no.finding.status, 'no-recorded-route');
  assert.equal(no.finding.absenceProven, false); assert(no.finding.unknownReachableEffects > 0);
});

test('independent host adapter is declarative, versioned and capture-bound replayable', async () => {
  const raw = independent(), index = core(raw), api = Analysis.create(raw);
  const host = index.entries.find(e => e.kind === 'host-callback');
  assert.equal(host.provenance.adapter, 'independent-host-integration@1.0.0');
  const result = await api.query({ op: 'effectPaths', entryId: host.id });
  assert(result.effects.items.some(e => e.operation === 'host-transport-send'));
  assert.equal(result.versions.entryEffects, 1);
  const replay = await api.query({ op: 'replay', replay: result.replay });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.effects, result.effects);
  const changed = structuredClone(raw), holder = changed.nodes[0];
  const config = JSON.parse(holder.attributes.entry_effects); config.adapters[0].version = '2.0.0';
  holder.attributes.entry_effects = JSON.stringify(config);
  assert.equal((await Analysis.create(changed).query({ op: 'replay', replay: result.replay })).error.code, 'CAPTURE_MISMATCH');
});

test('legacy and malformed models remain visibly incomplete; private APIs and missing effects are not guessed', () => {
  const raw = { nodes: callable('legacy::main', 'legacy', [], { target_kind: undefined,
    declaration_visibility: undefined, external_visibility: undefined }), edges: [] };
  const legacy = core(raw);
  assert(!legacy.entries.some(e => e.kind === 'binary'));
  assert.equal(legacy.coverage.declarationMetadata, 'partial-or-legacy');
  raw.nodes[0].attributes.entry_effects = '{broken';
  assert.match(core(raw).coverage.adapterDiagnostics.items[0], /malformed/);
  raw.nodes[0].attributes.entry_effects = JSON.stringify({ schemaVersion: 2, adapters: [] });
  assert.match(core(raw).coverage.adapterDiagnostics.items[0], /schemaVersion/);
  raw.nodes[0].attributes.entry_effects = JSON.stringify({ schemaVersion: 1, adapters: [{ id: 'bad', version: '1',
    entries: [{ id: 'unowned', selector: { path: 'legacy::main' }, kind: 'handler' }] }] });
  assert.match(core(raw).coverage.adapterDiagnostics.items[0], /packageId/);
});

test('exact package versions remain distinct and adapters never acquire ownership from paths', () => {
  const raw = { nodes: [
    ...callable('version1', 'common@1', []), ...callable('version2', 'common@2', [])], edges: [] };
  for (const n of raw.nodes) n.attributes.path = n.attributes.kind === 'flow_function' ? n.attributes.path : 'common::send';
  raw.nodes[0].attributes.entry_effects = JSON.stringify({ schemaVersion: 1, adapters: [{ id: 'package-model', version: '1',
    summaries: [{ id: 'v2', selector: { path: 'common::send', packageId: 'common@2' }, effects: [{ category: 'network', operation: 'send' }] }] }] });
  const effects = core(raw).effects.filter(e => e.category === 'network');
  assert.equal(effects.length, 1); assert.equal(effects[0].packageId, 'common@2');
});

test('paging and scope label the full result without mutating or rehashing the raw graph per query', async () => {
  const raw = fixture(), original = JSON.stringify(raw), api = Analysis.create(raw);
  const inventory = await api.query({ op: 'entrypoints', page: { limit: 1 } });
  assert(inventory.entries.total > 1); assert.equal(inventory.entries.nextOffset, 1);
  const main = core(raw).entries.find(e => e.kind === 'binary');
  const result = await api.query({ op: 'effectPaths', entryId: main.id, includePossible: false,
    scope: { packageIds: ['app'] }, page: { nodes: { limit: 1 } } });
  assert(result.nodes.total > result.nodes.items.length); assert.equal(result.completion.evidenceComplete, false);
  const all = [];
  for (let offset = 0; offset < result.nodes.total; offset++) {
    const page = await api.query({ op: 'effectPaths', entryId: main.id, includePossible: false,
      scope: { packageIds: ['app'] }, page: { nodes: { offset, limit: 1 } } });
    all.push(...page.nodes.items);
  }
  assert(all.some(n => n.packageId === 'dep' && n.outsideScope));
  assert.equal(JSON.stringify(raw), original);
  assert.equal((await api.query({ op: 'effectPaths', entryId: 'missing' })).error.code, 'INVALID_ENTRY_EFFECTS');
  assert.equal((await api.query({ op: 'effects', page: { effects: { limit: 101 } } })).error.code, 'INVALID_PAGE');
  assert.equal((await api.query({ op: 'effectPaths', entryId: main.id, includePossible: 'yes' })).error.code, 'INVALID_REQUEST');
});

test('build and unknown phases use captured target metadata rather than a name prefix', () => {
  const raw = { nodes: [
    ...callable('build_unit::main', 'builder', [], { target_kind: '["custom-build"]', capture_scope: 'build_dependency' }),
    ...callable('not_application::main', 'unknown', [], { target_kind: undefined, capture_scope: undefined })], edges: [] };
  const index = core(raw);
  assert.equal(entry(index, 'build_unit::main', 'build-script').buildPhase, 'build');
  assert(!index.entries.some(e => e.path === 'not_application::main' && e.kind === 'binary'));
  assert.equal(entry(index, 'not_application::main', 'disconnected-root').buildPhase, 'unknown');
});

test('standard summaries require compiler std identity and sysroot artifact, never a std-like application path', () => {
  const raw = { nodes: [
    ...callable('app::caller', 'app', [standard('std::fs::read_to_string')]),
    ...callable('std::fs::read_to_string', 'application', [], { function_id: 'application-std-lookalike' }),
    ...callable('legacy::caller', 'app', ['std::fs::write']),
    ...callable('dep::caller', 'app', [{ ...standard('std::fs::remove_file'),
      callee_artifact: '/app/target/deps/libstd-aabbcc.rlib' }])], edges: [] };
  // The proven std call cannot bind to a different identified application body.
  const index = core(raw);
  assert(!index.effects.some(e => e.nodeId === 'std::fs::read_to_string' && e.category === 'filesystem'));
  const proven = index.effects.find(e => e.category === 'filesystem');
  assert(proven && proven.path === 'std::fs::read_to_string');
  assert.match(proven.nodeId, /^boundary::/);
  assert(!index.effects.some(e => e.path === 'std::fs::write' && e.category === 'filesystem'));
  assert(!index.effects.some(e => e.operation === 'remove'));
  const captured = { nodes: [
    ...callable('app::caller', 'app', [{ ...standard('std::fs::write'), callee: 'dep::canonical_std_body' }]),
    ...callable('dep::canonical_std_body', 'sysroot-std', [], { function_id: 'compiler:std::fs::write', display_path: 'std::fs::write' })], edges: [] };
  assert(core(captured).effects.some(e => e.nodeId === 'dep::canonical_std_body' && e.category === 'filesystem'));
});

test('authoritative compiler IDs suppress redirected and unmatched raw decoy relations', () => {
  for (const calleeId of ['right-id', 'missing-id']) {
    const raw = { nodes: [
      ...callable('app::caller', 'app', [{ callee: 'app::wrong', callee_id: calleeId }]),
      ...callable('app::wrong', 'app', [standard('std::fs::write')], { function_id: 'wrong-id' }),
      ...callable('app::right', 'app', [standard('std::env::var')], { function_id: 'right-id' })],
      edges: [{ source: 'app::caller', target: 'app::wrong', relation: 'calls' }] };
    const index = core(raw), caller = entry(index, 'app::caller', 'library-api');
    for (const includePossible of [false, true]) {
      const route = index.route({ entryId: caller.id, includePossible });
      assert(!route.effects.some(e => e.category === 'filesystem'), calleeId);
      assert(!route.edges.some(e => e.target === 'app::wrong'), calleeId);
    }
    if (calleeId === 'right-id') assert(index.route({ entryId: caller.id }).nodes.some(n => n.id === 'app::right'));
  }
  const raw = { nodes: [...callable('raw::caller', 'raw', []), ...callable('raw::sink', 'raw', [standard('std::fs::write')])],
    edges: [{ source: 'raw::caller', target: 'raw::sink', relation: 'member_calls' }] };
  const index = core(raw), caller = entry(index, 'raw::caller', 'library-api');
  assert(!index.route({ entryId: caller.id, includePossible: false }).effects.some(e => e.category === 'filesystem'));
  assert(index.route({ entryId: caller.id, includePossible: true }).edges.some(e => !e.execution && e.possible));
});

test('resolved possible trait dispatch survives the authoritative route projection', () => {
  const implementation = 'app::<Private as PublicTrait>::run';
  const raw = { nodes: [
    ...callable('app::caller', 'app', ['app::PublicTrait::run']),
    ...callable(implementation, 'app', [standard('std::fs::write')], { kind: 'method',
      declaration_visibility: 'default', external_visibility: 'unknown', impl_trait: 'PublicTrait' }),
    { id: 'trait', attributes: { kind: 'trait', path: 'PublicTrait', crate: 'app' } },
    { id: 'declaration', attributes: { kind: 'method', path: 'PublicTrait::run', crate: 'app' } },
    { id: 'owner', attributes: { kind: 'struct', path: 'Private', crate: 'app' } }], edges: [
      { source: 'trait', target: 'declaration', relation: 'has_method' },
      { source: 'owner', target: 'trait', relation: 'implements' },
      { source: 'owner', target: implementation, relation: 'has_method' },
      { source: implementation, target: 'flow:' + implementation, relation: 'has_flow' }] };
  const index = core(raw), caller = entry(index, 'app::caller', 'library-api');
  const route = index.route({ entryId: caller.id, includePossible: false });
  assert(route.effects.some(e => e.category === 'filesystem'));
  assert(route.edges.some(e => e.kind === 'dispatch' && e.execution && e.possible));
  const candidate = entry(index, implementation, 'library-api');
  assert(candidate && candidate.certainty === 'possible' && !candidate.externalEntry);
  assert.equal(candidate.discoveryMechanism, 'unresolved-trait-accessibility');
  assert(!entry(index, implementation, 'disconnected-root'), 'internal caller is not the source of the accessibility candidate');
  assert(index.coverage.unresolvedAccessibility > 0);
  assert.equal(index.coverage.declarationMetadata, 'partial-or-legacy');
});

test('native boundary execution remains available through the canonical route seam', () => {
  const raw = { nodes: [
    ...callable('app::native_caller', 'app', [{ kind: 'call', callee: null,
      native_call: { symbol: 'send_native' }, native_target_ids: ['native::send'], callee_package_id: 'ffi' }]),
    ...callable('native::send', 'ffi', null, { language: 'native', native_symbol: 'send_native', has_body: 'false' })], edges: [] };
  const index = core(raw), caller = entry(index, 'app::native_caller', 'library-api');
  const route = index.route({ entryId: caller.id, includePossible: false });
  assert(route.edges.some(edge => edge.kind === 'native_call' && edge.execution));
  assert(route.effects.some(effect => effect.nodeId === 'native::send' && effect.category === 'native'));
});

test('target-root structure excludes nested and associated mains and workspace alone has unknown phase', () => {
  const raw = { nodes: [
    ...callable('bin::app::main', 'app', [], { target_kind: '["bin"]', rustdoc_root_function: 'true' }),
    ...callable('bin::app::helper::main', 'app', [], { target_kind: '["bin"]', rustdoc_root_function: 'false' }),
    ...callable('bin::app::Type::main', 'app', [], { target_kind: '["bin"]', rustdoc_root_function: 'false' }),
    ...callable('build::main', 'app', [], { target_kind: '["custom-build"]', rustdoc_root_function: 'true' }),
    ...callable('build::helper::main', 'app', [], { target_kind: '["custom-build"]', rustdoc_root_function: 'false' }),
    ...callable('legacy::main', 'app', [], { target_kind: '["bin"]' }),
    ...callable('workspace::missing_kind', 'app', [], { target_kind: undefined })], edges: [] };
  const index = core(raw);
  const root = entry(index, 'bin::app::main', 'binary');
  assert(root && !root.externalEntry && root.certainty === 'possible');
  assert.equal(root.discoveryMechanism, 'captured-target-root-declaration');
  assert(!entry(index, 'bin::app::helper::main', 'binary'));
  assert(!entry(index, 'bin::app::Type::main', 'binary'));
  assert(!entry(index, 'build::helper::main', 'build-script'));
  assert.equal(entry(index, 'build::main', 'build-script').buildPhase, 'build');
  assert.equal(entry(index, 'legacy::main', 'binary').certainty, 'possible');
  assert.equal(entry(index, 'workspace::missing_kind', 'library-api').buildPhase, 'unknown');
});

test('a private rootless call SCC has a deterministic selectable candidate and reverse route', () => {
  const privateAttrs = { declaration_visibility: 'default', external_visibility: 'private' };
  const raw = { nodes: [
    ...callable('private::b', 'app', ['private::a', standard('std::fs::write')], privateAttrs),
    ...callable('private::a', 'app', ['private::b'], privateAttrs)], edges: [] };
  const index = core(raw), candidates = index.entries.filter(e => e.kind === 'disconnected-root');
  assert.deepEqual(candidates.map(e => e.nodeId), ['private::a']);
  assert.equal(candidates[0].externalEntry, false);
  const forward = index.route({ entryId: candidates[0].id, includePossible: false });
  assert(forward.edges.some(e => e.source === 'private::a' && e.target === 'private::b'));
  assert(forward.edges.some(e => e.source === 'private::b' && e.target === 'private::a'));
  const effect = forward.effects.find(e => e.category === 'filesystem'); assert(effect);
  const reverse = index.route({ effectId: effect.id, includePossible: false });
  assert(reverse.entries.some(e => e.id === candidates[0].id));
  assert.equal(reverse.finding.status, 'structural-routes');
  assert(reverse.witnesses.some(w => w.nodeIds.includes('private::b')));
  const filtered = index.route({ effectId: effect.id, kind: 'absent-entry-kind', includePossible: false });
  assert.equal(filtered.effects.length, 1, 'effect remains inventoried');
  assert.equal(filtered.entries.length, 0);
  assert.equal(filtered.nodes.length, 0);
  assert.equal(filtered.witnesses.length, 0);
  assert.equal(filtered.finding.status, 'no-recorded-route');
});

// The executor supplies a real offline capture after independent source review.
// This assertion fails on dropped exporter metadata or disconnected real wiring.
if (process.env.ENTRY_EFFECT_CAPTURE) test('real offline fixture capture carries exported declarations through API routes', async () => {
  const bytes = fs.readFileSync(process.env.ENTRY_EFFECT_CAPTURE);
  const raw = JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
  const api = Analysis.create(raw), index = core(raw);
  const publicMethod = raw.nodes.find(n => n.label === 'unused_method' && n.attributes.declaration_visibility);
  assert(publicMethod, 'real rustdoc includes unused public methods');
  assert.equal(publicMethod.attributes.external_visibility, 'public');
  const privateMethod = raw.nodes.find(n => n.label === 'public_in_private_module' && n.attributes.declaration_visibility);
  assert(privateMethod); assert.equal(privateMethod.attributes.external_visibility, 'private');
  const exported = index.entries.find(e => e.kind === 'ffi' && /exported_service_entry$/.test(e.path));
  assert(exported && exported.externalEntry, 'ABI + body + export metadata establishes an FFI declaration entry');
  const main = index.entries.find(e => e.kind === 'binary' && e.discoveryMechanism === 'captured-target-root-declaration');
  assert(main, 'real target-root main remains discoverable');
  assert.equal(index.entries.filter(e => e.kind === 'binary').length, 1,
    'nested/associated MIR bodies bind to their declarations without duplicate main candidates');
  const mainBody = raw.nodes.find(n => n.attributes && n.attributes.kind === 'flow_function' &&
    n.attributes.symbol_id === main.nodeId);
  assert(mainBody, 'captured target main binds to its declaration across Cargo/rustc target spelling');
  assert.equal(mainBody.attributes.mapping_status, 'mapped');
  assert.equal(main.certainty, 'possible'); assert.equal(main.externalEntry, false);
  assert(index.coverage.unprovenCompilerEntryIdentities > 0);
  for (const owner of ['helper', 'AssociatedMain']) {
    const nested = raw.nodes.find(n => n.attributes && n.attributes.declaration_visibility &&
      (n.attributes.path || '').endsWith(owner + '::main'));
    assert(nested, 'captured nested/associated main: ' + owner);
    assert.equal(nested.attributes.rustdoc_root_function, 'false');
    assert(!index.entries.some(e => e.kind === 'binary' && e.nodeId === nested.id));
  }
  const lookalike = raw.nodes.find(n => n.attributes && n.attributes.path === 'std::fs::read_to_string' && n.attributes.declaration_visibility);
  assert(lookalike, 'full application std namespace is captured');
  assert(!index.effects.some(e => e.nodeId === lookalike.id && e.category === 'filesystem'));
  const traitCandidate = index.entries.find(e => e.discoveryMechanism === 'unresolved-trait-accessibility' && /activate$/.test(e.path));
  assert(traitCandidate, 'private implementor retains possible public trait-object activation');
  assert.equal(traitCandidate.certainty, 'possible'); assert.equal(traitCandidate.externalEntry, false);
  assert(index.coverage.unresolvedAccessibility > 0);
  assert(index.entries.some(e => e.kind === 'library-api' && /public_effect_factory$/.test(e.path)), 'public trait object factory captured');
  const internalCaller = index.entries.find(e => /internal_trait_caller$/.test(e.path));
  assert(internalCaller, 'private internal trait caller is captured');
  assert(index.route({ entryId: internalCaller.id, includePossible: false }).effects.some(e => e.category === 'filesystem'));
  assert(!index.entries.some(e => e.kind === 'disconnected-root' && e.nodeId === traitCandidate.nodeId), 'impl is internally referenced');
  const forward = await api.query({ op: 'effectPaths', entryId: main.id, includePossible: false });
  assert(forward.effects.items.some(e => e.category === 'filesystem'), 'real cross-package std API summary');
  assert(forward.nodes.items.some(n => /read_input$/.test(n.path)), 'dependency intermediary retained');
  assert(!forward.effects.items.some(e => e.category === 'process'), 'only configured/uninvoked commands');
  const reference = forward.effects.items.find(e => e.category === 'network'); assert.equal(reference, undefined);
  const result = await api.query({ op: 'entrypoints', function: publicMethod.id });
  assert(result.entries.items.some(e => e.kind === 'library-api'));
  const reexported = raw.nodes.find(n => n.label === 'publicly_reexported' && n.attributes.declaration_visibility);
  assert(reexported); assert.equal(reexported.attributes.external_visibility, 'public');
  const evidence = Evidence.create(raw);
  assert.equal(index.query({ op: 'entrypoints' }, evidence).graph.contentSha256, api.graph.contentSha256);
  const modeled = core(captureAdapters(raw, main.nodeId));
  assert(modeled.entries.some(e => e.kind === 'cli-command'));
  const declaredHandler = modeled.entries.find(e => e.kind === 'registered-handler');
  assert.equal(declaredHandler.certainty, 'possible');
  assert(modeled.route({ entryId: main.id, includePossible: true }).effects.some(e => e.category === 'network'));
  assert(!modeled.route({ entryId: main.id, includePossible: false }).effects.some(e => e.category === 'network'));
  assert.equal(core(raw).coverage.externalEntryInventoryComplete, false);
});

test('an internally referenced private callable supports function-origin effects without becoming an inventoried entry', async () => {
  const raw = fixture(), api = Analysis.create(raw);
  const inventory = await api.query({ op: 'entrypoints', function: 'app::invoked' });
  assert.equal(inventory.entries.total, 0);
  assert.equal(inventory.selection.kind, 'selected-function');
  assert.equal(inventory.selection.entryClassification, 'not-established-entry');
  assert.equal(inventory.selection.externalEntry, false);
  const route = await api.query({ op: 'effectPaths', function: 'app::invoked', includePossible: false });
  assert(route.effects.items.some(effect => effect.category === 'sensitive-data'));
  assert.equal(route.entries.items[0].entryClassification, 'not-established-entry');
  const replay = await api.query({ op: 'replay', replay: route.replay });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.effects, route.effects);
  assert.equal((await api.query({ op: 'effectPaths', function: 1 })).error.code, 'INVALID_REQUEST');
  assert.equal((await api.query({ op: 'effectPaths', function: 'missing-callable' })).error.code, 'INVALID_ENTRY_EFFECTS');
});

test('adapter template binding requires one exact inventoried callable for every placeholder', () => {
  const { bindManifest } = require('./bind-entry-effects-adapter.cjs');
  const template = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../tests/fixtures/entry-effects/adapter-example/adapter.json'), 'utf8'));
  const raw = independent();
  assert.throws(() => bindManifest(raw, template, {}), /missing or invalid binding/);
  assert.throws(() => bindManifest(raw, template, { $host_callback: { id: 'absent' } }), /resolved to 0/);
  const duplicate = { nodes: [...callable('one', 'one', []), ...callable('two', 'two', [])], edges: [] };
  duplicate.nodes.forEach(node => { if (node.attributes.kind === 'function') node.attributes.path = 'shared::callback'; });
  assert.throws(() => bindManifest(duplicate, template, { $host_callback: { path: 'shared::callback' } }), /resolved to 2/);
});

test('adapter binding preserves original captures and module bytes while safely embedding the bound manifest', t => {
  const path = require('node:path'), os = require('node:os');
  const { bindCapture } = require('./bind-entry-effects-adapter.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-effects-bind-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = independent(); delete raw.nodes[0].attributes.entry_effects;
  const original = JSON.stringify(raw), moduleBytes = 'const marker = "$&"; /* preserved */';
  const html = '<script id="graph-data">' + original + '</script><script id="entry-effects-source">' + moduleBytes + '</script>';
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/entry-effects/adapter-example/adapter.json'), 'utf8'));
  template.adapters[0].summaries[0].effects[0].operation = '</script> $&';
  const bindings = { $host_callback: { id: 'independent-host::host_callback' }, $transport_emit: { id: 'independent-host::custom_transport::emit' } };
  for (const [name, bytes] of [['graph.json', original], ['graph.html', html], ['template.json', JSON.stringify(template)], ['bindings.json', JSON.stringify(bindings)]])
    fs.writeFileSync(path.join(dir, name), bytes);
  const output = path.join(dir, 'bound');
  bindCapture(path.join(dir, 'graph.json'), path.join(dir, 'graph.html'), path.join(dir, 'template.json'), path.join(dir, 'bindings.json'), output);
  assert.equal(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(dir, 'graph.html'), 'utf8'), html);
  const emitted = fs.readFileSync(path.join(output, 'graph.html'), 'utf8');
  assert(emitted.endsWith('<script id="entry-effects-source">' + moduleBytes + '</script>'));
  const inline = emitted.match(/<script id="graph-data">([\s\S]*?)<\/script>/)[1];
  assert(!inline.includes('</script>')); assert(inline.includes('\\u003c/script>'));
  const bound = JSON.parse(fs.readFileSync(path.join(output, 'graph.json'), 'utf8'));
  assert.deepEqual(JSON.parse(inline), bound);
  assert.equal(JSON.parse(bound.nodes[0].attributes.entry_effects).adapters[0].summaries[0].effects[0].operation, '</script> $&');
});

if (process.env.ENTRY_EFFECT_ADAPTER_CAPTURE) test('fresh independent capture persists exact bound identities and API replay', async () => {
  const { readCapture } = require('./bind-entry-effects-adapter.cjs');
  const raw = readCapture(process.env.ENTRY_EFFECT_ADAPTER_CAPTURE), api = Analysis.create(raw), index = core(raw);
  const carrier = raw.nodes.find(node => node.attributes && node.attributes.entry_effects);
  assert(carrier, 'bound manifest persists in replayed graph');
  const manifest = JSON.parse(carrier.attributes.entry_effects);
  const adapter = manifest.adapters.find(item => item.id === 'independent-host-integration'); assert(adapter);
  for (const rule of [...adapter.entries, ...adapter.summaries]) {
    assert(raw.nodes.some(node => node.id === rule.selector.id), 'bound selector is a captured raw ID');
    assert(!rule.selector.id.startsWith('$'));
  }
  assert.equal(index.coverage.adapterDiagnostics.total, 0);
  const host = index.entries.find(row => row.kind === 'host-callback'); assert(host);
  const route = await api.query({ op: 'effectPaths', entryId: host.id, includePossible: false });
  assert(route.effects.items.some(effect => effect.operation === 'host-transport-send'));
  const replay = await api.query({ op: 'replay', replay: route.replay });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.effects, route.effects);
  const changed = structuredClone(raw);
  const changedCarrier = changed.nodes.find(node => node.id === carrier.id);
  const next = JSON.parse(changedCarrier.attributes.entry_effects); next.adapters[0].version += '-changed';
  changedCarrier.attributes.entry_effects = JSON.stringify(next);
  assert.equal((await Analysis.create(changed).query({ op: 'replay', replay: route.replay })).error.code, 'CAPTURE_MISMATCH');
});
