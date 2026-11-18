'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Analysis = require('../src/analysis-api.js');
const { affectedVersion } = require('../src/advisory-exposure.js');
const { fixture, engines, snapshot, fn } = require('../tests/fixtures/advisory-exposure/graphs.cjs');
const q = (extra = {}) => ({ op: 'advisoryExposure', snapshot: snapshot(), page: { limit: 100 }, ...extra });
const finding = (r, id = 'parser@1.2.3') => r.findings.items.find(f => f.package.id === id);
for (const [events, version, expected] of [
  [[{ introduced: '0' }, { fixed: '2.0.0' }], '1.2.3', 'affected'],
  [[{ introduced: '1.0.0' }, { fixed: '2.0.0' }], '2.0.0', 'not-affected'],
  [[{ introduced: '1.0.0' }, { last_affected: '2.0.0' }], '2.0.0', 'affected'],
  [[{ introduced: '0' }, { limit: '1.2.3' }], '1.2.3', 'not-affected'],
  [[{ introduced: '1.0.0-alpha.1' }, { fixed: '1.0.0' }], '1.0.0-beta.1', 'affected'],
  [[{ introduced: '0' }, { fixed: '2.0.0' }, { last_affected: '3.0.0' }], '1.2.3', 'unknown'],
  [[{ fixed: '2.0.0' }, { introduced: '1.0.0' }], '1.2.3', 'affected'],
  [[{ introduced: '0' }, { limit: '*' }], '9.0.0', 'affected'],
  [[{ fixed: '2.0.0' }], '1.2.3', 'unknown']
]) test(`OSV SEMVER ${JSON.stringify(events)} ${version}: ${expected}`, () => {
  assert.equal(affectedVersion({ ranges: [{ type: 'SEMVER', events }] }, version).status, expected);
});
test('exact versions and unsupported ranges/conditions never become false unaffected facts', () => {
  assert.equal(affectedVersion({ versions: ['1.2.3'] }, '1.2.3').status, 'affected');
  assert.equal(affectedVersion({ versions: ['1.2.3'] }, '1.2.4').status, 'not-affected');
  for (const affected of [{ ranges: [{ type: 'GIT', events: [{ introduced: '0' }] }] }, { ranges: [{ type: 'ECOSYSTEM', events: [] }] }, { versions: ['1.2.3'], ecosystem_specific: { target: 'cfg(unix)' } }, { versions: ['not semver'] }])
    assert.equal(affectedVersion(affected, '1.2.3').status, 'unknown');
  assert.equal(affectedVersion({ versions: ['1.2.3'] }, '1.2.3-01').status, 'unknown');
});
test('presence, exact versions/source, cross-dependency app/build reachability and inclusion are distinct', async () => {
  const r = await Analysis.create(fixture()).query(q()); assert.equal(r.completion.complete, true);
  const f = finding(r); assert.equal(f.versionMatch.status, 'affected'); assert.equal(f.presence, 'present'); assert.equal(f.exposure, 'reachable-affected-package-code');
  assert.equal(f.functionEvidence.status, 'unidentified'); assert.equal(f.reachableIdentifiedFunction, false);
  assert(f.routes.some(r => r.entry.phases.includes('application'))); assert(f.routes.some(r => r.entry.phases.includes('build')));
  const build = f.routes.find(route => route.entry.nodeId === 'builder::main' && route.entry.discoveryMechanism === 'compiler-entry-identity');
  assert(build); assert.equal(build.entry.kind, 'build-script'); assert.equal(build.entry.certainty, 'observed');
  assert.equal(build.entry.buildUnitId, 'unit:application@1.0.0:build'); assert.equal(build.entry.source.absolute_file, '/fixtures/build.rs');
  assert.equal(build.entry.executionObserved, false);
  assert(f.inclusion.dependencies.some(d => d.source === 'bridge@1.0.0')); assert(f.inclusion.dependencies.some(d => d.targetCondition === 'cfg(unix)'));
  assert.equal(finding(r, 'parser@2.0.0').versionMatch.status, 'not-affected');
  assert.equal(finding(r, 'fork@1.2.3').versionMatch.status, 'unknown'); assert.equal(r.nativeCoverage.status, 'unknown'); assert.equal(r.unmatched.items[0].advisoryId, 'x_TEST-NATIVE');
  const unqualified = fixture(); delete unqualified.nodes.find(n => n.id === 'package:application@1.0.0').attributes.build_units;
  const missingUnit = engines(unqualified).entries.entries.filter(entry => entry.nodeId === 'builder::main');
  assert(missingUnit.length > 0);
  assert(missingUnit.every(entry => entry.discoveryMechanism !== 'compiler-entry-identity' && !entry.phases.includes('build')));
});
test('explicit declared mappings bind exact source/version with provenance; duplicates are unknown', async () => {
  const s = snapshot(), mapping = { schemaVersion: 1, packageId: 'fork@1.2.3', source: 'git+https://example.invalid/fork#123', version: '1.2.3', ecosystem: 'crates.io', name: 'parser', provenance: 'local audited fork/version mapping' };
  s.coordinateMappings = [mapping];
  const api = Analysis.create(fixture()); assert.equal(finding(await api.query(q({ snapshot: s })), 'fork@1.2.3').versionMatch.status, 'affected');
  s.coordinateMappings.push(mapping); assert.equal(finding(await api.query(q({ snapshot: s })), 'fork@1.2.3').coordinate.status, 'unknown');
  s.coordinateMappings = [{ ...mapping, source: 'different source' }]; assert.equal(finding(await api.query(q({ snapshot: s })), 'fork@1.2.3').versionMatch.status, 'unknown');
});
test('only conjunctive structured package-bound unique symbol evidence identifies a vulnerable function', async () => {
  const s = snapshot(); s.functionMappings = [{ schemaVersion: 1, advisoryId: 'x_TEST-001', packageId: 'parser@1.2.3', functionId: 'compiler:parser::affected', nodeId: 'parser::affected', provenance: 'reviewed local symbol mapping' }];
  const api = Analysis.create(fixture()), r = await api.query(q({ snapshot: s })), f = finding(r);
  assert.equal(f.functionEvidence.status, 'identified-by-structured-evidence'); assert.equal(f.reachableIdentifiedFunction, true); assert(f.functionEvidence.items[0].function.source.source_file);
  s.functionMappings[0].nodeId = 'parser::unused'; assert.equal(finding(await api.query(q({ snapshot: s }))).functionEvidence.status, 'unidentified');
  const raw = fixture(); raw.nodes.push(...fn('other::same_symbol', 'parser@1.2.3', [], { function_id: 'compiler:parser::affected' }));
  delete s.functionMappings[0].nodeId;
  const ambiguous = finding(await Analysis.create(raw).query(q({ snapshot: s })));
  assert.equal(ambiguous.functionEvidence.status, 'unidentified'); assert.equal(ambiguous.functionEvidence.diagnostics[0].status, 'ambiguous');
});
test('withdrawn, stale, malformed and unsupported records remain evidence; snapshot/replay immutable and pinned', async () => {
  const s = snapshot(); s.asOf = '2027-01-01T00:00:00Z'; s.advisories[0].withdrawn = '2026-11-02T00:00:00Z'; s.advisories.push({ id: 'bad' }, { ...s.advisories[0], id: 'x_FUTURE', schema_version: '2.0.0' });
  const api = Analysis.create(fixture()), request = q({ snapshot: s }), promise = api.query(request); s.advisories.length = 0;
  const r = await promise; assert.equal(r.snapshot.freshness, 'stale'); assert.equal(finding(r).withdrawn, true); assert.equal(finding(r).exposure, 'indeterminate'); assert.equal(r.diagnostics.total, 2);
  const replay = await api.query({ op: 'replay', replay: r.replay }); assert.deepEqual(replay.snapshot, r.snapshot); assert.deepEqual(replay.findings, r.findings);
  r.snapshot.export.advisories.length = 0; assert.equal(replay.snapshot.export.advisories.length, 4);
});
test('missing bodies, no entries, budgets and cancellation never establish safety', async () => {
  const raw = fixture(); raw.nodes = raw.nodes.filter(n => n.id !== 'flow:parser::affected' && n.id !== 'flow:parser::cycle');
  const api = Analysis.create(raw), r = await api.query(q({ phase: 'application' })), f = finding(r);
  assert.equal(r.completion.complete, true); assert.equal(f.exposure, 'indeterminate'); assert.equal(f.capturedReachability, 'indeterminate');
  assert(f.queryCoverage.entries > 0); assert.equal(f.routes.length, 0);
  assert.equal(f.queryCoverage.missingBodies, 2); assert.equal(f.queryCoverage.capturedBodies, 1);
  assert.equal(f.queryCoverage.partial, true); assert.equal(f.queryCoverage.noExposureProven, false);
  // All phases still include the possible callback route to the available body.
  const all = await api.query(q()), positive = finding(all);
  assert.equal(all.completion.complete, true);
  assert.equal(positive.exposure, 'reachable-affected-package-code'); assert.equal(positive.capturedReachability, 'reachable');
  assert(positive.routes.some(route => route.entry.nodeId === 'application::invoke' && route.target.id === 'parser::unused' &&
    route.entry.kind === 'disconnected-root' && route.entry.certainty === 'possible' && route.entry.executionObserved === false && route.entry.externalEntry === false));
  assert.equal(positive.queryCoverage.partial, true); assert.equal(positive.queryCoverage.noExposureProven, false);
  assert.equal(all.semantics.executionObserved, false); assert.equal(all.semantics.invocationExact, false);
  // This fixture has no test/bench/example seeds: no selected entries is distinct from unproven activation.
  const empty = await api.query(q({ phase: 'dev-test' })), noEntries = finding(empty);
  assert.equal(empty.completion.complete, true); assert.equal(noEntries.queryCoverage.entries, 0); assert.equal(noEntries.routes.length, 0);
  assert.equal(noEntries.exposure, 'indeterminate'); assert.equal(noEntries.capturedReachability, 'indeterminate');
  assert.equal(noEntries.queryCoverage.partial, true); assert.equal(noEntries.queryCoverage.noExposureProven, false);
  for (const result of [r, all, empty]) assert.equal(result.semantics.vulnerabilityAbsenceProven, false);
  const { advisories, evidence } = engines();
  for (const extra of [{ budgets: { maxWork: 1 } }, { budgets: { maxRoutes: 1 } }, { budgets: { maxFindings: 1 } }]) {
    const partial = await advisories.query(q(extra), evidence); assert.equal(partial.completion.complete, false); assert.equal(partial.semantics.vulnerabilityAbsenceProven, false);
  }
  const cancelled = await advisories.query(q(), evidence, { cancelled: () => true }); assert.equal(cancelled.completion.reason, 'cancelled');
});
test('phase and paged findings preserve exact packages and complete snapshot in replay', async () => {
  const api = Analysis.create(fixture()), r = await api.query(q({ phase: 'build', page: { findings: { limit: 1 } } }));
  assert.equal(r.findings.total, 3); assert.equal(r.findings.truncated, true); assert.equal(r.completion.complete, true); assert.equal(r.completion.evidenceComplete, false);
  assert(r.findings.items.every(f => f.routes.every(r => r.entry.phases.includes('build')))); assert.equal(r.replay.request.snapshot.asOf, snapshot().asOf);
  assert.equal((await api.query(q({ snapshot: { ...snapshot(), asOf: null } }))).error.code, 'INVALID_SNAPSHOT');
});
if (process.env.ADVISORY_CAPTURE) test('actual controlled capture retains source-unknown local packages and native unknowns', async () => {
  const api = Analysis.create(JSON.parse(fs.readFileSync(process.env.ADVISORY_CAPTURE, 'utf8')));
  const r = await api.query(q()); assert.equal(r.completion.complete, true); assert.equal(r.nativeCoverage.status, 'unknown'); assert(r.unmatched.total > 0);
});

