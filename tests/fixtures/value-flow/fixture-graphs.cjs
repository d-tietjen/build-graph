'use strict';
const place = (local, ...projection) => ({ local, type: 'u64', projection: projection.map(p => typeof p === 'number' ? { kind: 'field', index: p, type: 'u64' } : { kind: p }) });
const op = (local, ...fields) => ({ kind: 'copy', place: place(local, ...fields) });
const constant = () => ({ kind: 'constant', type: 'u64' });
const assign = (destination, value) => ({ kind: 'assign', destination, value });
const use = operand => ({ kind: 'use', operands: [operand] });
const aggregate = (...operands) => ({ kind: 'aggregate', operands });
const ref = referent => ({ kind: 'ref', place: referent });
const edge = target => ({ target, kind: 'normal', label: 'next' });
const block = (id, statements = [], kind = 'return', successors = [], extra = {}) => ({ id, kind, successors, statements, ...extra });
const call = (id, callee, args, destination, target, statements = [], extra = {}) => block(id, statements, 'call', target ? [edge(target)] : [],
  { callee, call: { function: constant(), argument_convention: 'direct', arguments: args, destination }, ...extra });
function fn(id, params, blocks, extra = {}) {
  const control = blocks.map(({ statements, call, ...b }) => ({ ...b, label: b.kind, source_file: '/fixture/' + id + '.rs', source_location: 8 }));
  const values = blocks.map(b => ({ id: b.id, statements: b.statements.map((s, i) => ({ ...s, id: b.id + ':s' + i,
    source_file: '/fixture/' + id + '.rs', source_location: 9 })), call: b.call && { ...b.call, source_file: '/fixture/' + id + '.rs', source_location: 10 } || null }));
  const flow = { version: 1, function: id, function_id: 'compiler:' + id, entry: 'bb0', blocks: control,
    value_facts: { version: 1, capability: 'rustc-mir-values-v1', status: 'captured', return_local: 0,
      parameter_locals: Array.from({ length: params }, (_, i) => i + 1),
      locals: Array.from({ length: 24 }, (_, i) => ({ local: i, type: 'u64', kind: 'value', shape: { kind: 'scalar' }, source_file: '/fixture/' + id + '.rs', source_location: 3, role: i === 0 ? 'return' : i <= params ? 'parameter' : 'local' })), blocks: values } };
  return { id: 'flow:' + id, source_file: '/fixture/' + id + '.rs', source_location: 1,
    attributes: { kind: 'flow_function', path: id, function_id: 'compiler:' + id, package_id: 'package:' + id, ...extra, flow: JSON.stringify(flow) } };
}
// Synthetic compiler descriptors are built from this fixture's explicit typed
// constructors, never from display type strings. Mutation tests keep them frozen.
function graph(...nodes) {
  const flows = new Map(nodes.map(n => [n.id, JSON.parse(n.attributes.flow)]));
  const layouts = new Map(nodes.map(n => [n.id, Array.from({ length: 24 }, () => null)]));
  const scalar = { kind: 'scalar' }, unknown = { kind: 'unknown' };
  const get = (ls, p) => { let shape = ls[p.local]; for (const part of p.projection) shape = shape && (part.kind === 'field' ? shape.fields && shape.fields[part.index] : shape.target); return shape; };
  const put = (ls, p, shape) => {
    if (!shape) return;
    if (!p.projection.length) { ls[p.local] = shape; return; }
    let owner = ls, key = p.local;
    for (const part of p.projection) {
      if (part.kind === 'field') { if (!owner[key] || owner[key].kind === 'scalar') owner[key] = { kind: 'fields', fields: [] }; owner = owner[key].fields; key = part.index; }
      else { if (!owner[key] || owner[key].kind === 'scalar') owner[key] = { kind: 'reference', target: null }; const base = owner[key]; owner = base; key = 'target'; }
    }
    owner[key] = shape;
  };
  const operand = (ls, o) => o.kind === 'constant' ? scalar : get(ls, o.place);
  for (let round = 0; round < 12; round++) for (const [id, f] of flows) {
    const ls = layouts.get(id);
    for (const b of f.value_facts.blocks) {
      for (const s of b.statements) if (s.kind === 'assign') {
        const v = s.value;
        if (v.kind === 'ref') put(ls, s.destination, { kind: 'reference', target: get(ls, v.place) || scalar });
        else if (v.kind === 'aggregate') put(ls, s.destination, { kind: 'fields', fields: v.operands.map(o => operand(ls, o) || scalar) });
        else if (v.kind === 'use') put(ls, s.destination, operand(ls, v.operands[0]) || scalar);
        else put(ls, s.destination, scalar);
      }
      if (b.call) {
        const control = f.blocks.find(c => c.id === b.id), target = layouts.get('flow:' + control.callee);
        if (target) { b.call.arguments.forEach((o, i) => { if (operand(ls, o)) target[i + 1] = operand(ls, o); }); if (b.call.destination && target[0]) put(ls, b.call.destination, target[0]); }
      }
    }
  }
  const finish = shape => !shape ? scalar : shape.kind === 'fields' ? { kind: 'fields', fields: Array.from(shape.fields, finish) } : shape.kind === 'reference' ? { kind: 'reference', target: finish(shape.target) } : shape;
  for (const n of nodes) {
    const f = flows.get(n.id), ls = layouts.get(n.id).map(finish);
    f.value_facts.locals.forEach(l => { l.shape = ls[l.local]; l.kind = l.shape.kind === 'reference' ? 'reference' : 'value'; });
    function annotate(p) { p.shape = get(ls, p) || unknown; let shape = ls[p.local]; for (const part of p.projection) { shape = shape && (part.kind === 'field' ? shape.fields && shape.fields[part.index] : shape.target); if (part.kind === 'field') part.shape = shape || unknown; } }
    for (const b of f.value_facts.blocks) {
      for (const r of b.statements) if (r.kind === 'assign') { annotate(r.destination); if (r.value.place) annotate(r.value.place); for (const o of r.value.operands || []) if (o.place) annotate(o.place); }
      if (b.call) { if (b.call.destination) annotate(b.call.destination); for (const o of [b.call.function, ...b.call.arguments]) if (o.place) annotate(o.place); }
    }
    n.attributes.flow = JSON.stringify(f);
  }
  return { nodes, edges: [] };
}
const read = () => fn('input', 0, [block('bb0', [assign(place(0), use(constant()))])]);
const sensitive = () => fn('sensitive', 1, [block('bb0', [assign(place(0), use(op(1)))])]);
const relay = () => fn('relay', 2, [block('bb0', [assign(place(0), use(op(1)))])]);
function simple(swapped = false) {
  return graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', 'relay', swapped ? [constant(), op(1)] : [op(1), constant()], place(2), 'bb2'),
    call('bb2', 'sensitive', [op(2)], place(0), 'bb3'), block('bb3')]), read(), relay(), sensitive());
}
const model = (root = 'root') => ({ op: 'valueFlow', function: root, model: { version: 1,
  sources: [{ id: 'untrusted', at: { call: root + '#bb0@call', port: 'result' } }],
  sinks: [{ id: 'sensitive', at: { call: root + '#bb2@call', port: 'argument', index: 0 } }], summaries: [] } });
