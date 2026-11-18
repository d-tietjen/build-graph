/* Behavior gates. Execute only after independent source review. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const Analysis = require('../src/analysis-api.js'), Evidence = require('../src/analysis-evidence.js');
const Model = require('../src/execution-model.js'), Values = require('../src/value-flow.js'), Guards = require('../src/guard-obligations.js');
const F = require('../tests/fixtures/guard-obligations/fixture-graphs.cjs');
const capture = require('../tests/fixtures/guard-obligations/capture-model.cjs');
const { place: p, op, constant: c, assign: a, use, edge, block: b, call, fn, captured, update } = F;
const run = ({ raw, request }) => Analysis.create(raw).query(request);

for (const kind of ['direct','copied','targets-direct','targets-copied']) test('capture mutation: current ' + kind + ' pointer origin and isolated wrong compiler ID', async () => {
  const item = F.capturePointer(kind), { raw } = item, request = capture.request(raw, 'direct_pointer');
  assert.deepEqual(request, item.request, 'same exact policy from either compiler target form');
  const original = structuredClone(raw), api = Analysis.create(raw);
  const positive = await api.query(request); assert.equal(positive.status, 'supported-compliant');
  assert(positive.witnesses.items.flatMap(w => w.steps).some(s => s.kind === 'procedure-entry' && s.callsiteId === 'root#bb0@call' && s.target === 'check'));
  const positiveReplay = await api.query({ op: 'replay', replay: positive.replay });
  assert.deepEqual(positiveReplay.witnesses, positive.witnesses); assert.deepEqual(positiveReplay.queryCoverage, positive.queryCoverage);
  const changed = capture.pointerContradiction(raw), expected = structuredClone(raw);
  const row = capture.rows(expected).find(r => r.f.function === request.function);
  row.f.guard_facts.function_values[0].function_id = capture.body(expected, capture.procedure(expected, 'guard_fixture::other_check')).function_id;
  row.n.attributes.flow = JSON.stringify(row.f);
  assert.deepEqual(changed, expected, 'only the certified compiler function ID changes'); assert.deepEqual(raw, original);
  const changedApi = Analysis.create(changed), negative = await changedApi.query(request);
  assert.equal(negative.status, 'indeterminate'); assert.equal(negative.finding.supportedCompliantPath, false);
  assert.equal(negative.witnesses.total, 0); assert(negative.queryCoverage.gaps.some(g => g.kind === 'contradictory-or-unproven-function-pointer'));
  const negativeReplay = await changedApi.query({ op: 'replay', replay: negative.replay });
  assert.deepEqual(negativeReplay.witnesses, negative.witnesses); assert.deepEqual(negativeReplay.queryCoverage, negative.queryCoverage);
});

test('capture binding rejects uncertain, conflicting or duplicate target slots', () => {
  for (const [name, change] of [
    ['multiple targets', b => { b.callee_targets.push('other'); }],
    ['conflicting direct target', b => { b.callee = 'other'; }],
    ['unknown target', b => { b.callback_unknown = true; }],
    ['callback parameter', b => { b.callback_parameter = 0; }],
    ['malformed target list', b => { b.callee = 'check'; b.callee_targets = 'check'; }]
  ]) {
    const { raw } = F.capturePointer('targets-copied'); update(raw, 'root', f => change(f.blocks.find(b => b.id === 'bb0')));
    assert.throws(() => capture.request(raw, 'direct_pointer'), /exact fixture/, name);
    assert.throws(() => capture.pointerContradiction(raw), /exact fixture/, name);
  }
  const { raw } = F.capturePointer('targets-copied');
  update(raw, 'root', f => { f.blocks.push({ ...f.blocks.find(b => b.id === 'bb0'), id: 'other_call' }); });
  assert.throws(() => capture.request(raw, 'direct_pointer'), /unique fixture call/);
  assert.throws(() => capture.pointerContradiction(raw), /unique fixture call/);
});

test('capture mutation rejects overwritten, ambiguous, unrelated or stale pointer origins', () => {
  for (const kind of ['overwrite','storage','ambiguous','unrelated']) {
    const { raw } = F.capturePointer(kind); assert.throws(() => capture.pointerContradiction(raw), /direct pointer origin/, kind);
  }
  for (const [name, change] of [
    ['late reification', f => {
      const reification = f.value_facts.blocks.find(b => b.id === 'reify').statements.pop();
      const values = f.value_facts.blocks.find(b => b.id === 'bb0'); values.statements.splice(1, 0, reification);
      values.statements.forEach((s, i) => { s.id = 'bb0:s' + i; }); f.guard_facts.function_values[0].statement = reification.id;
    }],
    ['source mismatch', f => { f.guard_facts.function_values[0].source = op(3); }],
    ['span mismatch', f => { f.guard_facts.function_values[0].source_location++; }],
    ['destination mismatch', f => { f.guard_facts.function_values[0].destination = p(8); }],
    ['duplicate certification', f => { f.guard_facts.function_values.push({ ...f.guard_facts.function_values[0], function_id: 'compiler:other' }); }]
  ]) {
    const { raw } = F.capturePointer(); update(raw, 'root', change); assert.throws(() => capture.pointerContradiction(raw), assert.AssertionError, name);
  }
  const { raw } = F.capturePointer(); raw.nodes[0].attributes.function_id = 'unrelated-owner';
  assert.throws(() => capture.pointerContradiction(raw), /direct pointer compiler body owner/);
});

for (const item of F.reviewCases()) test('review boundary: ' + item.name, async () => {
  const api = Analysis.create(item.raw), value = await api.query(item.request);
  assert.equal(value.error, undefined, item.name); assert.equal(value.status, item.status, item.name);
  assert.equal(value.finding.supportedCompliantPath, !item.gap, item.name);
  assert.equal(value.partialCoverage, !!item.gap, item.name);
  if (item.gap) {
    assert.equal(value.witnesses.total, 0, item.name);
    assert(value.queryCoverage.gaps.some(g => g.kind === item.gap), item.name);
  } else assert(value.witnesses.items.some(w => w.classification === 'supported-compliant'), item.name);
  const replay = await api.query({ op: 'replay', replay: value.replay });
  assert.deepEqual(replay.witnesses, value.witnesses, item.name);
  assert.deepEqual(replay.finding, value.finding, item.name); assert.deepEqual(replay.queryCoverage, value.queryCoverage, item.name);
});

for (const item of F.cases()) test('exact obligations: ' + item.name, async () => {
  const value = await run(item);
  assert.equal(value.error, undefined); assert.equal(value.finding.candidateBypass, item.bypass, item.name);
  assert.equal(value.status, item.bypass ? 'bypass' : 'supported-compliant'); assert.equal(value.partialCoverage, false);
  assert.equal(value.finding.definitiveNegative, false); assert.equal(value.finding.vulnerabilityAbsenceProven, false);
  const row = value.witnesses.items.find(w => w.classification === (item.bypass ? 'bypass' : 'supported-compliant'));
  assert(row); assert.equal(row.ruleId, 'declared-access'); assert.equal(row.steps.at(-1).kind, 'sensitive-operation');
  assert.equal(row.steps.at(-1).callsiteId, item.request.model.rules[0].operation.call);
  assert(row.steps.every(s => s.sourceIdentity.rawNodeId && s.sourceIdentity.procedureId === s.sourceProcedure));
  assert.deepEqual(value.request.model.rules, Guards.normalize(item.request).model.rules);
  if (!item.bypass) {
    assert(row.requirements.every(r => r.satisfied && r.successfulInvocation));
    assert(row.steps.some(s => s.kind === 'guard-outcome' && s.successful));
  }
  if (item.name.startsWith('wrong-') || item.name === 'transformed' || item.name === 'field') assert(row.requirements.some(r => r.reason === 'subject-or-value-binding-not-proven'));
  if (item.name === 'failed-only') assert(row.requirements.some(r => r.reason === 'failed-guard-outcome'));
  if (item.name === 'ignored') assert(row.requirements.some(r => r.reason === 'ignored-or-unchecked-result'));
  if (item.name === 'after-effect') assert(!row.steps.some(s => s.kind === 'guard-result'));
  if (item.name.startsWith('repeated-')) {
    const invocations = row.steps.filter(s => s.kind === 'procedure-entry' && s.procedure === 'identity');
    assert.equal(invocations.length, 2); assert.notEqual(invocations[0].invocationId, invocations[1].invocationId);
  }
  const replay = await Analysis.create(item.raw).query({ op: 'replay', replay: value.replay });
  assert.deepEqual(replay.witnesses, value.witnesses); assert.deepEqual(replay.finding, value.finding);
});

test('requirements are conjunctive and same labels on distinct values grant no sufficiency', async () => {
  const item = F.scenario();
  item.request.model.rules[0].requires.push({ id: 'validation', at: { call: 'root#bb0@call', bindings: F.binding() }, success: false });
  const value = await run(item); assert.equal(value.status, 'bypass');
  assert(value.witnesses.items.some(w => w.requirements.some(r => r.satisfied) && w.requirements.some(r => !r.satisfied)));
  const known = F.scenario('wrong-object');
  known.request.model.rules[0].operation.bindings.object.fields = [];
  assert.equal((await run(known)).finding.candidateBypass, true);
});

test('exact versioned pure summaries can model dependency/native helpers but missing summaries stay unknown', async () => {
  for (const native of [false,true]) {
    const item = F.scenario(); item.raw.nodes = item.raw.nodes.filter(n => n.id !== 'flow:check');
    if (native) update(item.raw, 'root', f => { f.blocks[0].native_call = { symbol: 'declared_native', abi: 'C', libraries: [], declaration_local: true }; });
    let value = await run(item); assert.equal(value.status, 'indeterminate'); assert.equal(value.finding.supportedCompliantPath, false); assert.equal(value.witnesses.total, 0);
    item.request.model.summaries = [{ id: 'trusted-check-boundary', version: 1, call: 'root#bb0@call', returns: 'fresh', effects: 'none' }];
    value = await run(item); assert.equal(value.status, 'supported-compliant'); assert(value.assumptions.some(a => a.includes('trusted-check-boundary@1')));
    const ignored = F.scenario('ignored'); ignored.raw = item.raw;
    update(ignored.raw, 'root', f => { f.blocks[1] = { id: 'bb1', kind: 'goto', successors: [edge('bb2')] }; f.guard_facts.branches = []; });
    ignored.request.model.summaries = item.request.model.summaries;
    assert.equal((await run(ignored)).status, 'bypass');
  }
});

test('summary identity is exact, not a taint-preserving transfer or summary name', async () => {
  for (const returns of ['argument','fresh']) {
    const item = F.repeated(); item.request.model.summaries = [{ id: 'same-label', version: 1, call: 'root#second@call', returns, effects: 'none', ...(returns === 'argument' ? { argument: 0 } : {}) }];
    // Guard checks the pre-transform value while the effect consumes the result.
    update(item.raw, 'root', f => { f.value_facts.blocks.find(b => b.id === 'bb0').call.arguments[3] = op(4); });
    assert.equal((await run(item)).finding.candidateBypass, returns === 'fresh');
  }
});

test('unknown loops, recursion, aliases, branch facts and reachable unsupported controls never mean compliant', async () => {
  const variants = [
    ['loop', item => { item.raw = F.scenario('loop').raw; }],
    ['recursion', item => update(item.raw, 'check', f => { f.blocks = [{ id: 'bb0', kind: 'call', callee: 'check', successors: [edge('bb1')] }, { id: 'bb1', kind: 'return', successors: [] }]; f.value_facts.blocks = [{ id: 'bb0', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [op(1),op(2),op(3),op(4)], destination: p(0) } }, { id: 'bb1', statements: [] }]; })],
    ['alias', item => update(item.raw, 'root', f => { f.value_facts.blocks[0].call.arguments[0] = { kind: 'copy', place: p(1, 'deref') }; })],
    ['opaque', item => update(item.raw, 'root', f => { f.blocks[0].kind = 'opaque'; f.value_facts.blocks[0].call = null; })],
    ['tuple abi', item => update(item.raw, 'root', f => { f.value_facts.blocks[0].call.argument_convention = 'fn-trait-tuple'; })],
    ['malformed boolean', item => update(item.raw, 'root', f => { f.guard_facts.branches[0].targets[1].target = 'missing'; })],
    ['unsupported branch', item => update(item.raw, 'root', f => { f.guard_facts.branches[0] = { block: 'bb1', kind: 'unsupported' }; })],
    ['malformed control', item => update(item.raw, 'root', f => { f.blocks[0].successors[0].target = 'missing'; })],
    ['guard legacy', item => update(item.raw, 'root', f => { delete f.guard_facts; })],
    ['value legacy', item => update(item.raw, 'root', f => { delete f.value_facts; })],
    ['new guard version', item => update(item.raw, 'root', f => { f.guard_facts.version = 2; })]
  ];
  for (const [name, change] of variants) {
    const item = F.scenario(); change(item); const value = await run(item);
    assert.equal(value.status, 'indeterminate', name); assert.equal(value.partialCoverage, true, name); assert.equal(value.finding.definitiveNegative, false, name);
    assert(value.queryCoverage.totalGaps > 0, name);
  }
  const disconnected = F.scenario(); disconnected.raw.nodes.push(fn('unused-legacy', 0, [b('bb0')]));
  assert.equal((await run(disconnected)).status, 'supported-compliant');
});

test('value writes invalidate checked identities; subsequent checks establish the new identity', async () => {
  for (const after of [false,true]) {
    const item = F.scenario(after ? 'transformed-checked' : 'transformed');
    assert.equal((await run(item)).finding.candidateBypass, !after);
  }
  const item = F.scenario(); update(item.raw, 'root', f => { f.value_facts.blocks[2].statements = [{ ...a(p(4), use(op(5))), id: 'bb2:s0' }]; });
  assert.equal((await run(item)).status, 'bypass');
});

test('capture and request snapshots plus replay versions retain exact rule/source ownership', async () => {
  const item = F.scenario(), api = Analysis.create(item.raw), pending = api.query(item.request);
  item.request.model.rules[0].id = 'mutated'; update(item.raw, 'root', f => { delete f.guard_facts; });
  const value = await pending; assert.equal(value.status, 'supported-compliant'); assert.equal(value.rules[0].id, 'declared-access');
  const changed = await Analysis.create(item.raw).query({ op: 'replay', replay: value.replay }); assert.equal(changed.error.code, 'CAPTURE_MISMATCH');
  const version = structuredClone(value.replay); version.versions.guardObligations = 'other';
  assert.equal((await api.query({ op: 'replay', replay: version })).error.code, 'VERSION_MISMATCH');
  const duplicate = F.scenario(); const second = structuredClone(duplicate.raw.nodes[0]); second.id = 'detached-owner'; duplicate.raw.nodes.push(second);
  assert.equal((await run(duplicate)).status, 'indeterminate');
  const rejected = F.scenario(), bad = structuredClone(rejected.raw.nodes[0]); bad.id = 'rejected'; bad.attributes.flow = '{'; bad.source_file = '/wrong.rs'; rejected.raw.nodes.unshift(bad);
  const accepted = await run(rejected); assert.equal(accepted.status, 'supported-compliant');
  assert(accepted.witnesses.items.flatMap(w => w.steps).filter(s => s.procedure === 'root').every(s => s.sourceIdentity.rawNodeId === 'flow:root'));
});

test('bounded work, state, time, evidence and real cancellation stay explicit', async () => {
  for (const budgets of [{ maxWork: 1 }, { maxStates: 1 }]) {
    const item = F.scenario(); item.request.budgets = budgets;
    const value = await run(item); assert.equal(value.status, 'indeterminate'); assert.equal(value.completion.budgetExceeded, true); assert.equal(value.finding.definitiveNegative, false);
  }
  const item = F.scenario(); item.request.budgets = { maxEvidence: 1 };
  const value = await run(item); assert.equal(value.status, 'supported-compliant'); assert.equal(value.completion.evidenceComplete, false); assert.equal(value.witnesses.truncated, true);
  const raw = F.scenario().raw, index = Guards.build(Values.build(raw, Model.build(raw)), Model.build(raw));
  let clock = 0;
  const timed = await Guards.analyze(index, F.request(), { now: () => clock += 1000 }); assert.equal(timed.status, 'cancelled'); assert.equal(timed.completion.timedOut, true);
  let cancelled = false; setTimeout(() => { cancelled = true; }, 0);
  const pending = await Guards.analyze(index, F.request(), { cancelled: () => cancelled });
  assert.equal(pending.status, 'cancelled'); assert.equal(pending.completion.cancelled, true);
});

test('malformed policies and unavailable selections fail without inventing obligations', async () => {
  for (const change of [q => { q.model.version = 2; }, q => { q.model.rules[0].requires[0].success = 'true'; },
    q => { q.model.rules[0].requires[0].at.bindings = {}; }, q => { q.model.rules[0].operation.bindings.value.index = -1; },
    q => { q.model.summaries = [{ id: 'x', version: 1, call: 'root#bb2@call', returns: 'fresh', effects: 'none' }]; }]) {
    const item = F.scenario(); change(item.request); assert.equal((await run(item)).error.code, 'INVALID_GUARD_OBLIGATIONS');
  }
  const item = F.scenario(); item.request.model.rules[0].operation.call = 'root#not-found@call';
  assert.equal((await run(item)).status, 'indeterminate');
});

if (process.env.GUARD_CAPTURE) test('fresh compiler guard capability, exact IDs, sources, dependency bodies and replay', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.GUARD_CAPTURE)), api = Analysis.create(raw);
  const root = capture.procedure(raw, 'guard_fixture::early_return'), flow = capture.body(raw, root);
  assert.equal(flow.guard_facts.capability, 'rustc-mir-guards-v1'); assert.equal(flow.value_facts.capability, 'rustc-mir-values-v1');
  assert(flow.guard_facts.branches.some(b => b.kind === 'boolean' && b.targets[0].value === false && b.targets[1].value === true));
  const callback = capture.body(raw, capture.procedure(raw, 'guard_fixture::callback'));
  assert(callback.guard_facts.function_values.some(r => r.kind === 'function-pointer' && r.function_id && r.source && r.destination && r.source_file), 'compiler-owned direct pointer reification');
  for (const [name] of capture.cases) {
    const q = capture.request(raw, name), value = await api.query(q); capture.assertResult(name, value);
    if (!value.partialCoverage && name !== 'after_effect' && !name.startsWith('native')) assert(value.witnesses.items.flatMap(w => w.steps).some(s => s.procedure === capture.procedure(raw, 'policy_support::check')), name + ' dependency body');
    const replay = await api.query({ op: 'replay', replay: value.replay }); assert.deepEqual(replay.witnesses, value.witnesses, name);
    assert(value.witnesses.items.flatMap(w => w.steps).every(s => s.sourceIdentity.rawNodeId && s.sourceIdentity.functionId), name + ' accepted owner');
  }
  // Same fresh producer document, intentionally removed dependency capability.
  const missing = structuredClone(raw), dep = capture.procedure(missing, 'policy_support::check');
  const node = missing.nodes.find(n => { try { return JSON.parse((n.attributes || {}).flow).function === dep; } catch (_) { return false; } });
  const body = JSON.parse(node.attributes.flow); delete body.guard_facts; node.attributes.flow = JSON.stringify(body);
  assert.equal((await Analysis.create(missing).query(capture.request(missing, 'early_return'))).status, 'indeterminate');
  // Change only the certified function ID; keep the actual operand, cast,
  // accepted source/span and exact call target from the fresh compiler document.
  const contradictory = capture.pointerContradiction(raw), changedApi = Analysis.create(contradictory);
  const value = await changedApi.query(capture.request(contradictory, 'direct_pointer'));
  assert.equal(value.status, 'indeterminate'); assert.equal(value.finding.supportedCompliantPath, false);
  assert.equal(value.witnesses.total, 0); assert(value.queryCoverage.gaps.some(g => g.kind === 'contradictory-or-unproven-function-pointer'));
  const replay = await changedApi.query({ op: 'replay', replay: value.replay });
  assert.deepEqual(replay.witnesses, value.witnesses); assert.deepEqual(replay.queryCoverage, value.queryCoverage);
});

test('only exact compiler reification facts permit a function-pointer construction', async () => {
  const pointer = () => F.pointer('forwarded');
  assert.equal((await run(pointer())).status, 'supported-compliant');
  for (const change of [f => { f.guard_facts.function_values = []; }, f => { f.guard_facts.function_values[0].function_id = 'compiler:effect'; },
    f => { f.guard_facts.function_values[0].destination = p(8); }, f => { f.guard_facts.function_values[0].source = op(3); },
    f => { f.guard_facts.function_values[0].source_location = 4; }, f => { f.guard_facts.function_values.push(f.guard_facts.function_values[0]); }]) {
    const item = pointer(); update(item.raw, 'root', change); const value = await run(item);
    assert.equal(value.status, 'indeterminate'); assert.equal(value.finding.supportedCompliantPath, false);
  }
});
