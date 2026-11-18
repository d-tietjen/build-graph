'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Analysis = require('../src/analysis-api.js');
const Model = require('../src/execution-model.js');
const { fixture, legacyFixture, registrationFixture, callbackFixture, emptyCallbackFixture, bindingCases, bindingFixture, contextFixture } = require('../tests/fixtures/build-supply-chain/fixture-graphs.cjs');
// Reuse the actual emitted-module/Blob-worker and fallback harness. Requiring
// this module also keeps its existing entry/effect lifecycle regressions active.
const { harness, descendants, until, normalized } = require('./test-viewer-effects.cjs');
function phase(h, value) {
  const select = descendants(h.panel).find(e => e.attributes['aria-label'] === 'Execution phase');
  assert(select); select.value = value; select.listeners.change();
}
function inventory(h) { return descendants(h.panel).find(e => e.attributes['aria-label'] === 'Entries'); }
function evidence(h) {
  return descendants(h.panel).filter(e => e.tagName === 'pre').map(e => { try { return JSON.parse(e.textContent); } catch (_) { return null; } })
    .find(e => e && e.operation === 'buildInventory');
}
async function parity(h, api, request) {
  const browser = await h.ui.queryEntryEffects({ page: { limit: 100 }, ...request });
  const agent = await api.query({ page: { limit: 100 }, ...request });
  assert.equal(browser.error, undefined); assert.equal(agent.error, undefined);
  // The API adds view scope; the renderer adds highlight IDs. Compare every
  // shared payload field, including completion, coverage and replay envelopes.
  const { scope, ...agentPayload } = agent;
  const { activeNodeIds, activeEdgePairs, ...browserPayload } = normalized(browser);
  assert.equal(scope, null); assert.deepEqual(browserPayload, agentPayload);
  return browser;
}
async function phaseRejection(h, api, request) {
  const query = { page: { limit: 100 }, ...request };
  const reason = /(?:entry\/function|effect) has no recorded membership in requested phase/;
  await assert.rejects(h.ui.queryEntryEffects(query), reason);
  const agent = await api.query(query);
  assert.equal(agent.error && agent.error.code, 'INVALID_ENTRY_EFFECTS');
  assert.match(agent.error.message, reason);
}
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} build inventory and phase routes share API, replay and source evidence`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    for (const requestedPhase of ['build', 'application', 'dev-test', 'unknown']) {
      const request = { op: 'buildInventory', phase: requestedPhase, page: { limit: 100 } };
      const browser = await h.ui.queryEntryEffects(request), agent = await api.query(request);
      for (const name of ['inventory', 'units', 'relationships']) assert.deepEqual(normalized(browser[name]), agent[name]);
      const replay = await h.ui.queryEntryEffects({ op: 'replay', replay: browser.replay });
      assert.equal(replay.replayed, true); assert.equal(replay.request.phase, requestedPhase);
    }
    phase(h, 'build');
    await until(() => evidence(h) && evidence(h).request.phase === 'build');
    assert(!inventory(h).children.some(e => /app::main/.test(e.textContent)));
    const entry = (await api.query({ op: 'entrypoints', phase: 'build', page: { limit: 100 } })).entries.items
      .find(e => e.kind === 'build-script' && e.path === 'builder::main');
    const select = inventory(h); select.value = entry.id; select.listeners.change();
    await until(() => h.context.ENTRY_EFFECT_ACTIVE && h.context.ENTRY_EFFECT_ACTIVE.nodes.has('builder::main'));
    assert.equal(h.panelUI.request.phase, 'build');
    assert(descendants(h.panel).some(e => e.tagName === 'a' && e.href && e.href.startsWith('vscode://file/fixture/build.rs')));
    phase(h, 'application');
    assert.equal(h.panelUI.request, null); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    await until(() => evidence(h) && evidence(h).request.phase === 'application');
    assert(!inventory(h).children.some(e => /builder::main/.test(e.textContent)));
    assert.match(descendants(h.panel).map(e => e.textContent).join(' '), /Partial capture/);
  });
  test(`${worker ? 'worker' : 'fallback'} phase changes reject stale build inventory results`, async () => {
    const h = await harness(worker, fixture());
    h.defer(q => q.op === 'buildInventory' && q.phase === 'build'); phase(h, 'build');
    await until(() => h.pending.length > 0);
    const stale = h.pending[h.pending.length - 1]; h.defer(null); phase(h, 'application');
    await until(() => evidence(h) && evidence(h).request.phase === 'application');
    stale.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(evidence(h).request.phase, 'application'); assert.equal(h.panelUI.request, null);
  });
  test(`${worker ? 'worker' : 'fallback'} saved entries, effects and route endpoints cannot change later phase queries`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const baseline = await parity(h, api, { op: 'entrypoints' }), units = await parity(h, api, { op: 'buildInventory' });
    const saved = await parity(h, api, { op: 'entrypoints', phase: 'build' });
    const script = saved.entries.items.find(e => e.path === 'builder::main' && e.kind === 'build-script');
    script.phases.push('application');
    const effects = await parity(h, api, { op: 'effects', phase: 'build' });
    const write = effects.effects.items.find(e => e.operation === 'write'); write.phases.push('application');
    const request = { op: 'effectPaths', phase: 'build', entryId: script.id, includePossible: false };
    const route = await parity(h, api, request), expected = normalized(route);
    for (const field of ['entries', 'effects', 'nodes']) for (const row of route[field].items) row.phases.push('application');
    const selection = await parity(h, api, { op: 'entrypoints', function: 'builder::main' }); selection.selection.phases.push('application');
    await phaseRejection(h, api, { op: 'effectPaths', phase: 'application', entryId: script.id });
    await phaseRejection(h, api, { op: 'effectPaths', phase: 'application', effectId: write.id });
    assert.deepEqual(normalized((await parity(h, api, { op: 'entrypoints' })).entries), normalized(baseline.entries));
    assert.deepEqual(normalized((await parity(h, api, { op: 'buildInventory' })).units), normalized(units.units));
    const fresh = await parity(h, api, request), replay = await parity(h, api, { op: 'replay', replay: expected.replay });
    for (const field of ['entries', 'effects', 'nodes', 'edges', 'witnesses']) {
      assert.deepEqual(normalized(fresh[field]), expected[field]); assert.deepEqual(normalized(replay[field]), expected[field]);
    }
  });
  test(`${worker ? 'worker' : 'fallback'} typed and spelling-only build entries preserve declared unknown effects and replay`, async () => {
    for (const legacy of [false, true]) {
      const raw = legacy ? legacyFixture() : fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
      const build = await parity(h, api, { op: 'entrypoints', phase: 'build' });
      const script = build.entries.items.find(e => e.kind === 'build-script' && e.packageId === 'app@1'); assert(script);
      assert.equal(script.discoveryMechanism, legacy ? 'cargo-target-declaration-missing-body' : 'compiler-entry-identity');
      const all = await parity(h, api, { op: 'entrypoints' });
      assert.equal(all.entries.items.filter(e => e.packageId === 'app@1' && e.discoveryMechanism === 'cargo-target-declaration-missing-body').length, legacy ? 1 : 0);
      if (legacy) assert.deepEqual(normalized(all.entries.items.find(e => e.path === 'builder::main' && e.kind === 'build-script').phases), ['unknown']);
      const route = await parity(h, api, { op: 'effectPaths', entryId: script.id, phase: 'build', includePossible: false });
      assert(route.effects.items.some(e => e.certainty === 'unknown')); assert.equal(route.finding.absenceProven, false);
      const replay = await parity(h, api, { op: 'replay', replay: route.replay });
      assert.deepEqual(normalized(replay.effects), normalized(route.effects));
    }
  });
  test(`${worker ? 'worker' : 'fallback'} phase endpoints consistently filter nonexecution registrations in both directions`, async () => {
    const raw = registrationFixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const entries = await parity(h, api, { op: 'entrypoints' }), effects = await parity(h, api, { op: 'effects' });
    const script = entries.entries.items.find(e => e.path === 'builder::main' && e.kind === 'build-script');
    const app = entries.entries.items.find(e => e.path === 'app::main' && e.kind === 'binary');
    const unknown = entries.entries.items.find(e => e.path === 'builder::nested::main');
    const read = effects.effects.items.find(e => e.operation === 'read'); assert(read);
    assert.deepEqual(normalized(read.phases), ['application']);
    for (const includePossible of [false, true]) {
      const unfiltered = await parity(h, api, { op: 'effectPaths', entryId: script.id, includePossible });
      assert.equal(unfiltered.effects.items.some(e => e.id === read.id), includePossible);
      if (includePossible) assert(unfiltered.edges.items.some(e => e.kind === 'registration' && !e.execution));
      for (const phase of ['build', 'application', 'unknown']) {
        const root = phase === 'build' ? script : phase === 'application' ? app : unknown;
        const forward = await parity(h, api, { op: 'effectPaths', phase, entryId: root.id, includePossible });
        assert(!forward.error); assert(forward.effects.items.every(e => e.phases.includes(phase)));
        assert.equal(forward.effects.items.some(e => e.id === read.id), phase === 'application');
        const request = { op: 'effectPaths', phase, effectId: read.id, includePossible };
        if (phase !== 'application') await phaseRejection(h, api, request);
        else assert((await parity(h, api, request)).entries.items.every(e => e.phases.includes(phase)));
      }
    }
  });
  test(`${worker ? 'worker' : 'fallback'} callback bindings keep host/application units separate while shared invocation has both phases`, async () => {
    const raw = callbackFixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const build = await parity(h, api, { op: 'buildInventory' });
    for (const [unit, expected] of [['build-unit', ['build']], ['app-unit', ['application']], ['reused-unit', ['application', 'build']]])
      assert.deepEqual(normalized(build.units.items.find(u => u.buildUnitId === unit).phases), expected);
    for (const [name, expected] of [['builder::host_only', ['build']], ['app::target_only', ['application']],
      ['shared::forward', ['application', 'build']], ['shared::invoke', ['application', 'build']]]) {
      const selected = await parity(h, api, { op: 'entrypoints', function: name }); assert.deepEqual(normalized(selected.selection.phases), expected);
      for (const phase of ['build', 'application']) {
        const request = { op: 'effectPaths', function: name, phase, includePossible: false };
        if (expected.includes(phase)) await parity(h, api, request);
        else await phaseRejection(h, api, request);
      }
    }
    const entries = await parity(h, api, { op: 'entrypoints', phase: 'build' });
    const script = entries.entries.items.find(e => e.path === 'builder::main' && e.kind === 'build-script');
    const route = await parity(h, api, { op: 'effectPaths', entryId: script.id, phase: 'build', includePossible: false });
    for (const operation of ['write', 'spawn', 'environment-read']) assert(route.effects.items.some(e => e.operation === operation), operation);
    assert(!route.effects.items.some(e => e.operation === 'read'));
    const replay = await parity(h, api, { op: 'replay', replay: route.replay }); assert.deepEqual(normalized(replay.effects), normalized(route.effects));
    const unknown = callbackFixture(), flow = unknown.nodes.find(n => n.id === 'flow:app::main');
    const body = JSON.parse(flow.attributes.flow); body.blocks[0].callback_args = [{ index: 0, targets: [], unknown: true }];
    flow.attributes.flow = JSON.stringify(body);
    const partial = await harness(worker, unknown), partialApi = Analysis.create(unknown, { rawText: partial.raw });
    const target = await parity(partial, partialApi, { op: 'entrypoints', function: 'app::target_only' });
    assert.deepEqual(normalized(target.selection.phases), ['unknown']);
    const host = await parity(partial, partialApi, { op: 'entrypoints', function: 'builder::host_only' });
    assert.deepEqual(normalized(host.selection.phases), ['build']);
    const inventory = await parity(partial, partialApi, { op: 'buildInventory' });
    assert.equal(inventory.buildExecutionCoverage.phaseMembership.partial, true);
    assert(inventory.buildExecutionCoverage.phaseMembership.unresolvedCalls > 0);
  });
  test(`${worker ? 'worker' : 'fallback'} empty callback collections preserve known calls, phase coverage and replay`, async () => {
    for (const kind of ['ordinary', 'invocation']) {
      let baseline;
      for (const format of ['omitted', 'array', 'null']) {
        const raw = emptyCallbackFixture(kind, format), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw }), snapshot = {};
        for (const [op, field] of [['buildInventory', 'units'], ['entrypoints', 'entries'], ['effects', 'effects']]) {
          const result = await parity(h, api, { op });
          const coverage = op === 'buildInventory' ? result.buildExecutionCoverage.phaseMembership : result.entryEffectCoverage.phaseMembership;
          snapshot[field] = normalized(result[field]); snapshot.coverage = normalized(coverage);
          const replay = await parity(h, api, { op: 'replay', replay: result.replay });
          assert.deepEqual(normalized(replay[field]), normalized(result[field]), kind + ' ' + format + ' replay ' + field);
          assert.deepEqual(normalized(op === 'buildInventory' ? replay.buildExecutionCoverage.phaseMembership : replay.entryEffectCoverage.phaseMembership), normalized(coverage));
          for (const marker of kind === 'ordinary' ? ['application:app::main#bb0@call'] :
            ['application:shared::invoke#bb0@call', 'build:shared::invoke#bb0@call']) assert(!coverage.items.includes(marker), marker);
          assert(coverage.items.includes('application:' + (kind === 'ordinary' ? 'shared::target_probe' : 'app::target_only') + '#bb0@call'),
            'genuine missing std body remains unresolved');
          assert.equal(coverage.partial, true); assert.equal(coverage.truncated, false);
        }
        if (baseline) assert.deepEqual(snapshot, baseline, kind + ' ' + format);
        else baseline = snapshot;
      }
    }
  });
  test(`${worker ? 'worker' : 'fallback'} malformed callback facts disclose call-specific uncertainty without phase bleed`, async () => {
    for (const spec of bindingCases) {
      const raw = bindingFixture(spec), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
      const build = await parity(h, api, { op: 'buildInventory' }), coverage = build.buildExecutionCoverage.phaseMembership;
      assert.equal(coverage.items.includes('application:app::main#bb0@call'), !!spec.invalid, spec.name);
      assert.equal(coverage.items.includes('application:shared::invoke#bb0@call'), !!spec.usedUnknown, spec.name);
      const target = await parity(h, api, { op: 'entrypoints', function: 'app::target_only' });
      assert.deepEqual(normalized(target.selection.phases), spec.precise ? ['application'] : ['unknown'], spec.name);
      const host = await parity(h, api, { op: 'entrypoints', function: 'builder::host_only' });
      assert.deepEqual(normalized(host.selection.phases), Object.hasOwn(spec, 'invocationParameter') ? ['unknown'] : ['build'], spec.name);
      await phaseRejection(h, api, { op: 'effectPaths', function: 'app::target_only', phase: 'build' });
      await phaseRejection(h, api, { op: 'effectPaths', function: 'builder::host_only', phase: 'application' });
      const replay = await parity(h, api, { op: 'replay', replay: build.replay });
      assert.deepEqual(normalized(replay.buildExecutionCoverage), normalized(build.buildExecutionCoverage), spec.name);
      for (const op of ['entrypoints', 'effects']) assert.deepEqual(normalized((await parity(h, api, { op })).entryEffectCoverage.phaseMembership), normalized(coverage));
      if (spec.objectTargets || Object.hasOwn(spec, 'references')) {
        assert.equal(coverage.partial, true);
        assert.deepEqual(normalized(replay), { ...normalized(build), replayed: true }, spec.name + ' full inventory replay');
        const route = await parity(h, api, { op: 'effectPaths', function: 'app::main', includePossible: true });
        assert.equal(route.finding.absenceProven, false);
        const references = route.edges.items.filter(e => e.source === 'app::main' && e.kind === 'reference');
        assert.deepEqual(normalized(references.map(e => e.target)), spec.referenceTarget ? [spec.referenceTarget] : [], 'only valid arrays supply callback references');
        assert(references.every(e => e.execution === false), 'callback references remain nonexecuting');
        if (spec.objectTargets) assert(!route.nodes.items.some(n => n.id === 'app::target_only'), 'malformed targets invent no callback route');
        if (spec.callee) assert(route.nodes.items.some(n => n.path === spec.callee && n.bodyStatus === 'unavailable'), 'uncaptured helper remains a boundary');
        const routeReplay = await parity(h, api, { op: 'replay', replay: route.replay });
        assert.deepEqual(normalized(routeReplay), { ...normalized(route), replayed: true }, spec.name + ' full route replay');
      }
    }
  });
  test(`${worker ? 'worker' : 'fallback'} bounded context inference discloses incomplete replay and preserves known capabilities`, async () => {
    for (const [size, controls, truncated] of [[10, false, true], [2, true, false]]) {
      const raw = contextFixture(size, controls), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
      const inventory = await parity(h, api, { op: 'buildInventory' }), coverage = inventory.buildExecutionCoverage.phaseMembership;
      assert.equal(coverage.truncated, truncated);
      assert.equal(coverage.items.includes('application:phase-inference-budget-exhausted'), truncated);
      const selected = await parity(h, api, { op: 'entrypoints', function: 'budget::F0' });
      assert.deepEqual(normalized(selected.selection.phases), ['application']);
      const route = await parity(h, api, { op: 'effectPaths', function: 'budget::F0', phase: 'application', includePossible: false });
      assert.equal(route.completion.complete, !truncated);
      if (truncated) assert.equal(route.completion.evidenceComplete, false);
      const replay = await parity(h, api, { op: 'replay', replay: route.replay });
      assert.deepEqual(normalized(replay.coverage), normalized(route.coverage)); assert.deepEqual(normalized(replay.completion), normalized(route.completion));
      const host = await parity(h, api, { op: 'effectPaths', function: 'builder::main', phase: 'build', includePossible: false });
      for (const operation of ['write', 'spawn', 'environment-read']) assert(host.effects.items.some(e => e.operation === operation));
    }
  });
  test(`${worker ? 'worker' : 'fallback'} API capability mutations leave transport coverage and saved replay intact`, async () => {
    const raw = bindingFixture(bindingCases.find(c => c.name === 'empty targets'));
    const h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const inventory = await parity(h, api, { op: 'buildInventory' });
    const route = await parity(h, api, { op: 'effectPaths', function: 'app::main', phase: 'application' });
    for (const path of ['buildExecution', 'entryEffects', 'nestedBuildExecution']) {
      const caps = await api.query({ op: 'capabilities' });
      const exposed = path === 'buildExecution' ? caps.buildExecution.coverage.phaseMembership :
        path === 'entryEffects' ? caps.entryEffects.coverage.phaseMembership : caps.entryEffects.coverage.buildExecution.phaseMembership;
      exposed.partial = false; exposed.unresolvedCalls = 0; exposed.items.splice(0, exposed.items.length, 'caller mutation'); exposed.truncated = !exposed.truncated;
      assert.deepEqual(normalized((await parity(h, api, { op: 'buildInventory' })).buildExecutionCoverage), normalized(inventory.buildExecutionCoverage));
      for (const op of ['entrypoints', 'effects']) assert.deepEqual(normalized((await parity(h, api, { op })).entryEffectCoverage.phaseMembership), normalized(inventory.buildExecutionCoverage.phaseMembership));
      assert.deepEqual(normalized((await parity(h, api, { op: 'replay', replay: route.replay })).coverage), normalized(route.coverage));
    }
  });
}
if (process.env.BUILD_SUPPLY_CAPTURE) test('actual emitted compiler capture build inventory replays in worker and fallback with current module bytes', async () => {
  let bytes = fs.readFileSync(process.env.BUILD_SUPPLY_CAPTURE);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const raw = JSON.parse(bytes), html = fs.readFileSync(process.env.BUILD_SUPPLY_HTML || path.join(path.dirname(process.env.BUILD_SUPPLY_CAPTURE), 'graph.html'), 'utf8');
  const model = Model.build(raw), byProcedure = new Map(model.procedures.map(p => [p.id, p])), nullCalls = new Set();
  for (const procedure of model.procedures) {
    const node = raw.nodes.find(n => n.id === procedure.rawFlowNodeId), body = JSON.parse(node.attributes.flow);
    for (const block of body.blocks) if (block.callback_args === null) nullCalls.add(procedure.id + '#' + block.id + '@call');
  }
  const knownNullCalls = model.calls.filter(c => nullCalls.has(c.id) && c.callbackParameter == null && !c.unknown &&
    (byProcedure.get(c.procedure).display_path || c.procedure).endsWith('::main') &&
    !(c.dispatchTargets || []).length && c.targets.length && c.targets.every(t => byProcedure.has(t)));
  assert(knownNullCalls.length, 'emitted imported known ordinary calls retain null callback_args');
  const callbackCalls = model.calls.filter(c => c.callbackParameter === 0 &&
    (byProcedure.get(c.procedure).display_path || c.procedure).endsWith('::invoke'));
  assert(callbackCalls.length, 'emitted compiler zero-argument callback invocation');
  for (const worker of [false, true]) {
    const h = await harness(worker, raw, { html }), api = Analysis.create(raw, { rawText: h.raw });
    phase(h, 'build'); await until(() => evidence(h) && evidence(h).request.phase === 'build');
    const request = { op: 'buildInventory', page: { limit: 100 } };
    const browser = await parity(h, api, request), phaseCoverage = browser.buildExecutionCoverage.phaseMembership;
    assert.equal(phaseCoverage.truncated, false, 'call-specific coverage assertions require an untruncated list');
    for (const call of knownNullCalls.concat(callbackCalls)) {
      assert(nullCalls.has(call.id), 'emitted imported zero-argument call retains null callback_args: ' + call.id);
      const selected = await parity(h, api, { op: 'entrypoints', function: call.procedure });
      assert(selected.selection.phases.some(p => p !== 'unknown'), 'known fixture call has a rooted phase: ' + call.id);
      for (const phase of selected.selection.phases.filter(p => p !== 'unknown'))
        assert(!phaseCoverage.items.includes(phase + ':' + call.id), 'valid null callback_args creates no unresolved marker: ' + phase + ':' + call.id);
    }
    const inventoryReplay = await parity(h, api, { op: 'replay', replay: browser.replay });
    assert.deepEqual(normalized(inventoryReplay.buildExecutionCoverage), normalized(browser.buildExecutionCoverage));
    assert(browser.inventory.items.some(e => e.kind === 'proc-macro'));
    assert(browser.relationships.items.some(e => e.kind === 'native-link' && e.producerStatus === 'unknown'));
    const entries = await h.ui.queryEntryEffects({ op: 'entrypoints', phase: 'build', page: { limit: 100 } });
    const root = entries.entries.items.find(e => e.kind === 'build-script' && e.discoveryMechanism === 'compiler-entry-identity');
    assert(root);
    const rootBodies = raw.nodes.filter(n => n.attributes.flow && n.attributes.package_id === root.packageId &&
      n.attributes.unit_key === root.buildUnitId && n.attributes.compiler_entry === 'compiler-main' &&
      [n.id, n.attributes.symbol_id].includes(root.nodeId));
    assert.equal(rootBodies.length, 1, 'emitted compiler entry owns one exact captured build body');
    for (const callee of ['std::fs::write', 'std::process::Command::status', 'std::env::var_os']) {
      const calls = JSON.parse(rootBodies[0].attributes.flow).blocks.filter(b => b.callee === callee);
      assert(calls.length, 'emitted real build body calls ' + callee);
      for (const call of calls) {
        assert.equal(call.callee_crate, 'std');
        assert.equal(typeof call.callee_id, 'string'); assert(call.callee_id.length > 0);
        assert.match(call.callee_artifact || '', /\/lib\/rustlib\/[^/]+\/lib\/libstd-[a-f0-9]+\.(?:rlib|rmeta|so|dylib|dll)$/,
          'emitted compiler-loaded std artifact for ' + callee + ' at ' + call.id);
      }
    }
    const route = await parity(h, api, { op: 'effectPaths', phase: 'build', entryId: root.id, includePossible: false });
    assert(route.effects.items.some(e => e.category === 'process'));
    for (const [category, operation] of [['filesystem', 'write'], ['process', 'spawn'], ['sensitive-data', 'environment-read']])
      assert(route.effects.items.some(e => e.category === category && e.operation === operation && e.certainty === 'modeled' &&
        e.evidenceKind === 'modeled-capability' && e.executionObserved === false && e.provenance.adapter === 'rust-standard-effects-v1'),
      'emitted compiler std modeled capability: ' + operation);
    const replay = await parity(h, api, { op: 'replay', replay: route.replay });
    assert.deepEqual(normalized(replay.effects), normalized(route.effects));
    assert.equal(replay.request.phase, 'build');
    for (const [name, expected] of [['host_only', ['build']], ['target_only', ['application']]]) {
      const callbacks = model.procedures.filter(p => (p.display_path || p.id).endsWith('::' + name));
      assert(callbacks.length, 'emitted compiler callback body: ' + name);
      for (const callback of callbacks) {
        assert(model.calls.some(c => c.callbackArgs.some(a => (a.targets || []).includes(callback.id))), 'emitted exact compiler binding: ' + name);
        const selected = await parity(h, api, { op: 'entrypoints', function: callback.id });
        assert.deepEqual(normalized(selected.selection.phases), expected);
        await phaseRejection(h, api, { op: 'effectPaths', function: callback.id,
          phase: name === 'host_only' ? 'application' : 'build', includePossible: false });
      }
    }
    const invocations = model.procedures.filter(p => (p.display_path || p.id).endsWith('::invoke'));
    assert(invocations.length); const invokePhases = new Set();
    for (const invocation of invocations) {
      assert(model.calls.some(c => c.procedure === invocation.id && c.callbackParameter === 0), 'emitted compiler callback invocation');
      const selected = await parity(h, api, { op: 'entrypoints', function: invocation.id });
      selected.selection.phases.forEach(p => invokePhases.add(p));
    }
    assert.deepEqual(Array.from(invokePhases).sort(), ['application', 'build']);
  }
});
