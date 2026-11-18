const test = require('node:test');
const assert = require('node:assert/strict');
const CallGraph = require('../src/call-graph.js');
const ArchitectureOrganization = require('../src/architecture-organization.js');
const Flow = require('../src/execution-flow.js');

const symbol = (id, path, kind = 'function') => ({ id, label: path.split('::').pop(),
  source_file: 'src/lib.rs', source_location: 4,
  attributes: { kind, path, crate: 'x' } });
const flow = (id, path, owner, functionId) => ({ id, label: path.split('::').pop(),
  source_file: 'src/lib.rs', source_location: 8,
  attributes: { kind: 'flow_function', path, symbol_id: owner, crate: 'x',
    ...(functionId ? { function_id: functionId,
      flow: JSON.stringify({ version: 1, function: path, function_id: functionId,
        entry: 'bb0', blocks: [block('bb0', 'return')] }) } : {}) } });
const body = (path, blocks) => ({ path, blocks: new Map(blocks.map(b => [b.id, b])) });
const block = (id, kind, extra = {}) => ({ id, kind, successors: [], ...extra });
const graph = (nodes, edges = []) => ({ nodes, edges });
const index = (...functions) => ({ functions: new Map(functions.map(f => [f.path, f])) });

test('exact dependency identity keeps versions with the same human path separate', () => {
  const pathA = 'dep[pkg-a,unit-1,id-1]::dep::parse';
  const pathB = 'dep[pkg-b,unit-2,id-2]::dep::parse';
  const caller = flow('caller-flow', 'app::run', 'caller', 'caller-id');
  caller.attributes.package_id = 'app';
  caller.attributes.flow = JSON.stringify({ version: 1, function: 'app::run', function_id: 'caller-id',
    entry: 'bb0', blocks: [block('bb0', 'call', {
      callee: pathB, callee_id: 'same-compiler-id', callee_package_id: 'pkg-b' })] });
  const dependencies = [[pathA, 'pkg-a', 'fa'], [pathB, 'pkg-b', 'fb']].map(([path, pkg, id]) => ({
    id, label: 'parse', attributes: { kind: 'flow_function', path, display_path: 'dep::parse',
      package_id: pkg, function_id: 'same-compiler-id', flow: JSON.stringify({ version: 1,
        function: path, function_id: 'same-compiler-id', entry: 'bb0',
        blocks: [block('bb0', 'return')] }) } }));
  const data = graph([symbol('caller', 'app::run'), caller, ...dependencies]);
  const map = CallGraph.build(data, Flow.catalog(data));
  assert(map.edges.some(e => e.source === 'caller' && e.target === 'fb' && e.kind === 'call'));
  assert(!map.edges.some(e => e.source === 'caller' && e.target === 'fa'));
  assert.equal(map.nodes.find(n => n.id === 'fb').package_id, 'pkg-b');
  assert.equal(map.nodes.find(n => n.id === 'fb').display_path, 'dep::parse');
});

test('unit-namespaced paths select one body when a package reuses a compiler ID', () => {
  const paths = ['dep[pkg,host]::parse', 'dep[pkg,target]::parse'];
  const nodes = [symbol('caller', 'app::run'), flow('fc', 'app::run', 'caller', 'caller-id')];
  nodes[1].attributes.flow = JSON.stringify({ version: 1, function: 'app::run',
    function_id: 'caller-id', entry: 'bb0', blocks: [block('bb0', 'call', {
      callee: paths[1], callee_id: 'shared', callee_package_id: 'pkg' })] });
  paths.forEach((path, i) => nodes.push({ id: 'dep-' + i, attributes: {
    kind: 'flow_function', path, display_path: 'dep::parse', package_id: 'pkg',
    function_id: 'shared', flow: JSON.stringify({ version: 1, function: path,
      function_id: 'shared', entry: 'bb0', blocks: [block('bb0', 'return')] }) } }));
  const data = graph(nodes);
  const map = CallGraph.build(data, Flow.catalog(data));
  assert(map.edges.some(e => e.source === 'caller' && e.target === 'dep-1' && e.kind === 'call'));
  assert(!map.edges.some(e => e.source === 'caller' && e.target === 'dep-0'));
});

