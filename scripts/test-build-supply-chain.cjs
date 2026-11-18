'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const Analysis = require('../src/analysis-api.js');
const EntryEffects = require('../src/entry-effects.js');
const Model = require('../src/execution-model.js');
const { fixture, legacyFixture, registrationFixture, callbackFixture, emptyCallbackFixture, bindingCases, bindingFixture, contextFixture, unit } = require('../tests/fixtures/build-supply-chain/fixture-graphs.cjs');

test('build inventory retains exact units, duplicate versions, conditional declarations and unknown selection', async () => {
  const api = Analysis.create(fixture());
  const result = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  assert.equal(result.buildExecutionVersion, 'cargo-build-execution-v1');
  assert.equal(result.versions.buildExecution, 'cargo-build-execution-v1');
  assert(result.inventory.items.some(x => x.kind === 'build-script'));
  assert(result.inventory.items.some(x => x.kind === 'proc-macro'));
  const conditional = result.inventory.items.find(x => x.targetCondition === 'cfg(target_os = "none")');
  assert.equal(conditional.packageId, 'duplicate@1'); assert.equal(conditional.buildUnitId, null);
  assert.equal(conditional.evidenceKind, 'declaration'); assert.match(conditional.selectionStatus, /not evaluated/);
  assert(result.inventory.items.some(x => x.packageId === 'duplicate@2'));
  assert(result.inventory.items.some(x => x.phases.includes('dev-test')));
  const shared = result.units.items.filter(x => x.packageId === 'shared@1');
  assert.deepEqual(shared.find(x => x.buildUnitId === 'host-unit').phases, ['build']);
  assert.deepEqual(shared.find(x => x.buildUnitId === 'target-unit').phases, ['application']);
  assert.deepEqual(shared.find(x => x.buildUnitId === 'reused-unit').phases, ['application', 'build']);
  assert(shared.every(x => x.targetTriple === 'same-host-and-target'));
  assert.equal(result.buildExecutionCoverage.partial, true);
  const firstPage = await api.query({ op: 'buildInventory', page: { units: { limit: 1 } } });
  assert.equal(firstPage.units.items.length, 1); assert(firstPage.units.total > 1); assert.equal(firstPage.units.nextOffset, 1);
  firstPage.units.items[0].phases.push('mutated-caller-copy');
  firstPage.buildExecutionCoverage.note = 'changed';
  const fresh = await api.query({ op: 'buildInventory', page: { units: { limit: 1 } } });
  assert(!fresh.units.items[0].phases.includes('mutated-caller-copy')); assert.notEqual(fresh.buildExecutionCoverage.note, 'changed');
});

test('typed entries and reachable filesystem/process/environment/network summaries retain build evidence without execution claims', async () => {
  const raw = fixture(), index = EntryEffects.build(raw), api = Analysis.create(raw);
  const entries = await api.query({ op: 'entrypoints', phase: 'build', page: { limit: 100 } });
  const script = entries.entries.items.find(x => x.path === 'builder::main' && x.kind === 'build-script');
  const macro = entries.entries.items.find(x => x.path === 'macros::emit' && x.kind === 'proc-macro');
  assert(script && macro); assert.equal(script.buildUnitId, 'build-unit');
  assert(!entries.entries.items.some(x => x.path === 'builder::nested::main' && x.kind === 'build-script'));
  const paths = await api.query({ op: 'effectPaths', phase: 'build', entryId: script.id, includePossible: false, page: { limit: 100 } });
  for (const operation of ['write', 'spawn', 'environment-read']) assert(paths.effects.items.some(x => x.operation === operation), operation);
  assert(!paths.nodes.items.some(x => x.path === 'shared::target_probe'), 'target-only unit does not bleed into build routes');
  assert(paths.effects.items.every(x => x.executionObserved === false));
  assert(paths.effects.items.filter(x => x.certainty === 'modeled').every(x => x.evidenceKind === 'modeled-capability'));
  const expansion = index.route({ entryId: macro.id, includePossible: false, phase: 'build' });
  assert(expansion.effects.some(x => x.category === 'network'));
  assert.equal(expansion.finding.absenceProven, false);
  const wrongPhase = await api.query({ op: 'effectPaths', phase: 'application', entryId: script.id });
  assert(wrongPhase.error);
});