function update(raw, name, change) { const n = raw.nodes.find(n => n.id === 'flow:' + name), f = JSON.parse(n.attributes.flow); change(f); n.attributes.flow = JSON.stringify(f); return raw; }
function parameterFailures() {
  const malformed = [
    ['empty parameter list (VF-1)', f => { f.parameter_locals = []; }],
    ['truncated parameter list', f => { f.parameter_locals = [1]; }],
    ['duplicate parameter list', f => { f.parameter_locals = [1, 1]; }],
    ['reordered parameter list', f => { f.parameter_locals = [2, 1]; }],
    ['missing parameter local', f => { f.locals = f.locals.filter(l => l.local !== 2); }],
    ['parameter declared as temporary', f => { f.locals[2].role = 'local'; }],
    ['temporary declared as parameter', f => { f.locals[3].role = 'parameter'; }],
    ['reordered parameter declarations', f => { [f.locals[1], f.locals[2]] = [f.locals[2], f.locals[1]]; }],
    ['parameter declared as return', f => { f.locals[1].role = 'return'; }],
    ['return declared as temporary', f => { f.locals[0].role = 'local'; }],
    ['return declared as parameter', f => { f.locals[0].role = 'parameter'; }],
    ['temporary declared as return', f => { f.locals[3].role = 'return'; }],
    ['conflicting return local', f => { f.return_local = 1; }],
    ['missing return local', f => { f.locals = f.locals.filter(l => l.local !== 0); }],
    ['duplicate local declaration', f => { f.locals.push({ ...f.locals[1] }); }]
  ].map(([name, change]) => ({ name, raw: update(simple(), 'relay', f => change(f.value_facts)), invalidBody: true }));
  const arity = [
    ['missing direct argument', [op(1)]],
    ['excess direct argument carrying the source', [constant(), constant(), op(1)]]
  ].map(([name, args]) => ({ name, raw: update(simple(), 'root', f => { f.value_facts.blocks[1].call.arguments = args; }), invalidBody: false }));
  return malformed.concat(arity);
}
function externalRoot() {
  return { raw: graph(fn('root', 1, [block('bb0', [assign(place(0), use(op(1)))])])),
    request: { op: 'valueFlow', function: 'root', model: { version: 1,
      sources: [{ id: 'untrusted', at: { procedure: 'root', port: 'parameter', index: 0 } }],
      sinks: [{ id: 'sensitive', at: { procedure: 'root', port: 'return' } }], summaries: [] } } };
}
// These routes carry a source between endpoint calls without crossing a callee.
function endpointRoute(kind = 'direct', clean = false) {
  let statements = [assign(place(2), use(clean ? constant() : op(1)))], selected = op(2);
  if (kind === 'field') { statements = [assign(place(2), aggregate(op(1), constant()))]; selected = op(2, clean ? 1 : 0); }
  if (kind === 'reference') { statements = [assign(place(2), ref(place(1)))]; selected = clean ? constant() : op(2, 'deref'); }
  const sinkBlock = kind === 'bypass' ? 'bb2' : 'bb1', end = kind === 'bypass' ? 'bb3' : 'bb2';
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    ...(kind === 'bypass' ? [call('bb1', 'sanitize', [op(1)], place(3), 'bb2')] : []),
    call(sinkBlock, 'sensitive', [selected], place(0), end, statements), block(end)]), read(), sensitive(),
    fn('sanitize', 1, [block('bb0', [assign(place(0), use(op(1)))])]));
  const request = model(); request.model.sinks[0].at.call = 'root#' + sinkBlock + '@call';
  if (kind === 'bypass') request.model.summaries = [{ id: 'clean-unused-result', version: 1, call: 'root#bb1@call', kind: 'sanitize', from: [], to: 'result', referenceEffects: 'none' }];
  return { raw, request, expected: !clean };
}
function referenceTransferCases() {
  const cases = [], opaqueReference = { kind: 'reference', target: { kind: 'unknown' } };
  const transfer = { id: 'declared-transfer', version: 1, call: 'root#bb1@call', kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' };
  // Match the compiler's reference-valued constant return and &(*reference)
  // reborrow without inventing a captured pointee for the opaque reference.
  for (const mode of ['reborrow', 'copy', 'same-reborrow', 'same-copy']) for (const clean of [false, true]) {
    const borrowed = mode === 'same-reborrow' ? 1 : 2, copied = mode === 'copy' ? 3 : borrowed;
    const statements = [assign(place(5), use(constant())), assign(place(borrowed), ref(place(clean ? 5 : 1, 'deref'))),
      ...(['copy', 'same-copy'].includes(mode) ? [assign(place(copied), use(op(borrowed)))] : [])];
    const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
      call('bb1', 'declared_transform', [op(copied)], place(4), 'bb2', statements),
      call('bb2', 'sensitive', [op(4)], place(0), 'bb3'), block('bb3')]), read(), sensitive());
    update(raw, 'input', f => { f.value_facts.locals[0].kind = 'reference'; f.value_facts.locals[0].shape = structuredClone(opaqueReference);
      f.value_facts.blocks = JSON.parse(JSON.stringify(f.value_facts.blocks, (key, value) => key === 'shape' ? undefined : value)); });
    update(raw, 'root', f => {
      for (const local of [1, 2, 3, 5]) { f.value_facts.locals[local].kind = 'reference'; f.value_facts.locals[local].shape = structuredClone(opaqueReference); }
      f.value_facts.blocks = JSON.parse(JSON.stringify(f.value_facts.blocks, (key, value) => key === 'shape' ? undefined : value));
    });
    const request = model(); request.model.summaries = [{ ...transfer }];
    cases.push({ name: 'opaque ' + mode + '/' + clean, raw, request, expected: !clean, partial: true, copied: mode.includes('copy') });
  }
  // Node { next: &'static Node }: finite compiler layouts stop at depth 12.
  // The unresolved case must read p before p = copy((*p).next) clears p.
  const nodeShape = (reference = false, depth = 0) => depth === 12 ? { kind: 'unknown' } : reference ?
    { kind: 'reference', target: nodeShape(false, depth + 1) } : { kind: 'fields', fields: [nodeShape(true, depth + 1)] };
  for (const known of [false, true]) for (const clean of [false, true]) for (const same of known ? [true] : [true, false]) {
    const copied = same ? 1 : 7;
    const statements = known ? [assign(place(5), use(constant())), assign(place(3), ref(place(clean ? 5 : 6))),
      assign(place(2), aggregate(op(3))), assign(place(1), ref(place(2)))] : clean ? [assign(place(1), use(constant()))] : [];
    statements.push(assign(place(copied), use(op(1, 'deref', 0))));
    const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(known || clean ? 6 : 1), 'bb1'),
      call('bb1', 'declared_transform', [op(copied)], place(4), 'bb2', statements),
      call('bb2', 'sensitive', [op(4)], place(0), 'bb3'), block('bb3')]), read(), sensitive());
    update(raw, 'input', f => { f.value_facts.locals[0].kind = known ? 'value' : 'reference'; f.value_facts.locals[0].shape = nodeShape(!known);
      f.value_facts.blocks = JSON.parse(JSON.stringify(f.value_facts.blocks, (key, value) => key === 'shape' ? undefined : value)); });
    update(raw, 'root', f => {
      for (const local of known ? [1, 3] : [1, 6, 7]) { f.value_facts.locals[local].kind = 'reference'; f.value_facts.locals[local].shape = nodeShape(true); }
      if (known) for (const local of [2, 4, 5, 6]) f.value_facts.locals[local].shape = nodeShape();
      f.value_facts.blocks = JSON.parse(JSON.stringify(f.value_facts.blocks, (key, value) => key === 'shape' ? undefined : value));
    });
    const request = model(); request.model.summaries = [{ ...transfer }];
    cases.push({ name: (known ? 'precise' : 'opaque') + (same ? ' same' : ' distinct') + '-projected-copy/' + clean, raw, request,
      expected: !clean, partial: !known, unknownReason: 'unsupported-read-alias', readFact: 'bb1:s' + (statements.length - 1) });
  }
  // A known referent still transfers its separate field payloads into a result.
  for (const field of [0, 1]) {
    const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
      call('bb1', 'declared_transform', [op(3)], place(4), 'bb2', [assign(place(2), aggregate(op(1), constant())), assign(place(3), ref(place(2)))]),
      call('bb2', 'sensitive', [op(4, field)], place(0), 'bb3'), block('bb3')]), read(), sensitive());
    update(raw, 'root', f => { f.value_facts.locals[4].shape = structuredClone(f.value_facts.locals[2].shape);
      f.value_facts.blocks = JSON.parse(JSON.stringify(f.value_facts.blocks, (key, value) => key === 'shape' ? undefined : value)); });
    const request = model(); request.model.summaries = [{ ...transfer }];
    cases.push({ name: 'precise field/' + field, raw, request, expected: field === 0, partial: false });
  }
  return cases;
}
module.exports = { place, op, constant, assign, use, aggregate, ref, edge, block, call, fn, graph, read, sensitive, relay, simple, model, update, parameterFailures, externalRoot, endpointRoute, referenceTransferCases };