test('native calls require exact target IDs and keep unresolved symbols opaque', () => {
  const caller = flow('fc', 'app::run', 'caller', 'caller-id');
  caller.attributes.flow = JSON.stringify({ version: 1, function: 'app::run', function_id: 'caller-id',
    entry: 'bb0', blocks: [block('bb0', 'call', { callee: 'ffi::open',
      native_call: { symbol: 'open', abi: 'C', libraries: ['ssl'] }, native_target_ids: ['native-open'],
      callee_package_id: 'pkg-ssl' }), block('bb1', 'call', { callee: 'ffi::unknown',
      native_call: { symbol: 'unknown', abi: 'C', libraries: ['ssl'] },
      callee_package_id: 'pkg-ssl' })] });
  const native = { id: 'native-open', label: 'open', attributes: { kind: 'function', language: 'native',
    native_symbol: 'open', native_artifact: '/libssl.a', native_library_id: 'libssl',
    package_id: 'pkg-ssl', body_status: 'native_disassembly',
    native_direct_calls: JSON.stringify([{ address: '10', symbol: 'close', target_id: 'native-close',
      evidence: 'disassembly', source_artifact: '/libssl.a' }]),
    native_call_diagnostics: JSON.stringify([{ address: '20', reason: 'indirect_or_unknown_target' }]) } };
  const data = graph([symbol('caller', 'app::run'), caller, native]);
  const map = CallGraph.build(data, Flow.catalog(data));
  assert(map.edges.some(e => e.target === 'native-open' && e.kind === 'native_call' &&
    e.callsites[0].native_call.symbol === 'open'));
  assert(map.nodes.some(n => n.kind === 'boundary' && n.native_symbol === 'unknown' &&
    n.package_id === 'pkg-ssl'));
  assert(!map.edges.some(e => e.target === 'native-open' && e.kind === 'call'));
  assert.equal(JSON.parse(map.nodes.find(n => n.id === 'native-open').native_direct_calls)[0].target_id,
    'native-close');
  assert.equal(JSON.parse(map.nodes.find(n => n.id === 'native-open').native_call_diagnostics)[0].reason,
    'indirect_or_unknown_target');
});

test('same native symbol in two artifacts keeps distinct canonical node paths', () => {
  const data = graph([
    { id: 'native::lib-a::helper', label: 'helper', attributes: { kind: 'function',
      language: 'native', native_symbol: 'helper', native_artifact: '/a/lib.a',
      body_status: 'native_disassembly' } },
    { id: 'native::lib-b::helper', label: 'helper', attributes: { kind: 'function',
      language: 'native', native_symbol: 'helper', native_artifact: '/b/lib.a',
      body_status: 'native_disassembly' } }
  ]);
  const map = CallGraph.build(data, index());
  assert.deepEqual(map.nodes.map(n => n.path).sort(),
    ['native::lib-a::helper', 'native::lib-b::helper']);
  assert.deepEqual(map.nodes.map(n => n.display_path), ['helper', 'helper']);
  assert.equal(new Map(map.aliases).has('helper'), false);
});