const controls = require('../tests/fixtures/advisory-exposure/graphs.cjs');
test('CP3 unknown exact advisory package returns API JSON error while successful replay stays intact', async () => {
  assert.equal((await Analysis.create(fixture()).query(q({ packageId: 'absent' }))).error.code, 'UNKNOWN_PACKAGE');
});
for (const rootless of [false, true]) test(`CP6 inclusion intersects workspace reachability, roots absent=${rootless}`, async () => {
  const api = Analysis.create(controls.inclusionGraph(rootless)), r = await api.query(q({ packageId: 'parser@1.2.3' })), f = finding(r);
  assert.equal(r.completion.complete, true); assert(f);
  assert(!f.inclusion.dependencies.some(d => d.source === 'orphan@1'));
  if (rootless) { assert.equal(f.inclusion.roots.length, 0); assert.equal(f.inclusion.dependencies.length, 0); assert.match(f.inclusion.status, /unknown/); }
  else {
    assert.deepEqual(new Set(f.inclusion.roots), new Set(['application@1.0.0', 'second@1']));
    assert(f.inclusion.dependencies.some(d => d.source === 'parser@1.2.3' && d.target === 'bridge@1.0.0'));
    assert(f.inclusion.dependencies.some(d => d.targetCondition === 'cfg(windows)')); assert(f.inclusion.dependencies.some(d => d.targetCondition === 'cfg(unix)'));
  }
  assert.deepEqual((await api.query({ op: 'replay', replay: r.replay })).findings, r.findings);
});
test('CP7 every generated diagnostic/unmatched/mapping payload is byte charged before retention', async () => {
  const api = Analysis.create(fixture());
  for (const item of controls.byteCases()) {
    let budget = item.budget;
    if (budget == null) {
      const baseline = structuredClone(item.snapshot); baseline.functionMappings = [];
      budget = (await api.query(q({ snapshot: baseline, packageId: 'parser@1.2.3' }))).completion.evidenceBytes + 1000;
    }
    const r = await api.query(q({ snapshot: item.snapshot, packageId: 'parser@1.2.3', budgets: { maxEvidenceBytes: budget } }));
    assert.equal(r.completion.complete, false); assert.equal(r.completion.reason, 'evidence-byte-budget'); assert(r.completion.evidenceBytes <= budget);
    assert.equal(r.completion.evidenceComplete, false); assert.deepEqual(r.snapshot.export, item.snapshot);
    assert.match(r.completion.evidenceAccounting, /snapshot export.*excluded/); assert.equal(r.semantics.vulnerabilityAbsenceProven, false);
  }
});
test('CP8 high-cardinality inner ranges/versions/events/sorting and target filters obey tiny work budgets', async () => {
  const s = controls.highCardinalitySnapshot(); assert(JSON.stringify(s).length < 1048576);
  const api = Analysis.create(fixture());
  const manyEvents = snapshot(); manyEvents.advisories[0].affected[0].ranges = [{ type: 'SEMVER',
    events: Array.from({ length: 2400 }, (_, i) => ({ introduced: '1.' + (2400 - i) + '.0' })) }];
  const manyVersions = snapshot(); manyVersions.advisories[0].affected[0].versions = Array.from({ length: 2400 }, (_, i) => '1.' + i + '.0');
  for (const [changed, maxWork] of [[s, 80], [manyEvents, 10000], [manyVersions, 80]]) {
    const r = await api.query(q({ snapshot: changed, packageId: 'parser@1.2.3', budgets: { maxWork } }));
    assert.equal(r.completion.complete, false); assert.equal(r.completion.reason, 'work-budget'); assert(r.completion.work <= maxWork + 1); assert.equal(r.findings.total, 0);
  }
  const { advisories, evidence } = engines(); let cancelled = false, started = false;
  const pending = advisories.query(q({ snapshot: s, packageId: 'parser@1.2.3' }), evidence, { cancelled: () => { started = true; return cancelled; } });
  await new Promise(resolve => setTimeout(() => { assert(started); cancelled = true; resolve(); }, 0));
  const result = await pending; assert.equal(result.completion.reason, 'cancelled'); assert.equal(result.completion.complete, false);
});

