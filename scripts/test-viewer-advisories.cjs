'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Analysis = require('../src/analysis-api.js');
const { fixture, snapshot } = require('../tests/fixtures/advisory-exposure/graphs.cjs');
const { harness, descendants, until, normalized, panel, find, click, evidence } = require('./test-viewer-call-paths.cjs');
const id = 'advisory-content';
const request = (extra = {}) => ({ op: 'advisoryExposure', snapshot: snapshot(), page: { limit: 100 }, ...extra });
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} local advisory snapshot shares exact API/source/freshness/replay evidence`, async () => {
    const raw = fixture(), h = await harness(worker, raw), api = Analysis.create(raw, { rawText: h.raw });
    const q = request(), browser = await h.ui.queryConnections(q), agent = await api.query(q);
    assert.deepEqual(normalized(browser), agent); assert.equal(browser.snapshot.freshness, 'within-30-days');
    const replay = await h.ui.queryConnections({ op: 'replay', replay: browser.replay }); assert.equal(replay.replayed, true); assert.deepEqual(normalized(replay.findings), agent.findings);
    const pending = h.ui.queryConnections(request()); h.ui.cancelConnections(); await assert.rejects(pending, /cancelled/);
  });
  test(`${worker ? 'worker' : 'fallback'} import controls expose linked package findings, phase and connecting-call replay`, async () => {
    const h = await harness(worker, fixture()), s = snapshot();
    s.functionMappings.push({ schemaVersion: 1, advisoryId: 'x_TEST-001', packageId: 'parser@1.2.3', functionId: 'compiler:parser::affected', provenance: 'local review' });
    const input = find(h, 'Import local advisory snapshot', id); input.files = [{ size: JSON.stringify(s).length, text: async () => JSON.stringify(s) }]; input.listeners.change();
    await until(() => find(h, 'Local advisory snapshot JSON', id).value.length > 0);
    click(h, 'Check advisories', id); await until(() => evidence(h, id));
    assert(descendants(panel(h, id)).some(e => /x_TEST-001/.test(e.textContent)));
    assert(descendants(panel(h, id)).some(e => e.tagName === 'a' && /vscode:\/\/file/.test(e.href)));
    assert.equal(evidence(h, id).snapshot.export.advisories.length, 2);
    const exports = []; h.context.Blob = class { constructor(parts) { this.source = parts.join(''); } };
    h.context.URL = { createObjectURL(blob) { exports.push(JSON.parse(blob.source)); return 'blob:local-export'; }, revokeObjectURL() {} };
    click(h, 'Export local snapshot', id); assert.deepEqual(exports[0], normalized(evidence(h, id).snapshot.export));
    assert(descendants(panel(h, id)).some(e => e.download === 'advisory-snapshot.json'));
    click(h, 'Replay advisory exposure', id); await until(() => evidence(h, id) && evidence(h, id).replayed);
    click(h, 'Show connecting calls', id); await until(() => evidence(h)); assert.equal(evidence(h).operation, 'callPaths'); assert.equal(evidence(h).completion.graphComplete, true);
    const phase = find(h, 'Advisory entry phase', id); phase.value = 'build'; phase.listeners.change(); assert.equal(evidence(h, id), null);
    click(h, 'Check advisories', id); await until(() => evidence(h, id)); assert.equal(evidence(h, id).request.phase, 'build');
    assert(evidence(h, id).findings.items.every(f => f.routes.every(r => r.entry.phases.includes('build'))));
  });
  test(`${worker ? 'worker' : 'fallback'} unsupported/malformed inputs, pinned freshness, stale import/reset and cancellation remain visible`, async () => {
    const h = await harness(worker, fixture());
    find(h, 'Local advisory snapshot JSON', id).value = '{'; click(h, 'Check advisories', id);
    assert(descendants(panel(h, id)).some(e => /Advisory error/.test(e.textContent)));
    await assert.rejects(h.ui.queryConnections(request({ snapshot: { ...snapshot(), asOf: null } })), /pinned asOf/);
    const stale = snapshot(); stale.asOf = '2027-01-01T00:00:00Z';
    const value = await h.ui.runAdvisories(request({ snapshot: stale })); assert.equal(value.snapshot.freshness, 'stale');
    let release; const file = find(h, 'Import local advisory snapshot', id); file.files = [{ size: 1, text: () => new Promise(resolve => { release = resolve; }) }]; file.listeners.change();
    h.ui.cancelConnections(); release(JSON.stringify(snapshot())); await new Promise(resolve => setImmediate(resolve));
    assert.equal(evidence(h, id), null);
    const active = h.ui.runAdvisories(request()); const cancelled = assert.rejects(active, /cancelled/); h.ui.refresh(JSON.stringify(fixture())); await cancelled;
    assert.equal(evidence(h, id), null); assert.equal(find(h, 'Local advisory snapshot JSON', id).value, '');
  });
}
if (process.env.ADVISORY_CAPTURE || process.env.ADVISORY_HTML) test('actual CURRENT emitted HTML imports a source-bound advisory and exact function mapping', async () => {
  assert(process.env.ADVISORY_CAPTURE && process.env.ADVISORY_HTML, 'both capture and current emitted HTML required');
  const raw = JSON.parse(fs.readFileSync(process.env.ADVISORY_CAPTURE, 'utf8')), html = fs.readFileSync(process.env.ADVISORY_HTML, 'utf8'), api = Analysis.create(raw);
  const packages = (await api.query({ op: 'packages', page: { limit: 100 } })).packages.items;
  const functions = (await api.query({ op: 'functions', page: { limit: 100 } })).functions.items;
  const target = functions.find(f => f.body.status === 'captured' && f.identity.functionId && packages.some(p => p.id === f.packageId && p.version)); assert(target, 'actual exact package-bound compiler symbol');
  const pkg = packages.find(p => p.id === target.packageId), s = snapshot();
  s.advisories = [{ id: 'x_CAPTURE-001', schema_version: '1.9.2', modified: s.retrievedAt, affected: [{ package: { ecosystem: 'crates.io', name: pkg.name }, versions: [pkg.version] }] }];
  s.coordinateMappings = [{ schemaVersion: 1, packageId: pkg.id, source: pkg.source, version: pkg.version, ecosystem: 'crates.io', name: pkg.name, provenance: 'synthetic controlled-capture regression mapping; no real vulnerability assertion' }];
  s.functionMappings = [{ schemaVersion: 1, advisoryId: 'x_CAPTURE-001', packageId: pkg.id, functionId: target.identity.functionId, nodeId: target.id, provenance: 'synthetic exact compiler symbol regression' }];
  for (const worker of [false, true]) {
    const h = await harness(worker, raw, { html }), q = request({ snapshot: s, packageId: pkg.id });
    const browser = await h.ui.runAdvisories(q), agent = await Analysis.create(raw, { rawText: h.raw }).query(q);
    assert.deepEqual(normalized(browser), agent); assert.equal(browser.completion.complete, true);
    assert.equal(browser.findings.items[0].functionEvidence.status, 'identified-by-structured-evidence');
    assert.equal((await h.ui.queryConnections({ op: 'replay', replay: browser.replay })).replayed, true);
    assert.equal(evidence(h, id).snapshot.contentSha256, browser.snapshot.contentSha256);
  }
});

const controls = require('../tests/fixtures/advisory-exposure/graphs.cjs');
for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'fallback'} CP1 forms clear/reset via the actual shared highlight helper`, async () => {
    const h = await harness(worker, fixture());
    await h.ui.runCallPaths({ op: 'callPaths', from: 'application::main', to: 'parser::affected' }); assert(h.context.ENTRY_EFFECT_ACTIVE);
    click(h, 'Cancel / clear call paths'); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    await h.ui.runAdvisories(request()); assert(evidence(h, id));
    click(h, 'Cancel / clear advisory exposure', id); assert.equal(evidence(h, id), null);
    h.ui.refresh(JSON.stringify(fixture())); assert.equal(h.context.ENTRY_EFFECT_ACTIVE, null);
    assert.equal(find(h, 'Local advisory snapshot JSON', id).value, '');
  });
  test(`${worker ? 'worker' : 'fallback'} CP3 browser package rejection remains distinct from API JSON errors`, async () => {
    const h = await harness(worker, fixture());
    await assert.rejects(h.ui.queryConnections(request({ packageId: 'absent' })), /Unknown exact package ID/);
    assert.equal((await Analysis.create(fixture()).query(request({ packageId: 'absent' }))).error.code, 'UNKNOWN_PACKAGE');
  });
  for (const rootless of [false, true]) test(`${worker ? 'worker' : 'fallback'} CP6 root-connected inclusion/replay, absent roots=${rootless}`, async () => {
    const raw = controls.inclusionGraph(rootless), h = await harness(worker, raw), q = request({ packageId: 'parser@1.2.3' });
    const r = await h.ui.queryConnections(q), f = r.findings.items[0];
    assert.deepEqual(normalized(r), await Analysis.create(raw, { rawText: h.raw }).query(q));
    assert(!f.inclusion.dependencies.some(d => d.source === 'orphan@1'));
    assert.equal(f.inclusion.roots.length, rootless ? 0 : 2);
    if (!rootless) assert(f.inclusion.dependencies.some(d => d.source === 'parser@1.2.3' && d.target === 'bridge@1.0.0'));
    else assert.equal(f.inclusion.dependencies.length, 0);
    assert.deepEqual(normalized((await h.ui.queryConnections({ op: 'replay', replay: r.replay })).findings), normalized(r.findings));
  });
  test(`${worker ? 'worker' : 'fallback'} CP7 tiny budgets truncate generated malformed/unsupported/unmatched/symbol evidence`, async () => {
    const raw = fixture(), h = await harness(worker, raw);
    for (const item of controls.byteCases()) {
      let budget = item.budget;
      if (budget == null) {
        const baseline = structuredClone(item.snapshot); baseline.functionMappings = [];
        budget = (await h.ui.queryConnections(request({ snapshot: baseline, packageId: 'parser@1.2.3' }))).completion.evidenceBytes + 1000;
      }
      const q = request({ snapshot: item.snapshot, packageId: 'parser@1.2.3', budgets: { maxEvidenceBytes: budget } });
      const r = await h.ui.runAdvisories(q);
      assert.deepEqual(normalized(r), await Analysis.create(raw, { rawText: h.raw }).query(q));
      assert.equal(r.completion.reason, 'evidence-byte-budget'); assert.equal(r.completion.complete, false); assert(r.completion.evidenceBytes <= budget);
      assert.deepEqual(normalized(r.snapshot.export), item.snapshot); assert.equal(r.semantics.vulnerabilityAbsenceProven, false);
      assert.equal(evidence(h, id).completion.evidenceComplete, false);
    }
  });
  test(`${worker ? 'worker' : 'fallback'} CP8 inner work is bounded and a genuinely running query cooperatively cancels`, async () => {
    const raw = fixture(), h = await harness(worker, raw), s = controls.highCardinalitySnapshot(); assert(JSON.stringify(s).length < 1048576);
    const tiny = await h.ui.runAdvisories(request({ snapshot: s, packageId: 'parser@1.2.3', budgets: { maxWork: 80 } }));
    assert.equal(tiny.completion.reason, 'work-budget'); assert.equal(tiny.completion.complete, false); assert(tiny.completion.work <= 81);
    const completed = []; let active = false, inFlight = false, catalogReady = false;
    // Observe the actual engine, preserving its implementation and both transports.
    // Cancellation is triggered only at its first cooperative timer, after it runs.
    function observe(target) {
      const create = target.AdvisoryExposure.create, schedule = target.setTimeout;
      target.AdvisoryExposure.create = (...args) => {
        const engine = create(...args), query = engine.query;
        engine.query = (...args) => { active = true; return query(...args).then(result => { active = false; completed.push(result); return result; }); };
        return engine;
      };
      target.setTimeout = (callback, delay, ...args) => schedule(() => {
        if (active && !inFlight && delay === 0) { inFlight = true; h.ui.cancelConnections(); }
        callback(...args);
      }, delay);
    }
    if (worker) {
      const post = h.context.Worker.prototype.postMessage;
      h.context.Worker.prototype.postMessage = function (message) { if (message.type === 'init') observe(this.context); return post.call(this, message); };
    } else observe(h.context);
    h.context.STATE_UI.setData = () => { catalogReady = true; };
    h.ui.refresh(JSON.stringify(raw)); await until(() => catalogReady);
    const pending = h.ui.runAdvisories(request({ snapshot: s, packageId: 'parser@1.2.3' }));
    await assert.rejects(pending, /cancelled/); assert(inFlight, 'cancel happened only after engine yielded');
    await until(() => completed.length > 0);
    assert.equal(completed[0].completion.reason, 'cancelled'); assert.equal(completed[0].completion.complete, false);
    assert(completed[0].completion.work < 2400, 'inner pass was interrupted before all ranges'); assert.equal(evidence(h, id), null);
  });
}