// Confirmed review reproductions are shared by API and both real browser transports.
function nested(field = 1, boundary = false) {
  const nodes = [fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    ...(boundary ? [call('bb1', 'nested_copy', [op(3)], place(4), 'bb2', [assign(place(2), aggregate(op(1), constant())), assign(place(3), aggregate(op(2), constant()))]),
      call('bb2', 'sensitive', [op(4, 0, field)], place(0), 'bb3'), block('bb3')] :
      [call('bb1', 'sensitive', [op(3, 0, field)], place(0), 'bb2', [assign(place(2), aggregate(op(1), constant())), assign(place(3), aggregate(op(2), constant()))]), block('bb2')])]), read(), sensitive()];
  if (boundary) nodes.push(fn('nested_copy', 1, [block('bb0', [assign(place(0), use(op(1)))])]));
  const request = model(); request.model.sinks[0].at.call = boundary ? 'root#bb2@call' : 'root#bb1@call';
  return { raw: graph(...nodes), request, expected: field === 0, partial: false };
}
function retarget(clean = false, field = false) {
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', 'retarget', [op(4), op(5)], place(6), 'bb2', [
      assign(place(2), use(constant())), ...(field ? [assign(place(7), aggregate(clean ? constant() : op(1), constant()))] : []),
      assign(place(3), ref(place(2))), assign(place(4), ref(place(3))), assign(place(5), ref(field ? place(7, 0) : clean ? place(2) : place(1)))]),
    call('bb2', 'sensitive', [op(3, 'deref')], place(0), 'bb3'), block('bb3')]),
  fn('retarget', 2, [block('bb0', [assign(place(1, 'deref'), use(op(2))), assign(place(0), use(constant()))])]), read(), sensitive());
  return { raw, request: model(), expected: !clean, partial: true };
}
function reusedProof() {
  return { raw: graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', 'outer', [op(1), constant()], place(2), 'bb2'), call('bb2', 'outer', [constant(), op(1)], place(3), 'bb3'),
    call('bb3', 'sensitive', [op(3)], place(0), 'bb4'), block('bb4')]),
  fn('outer', 2, [call('bb0', 'inner', [op(3)], place(0), 'bb1', [assign(place(3), { kind: 'compute', operands: [op(1), op(2)] })]), block('bb1')]),
  fn('inner', 1, [block('bb0', [assign(place(0), use(op(1)))])]), read(), sensitive()),
  request: { ...model(), model: { ...model().model, sinks: [{ id: 'sensitive', at: { call: 'root#bb3@call', port: 'argument', index: 0 } }] } }, expected: true, partial: false };
}
function fieldOverwrite(sibling = 0, nestedField = false, byRef = false, summary = false, branch = false, referenceCall = false) {
  const path = nestedField ? [0, sibling] : [sibling], overwritten = nestedField ? [0, 0] : [0];
  const shape = nestedField ? { kind: 'fields', fields: [{ kind: 'fields', fields: [{ kind: 'scalar' }, { kind: 'scalar' }] }, { kind: 'scalar' }] } : { kind: 'fields', fields: [{ kind: 'scalar' }, { kind: 'scalar' }] };
  const writes = byRef ? [assign(place(3), ref(place(1, ...overwritten))), assign(place(3, 'deref'), use(constant()))] : [assign(place(1, ...overwritten), use(constant()))];
  let blocks = [block('bb0', [...writes, assign(place(0), use(op(1, ...path)))])];
  if (branch) blocks = [block('bb0', [], 'branch', [edge('bb1'), edge('bb2')]), block('bb1', writes, 'goto', [edge('bb2')]), block('bb2', [assign(place(0), use(op(1, ...path)))])];
  if (summary) blocks = [call('bb0', 'copy_pair', [op(1)], place(2), 'bb1'), block('bb1', [assign(place(1), use(op(2))), ...writes, assign(place(0), use(op(1, ...path)))])];
  if (referenceCall) blocks = [call('bb0', 'clear_field', [op(3)], place(2), 'bb1', [assign(place(3), ref(place(1, 0)))]), block('bb1', [assign(place(0), use(op(1, ...path)))])];
  const raw = graph(fn('root', 1, blocks), fn('clear_field', 1, [block('bb0', [assign(place(1, 'deref'), use(constant())), assign(place(0), use(constant()))])]), fn('copy_pair', 1, [block('bb0', [assign(place(0), use(op(1)))])]));
  // This parameter's complete compiler layout cannot be inferred from one field use.
  for (const n of raw.nodes) { if (n.id === 'flow:clear_field') continue; const f = JSON.parse(n.attributes.flow); for (const l of f.value_facts.locals) if (l.local === 1 || summary && l.local === 2 || n.id === 'flow:copy_pair' && l.local === 0) l.shape = structuredClone(shape);
    for (const b of f.value_facts.blocks) { for (const s of b.statements) { if (s.destination) { delete s.destination.shape; if (s.destination.local === 1) s.destination.projection.forEach(p => delete p.shape); } if (s.value.place) delete s.value.place.shape; for (const o of s.value.operands || []) if (o.place) { delete o.place.shape; o.place.projection.forEach(p => delete p.shape); } } if (b.call) { delete b.call.destination.shape; b.call.arguments.forEach(o => { if (o.place) delete o.place.shape; }); } }
    n.attributes.flow = JSON.stringify(f); }
  const request = externalRoot().request;
  if (summary) request.model.summaries = [{ id: 'copy', version: 1, call: 'root#bb0@call', kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' }];
  return { raw, request, expected: sibling !== 0 || branch, partial: false };
}
function callbackCase(bindings = [{ index: 0, targets: ['identity'] }], forwarded = false, forwardedTarget = 'identity') {
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', forwarded ? 'forward' : 'invoke', [constant(), op(1)], place(2), 'bb2', [], { callback_args: forwarded ? [{ index: 0, targets: [forwardedTarget] }] : bindings }),
    call('bb2', 'sensitive', [op(2)], place(0), 'bb3'), block('bb3')]),
  fn('forward', 2, [call('bb0', 'invoke', [op(1), op(2)], place(0), 'bb1', [], { callback_args: bindings }), block('bb1')]),
  fn('invoke', 2, [call('bb0', null, [op(2)], place(0), 'bb1', [], { callback_parameter: 0 }), block('bb1')]),
  fn('identity', 1, [block('bb0', [assign(place(0), use(op(1)))])]), fn('clean', 1, [block('bb0', [assign(place(0), use(constant()))])]), read(), sensitive());
  return { raw, request: model(), expected: true };
}
function unknownAlternative(source = true, multiple = false) {
  const raw = graph(fn('root', 0, [call('bb0', null, [], place(1), 'bb1', [], { callee_targets: multiple ? ['make', 'empty'] : ['make'], callback_unknown: !multiple }),
    call('bb1', 'sensitive', [op(1)], place(0), 'bb2'), block('bb2')]),
  fn('make', 0, [call('bb0', 'input', [], place(0), 'bb1'), block('bb1')]), fn('empty', 0, [block('bb0', [assign(place(0), use(constant()))])]), read(), sensitive());
  if (!source) update(raw, 'make', f => { f.value_facts.blocks[0].call.destination = place(2); });
  const request = model(); request.model.sources[0].at.call = 'make#bb0@call'; request.model.sinks[0].at.call = 'root#bb1@call';
  return { raw, request, expected: source, partial: true };
}
function referenceWrite() {
  return { raw: graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', 'write', [op(3), op(1)], place(4), 'bb2', [assign(place(2), use(constant())), assign(place(3), ref(place(2)))]),
    call('bb2', 'sensitive', [op(2)], place(0), 'bb3'), block('bb3')]),
  fn('write', 2, [block('bb0', [assign(place(1, 'deref'), use(op(2))), assign(place(0), use(constant()))])]), read(), sensitive()), request: model(), expected: true, partial: false };
}
function wrapperOverwrite(sibling = 0, byRef = false, branch = false) {
  const raw = graph(fn('root', 1, [call('bb0', 'wrapper', [op(byRef ? 3 : 1)], place(2), 'bb1', byRef ? [assign(place(3), ref(place(1, 0)))] : []),
    call('bb1', 'sensitive', [op(byRef ? 1 : 2, sibling)], place(0), 'bb2'), block('bb2')]),
  fn('wrapper', 1, [call('bb0', 'clear_pair', [op(1)], place(0), 'bb1'), block('bb1')]),
  fn('clear_pair', 1, branch ? [block('bb0', [], 'branch', [edge('bb1'), edge('bb2')]),
    block('bb1', [assign(place(1, 0), use(constant()))], 'goto', [edge('bb2')]), block('bb2', [assign(place(0), use(op(1)))])] :
    [block('bb0', [assign(byRef ? place(1, 'deref') : place(1, 0), use(constant())), assign(place(0), use(byRef ? constant() : op(1)))])]), sensitive());
  const pair = { kind: 'fields', fields: [{ kind: 'scalar' }, { kind: 'scalar' }] };
  for (const n of raw.nodes) update(raw, n.attributes.path, f => {
    const locals = n.attributes.path === 'root' ? byRef ? [1] : [1, 2] : !byRef && n.attributes.path !== 'sensitive' ? [0, 1] : [];
    for (const local of locals) f.value_facts.locals[local].shape = structuredClone(pair);
    const erase = p => { if (p) { delete p.shape; p.projection.forEach(part => delete part.shape); } };
    for (const b of f.value_facts.blocks) {
      for (const s of b.statements) { erase(s.destination); if (s.value) { erase(s.value.place); for (const o of s.value.operands || []) erase(o.place); } }
      if (b.call) { erase(b.call.destination); b.call.arguments.forEach(o => erase(o.place)); }
    }
  });
  const request = externalRoot().request; request.model.sinks[0].at = { call: 'root#bb1@call', port: 'argument', index: 0 };
  return { raw, request, expected: sibling !== 0 || branch, partial: false };
}
function mixedReference(clean = false, field = false) {
  const target = field ? place(5, 0) : clean ? place(5) : place(1);
  const raw = graph(fn('root', 0, [call('bb0', 'input', [], place(1), 'bb1'),
    call('bb1', null, [op(2)], place(3), 'bb2', [
      ...(field ? [assign(place(5), aggregate(clean ? constant() : op(1), constant()))] : clean ? [assign(place(5), use(constant()))] : []),
      assign(place(2), ref(target))], { callee_targets: ['clear'], callback_unknown: true }),
    // This known zero-argument gate prevents an early unresolved-only sink visit.
    call('bb2', 'gate', [], place(4), 'bb3'),
    call('bb3', 'sensitive', [{ kind: 'copy', place: target }], place(0), 'bb4'), block('bb4')]),
  fn('clear', 1, [block('bb0', [assign(place(1, 'deref'), use(constant())), assign(place(0), use(constant()))])]),
  fn('gate', 0, [block('bb0', [assign(place(0), use(constant()))])]), read(), sensitive());
  const request = model(); request.model.sinks[0].at.call = 'root#bb3@call';
  return { raw, request, expected: !clean, partial: true, possibleSink: !clean };
}
function reviewCases() {
  const cases = [];
  const add = (name, item) => cases.push({ name, ...item });
  for (const field of [0, 1]) for (const boundary of [false, true]) add('VF-2 nested ' + field + '/' + boundary, nested(field, boundary));
  for (const clean of [false, true]) for (const field of [false, true]) add('VF-3 retarget ' + clean + '/' + field, { ...retarget(clean, field), possibleSink: !clean });
  add('VF-4 current invocation', reusedProof());
  for (const mutate of [f => { f.value_facts.blocks[1].call.arguments[0].place.projection.push({ kind: 'field', index: 999 }); },
    f => { f.value_facts.locals[2].shape = { kind: 'scalar' }; }, f => { f.value_facts.blocks[1].call.arguments[0].place.projection[0].shape = { kind: 'reference', target: { kind: 'scalar' } }; }]) {
    const item = nested(); update(item.raw, 'root', mutate); add('VF-5 malformed field', { ...item, expected: false, partial: true });
  }
  const unshaped = nested(); update(unshaped.raw, 'root', f => { f.value_facts.locals.forEach(l => delete l.shape); }); add('VF-5 missing layout', { ...unshaped, expected: true, partial: true, possibleSink: true });
  const wrongBase = simple(); update(wrongBase, 'root', f => { f.value_facts.blocks[1].call.arguments[0].place.projection = [{ kind: 'deref' }]; }); add('VF-5 wrong dereference base', { raw: wrongBase, request: model(), expected: false, partial: true });
  for (const fields of [[999], [0, 999]]) { const item = nested(); item.request.model.sinks[0].at.fields = fields; add('VF-5 endpoint bounds', { ...item, expected: false, partial: true }); }
  const invalidSource = nested(); invalidSource.request.model.sources[0].at.fields = [0]; add('VF-5 invalid source endpoint', { ...invalidSource, expected: false, partial: true });
  const validEndpoint = fieldOverwrite(1, true); validEndpoint.request.model.sources[0].at.fields = [0, 1]; add('VF-5 valid nested source endpoint', validEndpoint);
  for (const change of [f => { delete f.blocks[1].successors; }, f => { f.blocks[1].successors[0].kind = 'alien'; }, f => { delete f.blocks[1].kind; }, f => { f.blocks[1].successors[0].action = 'continue'; }, f => { f.blocks[1].successors[0].target = 'missing'; }, f => { f.blocks[1].successors = []; }, f => { f.blocks[1].successors[0] = { kind: 'normal', action: 'alien' }; }]) {
    const raw = simple(); update(raw, 'root', change); add('VF-6 reachable malformed control', { raw, request: model(), expected: false, partial: true });
  }
  const disconnected = simple(); const other = fn('disconnected', 0, [block('bb0')]); const of = JSON.parse(other.attributes.flow); delete of.blocks[0].successors; other.attributes.flow = JSON.stringify(of); disconnected.nodes.push(other);
  add('VF-6 disconnected malformed body', { raw: disconnected, request: model(), expected: true, partial: false });
  for (const reverse of [false, true]) { const rows = [{ index: 0, targets: ['clean'] }, { index: 0, targets: ['identity'] }]; if (reverse) rows.reverse(); add('VF-7 duplicate ' + reverse, { ...callbackCase(rows), partial: true }); }
  add('VF-7 duplicate forwarded', { ...callbackCase([{ index: 0, parameter: 0 }, { index: 0, parameter: 0 }], true), partial: true });
  add('VF-7 known and unknown', { ...callbackCase([{ index: 0, targets: ['identity'] }, { index: 0, targets: [], unknown: true }]), partial: true });
  add('VF-7 invalid target identity', { ...callbackCase([{ index: 0, targets: ['missing-body'] }]), partial: true });
  add('VF-7 out-of-range forwarded parameter', { ...callbackCase([{ index: 0, parameter: 99 }], true), partial: true });
  add('VF-7 out-of-range binding', { ...callbackCase([{ index: 99, targets: ['identity'] }]), partial: true });
  add('VF-7 valid forwarded', { ...callbackCase([{ index: 0, parameter: 0 }], true), partial: false });
  for (const target of ['clean', 'identity']) for (const flag of [0, 'false', null, false, true]) {
    const malformed = typeof flag !== 'boolean', partial = malformed || flag === true, expected = partial || target === 'identity';
    add('VF-7 certainty ' + target + '/' + JSON.stringify(flag), { ...callbackCase([{ index: 0, targets: [target], unknown: flag }]), expected, partial, possibleSink: malformed });
    add('VF-7 forwarded certainty ' + target + '/' + JSON.stringify(flag), { ...callbackCase([{ index: 0, parameter: 0, unknown: flag }], true, target), expected, partial, possibleSink: malformed });
    const raw = callbackCase([{ index: 0, targets: [target] }]); update(raw.raw, 'invoke', f => { f.blocks[0].callback_unknown = flag; });
    add('VF-7 raw certainty ' + target + '/' + JSON.stringify(flag), { ...raw, expected, partial, possibleSink: malformed || flag === true && target === 'clean' });
  }
  for (const sibling of [0, 1]) for (const mode of ['plain', 'nested', 'reference', 'summary', 'branch', 'reference-call']) add('VF-8 overwrite ' + mode + '/' + sibling, fieldOverwrite(sibling, mode === 'nested', mode === 'reference', mode === 'summary', mode === 'branch', mode === 'reference-call'));
  for (const sibling of [0, 1]) for (const byRef of [false, true]) add('VF-8 pending wrapper ' + byRef + '/' + sibling, wrapperOverwrite(sibling, byRef));
  add('VF-8 actual wrapper branch', wrapperOverwrite(0, false, true));
  const unwind = wrapperOverwrite(); update(unwind.raw, 'wrapper', f => {
    const cleanup = JSON.parse(fn('wrapper', 1, [block('bb2', [assign(place(0), use(op(1)))])]).attributes.flow);
    f.blocks[0].successors.push({ kind: 'unwind', target: 'bb2', label: 'cleanup' });
    f.blocks.push(...cleanup.blocks); f.value_facts.blocks.push(...cleanup.value_facts.blocks);
  }); add('VF-8 unwind separate from normal return', { ...unwind, partial: true });
  for (const source of [false, true]) add('VF-9 known plus unknown ' + source, unknownAlternative(source));
  add('VF-9 multiple known', unknownAlternative(true, true));
  for (const clean of [false, true]) for (const field of [false, true]) add('VF-9 reference with gate ' + clean + '/' + field, mixedReference(clean, field));
  for (const owner of [null, '', 'compiler:other']) { const raw = simple(); update(raw, 'relay', f => { f.function_id = owner; }); add('VF-11 compiler owner ' + owner, { raw, request: model(), expected: true, partial: true }); }
  for (const owner of [null, '']) { const raw = simple(); raw.nodes.find(n => n.id === 'flow:relay').attributes.function_id = owner; add('VF-11 missing raw compiler ' + owner, { raw, request: model(), expected: true, partial: true }); }
  const conflicting = simple(); conflicting.nodes.find(n => n.id === 'flow:relay').attributes.function_id = 'compiler:other'; add('VF-11 conflicting raw claim', { raw: conflicting, request: model(), expected: true, partial: true });
  const duplicate = simple(); duplicate.nodes.push({ ...structuredClone(duplicate.nodes[1]), id: 'duplicate-body' }); add('VF-11 duplicate owner', { raw: duplicate, request: model(), expected: true, partial: true });
  add('VF-13 parameter declaration', { ...externalRoot(), expected: true, partial: false });
  add('VF-14 reference edge', referenceWrite());
  return cases;
}
module.exports = { ...module.exports, nested, retarget, reusedProof, fieldOverwrite, callbackCase, unknownAlternative, referenceWrite, wrapperOverwrite, mixedReference, reviewCases };
function cardinality(kind = 'references', count = 512) {
  let raw, request;
  if (kind === 'references') {
    raw = graph(fn('root', 0, [call('bb0', 'summary_only', [], place(0), 'bb1'), block('bb1')]));
    update(raw, 'root', f => {
      f.value_facts.parameter_locals = Array.from({ length: count }, (_, i) => i + 1);
      f.value_facts.locals = Array.from({ length: count + 1 }, (_, i) => ({ local: i, type: 'fixture', kind: i ? 'reference' : 'value', role: i ? 'parameter' : 'return', shape: i ? { kind: 'reference', target: { kind: 'scalar' } } : { kind: 'scalar' } }));
      f.value_facts.blocks[0].call.arguments = Array.from({ length: count }, (_, i) => op(i + 1));
    });
    request = externalRoot().request; request.model.summaries = [{ id: 'bounded-reference-summary', version: 1, call: 'root#bb0@call', kind: 'transfer', from: [0], to: 'result', referenceEffects: 'none' }];
  } else {
    raw = graph(fn('root', 1, [block('bb0', [assign(place(2), aggregate(...Array.from({ length: count }, () => op(1)))), assign(place(0), use(op(2, 0)))]) ]));
    request = externalRoot().request;
    request.model.sources = Array.from({ length: 64 }, (_, i) => ({ id: 'source-' + i, at: { procedure: 'root', port: 'parameter', index: 0 } }));
  }
  return { raw, request };
}
module.exports.cardinality = cardinality;