test('missing bodies, source references, cached reports and OUT_DIR artifacts preserve unknown writers', async () => {
  const api = Analysis.create(fixture());
  const entries = await api.query({ op: 'entrypoints', phase: 'build', page: { limit: 100 } });
  const missing = entries.entries.items.find(x => x.kind === 'build-script' && x.packageId === 'missing@1');
  assert(missing); assert.equal(missing.bodyStatus, 'unavailable'); assert.equal(missing.buildUnitId, null);
  const route = await api.query({ op: 'effectPaths', entryId: missing.id, phase: 'build', includePossible: false });
  assert(route.effects.items.some(x => x.certainty === 'unknown')); assert.equal(route.finding.absenceProven, false);
  const inventory = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  const links = inventory.relationships.items;
  assert.equal(links.find(x => x.kind === 'native-link').producer, null, 'even a legacy inferred package is not writer proof');
  assert.equal(links.find(x => x.kind === 'generated-source-reference').producer, null);
  const report = links.find(x => x.kind === 'build-script-output-report');
  assert.deepEqual(report.environmentNames, ['FIXTURE_BUILD_DECLARATION']);
  assert.match(report.relationship, /cached/); assert.equal(report.executionObserved, false);
  const compiler = links.find(x => x.kind === 'compiler-output');
  assert.equal(compiler.producerStatus, 'reported-compiler-target'); assert.equal(compiler.producerBuildUnitId, null);
  const unrooted = fixture();
  for (const node of unrooted.nodes.filter(n => n.id === 'app::main' || n.id === 'flow:app::main')) {
    delete node.attributes.compiler_entry; node.attributes.rustdoc_root_function = 'false';
  }
  const unknownPhase = await Analysis.create(unrooted).query({ op: 'buildInventory', phase: 'unknown', page: { limit: 100 } });
  assert(unknownPhase.relationships.items.some(x => x.kind === 'generated-source-reference' && x.phases.includes('unknown')),
    'missing consumer activation keeps source evidence visible under unknown phase');
});

test('legacy, malformed and ambiguous contexts remain unknown; phase filters and replay are exact', async () => {
  for (const badContext of [undefined, { schemaVersion: 9 }, null]) {
    const raw = fixture(), pkg = raw.nodes.find(n => n.id === 'package:shared@1');
    const data = JSON.parse(pkg.attributes.build_units); data.units[0].context = badContext;
    pkg.attributes.build_units = JSON.stringify(data);
    const result = await Analysis.create(raw).query({ op: 'buildInventory', page: { limit: 100 } });
    const row = result.units.items.find(x => x.buildUnitId === 'host-unit');
    assert.equal(row.targetTriple, null); assert.notEqual(row.contextStatus, 'captured');
  }
  const raw = fixture(), app = raw.nodes.find(n => n.id === 'package:app@1');
  const units = JSON.parse(app.attributes.build_units); units.units.push(unit('build-unit', 'build-script-build', ['custom-build'], '/fixture/build.rs'));
  app.attributes.build_units = JSON.stringify(units);
  const api = Analysis.create(raw), result = await api.query({ op: 'buildInventory', phase: 'build', page: { limit: 100 } });
  assert(result.buildExecutionCoverage.diagnostics.some(x => /duplicate compiler unit/.test(x)));
  const unknown = await api.query({ op: 'buildInventory', phase: 'impossible' }); assert.equal(unknown.error.code, 'INVALID_PHASE');
  const replayed = await api.query({ op: 'replay', replay: result.replay });
  assert.deepEqual(replayed.inventory, result.inventory); assert.equal(replayed.request.phase, 'build');
  const pinned = structuredClone(result.replay); pinned.versions.buildExecution = 'future';
  assert.equal((await api.query({ op: 'replay', replay: pinned })).error.code, 'VERSION_MISMATCH');
});

