/* Fixture-owned declarations bind exact captured IDs; no production name inference. */
'use strict';
const assert = require('node:assert/strict');
function rows(raw) { return raw.nodes.filter(n => n.attributes && n.attributes.kind === 'flow_function').map(n => ({ n, f: JSON.parse(n.attributes.flow) })); }
function procedure(raw, declared) {
  const matches = rows(raw).filter(({ n, f }) => (n.attributes.display_path || f.function) === declared);
  assert.equal(matches.length, 1, 'unique fixture declaration ' + declared); return matches[0].f.function;
}
function site(raw, caller, target) {
  const body = rows(raw).find(r => r.f.function === caller); assert(body, caller);
  const matches = body.f.blocks.filter(b => b.callee === target);
  assert.equal(matches.length, 1, 'one exact fixture call ' + caller + ' -> ' + target); return caller + '#' + matches[0].id + '@call';
}
function request(raw, scenario) {
  const root = procedure(raw, 'value_fixture::' + scenario), strings = scenario === 'strings';
  const parameter = scenario === 'parameter_source' || scenario.startsWith('overwrite_');
  const source = procedure(raw, 'value_fixture::' + (strings ? 'input_text' : 'input'));
  const sink = procedure(raw, 'value_fixture::' + (strings ? 'sensitive_text' : 'sensitive'));
  const q = { op: 'valueFlow', function: root, model: { version: 1,
    sources: [{ id: 'untrusted', at: scenario === 'raw_alias' || parameter ? { procedure: root, port: 'parameter', index: 0 } : { call: site(raw, root, source), port: 'result' } }],
    sinks: [{ id: 'sensitive', at: { call: site(raw, root, sink), port: 'argument', index: 0 } }], summaries: [] } };
  if (['sanitized','bypass'].includes(scenario)) q.model.summaries.push({ id: 'configured-clean-result', version: 1,
    call: site(raw, root, procedure(raw, 'value_fixture::sanitize')), kind: 'sanitize', from: [], to: 'result', referenceEffects: 'none' });
  if (scenario === 'overwrite_summary') q.model.summaries.push({ id: 'configured-pair-copy', version: 1,
    call: site(raw, root, procedure(raw, 'value_dependency::pair_copy')), kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' });
  if (strings) q.model.summaries.push({ id: 'configured-string-transform', version: 1,
    call: site(raw, root, procedure(raw, 'value_fixture::transform')), kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' });
  return q;
}
const reviewedCases = [['nested_positive', true, false], ['nested_clean', false, false], ['nested_return_positive', true, false], ['nested_return_clean', false, false],
  ['retarget_positive', true, true], ['retarget_clean', false, true], ['retarget_field_positive', true, true], ['retarget_field_clean', false, true],
  ['reused_proof', true, false], ['parameter_source', true, false], ['overwrite_clean', false, false], ['overwrite_sibling', true, false],
  ['overwrite_nested', false, false], ['overwrite_reference', false, false], ['overwrite_summary', false, false],
  ['overwrite_wrapper_clean', false, false], ['overwrite_wrapper_sibling', true, false],
  ['overwrite_wrapper_reference', false, false], ['overwrite_wrapper_reference_sibling', true, false], ['overwrite_wrapper_branch', true, false],
  ['mixed_reference', true, true], ['mixed_reference_clean', false, true], ['mixed_reference_field', true, true]];
function assertReviewed(raw, name, value) {
  const root = procedure(raw, 'value_fixture::' + name), sink = site(raw, root, procedure(raw, 'value_fixture::sensitive'));
  if (['retarget_positive','retarget_field_positive','mixed_reference','mixed_reference_field'].includes(name)) {
    assert.equal(value.status, 'indeterminate', name);
    assert(value.witnesses.items.some(w => w.sourceId === 'untrusted' && w.classification === 'possible' &&
      w.steps.at(-1).kind === 'sink' && w.steps.at(-1).endpoint.call === sink &&
      w.steps.some(s => s.kind === 'source' && s.procedure === root)), name + ' possible source at selected caller sink');
  }
  if (name.startsWith('overwrite_wrapper')) { assert.equal(value.completion.complete, true, name); assert(value.completion.states < 200, name); }
  if (name.startsWith('mixed_reference')) {
    const body = rows(raw).find(r => r.f.function === root).f, clear = procedure(raw, 'value_dependency::clear');
    const mixed = body.blocks.filter(b => (b.callee_targets || []).includes(clear) && b.callback_unknown === true);
    assert.equal(mixed.length, 1, name + ' actual compiler known plus unknown reference target');
    assert.equal(mixed[0].callback_parameter, undefined, name + ' unknown alternative has no exact callback parameter');
    const gate = site(raw, root, procedure(raw, 'value_dependency::gate'));
    const gateBlock = body.blocks.find(b => root + '#' + b.id + '@call' === gate);
    const gateValues = body.value_facts.blocks.find(b => b.id === gateBlock.id);
    assert.equal(gateValues.call.arguments.length, 0, name + ' zero-argument readiness gate');
    assert(mixed[0].successors.some(e => e.kind === 'normal' && e.target === gateBlock.id), name + ' gate immediately follows mixed reference call');
    assert(gateBlock.successors.some(e => e.kind === 'normal' && root + '#' + e.target + '@call' === sink), name + ' gate precedes selected sink');
  }
}
module.exports = { procedure, site, request, reviewedCases, assertReviewed };
