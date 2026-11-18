'use strict';
const edge = (target, kind = 'normal', label = 'next', extra = {}) => ({ target, kind, label, ...extra });
const block = (id, kind = 'return', successors = [], extra = {}) => ({ id, kind, label: kind + ' ' + id,
  source_file: '/fixture/src/lib.rs', source_location: 12, successors, ...extra });
const call = (id, callee, normal, extra = {}, unwind) => block(id, 'call',
  [...(normal ? [edge(normal, 'normal', 'return')] : []), ...(unwind ? [edge(unwind, 'unwind', 'cleanup')] : [])], { callee, ...extra });
function fn(id, blocks, attrs = {}) {
  return { id: 'flow:' + id, source_file: '/fixture/src/lib.rs', source_location: 3,
    attributes: { kind: 'flow_function', path: id, package_id: 'fixture-pkg', unit_key: 'fixture-unit', ...attrs,
      flow: JSON.stringify({ version: 1, function: id, function_id: 'compiler:' + id, entry: 'bb0', blocks }) } };
}
const graph = (...nodes) => ({ nodes, edges: [] });
const proc = id => ({ kind: 'procedure', id });
const node = id => ({ kind: 'node', id });
const site = id => ({ kind: 'call', id });
function siblings() {
  return graph(fn('root', [call('bb0', 'source', 'bb1'), call('bb1', 'sink', 'bb2'), block('bb2')]),
    fn('source', [block('bb0')]), fn('sink', [block('bb0')]));
}
function exclusive() {
  return graph(fn('root', [block('bb0', 'branch', [edge('bb1', 'normal', 'flag = true', { predicate: 'flag' }),
    edge('bb2', 'normal', 'flag = false')], { condition: 'flag' }),
    call('bb1', 'source', 'bb3'), call('bb2', 'sink', 'bb3'), block('bb3')]),
    fn('source', [block('bb0')]), fn('sink', [block('bb0')]));
}
function recursive() {
  return graph(fn('root', [call('bb0', 'recur', 'bb1'), block('bb1')]),
    fn('recur', [block('bb0', 'branch', [edge('bb1', 'normal', 'again'), edge('bb2', 'normal', 'done')]),
      call('bb1', 'recur', 'bb2'), block('bb2')]));
}
function callbacks() {
  return graph(fn('root', [call('bb0', 'forward', 'bb1', { callback_args: [{ index: 0, targets: ['source'] }] }),
    call('bb1', 'forward', 'bb2', { callback_args: [{ index: 0, targets: ['sink'] }] }), block('bb2')]),
    fn('forward', [call('bb0', 'invoke', 'bb1', { callback_args: [{ index: 0, parameter: 0 }] }), block('bb1')]),
    fn('invoke', [call('bb0', null, 'bb1', { callback_parameter: 0 }), block('bb1')]),
    fn('source', [block('bb0')]), fn('sink', [block('bb0')]));
}
function crossPackageSummary(sourceAttribute = 'source_absolute') {
  const root = fn('root', [call('bb0', 'callee', 'bb1', { source_file: 'src/lib.rs', source_location: 12 }),
    block('bb1', 'return', [], { source_file: 'src/lib.rs' })],
    { package_id: 'pkg-a', unit_key: 'unit-a', [sourceAttribute]: '/pkg-a/src/lib.rs' });
  const callee = fn('callee', [block('bb0', 'return', [], { source_file: 'src/lib.rs' })],
    { package_id: 'pkg-b', unit_key: 'unit-b', [sourceAttribute]: '/pkg-b/src/lib.rs' });
  root.source_file = callee.source_file = 'src/lib.rs';
  return graph(root, callee);
}
function repeatedHelpers(loop = false) {
  const blocks = loop ? [block('bb0', 'branch', [edge('bb1'), edge('bb4')]),
    call('bb1', 'helper', 'bb2'), call('bb2', 'helper', 'bb3'), call('bb3', 'source', 'bb0'),
    call('bb4', 'sink', 'bb5'), block('bb5')] :
    [call('bb0', 'helper', 'bb1'), call('bb1', 'helper', 'bb2'), call('bb2', 'sink', 'bb3'), block('bb3')];
  return graph(fn('root', blocks), fn('helper', [block('bb0')]),
    ...(loop ? [fn('source', [block('bb0')])] : []), fn('sink', [block('bb0')]));
}
module.exports = { edge, block, call, fn, graph, proc, node, site, siblings, exclusive, recursive, callbacks,
  crossPackageSummary, repeatedHelpers };
