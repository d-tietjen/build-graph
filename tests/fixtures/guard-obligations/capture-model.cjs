/* Fixture declarations resolve once to unique compiler IDs; requests use only exact IDs. */
'use strict';
const assert = require('node:assert/strict');
const { binding } = require('./fixture-graphs.cjs');
function rows(raw) { return raw.nodes.filter(n => (n.attributes || {}).kind === 'flow_function').map(n => ({ n, f: JSON.parse(n.attributes.flow) })); }
function procedure(raw, declaration) {
  const found = rows(raw).filter(({ n, f }) => (n.attributes.display_path || f.function) === declaration);
  assert.equal(found.length, 1, 'unique fixture declaration ' + declaration); return found[0].f.function;
}
function body(raw, id) { const row = rows(raw).find(r => r.f.function === id); assert(row, id); return row.f; }
function site(raw, caller, declaration) {
  const target = procedure(raw, declaration), found = body(raw, caller).blocks.filter(b =>
    b.callee === target || Array.isArray(b.callee_targets) && b.callee_targets.includes(target));
  assert.equal(found.length, 1, 'unique fixture call ' + caller + ' -> ' + declaration);
  const call = found[0];
  assert(call.kind === 'call' && !call.native_call && call.callback_parameter == null &&
    (call.callback_unknown == null || call.callback_unknown === false), 'exact fixture call certainty');
  assert(call.callee_targets == null || Array.isArray(call.callee_targets), 'exact fixture target list');
  // A reified pointer can have only callee_targets. Bind the complete exact
  // singleton, never one member of an ambiguous or explicitly unknown call.
  const targets = [...(call.callee == null ? [] : [call.callee]), ...(call.callee_targets || [])];
  assert.deepEqual([...new Set(targets)], [target], 'exact fixture call target');
  return caller + '#' + call.id + '@call';
}
function request(raw, scenario) {
  const native = scenario === 'native' || scenario === 'native_summary';
  const root = procedure(raw, 'guard_fixture::' + (native ? 'native' : scenario)), callback = scenario === 'callback';
  let guardCall;
  if (native) {
    const found = body(raw, root).blocks.filter(b => b.native_call && b.native_call.symbol === 'opaque_check');
    assert.equal(found.length, 1, 'fixture native declaration'); guardCall = root + '#' + found[0].id + '@call';
  } else guardCall = site(raw, root, callback ? 'policy_support::forward' : 'policy_support::check');
  const guardBindings = binding();
  if (callback) Object.values(guardBindings).forEach(p => p.index++);
  const q = { op: 'guardObligations', function: root, model: { version: 1, rules: [{ id: 'declared-access',
    operation: { call: site(raw, root, 'policy_support::effect'), bindings: binding() },
    requires: [{ id: 'successful-check', at: { call: guardCall, bindings: guardBindings }, success: true }] }], summaries: [] } };
  if (scenario === 'native_summary') q.model.summaries.push({ id: 'declared-native-check', version: 1, call: guardCall, returns: 'fresh', effects: 'none' });
  return q;
}
const cases = [
  ['early_return',false,false], ['fail_open',true,false], ['ignored',true,false], ['failed_only',true,false],
  ['wrong_tenant',true,false], ['wrong_object',true,false], ['wrong_principal',true,false], ['after_effect',true,false],
  ['transformed',true,false], ['transformed_checked',false,false], ['alternate',true,false], ['middleware',false,false],
  ['callback',false,false], ['direct_pointer',false,false], ['repeated',false,false], ['loop_frontier',false,true], ['native',false,true], ['native_summary',false,false]
];
// This fixture needs only plain locals along one current, acyclic goto prefix.
// Trace the last write at each copy/move, rather than equating MIR temporaries.
function pointerOrigin(flow, callId, reification) {
  const controls = new Map(flow.blocks.map(b => [b.id, b])), facts = new Map(flow.value_facts.blocks.map(b => [b.id, b]));
  assert.equal(controls.size, flow.blocks.length, 'unique direct pointer control blocks');
  assert.equal(facts.size, flow.value_facts.blocks.length, 'unique direct pointer value blocks');
  assert.deepEqual([...facts.keys()].sort(), [...controls.keys()].sort(), 'direct pointer value-body ownership');
  const statements = flow.value_facts.blocks.flatMap(b => b.statements.map((s, i) => {
    assert.equal(s.id, b.id + ':s' + i, 'direct pointer statement ownership'); return s;
  }));
  const certified = statements.filter(s => s.id === reification.statement);
  assert.equal(certified.length, 1, 'unique direct pointer certified statement');
  const statement = certified[0];
  assert.equal(reification.kind, 'function-pointer'); assert.equal(statement.kind, 'assign');
  assert.equal(statement.value.kind, 'unsupported'); assert.equal(statement.value.reason, 'pointer/representation cast');
  assert.deepEqual(statement.value.operands, [reification.source], 'direct pointer certified source');
  assert.deepEqual(statement.destination, reification.destination, 'direct pointer certified destination');
  assert.equal(statement.source_file, reification.source_file, 'direct pointer certified source file');
  assert.equal(statement.source_location, reification.source_location, 'direct pointer certified source span');
  assert.equal(flow.guard_facts.function_values.filter(r => r.statement === statement.id).length, 1, 'unique direct pointer statement certification');
  const locals = new Map(flow.value_facts.locals.map(l => [l.local, l]));
  assert.equal(locals.size, flow.value_facts.locals.length, 'unique direct pointer local declarations');
  function local(place) {
    assert(place && Number.isInteger(place.local) && locals.has(place.local), 'direct pointer origin needs an owned local');
    assert.deepEqual(place.projection, [], 'direct pointer origin needs an unprojected local');
    const declaration = locals.get(place.local);
    assert.equal(place.type, declaration.type, 'direct pointer origin keeps the compiler type');
    assert.deepEqual(declaration.shape, { kind: 'scalar' }, 'direct pointer origin needs a scalar local');
    if (place.shape) assert.deepEqual(place.shape, declaration.shape, 'direct pointer origin keeps the compiler shape');
    return place.local;
  }
  const incoming = id => flow.blocks.flatMap(b => b.successors.filter(e => e.target === id).map(e => ({ b, e })));
  const prefix = [], seen = new Set(); let id = callId;
  for (;;) {
    assert(controls.has(id) && facts.has(id) && !seen.has(id), 'direct pointer origin needs an owned acyclic prefix');
    seen.add(id); prefix.unshift(facts.get(id));
    if (id === flow.entry) { assert.equal(incoming(id).length, 0, 'direct pointer origin rejects an entry backedge'); break; }
    const predecessors = incoming(id);
    assert.equal(predecessors.length, 1, 'direct pointer origin rejects ambiguous predecessors');
    const { b, e } = predecessors[0];
    assert(b.kind === 'goto' && b.successors.length === 1 && e.kind === 'normal', 'direct pointer origin needs a plain goto prefix');
    id = b.id;
  }
  assert.equal(controls.get(callId).kind, 'call', 'direct pointer exact invocation block');
  assert.equal(facts.get(callId).call.argument_convention, 'direct', 'direct pointer exact invocation convention');
  const operand = facts.get(callId).call.function;
  assert(['copy','move'].includes(operand.kind), 'direct invocation reads the reified pointer');
  let current = local(operand.place);
  for (const block of prefix.reverse()) for (const s of block.statements.slice().reverse()) {
    assert(['assign','storage','nop'].includes(s.kind), 'direct pointer origin rejects unsupported writes');
    if (s.kind === 'storage') { assert.notEqual(s.local, current, 'direct pointer origin rejects a storage overwrite'); continue; }
    if (s.kind !== 'assign' || local(s.destination) !== current) continue;
    if (s === statement) { assert.equal(current, local(reification.destination)); return; }
    const value = s.value;
    assert(value.kind === 'use' && value.operands.length === 1 && ['copy','move'].includes(value.operands[0].kind), 'direct pointer origin rejects an overwrite or unrelated value');
    assert.equal(s.destination.type, value.operands[0].place.type, 'direct pointer copy/move keeps its compiler type');
    current = local(value.operands[0].place);
  }
  assert.fail('direct pointer origin does not reach the certified reification');
}
function pointerContradiction(raw) {
  const changed = structuredClone(raw), root = procedure(changed, 'guard_fixture::direct_pointer');
  const owners = rows(changed).filter(r => r.f.function === root);
  assert.equal(owners.length, 1, 'unique direct pointer body owner');
  const row = owners[0], check = body(changed, procedure(changed, 'policy_support::check'));
  assert.equal(row.n.attributes.function_id, row.f.function_id, 'direct pointer compiler body owner');
  const other = body(changed, procedure(changed, 'guard_fixture::other_check'));
  const reifications = row.f.guard_facts.function_values.filter(r => r.function_id === check.function_id);
  assert.equal(reifications.length, 1, 'unique direct pointer compiler reification');
  const callId = site(changed, root, 'policy_support::check').slice((root + '#').length).split('@')[0];
  pointerOrigin(row.f, callId, reifications[0]);
  assert.notEqual(other.function_id, check.function_id, 'distinct same-signature compiler function');
  reifications[0].function_id = other.function_id;
  row.n.attributes.flow = JSON.stringify(row.f);
  return changed;
}
function assertResult(name, value) {
  const row = cases.find(c => c[0] === name); assert(row, name);
  assert.equal(value.error, undefined, name); assert.equal(value.finding.candidateBypass, row[1], name);
  assert.equal(value.partialCoverage, row[2], name); assert.equal(value.finding.definitiveNegative, false, name);
  assert.equal(value.status, row[2] ? 'indeterminate' : row[1] ? 'bypass' : 'supported-compliant', name);
  if (!row[2]) assert(value.witnesses.items.some(w => w.classification === (row[1] ? 'bypass' : 'supported-compliant')), name);
  if (name === 'failed_only') assert(value.witnesses.items.some(w => w.requirements.some(r => r.reason === 'failed-guard-outcome')));
  if (['wrong_tenant','wrong_object','wrong_principal','transformed'].includes(name)) assert(value.witnesses.items.some(w => w.requirements.some(r => r.reason === 'subject-or-value-binding-not-proven')));
  if (name === 'after_effect') assert(value.witnesses.items.every(w => !w.steps.some(s => s.kind === 'guard-result')));
  assert.equal(value.completion.complete, true, name);
}
module.exports = { rows, body, procedure, site, request, cases, assertResult, pointerContradiction };