test('saved phase-bearing responses cannot mutate phase guards, memberships or replay', async () => {
  const raw = fixture(), api = Analysis.create(raw), query = request => api.query({ page: { limit: 100 }, ...request });
  const baseline = await query({ op: 'entrypoints' }), inventory = await query({ op: 'buildInventory' });
  const script = baseline.entries.items.find(e => e.path === 'builder::main' && e.kind === 'build-script');
  const saved = await query({ op: 'entrypoints', phase: 'build' });
  saved.entries.items.find(e => e.id === script.id).phases.push('application');
  const effects = await query({ op: 'effects', phase: 'build' });
  const write = effects.effects.items.find(e => e.operation === 'write'); assert(write);
  write.phases.push('application');
  const request = { op: 'effectPaths', phase: 'build', entryId: script.id, includePossible: false };
  const route = await query(request), expected = structuredClone(route);
  for (const field of ['entries', 'effects', 'nodes']) for (const row of route[field].items) row.phases.push('application');
  const selection = await query({ op: 'entrypoints', function: 'builder::main' }); selection.selection.phases.push('application');
  assert((await query({ op: 'effectPaths', phase: 'application', entryId: script.id })).error);
  assert((await query({ op: 'effectPaths', phase: 'application', effectId: write.id })).error);
  assert.deepEqual((await query({ op: 'entrypoints' })).entries, baseline.entries);
  assert.deepEqual((await query({ op: 'buildInventory' })).units, inventory.units);
  const fresh = await query(request), replay = await api.query({ op: 'replay', replay: expected.replay });
  for (const field of ['entries', 'effects', 'nodes', 'edges', 'witnesses']) {
    assert.deepEqual(fresh[field], expected[field]); assert.deepEqual(replay[field], expected[field]);
  }
  const index = EntryEffects.build(raw), coreRoute = index.route(request); coreRoute.entries[0].phases.push('application');
  coreRoute.effects.forEach(e => e.phases.push('application'));
  assert.throws(() => index.route({ ...request, phase: 'application' }), /no recorded membership/);
});

test('spelling-only build bodies retain a declared unknown boundary instead of compiler entry proof', async () => {
  for (const raw of [fixture(), legacyFixture()]) {
    const legacy = !raw.nodes.find(n => n.id === 'builder::main').attributes.compiler_entry;
    const api = Analysis.create(raw), entries = await api.query({ op: 'entrypoints', page: { limit: 100 } });
    const scripts = entries.entries.items.filter(e => e.kind === 'build-script' && e.packageId === 'app@1');
    const build = await api.query({ op: 'entrypoints', phase: 'build', page: { limit: 100 } });
    const boundary = build.entries.items.find(e => e.kind === 'build-script' && e.packageId === 'app@1'); assert(boundary);
    assert.equal(boundary.discoveryMechanism, legacy ? 'cargo-target-declaration-missing-body' : 'compiler-entry-identity');
    assert.equal(scripts.filter(e => e.discoveryMechanism === 'cargo-target-declaration-missing-body').length, legacy ? 1 : 0);
    assert(!build.entries.items.some(e => e.path === 'builder::nested::main' && e.kind === 'build-script'));
    if (legacy) {
      const candidate = scripts.find(e => e.path === 'builder::main'); assert(candidate);
      assert.equal(candidate.discoveryMechanism, 'unproven-target-entry'); assert.deepEqual(candidate.phases, ['unknown']);
    }
    const route = await api.query({ op: 'effectPaths', entryId: boundary.id, phase: 'build', includePossible: false });
    assert(route.effects.items.some(e => e.certainty === 'unknown')); assert.equal(route.finding.absenceProven, false);
    const replay = await api.query({ op: 'replay', replay: route.replay }); assert.deepEqual(replay.effects, route.effects);
    assert(build.entries.items.some(e => e.kind === 'proc-macro' && e.discoveryMechanism === 'compiler-proc-macro-export'));
  }
});