test('ordinary MIR aliases rich identity; closure keeps its own existing flow ID', () => {
  const data = graph([symbol('a', 'x::A'), symbol('b', 'x::B', 'method'),
    symbol('isolated', 'x::Isolated'), flow('fa', 'x::A', 'a'),
    flow('fa_alias', 'bin::x::A', 'a'), flow('closure', 'x::A::{closure#0}', 'a')],
  [{ source: 'a', target: 'b', relation: 'calls' }]);
  const map = CallGraph.layout(CallGraph.build(data, index(
    body('x::A', [block('bb0', 'return')]),
    body('bin::x::A', [block('bb0', 'return')]),
    body('x::A::{closure#0}', [block('bb0', 'return')]))));
  assert.equal(map.nodes.length, 4);
  assert.equal(map.counts.architectureCallables, 3);
  assert.equal(map.counts.closures, 1);
  assert.equal(map.counts.flowIdentities, 3);
  const aliases = new Map(map.aliases);
  assert.equal(aliases.get('x::A'), 'a');
  assert.equal(aliases.get('bin::x::A'), 'a');
  assert.equal(aliases.get('x::A::{closure#0}'), 'closure');
  assert.ok(map.nodes.some(n => n.id === 'isolated'));
  assert.ok(map.edges.some(e => e.source === 'a' && e.target === 'b' && e.kind === 'call'));
  assert.equal(map.counts.disconnected, 2);
  assert.ok(map.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('known callback invocation and fnptr target differ from external candidate', () => {
  const data = graph([symbol('entry', 'x::Entry'), symbol('wrapper', 'x::Wrapper'),
    symbol('callback', 'x::Callback'), symbol('alternate', 'x::Alternate'),
    flow('fe', 'x::Entry', 'entry'), flow('fw', 'x::Wrapper', 'wrapper'),
    flow('fc', 'x::Callback', 'callback'), flow('falt', 'x::Alternate', 'alternate')]);
  const map = CallGraph.build(data, index(
    body('x::Entry', [
      block('bb0', 'call', { callee: 'x::Wrapper',
        callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] }),
      block('bb1', 'call', { callee_targets: ['x::Alternate'] }),
      block('bb2', 'call', { callee: 'external::register',
        callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] })]),
    body('x::Wrapper', [block('bb0', 'call', { callback_parameter: 0 })]),
    body('x::Callback', [block('bb0', 'return')]),
    body('x::Alternate', [block('bb0', 'return')])
  ));
  assert.ok(map.edges.some(e => e.source === 'entry' && e.target === 'wrapper' && e.kind === 'call'));
  assert.ok(map.edges.some(e => e.source === 'entry' && e.target === 'alternate' && e.kind === 'indirect'));
  assert.ok(map.edges.some(e => e.source === 'wrapper' && e.target === 'callback' && e.kind === 'callback'));
  assert.ok(map.edges.some(e => e.source === 'entry' && e.target === 'callback' && e.kind === 'candidate'));
  assert.ok(!map.edges.some(e => e.source === 'entry' && e.target === 'callback' && e.kind === 'callback'));
});

test('forwarded callback bindings reach invoked formal without claiming registration', () => {
  const data = graph([symbol('entry', 'x::Entry'), symbol('forward', 'x::Forward'),
    symbol('invoke', 'x::Invoke'), symbol('cb', 'x::Callback'),
    flow('fe', 'x::Entry', 'entry'), flow('ff', 'x::Forward', 'forward'),
    flow('fi', 'x::Invoke', 'invoke'), flow('fc', 'x::Callback', 'cb')]);
  const map = CallGraph.build(data, index(
    body('x::Entry', [block('bb0', 'call', { callee: 'x::Forward',
      callback_args: [{ index: 0, targets: ['x::Callback'], parameter: null }] })]),
    body('x::Forward', [block('bb0', 'call', { callee: 'x::Invoke',
      callback_args: [{ index: 0, targets: [], parameter: 0 }] })]),
    body('x::Invoke', [block('bb0', 'call', { callback_parameter: 0 })]),
    body('x::Callback', [block('bb0', 'return')])
  ));
  assert.ok(map.edges.some(e => e.source === 'invoke' && e.target === 'cb' && e.kind === 'callback'));
  assert.ok(!map.edges.some(e => e.kind === 'candidate'));
});

test('MIR loop self-edge and recursive call survive, including disconnected nodes', () => {
  const data = graph([symbol('loop', 'x::Loop'), symbol('recur', 'x::Recur'),
    symbol('island', 'x::Island'), flow('fl', 'x::Loop', 'loop'),
    flow('fr', 'x::Recur', 'recur')]);
  const map = CallGraph.layout(CallGraph.build(data, index(
    body('x::Loop', [block('bb0', 'goto', { successors: [{ target: 'bb1' }] }),
      block('bb1', 'goto', { successors: [{ target: 'bb0' }] })]),
    body('x::Recur', [block('bb0', 'call', { callee: 'x::Recur' })])
  )));
  assert.ok(map.edges.some(e => e.source === 'loop' && e.target === 'loop' && e.kind === 'loop'));
  assert.ok(map.edges.some(e => e.source === 'recur' && e.target === 'recur' && e.kind === 'recursion'));
  assert.ok(map.nodes.some(n => n.id === 'island'));
  assert.equal(map.counts.disconnected, 1);
});

test('architecture-only graph still shows every callable and direct call', () => {
  const map = CallGraph.layout(CallGraph.build(graph([
    symbol('a', 'x::A'), symbol('b', 'x::B'), symbol('c', 'x::C')],
    [{ source: 'a', target: 'b', relation: 'member_calls' }]), index()));
  assert.equal(map.nodes.length, 3);
  assert.equal(map.counts.flowIdentities, 0);
  assert.equal(map.counts.disconnected, 1);
  assert.ok(map.edges.some(e => e.source === 'a' && e.target === 'b'));
});

test('callback invocation forwards its own callback argument to the bound target', () => {
  const names = ['entry', 'apply', 'consume', 'leaf'];
  const data = graph(names.flatMap(name => [symbol(name, `x::${name}`), flow(`f_${name}`, `x::${name}`, name)]));
  const map = CallGraph.build(data, index(
    body('x::entry', [block('bb0', 'call', { callee: 'x::apply', callback_args: [
      { index: 0, targets: ['x::consume'], parameter: null },
      { index: 1, targets: ['x::leaf'], parameter: null }] })]),
    body('x::apply', [block('bb0', 'call', { callback_parameter: 0, callback_args: [
      { index: 0, targets: [], parameter: 1 }] })]),
    body('x::consume', [block('bb0', 'call', { callback_parameter: 0 })]),
    body('x::leaf', [block('bb0', 'return')])
  ));
  assert.ok(map.edges.some(e => e.source === 'apply' && e.target === 'consume' && e.kind === 'callback'));
  assert.ok(map.edges.some(e => e.source === 'consume' && e.target === 'leaf' && e.kind === 'callback'));
  assert.ok(!map.edges.some(e => e.kind === 'candidate'));
});

test('raw closure identity remains selectable when its MIR body is unavailable', () => {
  const map = CallGraph.build(graph([symbol('a', 'x::A'), flow('fa', 'x::A', 'a'),
    flow('missing', 'x::A::{closure#1}', 'a')]), index());
  assert.equal(map.nodes.length, 2);
  assert.equal(map.counts.flowIdentities, 2);
  assert.equal(new Map(map.aliases).get('x::A::{closure#1}'), 'missing');
});

test('named uncaptured call creates a directed body boundary with callsite provenance', () => {
  const data = graph([symbol('caller', 'x::Caller'), flow('fc', 'x::Caller', 'caller')]);
  const map = CallGraph.build(data, index(body('x::Caller', [
    block('bb0', 'call', { callee: 'dep::Widget::run', callee_id: 'opaque-target',
      source_file: 'src/lib.rs', source_location: 23 })
  ])));
  const boundary = map.nodes.find(n => n.kind === 'boundary');
  assert.ok(boundary);
  assert.equal(boundary.source_file, null);
  assert.deepEqual(boundary.flowPaths, []);
  assert.deepEqual(boundary.calleePaths, ['dep::Widget::run']);
  assert.equal(map.counts.architectureCallables, 1);
  assert.equal(map.counts.boundaries, 1);
  assert.ok(map.edges.some(e => e.source === 'caller' && e.target === boundary.id &&
    e.kind === 'boundary' && e.callsites[0].id === 'x::Caller#bb0@call'));
});

test('one opaque callee identity retains all aliases and callsites deterministically', () => {
  const data = graph([symbol('a', 'x::A'), symbol('b', 'x::B'),
    flow('fa', 'x::A', 'a'), flow('fb', 'x::B', 'b')]);
  const map = CallGraph.build(data, index(
    body('x::A', [block('bb0', 'call', { callee: 'dep::Z::run', callee_id: 'same-id' })]),
    body('x::B', [block('bb0', 'call', { callee: 'dep::A::run', callee_id: 'same-id' })])));
  const boundary = map.nodes.find(n => n.kind === 'boundary');
  assert.equal(map.counts.boundaries, 1);
  assert.deepEqual(boundary.calleePaths, ['dep::A::run', 'dep::Z::run']);
  assert.equal(boundary.canonicalPath, 'dep::A::run');
  assert.equal(map.edges.filter(e => e.target === boundary.id && e.kind === 'boundary').length, 2);
  assert.equal(new Map(map.boundaryCallsites).size, 2);
});

test('authoritative callee ID selects matching body and mismatched ID stays at boundary', () => {
  const data = graph([symbol('caller', 'x::Caller'), symbol('right', 'x::Right'),
    symbol('wrong', 'x::Wrong'), flow('fc', 'x::Caller', 'caller'),
    flow('fr', 'x::Right', 'right', 'right-id'), flow('fw', 'x::Wrong', 'wrong', 'wrong-id')]);
  const map = CallGraph.build(data, index(
    body('x::Caller', [
      block('bb0', 'call', { callee: 'x::Wrong', callee_id: 'right-id' }),
      block('bb1', 'call', { callee: 'x::Wrong', callee_id: 'missing-id' })]),
    body('x::Right', [block('bb0', 'return')]), body('x::Wrong', [block('bb0', 'return')])));
  const boundary = map.nodes.find(n => n.kind === 'boundary');
  assert.ok(map.edges.some(e => e.source === 'caller' && e.target === 'right' && e.kind === 'call'));
  assert.ok(!map.edges.some(e => e.source === 'caller' && e.target === 'wrong' && e.kind === 'call'));
  assert.ok(map.edges.some(e => e.source === 'caller' && e.target === boundary.id && e.kind === 'boundary'));
  assert.equal(new Map(map.boundaryCallsites).has('x::Caller#bb0@call'), false);
  assert.equal(new Map(map.boundaryCallsites).get('x::Caller#bb1@call'), boundary.id);
});

test('compiler-proven trait capabilities attach as references by method identity', () => {
  const data = graph([
    symbol('caller', 'x::Caller'),
    symbol('accept', 'x::a::Selected::accept', 'method'),
    symbol('finish', 'x::a::Selected::finish', 'method'),
    symbol('unrelated', 'x::b::Selected::accept', 'method'),
    flow('fc', 'x::Caller', 'caller'),
    flow('fa', 'x::a::Selected::accept', 'accept', 'accept-id'),
    flow('ff', 'x::a::Selected::finish', 'finish', 'finish-id'),
    flow('fu', 'x::b::Selected::accept', 'unrelated', 'unrelated-id')
  ]);
  const references = [{ kind: 'trait_method_reference', index: 1,
    receiver_type: 'x::a::Selected', trait: 'x::Handle', trait_id: 'trait-id',
    targets: [
      { function: 'x::renamed::Selected::accept', function_id: 'accept-id' },
      { function: 'x::a::Selected::finish', function_id: 'finish-id' },
      { function: 'x::b::Selected::accept', function_id: 'missing-id' }
    ] }];
  const map = CallGraph.build(data, index(
    body('x::Caller', [block('bb0', 'call', {
      callee: 'dep::Deserializer::run', callee_id: 'external-id',
      source_file: 'src/lib.rs', source_location: 23,
      callback_references: references
    })]),
    body('x::a::Selected::accept', [block('bb0', 'return')]),
    body('x::a::Selected::finish', [block('bb0', 'return')]),
    body('x::b::Selected::accept', [block('bb0', 'return')])
  ));
  const candidate = map.edges.filter(e => e.source === 'caller' && e.kind === 'candidate');
  assert.deepEqual(candidate.map(e => e.target).sort(), ['accept', 'finish']);
  assert(candidate.every(e => e.referenceKind === 'trait_method_reference'));
  assert(candidate.every(e => e.callsites[0].id === 'x::Caller#bb0@call' &&
    e.callsites[0].source_location === 23 &&
    e.callsites[0].reference.index === 1 &&
    e.callsites[0].reference.receiver_type === 'x::a::Selected' &&
    e.callsites[0].reference.trait_id === 'trait-id'));
  assert.equal(candidate.find(e => e.target === 'accept').callsites[0].reference.target_function_id,
    'accept-id');
  assert(!map.edges.some(e => e.source === 'caller' && e.target === 'unrelated'));
  const boundary = map.nodes.find(n => n.kind === 'boundary');
  assert(boundary);
  assert(map.edges.some(e => e.source === 'caller' && e.target === boundary.id && e.kind === 'boundary'));
  assert(!map.edges.some(e => e.source === boundary.id && e.kind === 'candidate'));
});

test('legacy trait reference path is fully qualified and ID conflicts never use its text', () => {
  const data = graph([symbol('caller', 'x::Caller'), symbol('one', 'x::a::Item::run', 'method'),
    symbol('other', 'x::b::Item::run', 'method'), flow('fc', 'x::Caller', 'caller'),
    flow('f1', 'x::a::Item::run', 'one', 'one-id'),
    flow('f2', 'x::b::Item::run', 'other', 'other-id')]);
  const map = CallGraph.build(data, index(
    body('x::Caller', [block('bb0', 'call', { callee: 'dep::invoke', callback_references: [
      { kind: 'trait_method_reference', index: 0, receiver_type: 'x::Item',
        trait: 'x::Trait', trait_id: 'trait-id', targets: [
          { function: 'x::a::Item::run' },
          { function: 'x::b::Item::run', function_id: 'one-id' },
          { function: 'x::b::Item::run', function_id: 'absent-id' }
        ] }
    ] })]), body('x::a::Item::run', [block('bb0', 'return')]),
    body('x::b::Item::run', [block('bb0', 'return')])));
  const candidate = map.edges.filter(e => e.kind === 'candidate');
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].target, 'one');
  assert.equal(candidate[0].callsites.length, 2);
  assert(!map.edges.some(e => e.target === 'other' && e.kind === 'candidate'));
});