for (const worker of [false, true]) test(`${worker ? 'worker' : 'fallback'} CP5 missing-MIR advisory body/function eligibility is conservative in API/replay`, async () => {
  const raw = controls.replaceBody(fixture(), 'parser::affected', 'missing-mir'), h = await harness(worker, raw), s = snapshot();
  s.functionMappings.push({ schemaVersion: 1, advisoryId: 'x_TEST-001', packageId: 'parser@1.2.3',
    functionId: 'compiler:parser::affected', nodeId: 'parser::affected', provenance: 'exact local compiler identity' });
  // Keep the negative and known-return positive under the same controlled application selection.
  const q = request({ snapshot: s, packageId: 'parser@1.2.3', phase: 'application' }), r = await h.ui.runAdvisories(q), f = r.findings.items[0];
  assert.deepEqual(normalized(r), await Analysis.create(raw, { rawText: h.raw }).query(q));
  assert.equal(r.completion.complete, true); assert.equal(r.request.phase, 'application'); assert.equal(f.versionMatch.status, 'affected');
  assert.equal(f.exposure, 'indeterminate'); assert.equal(f.capturedReachability, 'indeterminate');
  assert.equal(f.functionEvidence.status, 'unidentified'); assert.equal(f.reachableIdentifiedFunction, false);
  assert.equal(f.functionEvidence.items.length, 0); assert.equal(f.functionEvidence.diagnostics[0].status, 'unknown');
  assert.deepEqual(normalized(f.functionEvidence.diagnostics[0].mapping), s.functionMappings[0]);
  assert.equal(f.queryCoverage.missingBodies, 1); assert.equal(f.queryCoverage.capturedBodies, 2); assert(f.queryCoverage.entries > 0);
  assert.equal(f.queryCoverage.partial, true); assert.equal(f.queryCoverage.noExposureProven, false);
  assert(!f.routes.some(route => route.target.id === 'parser::affected')); assert.equal(f.routes.length, 0);
  assert.equal(r.semantics.vulnerabilityAbsenceProven, false);
  assert.deepEqual(normalized((await h.ui.queryConnections({ op: 'replay', replay: r.replay })).findings), normalized(r.findings));
  const knownRaw = controls.replaceBody(fixture(), 'parser::affected', 'return'), knownHarness = await harness(worker, knownRaw);
  const knownResult = await knownHarness.ui.runAdvisories(q), known = knownResult.findings.items[0];
  assert.deepEqual(normalized(knownResult), await Analysis.create(knownRaw, { rawText: knownHarness.raw }).query(q));
  assert.equal(knownResult.completion.complete, true); assert.equal(knownResult.request.phase, 'application');
  assert.equal(known.functionEvidence.status, 'identified-by-structured-evidence'); assert.equal(known.reachableIdentifiedFunction, true);
  assert.equal(known.functionEvidence.items[0].function.functionId, 'compiler:parser::affected');
  assert.equal(known.exposure, 'reachable-affected-package-code'); assert.equal(known.capturedReachability, 'reachable');
  assert(known.routes.some(route => route.entry.nodeId === 'application::main' && route.target.id === 'parser::affected'));
  assert(known.routes.every(route => route.entry.phases.includes('application')));
  assert.equal(known.queryCoverage.missingBodies, 0); assert.equal(known.queryCoverage.capturedBodies, 3);
  assert.equal(f.queryCoverage.missingBodies, known.queryCoverage.missingBodies + 1);
  assert.equal(f.queryCoverage.capturedBodies, known.queryCoverage.capturedBodies - 1);
  assert.deepEqual(normalized((await knownHarness.ui.queryConnections({ op: 'replay', replay: knownResult.replay })).findings), normalized(knownResult.findings));

  // Available disconnected candidates still establish captured topology in the all-phase query.
  const allQuery = request({ snapshot: s, packageId: 'parser@1.2.3' }), all = await h.ui.runAdvisories(allQuery), positive = all.findings.items[0];
  assert.deepEqual(normalized(all), await Analysis.create(raw, { rawText: h.raw }).query(allQuery));
  assert.equal(all.completion.complete, true); assert.equal(positive.exposure, 'reachable-affected-package-code');
  assert.equal(positive.capturedReachability, 'reachable');
  for (const [entry, target] of [['parser::cycle', 'parser::cycle'], ['application::invoke', 'parser::unused']]) assert(positive.routes.some(route =>
    route.entry.nodeId === entry && route.target.id === target && route.entry.kind === 'disconnected-root' &&
    route.entry.certainty === 'possible' && route.entry.executionObserved === false && route.entry.externalEntry === false));
  assert.equal(positive.functionEvidence.status, 'unidentified'); assert.equal(positive.reachableIdentifiedFunction, false);
  assert.equal(positive.functionEvidence.items.length, 0); assert.equal(positive.functionEvidence.diagnostics[0].status, 'unknown');
  assert.deepEqual(normalized(positive.functionEvidence.diagnostics[0].mapping), s.functionMappings[0]);
  assert(!positive.routes.some(route => route.target.id === 'parser::affected'));
  assert.equal(positive.queryCoverage.missingBodies, 1); assert.equal(positive.queryCoverage.capturedBodies, 2);
  assert.equal(positive.queryCoverage.partial, true); assert.equal(positive.queryCoverage.noExposureProven, false);
  assert.equal(all.semantics.vulnerabilityAbsenceProven, false); assert.equal(all.semantics.executionObserved, false); assert.equal(all.semantics.invocationExact, false);
  assert.deepEqual(normalized((await h.ui.queryConnections({ op: 'replay', replay: all.replay })).findings), normalized(all.findings));
});