test('phase endpoint filters agree in forward and reverse reference routes without changing phase-omitted routes', async () => {
  const raw = registrationFixture(), api = Analysis.create(raw), index = EntryEffects.build(raw);
  const script = index.entries.find(e => e.path === 'builder::main' && e.kind === 'build-script');
  const read = index.effects.find(e => e.operation === 'read'); assert(read); assert.deepEqual(read.phases, ['application']);
  const declared = index.entries.find(e => e.packageId === 'missing@1' && e.kind === 'build-script');
  for (const includePossible of [false, true]) {
    const noPhase = await api.query({ op: 'effectPaths', entryId: script.id, includePossible, page: { limit: 100 } });
    assert.equal(noPhase.effects.items.some(e => e.id === read.id), includePossible);
    if (includePossible) {
      assert(noPhase.edges.items.some(e => e.kind === 'registration' && !e.execution));
      assert(noPhase.nodes.items.some(e => e.path === 'shared::target_probe'));
    }
    for (const phase of ['build', 'application', 'unknown']) {
      const entryId = phase === 'unknown' ? declared.id : script.id;
      const forward = await api.query({ op: 'effectPaths', entryId, phase, includePossible, page: { limit: 100 } });
      const reverse = await api.query({ op: 'effectPaths', effectId: read.id, phase, includePossible, page: { limit: 100 } });
      if (phase === 'build') { assert(!forward.error); assert(!forward.effects.items.some(e => e.id === read.id)); assert(reverse.error); }
      if (phase === 'application') { assert(forward.error); assert(!reverse.error); assert(reverse.entries.items.every(e => e.phases.includes(phase))); }
      if (phase === 'unknown') { assert(forward.error); assert(reverse.error); }
      const effects = await api.query({ op: 'effects', phase, page: { limit: 100 } });
      assert(effects.effects.items.every(e => e.phases.includes(phase)));
    }
    const unknown = index.entries.find(e => e.path === 'builder::nested::main'); assert(unknown);
    const route = await api.query({ op: 'effectPaths', entryId: unknown.id, phase: 'unknown', includePossible });
    assert(!route.error); assert(route.effects.items.every(e => e.phases.includes('unknown')));
    const application = index.entries.find(e => e.path === 'app::main' && e.kind === 'binary');
    const target = await api.query({ op: 'effectPaths', entryId: application.id, phase: 'application', includePossible });
    assert(target.effects.items.some(e => e.id === read.id));
  }
});

test('callback phase membership uses each invocation and forwarding, preserving global alternatives and capability boundaries', async () => {
  const raw = callbackFixture(), index = EntryEffects.build(raw), api = Analysis.create(raw);
  const build = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  for (const [unit, expected] of [['build-unit', ['build']], ['app-unit', ['application']], ['reused-unit', ['application', 'build']]])
    assert.deepEqual(build.units.items.find(u => u.buildUnitId === unit).phases, expected, unit);
  for (const [name, expected] of [['builder::host_only', ['build']], ['app::target_only', ['application']],
    ['shared::forward', ['application', 'build']], ['shared::invoke', ['application', 'build']]]) {
    const selected = await api.query({ op: 'entrypoints', function: name }); assert.deepEqual(selected.selection.phases, expected, name);
    for (const phase of ['build', 'application']) {
      const route = await api.query({ op: 'effectPaths', function: name, phase, includePossible: false });
      assert.equal(!!route.error, !expected.includes(phase), name + ' ' + phase);
    }
  }
  const model = Model.build(raw), invocation = model.calls.find(c => c.procedure === 'shared::invoke');
  assert.deepEqual(invocation.possibleTargets, ['app::target_only', 'builder::host_only'], 'diagram union remains intact');
  const script = index.entries.find(e => e.kind === 'build-script' && e.path === 'builder::main');
  const route = await api.query({ op: 'effectPaths', entryId: script.id, phase: 'build', includePossible: false, page: { limit: 100 } });
  for (const operation of ['write', 'spawn', 'environment-read']) assert(route.effects.items.some(e => e.operation === operation), operation);
  assert(!route.effects.items.some(e => e.operation === 'read'));
  const unfiltered = await api.query({ op: 'effectPaths', entryId: script.id, includePossible: false, page: { limit: 100 } });
  assert(unfiltered.edges.items.some(e => e.target === 'app::target_only'), 'global structural alternatives remain available without a phase filter');
  const unknown = callbackFixture(), flow = unknown.nodes.find(n => n.id === 'flow:app::main');
  const body = JSON.parse(flow.attributes.flow); body.blocks[0].callback_args = [{ index: 0, targets: [], unknown: true }];
  flow.attributes.flow = JSON.stringify(body);
  const partial = Analysis.create(unknown), selected = await partial.query({ op: 'entrypoints', function: 'app::target_only' });
  assert.deepEqual(selected.selection.phases, ['unknown']);
  const host = await partial.query({ op: 'entrypoints', function: 'builder::host_only' }); assert.deepEqual(host.selection.phases, ['build']);
  const inventory = await partial.query({ op: 'buildInventory', page: { limit: 100 } });
  assert.equal(inventory.buildExecutionCoverage.phaseMembership.partial, true);
  assert(inventory.buildExecutionCoverage.phaseMembership.unresolvedCalls > 0);
});