test('ambiguous compiler identity does not select one trait method body', () => {
  const data = graph([symbol('caller', 'x::Caller'), symbol('a', 'x::a::Item::run', 'method'),
    symbol('b', 'x::b::Item::run', 'method'), flow('fc', 'x::Caller', 'caller'),
    flow('fa', 'x::a::Item::run', 'a', 'shared-id'),
    flow('fb', 'x::b::Item::run', 'b', 'shared-id')]);
  const map = CallGraph.build(data, index(
    body('x::Caller', [block('bb0', 'call', { callee: 'dep::invoke', callback_references: [
      { kind: 'trait_method_reference', index: 0, receiver_type: 'x::Item',
        trait: 'x::Trait', trait_id: 'trait-id', targets: [
          { function: 'x::a::Item::run', function_id: 'shared-id' }
        ] }
    ] })]), body('x::a::Item::run', [block('bb0', 'return')]),
    body('x::b::Item::run', [block('bb0', 'return')])));
  assert(!map.edges.some(e => e.kind === 'candidate'));
});

test('Fn registration and trait capability to one body retain separate reference provenance', () => {
  const data = graph([symbol('caller', 'x::Caller'), symbol('method', 'x::Method'),
    flow('fc', 'x::Caller', 'caller'), flow('fm', 'x::Method', 'method', 'method-id')]);
  const map = CallGraph.build(data, index(
    body('x::Caller', [block('bb0', 'call', {
      callee: 'dep::register', callee_id: 'external-id',
      source_file: 'src/lib.rs', source_location: 31,
      callback_args: [{ index: 0, targets: ['x::Method'], parameter: null }],
      callback_references: [{ kind: 'trait_method_reference', index: 1,
        receiver_type: 'x::Method', trait: 'x::Trait', trait_id: 'trait-id',
        targets: [{ function: 'x::Method', function_id: 'method-id' }] }]
    })]), body('x::Method', [block('bb0', 'return')])));
  const candidates = map.edges.filter(e => e.source === 'caller' && e.target === 'method' &&
    e.kind === 'candidate');
  assert.deepEqual(candidates.map(e => e.referenceKind).sort(),
    ['callback_registration', 'trait_method_reference']);
  assert(candidates.every(e => e.callsites[0].id === 'x::Caller#bb0@call' &&
    e.callsites[0].source_file === 'src/lib.rs' && e.callsites[0].source_location === 31));
  assert.equal(candidates.find(e => e.referenceKind === 'callback_registration')
    .callsites[0].reference.index, 0);
  assert.equal(candidates.find(e => e.referenceKind === 'trait_method_reference')
    .callsites[0].reference.trait_id, 'trait-id');
  const projection = ArchitectureOrganization.project(map, { calls: [] });
  const references = projection.edges.filter(e => e.source === 'caller' && e.target === 'method');
  assert.deepEqual(references.map(e => e.referenceKind).sort(),
    ['callback_registration', 'trait_method_reference']);
  assert(references.every(e => e.kind === 'reference' && !e.execution &&
    e.callsites[0].id === 'x::Caller#bb0@call'));
  const active = ArchitectureOrganization.activeProjection({ nodes: [], calls: [] }, {
    status: 'impossible', activeNodeIds: [], activeCallTargets: []
  }, projection.aliases, projection.boundaryCallsites);
  assert.equal(active.edgePairs.size, 0);
});

