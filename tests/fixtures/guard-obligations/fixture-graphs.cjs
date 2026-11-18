/* Explicit fixture facts: no production rule or identity is inferred from names. */
'use strict';
const F = require('../value-flow/fixture-graphs.cjs');
const { place: p, op, constant: c, assign: a, use, aggregate, edge, block: b, call, fn, graph, update } = F;
const args = [op(1), op(2), op(3), op(4)];
const binding = () => Object.fromEntries(['principal','tenant','object','value'].map((name, index) => [name, { index }]));
const guard = () => fn('check', 4, [b('bb0', [a(p(0), use(op(1)))])]);
const effect = () => fn('effect', 4, [b('bb0', [a(p(0), use(op(4)))])]);
const identity = () => fn('identity', 1, [b('bb0', [a(p(0), use(op(1)))])]);
const branch = (id, local, yes, no) => b(id, [], 'branch', [edge(no), edge(yes)], { guardLocal: local });
function captured(...nodes) {
  // Build typed layouts using the shared fixture constructors. Boolean branch
  // associations are separately explicit, as in the optional producer capability.
  const raw = graph(...nodes);
  for (const node of raw.nodes) {
    const flow = JSON.parse(node.attributes.flow);
    flow.guard_facts = { version: 1, capability: 'rustc-mir-guards-v1', status: 'captured', function_values: [],
      branches: flow.blocks.filter(b => b.kind === 'branch').map(b => ({ block: b.id, kind: 'boolean',
        discriminant: op(b.guardLocal), targets: [{ value: false, target: b.successors[0].target }, { value: true, target: b.successors[1].target }] })) };
    node.attributes.flow = JSON.stringify(flow);
  }
  return raw;
}
function request(effectCall = 'root#bb2@call', guardCall = 'root#bb0@call') {
  return { op: 'guardObligations', function: 'root', model: { version: 1, rules: [{ id: 'declared-access',
    operation: { call: effectCall, bindings: binding() }, requires: [{ id: 'successful-check', at: { call: guardCall, bindings: binding() }, success: true }] }], summaries: [] } };
}
function scenario(kind = 'early-return') {
  let checked = args.slice(), consumed = args.slice(), statements = [], tail = 'bb3';
  if (kind.startsWith('wrong-')) checked[{ 'wrong-principal': 0, 'wrong-tenant': 1, 'wrong-object': 2 }[kind]] = op(5);
  if (kind === 'transformed') { statements = [a(p(7), { kind: 'compute', operands: [op(4), c()] })]; consumed[3] = op(7); }
  if (kind === 'transformed-checked') { statements = [a(p(7), { kind: 'compute', operands: [op(4), c()] })]; checked[3] = consumed[3] = op(7); }
  let blocks = [call('bb0', 'check', checked, p(6), 'bb1', kind === 'transformed-checked' ? statements : []),
    branch('bb1', 6, 'bb2', kind === 'fail-open' ? 'bb2' : 'bb3'),
    call('bb2', 'effect', consumed, p(0), tail, kind === 'transformed' ? statements : []), b('bb3', [a(p(0), use(c()))])];
  if (kind === 'ignored') blocks[1] = b('bb1', [], 'goto', [edge('bb2')]);
  if (kind === 'failed-only') blocks[1] = branch('bb1', 6, 'bb3', 'bb2');
  if (kind === 'after-effect') blocks = [call('bb0', 'effect', args, p(8), 'bb1'), call('bb1', 'check', args, p(6), 'bb2'), branch('bb2', 6, 'bb3', 'bb3'), b('bb3', [a(p(0), use(op(8)))])];
  if (kind === 'alternate') blocks.unshift(branch('entry', 5, 'bb0', 'bb2'));
  if (kind === 'loop') blocks[3] = branch('bb3', 5, 'bb0', 'bb4'), blocks.push(b('bb4', [a(p(0), use(c()))]));
  let raw = captured(fn('root', 5, blocks), guard(), effect(), identity()), q = request();
  if (kind === 'alternate') update(raw, 'root', f => { f.entry = 'entry'; });
  if (kind === 'after-effect') q = request('root#bb0@call', 'root#bb1@call');
  if (kind === 'field') {
    update(raw, 'root', f => {
      const first = f.value_facts.blocks[0]; first.statements = [{ ...a(p(7), aggregate(op(3), op(5))), id: 'bb0:s0' }];
      first.call.arguments[2] = op(7, 0); f.value_facts.blocks[2].call.arguments[2] = op(7, 1);
      f.value_facts.locals[7].shape = { kind: 'fields', fields: [{ kind: 'scalar' }, { kind: 'scalar' }] };
      first.statements[0].destination.shape = f.value_facts.locals[7].shape;
    });
  }
  return { raw, request: q };
}
function helper(kind = 'middleware', clean = true) {
  const checked = [op(1), op(2), op(3), clean ? op(4) : op(5)];
  let extra = [fn('wrapper', 5, [call('bb0', 'check', checked, p(0), 'bb1'), b('bb1')])];
  const rootCall = call('bb0', 'wrapper', [op(1),op(2),op(3),op(4),op(5)], p(6), 'bb1');
  if (kind === 'callback') {
    rootCall.callback_args = [{ index: 0, targets: ['check'] }];
    rootCall.call.arguments = [c(), ...args];
    extra = [fn('wrapper', 5, [call('bb0', null, [op(2),op(3),op(4), clean ? op(5) : op(2)], p(0), 'bb1', [], { callback_parameter: 0 }), b('bb1')])];
  }
  const raw = captured(fn('root', 5, [rootCall, branch('bb1', 6, 'bb2', 'bb3'), call('bb2', 'effect', args, p(0), 'bb3'), b('bb3', [a(p(0), use(c()))])]), ...extra, guard(), effect());
  return { raw, request: request('root#bb2@call', 'wrapper#bb0@call') };
}
function repeated(clean = true) {
  const { raw, request: q } = scenario();
  update(raw, 'root', f => {
    f.blocks.unshift({ id: 'entry', kind: 'call', callee: 'identity', successors: [edge('second')] }, { id: 'second', kind: 'call', callee: 'identity', successors: [edge('bb0')] });
    f.entry = 'entry';
    f.value_facts.blocks.push({ id: 'entry', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [op(5)], destination: p(7) } },
      { id: 'second', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [op(4)], destination: p(8) } });
    f.value_facts.blocks.find(b => b.id === 'bb0').call.arguments[3] = op(clean ? 8 : 7);
    f.value_facts.blocks.find(b => b.id === 'bb2').call.arguments[3] = op(8);
  });
  return { raw, request: q };
}
function pointer(kind = 'direct') {
  const item = kind === 'forwarded' ? helper('callback') : scenario();
  const target = kind === 'operation' ? 'effect' : 'check', block = kind === 'operation' ? 'bb2' : 'bb0';
  item.raw.nodes.push(...captured(fn('other', 4, [b('bb0', [a(p(0), use(op(1)))])])).nodes);
  update(item.raw, 'root', f => {
    const destination = { ...p(7), shape: { kind: 'scalar' } }, source = c();
    const statement = { id: block + ':s0', kind: 'assign', destination,
      value: { kind: 'unsupported', reason: 'pointer/representation cast', operands: [source] },
      source_file: '/fixture/root.rs', source_location: 9 };
    const values = f.value_facts.blocks.find(b => b.id === block);
    values.statements = [statement];
    if (kind === 'forwarded') values.call.arguments[0] = op(7); else values.call.function = op(7);
    f.guard_facts.function_values = [{ statement: statement.id, kind: 'function-pointer', function_id: 'compiler:' + target,
      source, destination, source_file: statement.source_file, source_location: statement.source_location }];
    if (kind === 'repeated') {
      f.blocks.find(b => b.id === 'bb0').successors = [edge('second')];
      f.blocks.push({ id: 'second', kind: 'call', callee: 'check', successors: [edge('bb1')] });
      f.value_facts.blocks.push({ id: 'second', statements: [], call: { function: op(7), argument_convention: 'direct', arguments: args.slice(), destination: p(6) } });
    }
  });
  if (kind === 'forwarded') update(item.raw, 'wrapper', f => { f.value_facts.blocks[0].call.function = op(1); });
  if (kind === 'repeated') item.request.model.rules[0].requires[0].at.call = 'root#second@call';
  if (kind === 'summary') item.request.model.summaries = [{ id: 'known-pointer-check', version: 1, call: 'root#bb0@call', returns: 'fresh', effects: 'none' }];
  return item;
}
function capturePointer(kind = 'copied') {
  const item = pointer();
  if (kind.startsWith('targets-')) {
    kind = kind.slice('targets-'.length);
    update(item.raw, 'root', f => { const call = f.blocks.find(b => b.id === 'bb0'); call.callee = null; call.callee_targets = ['check']; });
  }
  // Exact fixture declarations let the portable controls use the same mutation
  // helper as the fresh compiler capture. They do not supply pointer origins.
  const declarations = { root: 'guard_fixture::direct_pointer', check: 'policy_support::check',
    other: 'guard_fixture::other_check', effect: 'policy_support::effect' };
  item.raw.nodes.forEach(n => { n.attributes.display_path = declarations[JSON.parse(n.attributes.flow).function]; });
  if (kind === 'direct') return item;
  update(item.raw, 'root', f => {
    const values = f.value_facts.blocks.find(b => b.id === 'bb0'), reification = values.statements[0];
    reification.id = 'reify:s0'; f.guard_facts.function_values[0].statement = reification.id;
    f.entry = 'reify'; f.blocks.unshift({ id: 'reify', kind: 'goto', successors: [edge('bb0')] });
    f.value_facts.blocks.unshift({ id: 'reify', statements: [reification], call: null });
    const statement = (id, destination, operand) => ({ ...a(p(destination), use(operand)), id,
      source_file: reification.source_file, source_location: reification.source_location });
    values.statements = [statement('bb0:s0', 9, op(kind === 'unrelated' ? 5 : 7)),
      statement('bb0:s1', 10, { ...op(9), kind: 'move' })];
    values.call.function = { ...op(10), kind: 'move' };
    if (kind === 'overwrite') f.value_facts.blocks[0].statements.push(statement('reify:s1', 7, c()));
    if (kind === 'storage') values.statements.splice(1, 0, { id: 'bb0:s1', kind: 'storage', local: 9 });
    if (kind === 'storage') values.statements[2].id = 'bb0:s2';
    if (kind === 'ambiguous') {
      f.entry = 'choice'; f.blocks.unshift(branch('choice', 5, 'reify', 'other_origin'));
      f.blocks.push({ id: 'other_origin', kind: 'goto', successors: [edge('bb0')] });
      f.value_facts.blocks.push({ id: 'choice', statements: [], call: null },
        { id: 'other_origin', statements: [statement('other_origin:s0', 7, op(5))], call: null });
      f.guard_facts.branches.push({ block: 'choice', kind: 'boolean', discriminant: op(5),
        targets: [{ value: false, target: 'other_origin' }, { value: true, target: 'reify' }] });
    }
  });
  return item;
}
function forwardedCallback() {
  const item = helper('callback');
  update(item.raw, 'root', f => { f.blocks[0].callee = 'forwarder'; f.blocks[0].callback_args[0].parameter = null; });
  item.raw.nodes.push(...captured(fn('forwarder', 5, [call('bb0', 'wrapper', [op(1),op(2),op(3),op(4),op(5)], p(0), 'bb1', [],
    { callback_args: [{ index: 0, parameter: 0, targets: [] }] }), b('bb1')])).nodes);
  return item;
}
function reviewCases() {
  const out = [], add = (name, item, gap) => out.push({ name, ...item, status: gap ? 'indeterminate' : 'supported-compliant', gap });
  for (const boundary of ['operation','summarized-guard','summarized-helper']) for (const delta of [-1,0,1]) {
    const item = boundary === 'summarized-helper' ? repeated() : scenario();
    const rule = item.request.model.rules[0];
    rule.operation.bindings = { principal: { index: 0 } }; rule.requires[0].at.bindings = { principal: { index: 0 } };
    const block = boundary === 'operation' ? 'bb2' : boundary === 'summarized-guard' ? 'bb0' : 'second';
    if (boundary !== 'operation') item.request.model.summaries = [{ id: 'known-boundary', version: 1, call: 'root#' + block + '@call', returns: 'fresh', effects: 'none' }];
    update(item.raw, 'root', f => {
      const call = f.value_facts.blocks.find(b => b.id === block).call;
      if (delta < 0) call.arguments.pop(); else if (delta > 0) call.arguments.push(op(5));
    });
    add(boundary + '-arity-' + delta, item, delta ? 'call-argument-arity-mismatch' : null);
  }
  const zero = scenario();
  zero.raw.nodes.push(...captured(fn('zero', 0, [b('bb0', [a(p(0), use(c()))])])).nodes);
  update(zero.raw, 'root', f => {
    f.entry = 'entry'; f.blocks.unshift({ id: 'entry', kind: 'call', callee: 'zero', successors: [edge('bb0')] });
    f.value_facts.blocks.push({ id: 'entry', statements: [], call: { function: c(), argument_convention: 'direct', arguments: [], destination: p(8) } });
  });
  add('known-zero-argument-helper', zero);
  for (const kind of ['direct','operation','summary','forwarded','repeated']) for (const wrong of [false,true]) {
    const item = pointer(kind);
    if (wrong) update(item.raw, 'root', f => { f.guard_facts.function_values[0].function_id = 'compiler:other'; });
    add(kind + '-pointer-' + (wrong ? 'contradiction' : 'matched'), item,
      wrong ? kind === 'forwarded' ? 'contradictory-function-pointer-binding' : 'contradictory-or-unproven-function-pointer' : null);
  }
  const unproven = pointer();
  update(unproven.raw, 'root', f => { f.guard_facts.function_values = []; f.value_facts.blocks[0].statements[0].value = use(op(5)); });
  add('direct-pointer-unproven', unproven, 'contradictory-or-unproven-function-pointer');
  for (const forwarded of [false,true]) for (const flag of [undefined,false,true,null,0,'false']) {
    const item = forwarded ? forwardedCallback() : helper('callback');
    update(item.raw, forwarded ? 'forwarder' : 'root', f => {
      const arg = f.blocks[0].callback_args[0];
      if (!forwarded) arg.parameter = null;
      if (flag !== undefined) arg.unknown = flag;
    });
    add((forwarded ? 'forwarded' : 'direct') + '-certainty-' + String(flag), item,
      flag === true ? 'unknown-callback-binding' : flag !== undefined && flag !== false ? 'ambiguous-callback-binding' : null);
  }
  return out;
}
const cases = () => [
  ...['early-return','fail-open','ignored','failed-only','wrong-principal','wrong-tenant','wrong-object','after-effect','transformed','transformed-checked','alternate','field'].map(name => ({ name, ...scenario(name), bypass: !['early-return','transformed-checked'].includes(name) })),
  ...['middleware','callback'].flatMap(kind => [true,false].map(clean => ({ name: kind + (clean ? '-matched' : '-mismatch'), ...helper(kind, clean), bypass: !clean }))),
  ...[true,false].map(clean => ({ name: 'repeated-' + clean, ...repeated(clean), bypass: !clean }))
];
module.exports = { ...F, binding, guard, effect, identity, branch, captured, request, scenario, helper, repeated, pointer, capturePointer, reviewCases, cases };