for (const kind of ['ordinary', 'invocation']) test('empty callback collections preserve known ' + kind + ' calls and replay', async () => {
  let baseline;
  for (const format of ['omitted', 'array', 'null']) {
    const api = Analysis.create(emptyCallbackFixture(kind, format)), snapshot = {};
    for (const [op, field] of [['buildInventory', 'units'], ['entrypoints', 'entries'], ['effects', 'effects']]) {
      const result = await api.query({ op, page: { limit: 100 } });
      const coverage = op === 'buildInventory' ? result.buildExecutionCoverage.phaseMembership : result.entryEffectCoverage.phaseMembership;
      snapshot[field] = result[field]; snapshot.coverage = coverage;
      const replay = await api.query({ op: 'replay', replay: result.replay });
      assert.deepEqual(replay[field], result[field], kind + ' ' + format + ' replay ' + field);
      assert.deepEqual(op === 'buildInventory' ? replay.buildExecutionCoverage.phaseMembership : replay.entryEffectCoverage.phaseMembership, coverage);
      for (const marker of kind === 'ordinary' ? ['application:app::main#bb0@call'] :
        ['application:shared::invoke#bb0@call', 'build:shared::invoke#bb0@call']) assert(!coverage.items.includes(marker), marker);
      assert(coverage.items.includes('application:' + (kind === 'ordinary' ? 'shared::target_probe' : 'app::target_only') + '#bb0@call'),
        'genuine missing std body remains unresolved');
      assert.equal(coverage.partial, true); assert.equal(coverage.truncated, false);
      if (op === 'buildInventory') assert(result.relationships.items.some(r => r.kind === 'native-link' && r.producer == null));
      if (op === 'entrypoints') assert(result.entries.items.some(e => e.packageId === 'missing@1' && e.bodyStatus === 'unavailable'));
    }
    if (baseline) assert.deepEqual(snapshot, baseline, kind + ' ' + format);
    else baseline = snapshot;
  }
});

for (const spec of bindingCases) test('callback facts are conservative and call-specific: ' + spec.name, async () => {
  const raw = bindingFixture(spec), capturedFlow = raw.nodes.find(n => n.id === 'flow:app::main').attributes.flow;
  const api = Analysis.create(raw);
  const inventory = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  const coverage = inventory.buildExecutionCoverage.phaseMembership;
  assert.equal(coverage.items.includes('application:app::main#bb0@call'), !!spec.invalid, 'raw application call certainty');
  assert.equal(coverage.items.includes('application:shared::invoke#bb0@call'), !!spec.usedUnknown, 'used callback destination certainty');
  const selected = await api.query({ op: 'entrypoints', function: 'app::target_only' });
  assert.deepEqual(selected.selection.phases, spec.precise ? ['application'] : ['unknown']);
  const host = await api.query({ op: 'entrypoints', function: 'builder::host_only' });
  assert.deepEqual(host.selection.phases, Object.hasOwn(spec, 'invocationParameter') ? ['unknown'] : ['build']);
  const replay = await api.query({ op: 'replay', replay: inventory.replay });
  assert.deepEqual(replay.buildExecutionCoverage, inventory.buildExecutionCoverage);
  const entries = await api.query({ op: 'entrypoints' }), effects = await api.query({ op: 'effects' });
  assert.deepEqual(entries.entryEffectCoverage.phaseMembership, coverage);
  assert.deepEqual(effects.entryEffectCoverage.phaseMembership, coverage);
  if (spec.invalid || spec.usedUnknown) assert.equal(coverage.partial, true);
  if (spec.objectTargets || Object.hasOwn(spec, 'references')) {
    assert.deepEqual(replay, { ...inventory, replayed: true }, spec.name + ' full inventory replay');
    const route = await api.query({ op: 'effectPaths', function: 'app::main', includePossible: true, page: { limit: 100 } });
    assert.equal(route.error, undefined);
    assert.equal(route.finding.absenceProven, false);
    const references = route.edges.items.filter(e => e.source === 'app::main' && e.kind === 'reference');
    assert.deepEqual(references.map(e => e.target), spec.referenceTarget ? [spec.referenceTarget] : [], 'only valid arrays supply callback references');
    assert(references.every(e => e.execution === false), 'callback references remain nonexecuting');
    if (spec.objectTargets) assert(!route.nodes.items.some(n => n.id === 'app::target_only'), 'malformed targets invent no callback route');
    if (spec.callee) assert(route.nodes.items.some(n => n.path === spec.callee && n.bodyStatus === 'unavailable'), 'uncaptured helper remains a boundary');
    assert.deepEqual(await api.query({ op: 'replay', replay: route.replay }), { ...route, replayed: true }, spec.name + ' full route replay');
    assert.equal(raw.nodes.find(n => n.id === 'flow:app::main').attributes.flow, capturedFlow, 'raw malformed facts remain unchanged');
  }
});