test('CP8 structured mapping target scans share the work budget before route evaluation', async () => {
  const raw = fixture(); for (let i = 0; i < 300; i++) raw.nodes.push(...fn('many::' + i, 'parser@1.2.3'));
  const s = snapshot(); s.advisories = [s.advisories[0]]; s.advisories[0].withdrawn = s.retrievedAt;
  const api = Analysis.create(raw), base = await api.query(q({ snapshot: s, packageId: 'parser@1.2.3' }));
  assert.equal(base.completion.complete, true);
  const maxWork = base.completion.work - controls.engines(raw).paths.functions().length + 100;
  s.functionMappings.push({ schemaVersion: 1, advisoryId: s.advisories[0].id, packageId: 'parser@1.2.3', functionId: 'compiler:many::299', provenance: 'bounded target scan' });
  const r = await api.query(q({ snapshot: s, packageId: 'parser@1.2.3', budgets: { maxWork } }));
  assert.equal(r.completion.complete, false); assert.equal(r.completion.reason, 'work-budget'); assert.equal(r.completion.routes, 0);
});

test('CP5 producer missing-MIR stubs retain exact symbol identity but cannot qualify a captured advisory body/function', async () => {
  const s = snapshot(); s.functionMappings.push({ schemaVersion: 1, advisoryId: 'x_TEST-001', packageId: 'parser@1.2.3',
    functionId: 'compiler:parser::affected', nodeId: 'parser::affected', provenance: 'exact local compiler identity' });
  const raw = controls.replaceBody(fixture(), 'parser::affected', 'missing-mir'), api = Analysis.create(raw);
  // The application entry reaches only affected via bridge; the stub cannot reach cycle/unused.
  const selected = q({ snapshot: s, packageId: 'parser@1.2.3', phase: 'application' });
  const r = await api.query(selected), f = finding(r);
  assert.equal(r.completion.complete, true); assert.equal(r.request.phase, 'application'); assert.equal(f.versionMatch.status, 'affected');
  assert.equal(f.exposure, 'indeterminate'); assert.equal(f.capturedReachability, 'indeterminate');
  assert.equal(f.functionEvidence.status, 'unidentified'); assert.equal(f.reachableIdentifiedFunction, false);
  assert.equal(f.functionEvidence.items.length, 0); assert.equal(f.functionEvidence.diagnostics[0].status, 'unknown');
  assert.deepEqual(f.functionEvidence.diagnostics[0].mapping, s.functionMappings[0]);
  assert.equal(f.queryCoverage.missingBodies, 1); assert.equal(f.queryCoverage.capturedBodies, 2); assert(f.queryCoverage.entries > 0);
  assert.equal(f.queryCoverage.partial, true); assert.equal(f.queryCoverage.noExposureProven, false);
  assert(!f.routes.some(route => route.target.id === 'parser::affected')); assert.equal(f.routes.length, 0);
  assert.equal(r.semantics.vulnerabilityAbsenceProven, false);
  assert.deepEqual((await api.query({ op: 'replay', replay: r.replay })).findings, r.findings);
  const known = finding(await Analysis.create(controls.replaceBody(fixture(), 'parser::affected', 'return')).query(selected));
  assert.equal(known.functionEvidence.status, 'identified-by-structured-evidence'); assert.equal(known.reachableIdentifiedFunction, true);
  assert.equal(known.functionEvidence.items[0].function.functionId, 'compiler:parser::affected');
  assert.equal(known.exposure, 'reachable-affected-package-code'); assert.equal(known.capturedReachability, 'reachable');
  assert(known.routes.some(route => route.entry.nodeId === 'application::main' && route.target.id === 'parser::affected'));
  assert(known.routes.every(route => route.entry.phases.includes('application')));
  assert.equal(known.queryCoverage.missingBodies, 0); assert.equal(known.queryCoverage.capturedBodies, 3);
  assert.equal(f.queryCoverage.missingBodies, known.queryCoverage.missingBodies + 1);
  assert.equal(f.queryCoverage.capturedBodies, known.queryCoverage.capturedBodies - 1);

  // All phases retain available package-code candidates; activation/invocation is unproven.
  const all = await api.query(q({ snapshot: s, packageId: 'parser@1.2.3' })), positive = finding(all);
  assert.equal(all.completion.complete, true); assert.equal(positive.exposure, 'reachable-affected-package-code');
  assert.equal(positive.capturedReachability, 'reachable');
  for (const [entry, target] of [['parser::cycle', 'parser::cycle'], ['application::invoke', 'parser::unused']]) assert(positive.routes.some(route =>
    route.entry.nodeId === entry && route.target.id === target && route.entry.kind === 'disconnected-root' &&
    route.entry.certainty === 'possible' && route.entry.executionObserved === false && route.entry.externalEntry === false));
  assert.equal(positive.functionEvidence.status, 'unidentified'); assert.equal(positive.reachableIdentifiedFunction, false);
  assert.equal(positive.functionEvidence.items.length, 0); assert.equal(positive.functionEvidence.diagnostics[0].status, 'unknown');
  assert.deepEqual(positive.functionEvidence.diagnostics[0].mapping, s.functionMappings[0]);
  assert(!positive.routes.some(route => route.target.id === 'parser::affected'));
  assert.equal(positive.queryCoverage.missingBodies, 1); assert.equal(positive.queryCoverage.capturedBodies, 2);
  assert.equal(positive.queryCoverage.partial, true); assert.equal(positive.queryCoverage.noExposureProven, false);
  assert.equal(all.semantics.vulnerabilityAbsenceProven, false); assert.equal(all.semantics.executionObserved, false); assert.equal(all.semantics.invocationExact, false);
  assert.deepEqual((await api.query({ op: 'replay', replay: all.replay })).findings, all.findings);
});