test('empty and singleton maps have finite radial geometry', () => {
  const empty = CallGraph.layout(CallGraph.build(graph([]), index()));
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.rings.length, 0);
  assert.ok(Number.isFinite(empty.width) && Number.isFinite(empty.height));
  const one = CallGraph.layout(CallGraph.build(graph([symbol('only', 'x::Only')]), index()));
  assert.equal(one.nodes.length, 1);
  assert.equal(one.counts.disconnected, 1);
  assert.equal(one.rings.at(-1).label, 'Disconnected');
  assert.ok(Number.isFinite(one.nodes[0].x) && Number.isFinite(one.nodes[0].y));
});

test('directed call depth, rootless cycle, and outer boundary rings retain every link', () => {
  const names = ['entry', 'a', 'b', 'cycleA', 'cycleB', 'unknown', 'island'];
  const data = graph(names.map(name => symbol(name, `x::${name}`)), [
    { source: 'entry', target: 'a', relation: 'calls' },
    { source: 'entry', target: 'unknown', relation: 'calls' },
    { source: 'a', target: 'b', relation: 'calls' },
    { source: 'cycleA', target: 'cycleB', relation: 'calls' },
    { source: 'cycleB', target: 'cycleA', relation: 'calls' }
  ]);
  const built = CallGraph.build(data, index(body('x::unknown', [
    block('bb0', 'call', { callee: 'external::missing' })])));
  built.nodes.find(n => n.id === 'unknown').unknownCalls = 1;
  const map = CallGraph.layout(built);
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  assert.equal(map.edges.length, 6);
  assert.equal(map.counts.boundaries, 1);
  assert.equal(byId.get('entry').callDepth, 0);
  assert.equal(byId.get('a').callDepth, 1);
  assert.equal(byId.get('b').callDepth, 2);
  assert.ok(byId.get('cycleA').callDepth !== null && byId.get('cycleB').callDepth !== null);
  assert.equal(map.rings.find(r => r.label === 'Has unknown callees').level, byId.get('unknown').ring);
  assert.equal(map.rings.find(r => r.label === 'Disconnected').level, byId.get('island').ring);
  assert.equal(map.nodes.length, names.length + 1);
});