test('duplicate binding row order cannot select a different phase destination', async () => {
  const results = [];
  for (const spec of bindingCases.filter(c => c.name.startsWith('duplicate '))) {
    const api = Analysis.create(bindingFixture(spec));
    results.push(await api.query({ op: 'buildInventory', page: { limit: 100 } }));
  }
  assert.deepEqual(results[0].units, results[1].units);
  assert.deepEqual(results[0].buildExecutionCoverage, results[1].buildExecutionCoverage);
});

test('acyclic callback environment branching stops with incomplete phase coverage and preserves supported roots and capabilities', async () => {
  const api = Analysis.create(contextFixture());
  const inventory = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  const coverage = inventory.buildExecutionCoverage.phaseMembership;
  assert.equal(coverage.partial, true); assert.equal(coverage.truncated, true);
  assert(coverage.items.includes('application:phase-inference-budget-exhausted'));
  assert(!coverage.items.includes('build:phase-inference-budget-exhausted'));
  assert.deepEqual((await api.query({ op: 'entrypoints', function: 'budget::F0' })).selection.phases, ['application']);
  assert.deepEqual(inventory.units.items.find(u => u.buildUnitId === 'build-unit').phases, ['build']);
  const request = { op: 'effectPaths', function: 'budget::F0', phase: 'application', includePossible: false };
  const route = await api.query(request);
  assert.equal(route.completion.complete, false); assert.equal(route.completion.evidenceComplete, false);
  assert.deepEqual(route.coverage.phaseMembership, coverage);
  const replay = await api.query({ op: 'replay', replay: route.replay });
  assert.deepEqual(replay.coverage, route.coverage); assert.deepEqual(replay.completion, route.completion);
  const host = await api.query({ op: 'effectPaths', function: 'builder::main', phase: 'build', includePossible: false, page: { limit: 100 } });
  for (const operation of ['write', 'spawn', 'environment-read']) assert(host.effects.items.some(e => e.operation === operation));
  assert(host.effects.items.some(e => e.operation === 'additional-effects-unavailable'));
});

test('small exact environments with recursion and a CFG loop stabilize without budget exhaustion', async () => {
  const api = Analysis.create(contextFixture(2, true));
  const result = await api.query({ op: 'buildInventory' }), coverage = result.buildExecutionCoverage.phaseMembership;
  assert.equal(coverage.truncated, false); assert(!coverage.items.some(item => item.includes('budget-exhausted')));
  assert.deepEqual((await api.query({ op: 'entrypoints', function: 'budget::F2' })).selection.phases, ['application']);
  const route = await api.query({ op: 'effectPaths', function: 'budget::F0', phase: 'application' });
  assert.equal(route.completion.complete, true);
});

test('capability coverage snapshots cannot mutate private phase uncertainty through any new exposure', async () => {
  for (const path of ['buildExecution', 'entryEffects', 'nestedBuildExecution']) {
    const api = Analysis.create(bindingFixture(bindingCases.find(c => c.name === 'empty targets')));
    const inventory = await api.query({ op: 'buildInventory' }), entries = await api.query({ op: 'entrypoints' }), effects = await api.query({ op: 'effects' });
    const route = await api.query({ op: 'effectPaths', function: 'app::main', phase: 'application' });
    const caps = await api.query({ op: 'capabilities' });
    const exposed = path === 'buildExecution' ? caps.buildExecution.coverage.phaseMembership :
      path === 'entryEffects' ? caps.entryEffects.coverage.phaseMembership : caps.entryEffects.coverage.buildExecution.phaseMembership;
    assert(exposed.partial); assert(exposed.unresolvedCalls > 0);
    exposed.partial = false; exposed.unresolvedCalls = 0; exposed.items.splice(0, exposed.items.length, 'caller mutation'); exposed.truncated = !exposed.truncated;
    assert.deepEqual((await api.query({ op: 'buildInventory' })).buildExecutionCoverage, inventory.buildExecutionCoverage, path);
    assert.deepEqual((await api.query({ op: 'entrypoints' })).entryEffectCoverage, entries.entryEffectCoverage, path);
    assert.deepEqual((await api.query({ op: 'effects' })).entryEffectCoverage, effects.entryEffectCoverage, path);
    const replay = await api.query({ op: 'replay', replay: route.replay });
    assert.deepEqual(replay.coverage, route.coverage, path);
    const fresh = await api.query({ op: 'capabilities' });
    assert.deepEqual(fresh.buildExecution.coverage.phaseMembership, inventory.buildExecutionCoverage.phaseMembership, path);
    assert.deepEqual(fresh.entryEffects.coverage.phaseMembership, inventory.buildExecutionCoverage.phaseMembership, path);
    assert.deepEqual(fresh.entryEffects.coverage.buildExecution.phaseMembership, inventory.buildExecutionCoverage.phaseMembership, path);
  }
});

