/* Value propagation regressions. Run only after independent source review. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const Analysis = require('../src/analysis-api.js'), Evidence = require('../src/analysis-evidence.js');
const Model = require('../src/execution-model.js'), Values = require('../src/value-flow.js');
const F = require('../tests/fixtures/value-flow/fixture-graphs.cjs');
const { place: p, op, constant: c, assign: a, use, aggregate, ref, edge, block: b, call, fn, graph, read, sensitive, simple, model, update } = F;
const run = (raw, q = model()) => Analysis.create(raw).query(q);
const yes = value => { assert.equal(value.finding.candidateInfluence, true); assert(value.witnesses.items.some(w => w.sourceId === 'untrusted')); };
const no = value => { assert.equal(value.finding.candidateInfluence, false); assert.equal(value.status, 'not-found'); assert.equal(value.finding.definitiveNegative, false); };
const sinkAt = (q, id) => { q.model.sinks[0].at.call = id; return q; };
function assertEndpointCalls(value, request, name) {
  const steps = value.witnesses.items.flatMap(w => w.steps);
  for (const [kind, rule] of [['source', request.model.sources[0]], ['sink', request.model.sinks[0]]]) {
    const step = steps.find(s => s.kind === kind && s[kind + 'Id'] === rule.id);
    assert(step, name + ' ' + kind); assert.equal(step.callsiteId, rule.at.call, name + ' exact ' + kind + ' call');
    assert.deepEqual(step.endpoint, { ...rule.at, fields: rule.at.fields || [] }, name + ' exact ' + kind + ' endpoint');
  }
}

function assertMatchedContexts(value) {
  for (const witness of value.witnesses.items.filter(w => w.sourceId && w.classification === 'modeled')) {
    const steps = witness.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!['return-to-destination', 'reference-return'].includes(step.kind) || !step.target) continue;
      if (steps.slice(0, i).some(s => s.callsiteId === step.callsiteId && ['transformation','sanitizer'].includes(s.kind))) continue;
      assert(step.targetContextId, 'return has exact target invocation');
      const callee = steps.slice(0, i).filter(s => s.procedure === step.target && s.contextId === step.targetContextId);
      assert(callee.length, 'return matches its callee invocation');
      for (const parameter of callee.filter(s => s.kind === 'parameter' && s.inputDependency)) {
        assert(steps.slice(0, i).some(s => s.kind === 'argument-to-parameter' && s.callsiteId === step.callsiteId && s.target === step.target && s.parameter === parameter.parameter && s.targetContextId === parameter.contextId), 'parameter matches the current caller argument');
      }
    }
  }
}

test('argument positions, return values, field identities and assignments distinguish data from calls', async () => {
  const positive = await run(simple()); yes(positive); assert.equal(positive.status, 'influenced');
  const steps = positive.witnesses.items[0].steps;
  for (const kind of ['source','argument-to-parameter','assignment','return-to-destination','sink']) assert(steps.some(s => s.kind === kind), kind);
  assert(steps.some(s => s.procedure === 'relay' && s.factId === 'bb0:s0'));
  assert(steps.some(s => s.callsiteId === 'root#bb1@call'));
  assert(steps.every(s => s.sourceIdentity.rawNodeId && s.evidencePath.includes('/attributes/flow#value_facts')));
  assert.equal(positive.semantics.implicitControlTaint, false);
  no(await run(simple(true)));
  for (const field of [0, 1]) {
    const raw = graph(fn('root', 0, [call('bb0', 'input', [], p(1), 'bb1'),
      call('bb1', 'sensitive', [op(2, field)], p(0), 'bb2', [a(p(2), aggregate(op(1), c()))]), b('bb2')]), read(), sensitive());
    const value = await run(raw, sinkAt(model(), 'root#bb1@call'));
    if (field === 0) yes(value); else no(value);
  }
});

test('VF-1 parameter/return contradictions and direct arity mismatches retain possible source influence', async () => {
  for (const { name, raw, invalidBody } of F.parameterFailures()) {
    const index = Values.build(raw, Model.build(raw));
    assert.equal(index.procedures.get('relay').status, invalidBody ? 'invalid' : 'captured', name);
    const value = await run(raw);
    assert.equal(value.error, undefined, name);
    assert.equal(value.status, 'indeterminate', name); assert.equal(value.partialCoverage, true, name);
    assert.equal(value.finding.definitiveNegative, false, name); yes(value);
    assert(value.queryCoverage.gaps.some(g => g.procedure === 'relay' && g.detail === 'root#bb1@call' &&
      g.kind === (invalidBody ? index.procedures.get('relay').reason : 'call-argument-arity-mismatch')), name);
    assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.classification === 'possible' &&
      w.steps.some(s => s.kind === 'unknown-propagation')), name);
    assert(value.witnesses.items.some(w => w.classification === 'unknown'), name);
  }
});

test('valid zero-parameter bodies and configured external root parameters keep their supported contracts', async () => {
  const raw = simple(), index = Values.build(raw, Model.build(raw));
  for (const id of ['root', 'input']) {
    assert.equal(index.procedures.get(id).status, 'captured');
    assert.deepEqual(index.procedures.get(id).facts.parameter_locals, []);
  }
  const positive = await run(raw); yes(positive); assert.equal(positive.partialCoverage, false);
  no(await run(simple(true)));
  const external = F.externalRoot(), value = await run(external.raw, external.request);
  yes(value); assert.equal(value.status, 'influenced'); assert.equal(value.partialCoverage, false);
  assert.equal(value.completion.complete, true);
});

test('direct endpoint routes retain both exact callsites without inventing a callee target', async () => {
  for (const kind of ['direct', 'field', 'reference', 'bypass']) for (const clean of [false, true]) {
    const { raw, request } = F.endpointRoute(kind, clean), value = await run(raw, request);
    assert.equal(value.error, undefined, kind); assert.equal(value.partialCoverage, false, kind);
    assert.equal(value.completion.complete, true, kind);
    if (clean) { no(value); continue; }
    yes(value); assertEndpointCalls(value, request, kind);
    const steps = value.witnesses.items.flatMap(w => w.steps);
    assert.deepEqual([...new Set(steps.map(s => s.callsiteId).filter(Boolean))], [request.model.sources[0].at.call, request.model.sinks[0].at.call], kind);
    assert(steps.some(s => s.factId), kind); assert(steps.every(s => !s.target), kind + ' no inferred target');
    for (const step of steps.filter(s => ['source', 'sink'].includes(s.kind))) {
      assert.equal(step.sourceIdentity.rawNodeId, 'flow:root', kind); assert.equal(step.source.source_file, '/fixture/root.rs', kind);
    }
    const replayed = await Analysis.create(raw).query({ op: 'replay', replay: value.replay });
    assert.deepEqual(replayed.witnesses, value.witnesses, kind + ' replay');
  }
  // Argument sources and result sinks use the same exact endpoint metadata.
  const { raw, request } = F.endpointRoute();
  request.model.sources[0].at = { ...request.model.sinks[0].at };
  request.model.sinks[0].at = { call: request.model.sources[0].at.call, port: 'result' };
  const throughCall = await run(raw, request); yes(throughCall); assertEndpointCalls(throughCall, request, 'argument to result');
  const external = F.externalRoot(), procedureOnly = await run(external.raw, external.request); yes(procedureOnly);
  assert(procedureOnly.witnesses.items.flatMap(w => w.steps).every(s => !Object.hasOwn(s, 'callsiteId')), 'procedure endpoints invent no callsite');
});

test('unrelated values and callers cannot exchange parameter taint or return continuations', async () => {
  const raw = simple();
  update(raw, 'root', f => {
    f.blocks.splice(2, 0, { id: 'bb4', kind: 'call', callee: 'relay', successors: [edge('bb2')] });
    f.blocks.find(b => b.id === 'bb1').successors = [edge('bb4')];
    f.value_facts.blocks.push({ id: 'bb4', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [c(), c()], destination: p(3) } });
    f.value_facts.blocks.find(b => b.id === 'bb2').call.arguments = [op(3)];
  });
  no(await run(raw));
  update(raw, 'root', f => { f.value_facts.blocks.find(b => b.id === 'bb4').call.arguments[0] = op(1); });
  const isolated = model(); isolated.model.summaries = [{ id: 'one-call-clean', version: 1, call: 'root#bb1@call', kind: 'sanitize', from: [], to: 'result', referenceEffects: 'none' }];
  yes(await run(raw, isolated));
  const branch = graph(fn('root', 0, [b('bb0', [], 'branch', [edge('bb1'), edge('bb2')]), call('bb1', 'left', [], p(0), 'bb3'),
    call('bb2', 'right', [], p(0), 'bb3'), b('bb3')]),
  fn('left', 0, [call('bb0', 'input', [], p(1), 'bb1'), call('bb1', 'relay', [op(1), c()], p(0), 'bb2'), b('bb2')]),
  fn('right', 0, [call('bb0', 'relay', [c(), c()], p(1), 'bb1'), call('bb1', 'sensitive', [op(1)], p(0), 'bb2'), b('bb2')]), read(), F.relay(), sensitive());
  const q = model(); q.model.sources[0].at.call = 'left#bb0@call'; q.model.sinks[0].at.call = 'right#bb1@call';
  no(await run(branch, q));
});

test('precise references, field aliases and by-reference effects preserve value witnesses', async () => {
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], p(1), 'bb1'),
    call('bb1', 'sensitive', [op(2, 'deref')], p(0), 'bb2', [a(p(3), aggregate(op(1), c())), a(p(2), ref(p(3, 0)))]), b('bb2')]), read(), sensitive());
  const q = sinkAt(model(), 'root#bb1@call'), value = await run(raw, q); yes(value);
  assert(value.witnesses.items.some(w => w.steps.some(s => s.kind === 'reference-alias')));
  const written = graph(fn('root', 0, [call('bb0', 'input', [], p(1), 'bb1'),
    call('bb1', 'write', [op(3), op(1)], p(4), 'bb2', [a(p(2), use(c())), a(p(3), ref(p(2)))]),
    call('bb2', 'sensitive', [op(2)], p(0), 'bb3'), b('bb3')]),
    fn('write', 2, [b('bb0', [a(p(1, 'deref'), use(op(2))), a(p(0), use(c()))])]), read(), sensitive());
  const refValue = await run(written); yes(refValue); assertMatchedContexts(refValue);
  update(written, 'root', f => { f.value_facts.blocks[1].call.destination = p(2); });
  no(await run(written));
  update(raw, 'root', f => { f.value_facts.blocks[1].statements[0].value = { kind: 'unsupported', reason: 'raw pointer alias' }; });
  const unknown = await run(raw, q); assert.equal(unknown.status, 'indeterminate'); assert(unknown.queryCoverage.totalGaps);
  assert(unknown.witnesses.items.some(w => w.classification === 'unknown'));
});

test('configured transformations and sanitizers are versioned, exact, value scoped and context scoped', async () => {
  const raw = simple(), q = model();
  q.model.summaries = [{ id: 'text-transform', version: 1, call: 'root#bb1@call', kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' }];
  const transformed = await run(raw, q); yes(transformed);
  assert(transformed.witnesses.items.some(w => w.steps.some(s => s.kind === 'transformation' && s.summaryVersion === 1)));
  q.model.summaries = [{ ...q.model.summaries[0], id: 'clean-result', kind: 'sanitize', from: [] }];
  no(await run(raw, q));
  update(raw, 'root', f => { f.value_facts.blocks[2].call.arguments = [op(1)]; });
  yes(await run(raw, q));
  const invalid = structuredClone(q); invalid.model.summaries[0].version = 2;
  assert.equal((await run(raw, invalid)).error.code, 'INVALID_VALUE_FLOW');
  const ambiguous = structuredClone(q); ambiguous.model.summaries.push({ ...q.model.summaries[0], id: 'second' });
  assert.equal((await run(raw, ambiguous)).error.code, 'INVALID_VALUE_FLOW');
});

test('declared transfers retain possible opaque-reference inputs and precise referent fields', async () => {
  for (const { name, raw, request, expected, partial, copied, readFact, unknownReason = 'unsupported-reference' } of F.referenceTransferCases()) {
    const index = Values.build(raw, Model.build(raw));
    assert(['root', 'input', 'sensitive'].every(p => index.procedures.get(p).status === 'captured'), name + ' valid typed fixture');
    const api = Analysis.create(raw), value = await api.query(request);
    assert.equal(value.error, undefined, name); assert.equal(value.finding.candidateInfluence, expected, name);
    assert.equal(value.partialCoverage, partial, name); assert.equal(value.completion.complete, true, name);
    assert.equal(value.finding.definitiveNegative, false, name);
    assert.equal(value.status, partial ? 'indeterminate' : expected ? 'influenced' : 'not-found', name);
    if (partial) assert(value.queryCoverage.gaps.some(g => g.kind === unknownReason && g.procedure === 'root' && (!readFact || g.detail === readFact)), name);
    if (copied) assert(value.queryCoverage.gaps.some(g => g.kind === 'unsupported-reference-copy' && g.procedure === 'root'), name);
    if (expected) {
      yes(value); assertEndpointCalls(value, request, name); assertMatchedContexts(value);
      const witness = value.witnesses.items.find(w => w.sourceId === 'untrusted'), steps = witness.steps;
      assert.equal(witness.classification, partial ? 'possible' : 'modeled', name);
      assert(steps.every(s => s.procedure === 'root' && s.sourceProcedure === 'root' && s.contextId === witness.contextId), name + ' current caller proof');
      assert(steps.some(s => s.kind === 'transformation' && s.summaryId === 'declared-transfer' && s.callsiteId === 'root#bb1@call'), name);
      if (partial) {
        assert(steps.some(s => s.kind === 'unknown-propagation' && s.reason === unknownReason && (!readFact || s.factId === readFact)), name);
        assert(!steps.some(s => s.kind === 'reference-alias'), name + ' no invented precise referent');
        if (copied) assert(steps.some(s => s.kind === 'unknown-propagation' && s.reason === 'unsupported-reference-copy'), name);
      }
    } else assert(!value.witnesses.items.some(w => w.sourceId === 'untrusted'), name + ' unrelated source stays separate');
    const replayed = await api.query({ op: 'replay', replay: value.replay });
    assert.deepEqual(replayed.witnesses, value.witnesses, name + ' replay');
    if (name.startsWith('opaque reborrow/')) {
      const sourceResult = structuredClone(request); sourceResult.model.sinks[0].at = { call: 'root#bb0@call', port: 'result' };
      yes(await api.query(sourceResult));
    }
  }
});

test('direct function-pointer callbacks retain invocation bindings and argument positions', async () => {
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], p(1), 'bb1'),
    call('bb1', 'invoke', [c(), op(1)], p(2), 'bb2', [], { callback_args: [{ index: 0, targets: ['identity'] }] }),
    call('bb2', 'sensitive', [op(2)], p(0), 'bb3'), b('bb3')]),
    fn('invoke', 2, [call('bb0', null, [op(2)], p(0), 'bb1', [], { callback_parameter: 0 }), b('bb1')]),
    fn('identity', 1, [b('bb0', [a(p(0), use(op(1)))])]), read(), sensitive());
  const callback = await run(raw); yes(callback); assertMatchedContexts(callback);
  raw.nodes.push(fn('forward', 2, [call('bb0', 'invoke', [op(1), op(2)], p(0), 'bb1', [], { callback_args: [{ index: 0, parameter: 0 }] }), b('bb1')]));
  update(raw, 'root', f => { f.blocks[1].callee = 'forward'; });
  yes(await run(raw));
  update(raw, 'root', f => { f.blocks[1].callback_args[0].unknown = true; });
  assert.equal((await run(raw)).status, 'indeterminate');
  update(raw, 'invoke', f => { f.value_facts.blocks[0].call.argument_convention = 'fn-trait-tuple'; });
  assert((await run(raw)).queryCoverage.gaps.some(g => g.kind === 'unsupported-fn-trait-tuple-abi'));
});

test('loop and recursive contexts reach a finite fixed point; missing/native/legacy/malformed stay unknown', async () => {
  const raw = simple();
  update(raw, 'relay', f => {
    f.blocks[0].kind = 'branch'; f.blocks[0].successors = [edge('bb1'), edge('bb2')];
    f.blocks.push({ id: 'bb1', kind: 'call', callee: 'relay', successors: [edge('bb2')] }, { id: 'bb2', kind: 'return', successors: [] });
    f.value_facts.blocks.push({ id: 'bb1', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [op(1), op(2)], destination: p(0) } }, { id: 'bb2', statements: [], call: null });
  });
  const value = await run(raw); yes(value); assertMatchedContexts(value); assert(value.completion.complete); assert(value.completion.states < 200);
  const loop = simple(); update(loop, 'root', f => { f.blocks[1].successors = [edge('bb1'), edge('bb2')]; });
  const loopValue = await run(loop); yes(loopValue); assert(loopValue.completion.complete); assert(loopValue.completion.states < 200);
  for (const mutate of [
    raw => { raw.nodes = raw.nodes.filter(n => n.id !== 'flow:relay'); },
    raw => update(raw, 'root', f => { f.blocks[1].native_call = { symbol: 'external', abi: 'C', libraries: [] }; }),
    raw => update(raw, 'root', f => { delete f.value_facts; }),
    raw => update(raw, 'root', f => { f.value_facts.version = 9; }),
    raw => update(raw, 'root', f => { f.value_facts.blocks[1].call.arguments[0].place.local = 999; }),
    raw => update(raw, 'root', f => { f.value_facts.blocks[1].call.source_file = {}; })
  ]) {
    const broken = simple(); mutate(broken); const result = await run(broken);
    assert.equal(result.status, 'indeterminate'); assert(result.queryCoverage.totalGaps); assert.equal(result.finding.definitiveNegative, false);
  }
  const legacy = simple(); legacy.nodes.forEach(n => { const f = JSON.parse(n.attributes.flow); delete f.value_facts; n.attributes.flow = JSON.stringify(f); });
  assert.equal((await Analysis.create(legacy).query({ op: 'capabilities' })).valueFlow.status, 'unavailable');
  assert.equal((await Analysis.create(legacy).query({ op: 'orderedPath', function: 'root', target: { kind: 'procedure', id: 'sensitive' } })).status, 'exact');
});

test('snapshot models, capture ownership, replay, cancellation, timeout, work/state/evidence budgets are conservative', async () => {
  const raw = simple(), core = Evidence.create(raw), input = model(), prepared = core.prepare(input);
  input.model.sources[0].id = 'mutated'; raw.nodes[0].attributes.flow = '{}';
  const result = await core.analyzeValues(prepared); yes(result); assert.equal(result.request.model.sources[0].id, 'untrusted');
  const replay = await core.analyzeValues(core.prepare({ op: 'replay', replay: result.replay }));
  assert.deepEqual(replay.witnesses, result.witnesses); assert.equal(replay.replayed, true);
  const wrong = structuredClone(result.replay); wrong.versions.valueFlow = 'v2';
  assert.throws(() => core.prepare({ op: 'replay', replay: wrong }), { code: 'VERSION_MISMATCH' });
  assert.throws(() => Evidence.create(simple(true)).prepare({ op: 'replay', replay: result.replay }), { code: 'CAPTURE_MISMATCH' });
  for (const budgets of [{ maxWork: 1 }, { maxStates: 1 }]) { const r = await run(simple(), { ...model(), budgets }); assert.equal(r.status, 'indeterminate'); assert(r.completion.budgetExceeded); }
  const truncated = await run(simple(), { ...model(), budgets: { maxEvidence: 1 } }); yes(truncated); assert.equal(truncated.completion.evidenceComplete, false);
  const index = Values.build(simple(), Model.build(simple()));
  assert.equal((await Values.analyze(index, model(), { cancelled: () => true })).status, 'cancelled');
  let clock = 0; const timeout = await Values.analyze(index, { ...model(), timeoutMs: 1 }, { now: () => clock++ });
  assert.equal(timeout.completion.timedOut, true);
  const duplicated = simple(); duplicated.nodes.push({ ...structuredClone(duplicated.nodes[0]), id: 'duplicate' });
  assert.equal((await run(duplicated)).status, 'indeterminate');
});

// This module is also the single exact fixture binding used by emitted browser checks.
const capture = require('../tests/fixtures/value-flow/capture-model.cjs');
if (process.env.VALUE_CAPTURE) test('fresh reviewed compiler capture proves typed values across the independent dependency', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.VALUE_CAPTURE)), api = Analysis.create(raw);
  for (const [name, expected] of [['positive', true], ['swapped', false], ['fields', false], ['field_positive', true],
    ['cross_fields', true], ['cross_fields_clean', false], ['references', true], ['reference_write', true], ['unrelated', false], ['callbacks', true], ['sanitized', false], ['bypass', true]]) {
    const request = capture.request(raw, name), result = await api.query(request);
    assert.equal(result.error, undefined, name); assert.equal(result.finding.candidateInfluence, expected, name);
    if (expected) { assert(result.witnesses.items.some(w => w.steps.some(s => s.factId)), name); assert(result.witnesses.items.some(w => w.steps.some(s => s.callsiteId)), name); assertEndpointCalls(result, request, name); }
  }
  for (const [name, expected, partial] of capture.reviewedCases) {
    const value = await api.query(capture.request(raw, name));
    assert.equal(value.error, undefined, name); assert.equal(value.finding.candidateInfluence, expected, name);
    assert.equal(value.partialCoverage, partial, name);
    if (expected) assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.steps.some(s => s.factId)), name);
    capture.assertReviewed(raw, name, value);
    const replayed = await api.query({ op: 'replay', replay: value.replay }); assert.deepEqual(replayed.witnesses, value.witnesses, name + ' fresh replay');
    if (name === 'reused_proof') { const root = capture.procedure(raw, 'value_fixture::reused_proof'), outer = capture.procedure(raw, 'value_dependency::outer'), body = raw.nodes.map(n => { try { return JSON.parse((n.attributes || {}).flow); } catch (_) { return null; } }).find(f => f && f.function === root); const sites = body.blocks.filter(b => b.callee === outer).map(b => root + '#' + b.id + '@call'); assert.equal(sites.length, 2); const steps = value.witnesses.items.flatMap(w => w.steps); assert(!steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === sites[0])); assert(steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === sites[1] && s.parameter === 1)); }
    if (name === 'parameter_source') { const source = value.witnesses.items.flatMap(w => w.steps).find(s => s.kind === 'source'); assert(source.source.source_file && source.source.source_location, name); }
  }
  const value = await api.query(capture.request(raw, 'positive'));
  assert(value.witnesses.items.some(w => w.steps.some(s => s.procedure === capture.procedure(raw, 'value_dependency::relay'))));
  const stringRequest = capture.request(raw, 'strings'), strings = await api.query(stringRequest); yes(strings);
  assert.equal(strings.status, 'indeterminate'); assert.equal(strings.partialCoverage, true); assert.equal(strings.completion.complete, true);
  assertEndpointCalls(strings, stringRequest, 'strings');
  const stringWitness = strings.witnesses.items.find(w => w.sourceId === 'untrusted');
  assert.equal(stringWitness.classification, 'possible');
  assert(stringWitness.steps.some(s => s.kind === 'unknown-propagation' && s.reason === 'unsupported-reference' && s.factId === 'bb1:s0'));
  assert(stringWitness.steps.some(s => s.kind === 'transformation' && s.summaryId === 'configured-string-transform' && s.callsiteId === stringRequest.model.summaries[0].call));
  assert(stringWitness.steps.every(s => s.procedure === stringRequest.function && s.contextId === stringWitness.contextId));
  const stringsReplay = await api.query({ op: 'replay', replay: strings.replay }); assert.deepEqual(stringsReplay.witnesses, strings.witnesses, 'strings replay');
  for (const name of ['loops','native','raw_alias','callback_tuple']) {
    const value = await api.query(capture.request(raw, name)); assert.equal(value.finding.definitiveNegative, false);
    if (name !== 'loops') { assert.equal(value.status, 'indeterminate'); assert(value.queryCoverage.totalGaps); }
    if (name === 'callback_tuple') assert(value.queryCoverage.gaps.some(g => g.kind === 'unsupported-fn-trait-tuple-abi'));
    if (name === 'loops') assert(value.finding.candidateInfluence);
  }
  for (const n of raw.nodes.filter(n => n.attributes && n.attributes.kind === 'flow_function')) {
    const flow = JSON.parse(n.attributes.flow); assert.equal(flow.version, 1); assert.equal(flow.value_facts.capability, 'rustc-mir-values-v1');
    assert(flow.value_facts.locals.some(l => l.role === 'return')); assert(flow.value_facts.locals.every(l => l.shape && l.shape.kind)); assert(flow.value_facts.blocks.every(b => b.statements.every(s => s.id && 'source_file' in s)));
  }
});

test('valid nested source endpoints distinguish overwritten fields from untouched siblings', async () => {
  for (const field of [0, 1]) {
    const { raw, request } = F.fieldOverwrite(1, true);
    request.model.sources[0].at.fields = [0, field];
    const index = Values.build(raw, Model.build(raw));
    assert.equal(index.procedures.get('root').status, 'captured', 'consistent nested compiler descriptors');
    const value = await run(raw, request);
    assert.equal(value.error, undefined); assert.equal(value.partialCoverage, false); assert.equal(value.completion.complete, true);
    if (field === 0) no(value);
    else {
      yes(value); assertMatchedContexts(value);
      const source = value.witnesses.items.find(w => w.sourceId === 'untrusted').steps.find(s => s.kind === 'source');
      assert.deepEqual(source.endpoint.fields, [0, 1]); assert.equal(source.sourceIdentity.rawNodeId, 'flow:root');
    }
  }
});

test('VF-2 through VF-9/VF-11/VF-13/VF-14 shared review regressions preserve supported controls', async () => {
  for (const { name, raw, request, expected, partial, possibleSink } of F.reviewCases()) {
    const value = await run(raw, request);
    assert.equal(value.error, undefined, name); assert.equal(value.finding.candidateInfluence, expected, name);
    assert.equal(value.partialCoverage, partial, name); assert.equal(value.finding.definitiveNegative, false, name);
    assertMatchedContexts(value);
    if (partial) assert(value.queryCoverage.totalGaps, name);
    if (possibleSink) assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.classification === 'possible' &&
      w.steps.at(-1).kind === 'sink' && w.steps.at(-1).endpoint.call === request.model.sinks[0].at.call &&
      w.steps.some(s => s.kind === 'source' && s.sourceIdentity.rawNodeId === 'flow:root')), name + ' source-bearing selected caller sink');
    if (name.startsWith('VF-8')) { assert.equal(value.completion.complete, true, name); assert(value.completion.states < 200, name); }
    if (name.startsWith('VF-9 reference')) {
      const root = JSON.parse(raw.nodes.find(n => n.id === 'flow:root').attributes.flow);
      assert.equal(root.blocks[2].callee, 'gate'); assert.equal(root.value_facts.blocks[2].call.arguments.length, 0);
      assert.deepEqual(root.blocks[1].callee_targets, ['clear']); assert.equal(root.blocks[1].callback_unknown, true);
      assert.equal(value.status, 'indeterminate', name);
    } else if (name.startsWith('VF-9') && expected) assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.steps.some(s => s.procedure === 'make')), name);
    if (name.startsWith('VF-4')) {
      const steps = value.witnesses.items.find(w => w.sourceId).steps;
      assert(!steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === 'root#bb1@call'));
      assert(steps.some(s => s.kind === 'argument-to-parameter' && s.callsiteId === 'root#bb2@call' && s.parameter === 1 && s.target === 'outer'));
      const entry = steps.find(s => s.kind === 'parameter' && s.procedure === 'inner');
      assert(entry.contextId.includes('root#bb2@call->outer/outer#bb0@call->inner'));
    }
    if (name.startsWith('VF-13')) {
      const source = value.witnesses.items.flatMap(w => w.steps).find(s => s.kind === 'source');
      assert.equal(source.source.source_location, 3); assert.equal(source.sourceIdentity.rawNodeId, 'flow:root');
    }
    const core = Evidence.create(raw), replay = await core.analyzeValues(core.prepare({ op: 'replay', replay: value.replay }));
    assert.deepEqual(replay.witnesses, value.witnesses, name + ' replay');
  }
});

test('VF-10 inner reference/proof work exhausts charged budgets and cooperates with time/cancellation', async () => {
  for (const kind of ['references', 'proofs']) {
    const { raw, request } = F.cardinality(kind), index = Values.build(raw, Model.build(raw));
    const maxWork = kind === 'proofs' ? 150000 : 15000;
    const limited = await Values.analyze(index, { ...request, budgets: { maxWork } });
    assert(limited.completion.budgetExceeded, kind); assert(limited.completion.work > maxWork, kind);
    let time = 0;
    const timed = await Values.analyze(index, { ...request, timeoutMs: 5 }, { now: () => ++time / 100 });
    assert(timed.completion.timedOut, kind);
    let cancelled = false;
    const pending = Values.analyze(index, request, { cancelled: () => cancelled });
    setTimeout(() => { cancelled = true; }, 0);
    const value = await pending; assert(value.completion.cancelled, kind);
    assert.equal(value.completion.complete, false, kind);
  }
});

test('VF-11 rejected-first body never supplies the accepted owner or source span', async () => {
  const raw = F.externalRoot().raw, bad = structuredClone(raw.nodes[0]);
  bad.id = 'rejected-first'; bad.source_file = '/wrong/owner.rs'; bad.attributes.flow = '{';
  raw.nodes.unshift(bad);
  const result = await run(raw, F.externalRoot().request); yes(result);
  assert(result.witnesses.items.flatMap(w => w.steps).every(s => s.sourceIdentity.rawNodeId === 'flow:root'));
  const relative = F.externalRoot(); update(relative.raw, 'root', f => { f.value_facts.locals[1].source_file = 'src/lib.rs'; });
  const value = await run(relative.raw, relative.request), source = value.witnesses.items.flatMap(w => w.steps).find(s => s.kind === 'source');
  assert.equal(source.source.source_file, 'src/lib.rs'); assert.equal(source.source.absolute_file, null);
});