test('deep and dense crate sectors preserve unique polar points and all callables', () => {
  const names = Array.from({ length: 180 }, (_, i) => `n${i}`);
  const nodes = names.map((name, i) => ({ ...symbol(name, `x::${name}`),
    attributes: { kind: 'function', path: `x::${name}`, crate: i % 3 ? 'x' : 'y' } }));
  const edges = names.slice(1).map((name, i) => ({ source: i < 12 ? names[i] : 'n12',
    target: name, relation: 'calls' }));
  const map = CallGraph.layout(CallGraph.build(graph(nodes, edges), index()));
  assert.equal(map.nodes.length, names.length);
  assert.equal(map.edges.length, edges.length);
  assert.equal(map.groups.length, 2);
  assert.ok(map.groups.every(g => g.endAngle > g.startAngle));
  assert.ok(map.nodes.some(n => n.callDepth >= 8 && n.ring === 6));
  assert.ok(map.rings.some(r => r.label === 'Call depth 6+'));
  assert.ok(map.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) &&
    Number.isFinite(n.radius) && Number.isFinite(n.angle)));
  assert.equal(new Set(map.nodes.map(n => `${n.x.toFixed(7)},${n.y.toFixed(7)}`)).size, names.length);
  assert.ok(map.rings.length >= 7);
});