if (process.env.BUILD_SUPPLY_CAPTURE) test('actual controlled compiler capture exposes build roots, native/source evidence and exact shared roles', async () => {
  let bytes = fs.readFileSync(process.env.BUILD_SUPPLY_CAPTURE);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const raw = JSON.parse(bytes), api = Analysis.create(raw, { rawText: bytes.toString() });
  const build = await api.query({ op: 'buildInventory', page: { limit: 100 } });
  const entries = await api.query({ op: 'entrypoints', phase: 'build', page: { limit: 100 } });
  const script = entries.entries.items.find(e => e.kind === 'build-script' && e.discoveryMechanism === 'compiler-entry-identity');
  const macro = entries.entries.items.find(e => e.kind === 'proc-macro' && e.discoveryMechanism === 'compiler-proc-macro-export');
  assert(script, 'real compiler build-script entry identity'); assert(macro, 'real typed proc-macro export');
  const scriptBodies = raw.nodes.filter(n => n.attributes.flow && n.attributes.package_id === script.packageId &&
    n.attributes.unit_key === script.buildUnitId && n.attributes.compiler_entry === 'compiler-main' &&
    [n.id, n.attributes.symbol_id].includes(script.nodeId));
  assert.equal(scriptBodies.length, 1, 'selected compiler entry owns one exact captured build body');
  const scriptBody = JSON.parse(scriptBodies[0].attributes.flow);
  for (const callee of ['std::fs::write', 'std::process::Command::status', 'std::env::var_os']) {
    const calls = scriptBody.blocks.filter(b => b.callee === callee);
    assert(calls.length, 'real build body calls ' + callee);
    for (const call of calls) {
      assert.equal(call.callee_crate, 'std');
      assert.equal(typeof call.callee_id, 'string'); assert(call.callee_id.length > 0);
      assert.match(call.callee_artifact || '', /\/lib\/rustlib\/[^/]+\/lib\/libstd-[a-f0-9]+\.(?:rlib|rmeta|so|dylib|dll)$/,
        'compiler-loaded std artifact for ' + callee + ' at ' + call.id);
    }
  }
  const route = await api.query({ op: 'effectPaths', entryId: script.id, phase: 'build', includePossible: false, page: { limit: 100 } });
  assert(route.effects.items.some(e => e.category === 'filesystem'));
  assert(route.effects.items.some(e => e.category === 'process'));
  assert(route.effects.items.some(e => e.operation === 'environment-read'));
  for (const [category, operation] of [['filesystem', 'write'], ['process', 'spawn'], ['sensitive-data', 'environment-read']])
    assert(route.effects.items.some(e => e.category === category && e.operation === operation && e.certainty === 'modeled' &&
      e.evidenceKind === 'modeled-capability' && e.executionObserved === false && e.provenance.adapter === 'rust-standard-effects-v1'),
    'compiler std modeled capability: ' + operation);
  assert(build.relationships.items.some(r => r.kind === 'generated-source-reference' && r.producer == null));
  assert(build.relationships.items.some(r => r.kind === 'native-link' && r.producer == null));
  const sharedPackage = raw.nodes.find(n => n.attributes.kind === 'crate' && n.attributes.crate === 'shared').attributes.package_id;
  const shared = build.units.items.filter(u => u.packageId === sharedPackage);
  assert(shared.some(u => u.phases.includes('build'))); assert(shared.some(u => u.phases.includes('application')));
  const model = Model.build(raw), byProcedure = new Map(model.procedures.map(p => [p.id, p]));
  const nullCalls = new Set();
  for (const procedure of model.procedures) {
    const node = raw.nodes.find(n => n.id === procedure.rawFlowNodeId), body = JSON.parse(node.attributes.flow);
    for (const block of body.blocks) if (block.callback_args === null) nullCalls.add(procedure.id + '#' + block.id + '@call');
  }
  const knownNullCalls = model.calls.filter(c => nullCalls.has(c.id) && c.callbackParameter == null && !c.unknown &&
    (byProcedure.get(c.procedure).display_path || c.procedure).endsWith('::main') &&
    !(c.dispatchTargets || []).length && c.targets.length && c.targets.every(t => byProcedure.has(t)));
  assert(knownNullCalls.length, 'real imported known ordinary calls retain null callback_args');
  for (const [name, expected] of [['host_only', ['build']], ['target_only', ['application']]]) {
    const callbacks = model.procedures.filter(p => (p.display_path || p.id).endsWith('::' + name));
    assert(callbacks.length, 'real compiler callback body: ' + name);
    for (const callback of callbacks) {
      assert(model.calls.some(c => c.callbackArgs.some(a => (a.targets || []).includes(callback.id))), 'real compiler callback argument binding: ' + name);
      const selected = await api.query({ op: 'entrypoints', function: callback.id });
      assert.deepEqual(selected.selection.phases, expected, 'real invocation-specific membership: ' + name);
    }
  }
  const invocations = model.calls.filter(c => c.callbackParameter === 0 &&
    (byProcedure.get(c.procedure).display_path || c.procedure).endsWith('::invoke'));
  assert(invocations.length, 'real compiler callback parameter invocation');
  const phaseCoverage = build.buildExecutionCoverage.phaseMembership;
  assert.equal(phaseCoverage.truncated, false, 'call-specific coverage assertions require an untruncated list');
  for (const call of knownNullCalls.concat(invocations)) {
    assert(nullCalls.has(call.id), 'real imported zero-argument call retains null callback_args: ' + call.id);
    const selected = await api.query({ op: 'entrypoints', function: call.procedure });
    assert(selected.selection.phases.some(p => p !== 'unknown'), 'known fixture call has a rooted phase: ' + call.id);
    for (const phase of selected.selection.phases.filter(p => p !== 'unknown'))
      assert(!phaseCoverage.items.includes(phase + ':' + call.id), 'valid null callback_args creates no unresolved marker: ' + phase + ':' + call.id);
  }
  const inventoryReplay = await api.query({ op: 'replay', replay: build.replay });
  assert.deepEqual(inventoryReplay.buildExecutionCoverage, build.buildExecutionCoverage);
  const invokePhases = new Set();
  for (const invocation of invocations) {
    const selected = await api.query({ op: 'entrypoints', function: invocation.procedure });
    selected.selection.phases.forEach(p => invokePhases.add(p));
  }
  assert.deepEqual(Array.from(invokePhases).sort(), ['application', 'build']);
  assert.deepEqual(build.units.items.find(u => u.packageId === script.packageId && u.buildUnitId === script.buildUnitId).phases, ['build']);
  const application = (await api.query({ op: 'entrypoints', phase: 'application', page: { limit: 100 } })).entries.items
    .find(e => e.kind === 'binary' && e.discoveryMechanism === 'compiler-entry-identity'); assert(application);
  assert.deepEqual(build.units.items.find(u => u.packageId === application.packageId && u.buildUnitId === application.buildUnitId).phases, ['application']);
  const duplicates = raw.nodes.filter(n => n.attributes.kind === 'crate' && n.attributes.crate === 'duplicate');
  assert.equal(new Set(duplicates.map(n => n.attributes.package_id)).size, 2);
  const serialized = JSON.stringify(build);
  assert(!serialized.includes('controlled-fixture-value'), 'Cargo rustc-env values are not retained');
});

if (process.env.BUILD_SUPPLY_CAPTURE && process.env.BUILD_SUPPLY_PRIOR_CAPTURE) test('unchanged capture retains build units and Cargo reports across crate catalog refresh', async () => {
  function read(file) { let bytes = fs.readFileSync(file); if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes); return JSON.parse(bytes); }
  const previous = await Analysis.create(read(process.env.BUILD_SUPPLY_PRIOR_CAPTURE)).query({ op: 'buildInventory', page: { limit: 100 } });
  const current = await Analysis.create(read(process.env.BUILD_SUPPLY_CAPTURE)).query({ op: 'buildInventory', page: { limit: 100 } });
  assert(previous.units.total > 0); assert(previous.relationships.total > 0);
  for (const field of ['inventory', 'units', 'relationships']) assert.deepEqual(current[field], previous[field]);
});
