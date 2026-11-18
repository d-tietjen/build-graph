const assert = require('node:assert/strict');
const { unify, project, activeProjection, treeLayout } = require('../src/architecture-organization.js');

const overview = {
  nodes: ['entry', 'selected', 'branch', 'sibling', 'callback', 'dispatch', 'registered']
    .map((id, i) => ({ id, path: id, x: i * 10, y: i * 5 })),
  aliases: ['entry', 'selected', 'branch', 'sibling', 'callback', 'dispatch', 'registered']
    .map((id) => [id, id]),
  edges: [
    { source: 'entry', target: 'selected', kind: 'call' },
    { source: 'entry', target: 'sibling', kind: 'call' },
    { source: 'selected', target: 'branch', kind: 'call' },
    { source: 'selected', target: 'registered', kind: 'candidate' }
  ]
};
const model = { calls: [
  { procedure: 'selected', targets: [], possibleTargets: ['callback'] },
  { procedure: 'selected', targets: ['dispatch'], dispatchTargets: ['dispatch'] }
] };
const graph = project(overview, model);

const nativeProjection = project({ nodes: [
  { id: 'rust', path: 'app::run', package_id: 'pkg-app' },
  { id: 'native', path: 'open', language: 'native', package_id: 'pkg-ssl', body_status: 'native_disassembly' },
  { id: 'missing', path: 'unknown', kind: 'boundary', language: 'native', boundaryKind: 'native_symbol' }
], aliases: [['app::run', 'rust']], boundaryCallsites: [['app::run#bb1@call', 'missing']], edges: [
  { source: 'rust', target: 'native', kind: 'native_call', native_call: { symbol: 'open', abi: 'C', libraries: ['ssl'] } },
  { source: 'rust', target: 'missing', kind: 'boundary', boundaryKind: 'native_symbol',
    callsites: [{ id: 'app::run#bb1@call' }] }
] }, { calls: [] });
assert(nativeProjection.edges.some(e => e.target === 'native' && e.execution && e.bodyUnavailable &&
  e.native_call.symbol === 'open'));
assert(nativeProjection.edges.some(e => e.target === 'missing' && e.uncertain &&
  e.boundaryKind === 'native_symbol'));
const unresolvedNative = project({ nodes: [
  { id: 'native-caller', path: 'native-caller', language: 'native' },
  { id: 'native-unknown', path: 'native-unknown', language: 'native',
    native_boundary_kind: 'indirect_call', body_status: 'unavailable' }
], aliases: [], edges: [{ source: 'native-caller', target: 'native-unknown', kind: 'native_call' }] },
{ calls: [] });
assert(unresolvedNative.edges.some(e => e.target === 'native-unknown' && e.uncertain &&
  e.bodyUnavailable && e.boundaryKind === 'indirect_call'));

assert.deepEqual([...graph.related('selected')].sort(),
  ['entry', 'selected', 'branch', 'callback', 'dispatch', 'registered'].sort());
assert(!graph.related('selected').has('sibling'));
assert(!graph.related('entry').has('registered'));
assert(graph.edges.some((edge) => edge.target === 'callback' && edge.kind === 'callback' && edge.uncertain));
assert(graph.edges.some((edge) => edge.target === 'dispatch' && edge.kind === 'dispatch' && edge.uncertain));
assert(graph.edges.some((edge) => edge.target === 'registered' && edge.kind === 'reference' &&
  edge.execution === false));
assert.deepEqual([...graph.refine(['entry', 'selected'])].sort(),
  ['entry', 'selected', 'branch', 'callback', 'dispatch'].sort());

// Sibling pins can share a caller while belonging to mutually exclusive CFG
// branches. The full model's impossible result must not light that caller.
const exclusive = activeProjection({ nodes: [
  { id: 'entry#branch', procedure: 'entry' },
  { id: 'left#start', procedure: 'selected' },
  { id: 'right#start', procedure: 'sibling' }
], calls: [] }, {
  status: 'impossible', activeNodeIds: [], activeCallTargets: []
}, graph.aliases);
assert.equal(exclusive.nodeIds.size, 0);
assert.equal(exclusive.edgePairs.size, 0);

// A raw literal edge to a different identified body cannot survive the
// compiler identity resolution as an executable architecture link.
const identityOverview = { nodes: [
  { id: 'caller', path: 'x::caller' }, { id: 'wrong', path: 'x::wrong' },
  { id: 'right', path: 'x::right' }
], aliases: [['x::caller', 'caller'], ['x::wrong', 'wrong'], ['x::right', 'right']],
edges: [{ source: 'caller', target: 'wrong', kind: 'call' }] };
const identityModel = { calls: [{ procedure: 'x::caller', directKey: 'x::wrong',
  calleeId: 'right-id', targets: ['x::right'], resolvedTargets: ['x::right'],
  possibleTargets: [], dispatchTargets: [], unknown: false }] };
const identityProjection = project(identityOverview, identityModel);
assert(!identityProjection.edges.some((edge) => edge.source === 'caller' &&
  edge.target === 'wrong' && edge.execution));
assert(identityProjection.edges.some((edge) => edge.source === 'caller' &&
  edge.target === 'right' && edge.execution));
const mismatchProjection = project(identityOverview, { calls: [{
  procedure: 'x::caller', directKey: 'x::wrong', calleeId: 'missing-id',
  targets: [], resolvedTargets: [], unknown: true
}] });
assert(!mismatchProjection.edges.some((edge) => edge.source === 'caller' &&
  edge.target === 'wrong' && edge.execution));

const boundaryOverview = {
  nodes: [{ id: 'entry', path: 'x::Entry' }, { id: 'boundary-a', kind: 'boundary' },
    { id: 'boundary-b', kind: 'boundary' }, { id: 'registered', path: 'x::Registered' }],
  aliases: [['x::Entry', 'entry'], ['x::Registered', 'registered']],
  boundaryCallsites: [['x::Entry#bb0@call', 'boundary-a'],
    ['x::Entry#bb1@call', 'boundary-b']],
  edges: [
    { source: 'entry', target: 'boundary-a', kind: 'boundary',
      callsites: [{ id: 'x::Entry#bb0@call', source_file: 'src/lib.rs', source_location: 10 }] },
    { source: 'entry', target: 'boundary-b', kind: 'boundary',
      callsites: [{ id: 'x::Entry#bb1@call', source_file: 'src/lib.rs', source_location: 11 }] },
    { source: 'entry', target: 'registered', kind: 'candidate' }
  ]
};
const boundaryModel = { nodes: [
  { id: 'x::Entry#bb0', procedure: 'x::Entry' },
  { id: 'x::Entry#bb1', procedure: 'x::Entry' }
], calls: [
  { id: 'x::Entry#bb0@call', from: 'x::Entry#bb0', procedure: 'x::Entry', targets: [] },
  { id: 'x::Entry#bb1@call', from: 'x::Entry#bb1', procedure: 'x::Entry', targets: [] }
] };
const boundaryProjection = project(boundaryOverview, boundaryModel);
assert(boundaryProjection.edges.some(e => e.kind === 'boundary' && e.execution &&
  e.bodyUnavailable && e.callsites[0].id === 'x::Entry#bb0@call'));
assert(boundaryProjection.edges.some(e => e.kind === 'reference' && !e.execution));
const activeBoundary = activeProjection(boundaryModel, {
  status: 'indeterminate', activeNodeIds: ['x::Entry#bb0'],
  activeCallTargets: []
}, boundaryProjection.aliases, boundaryProjection.boundaryCallsites);
assert.deepEqual([...activeBoundary.boundaryContextNodeIds], ['boundary-a']);
assert.deepEqual([...activeBoundary.boundaryContextEdgePairs], ['entry\tboundary-a']);
assert(!activeBoundary.nodeIds.has('boundary-a'));
assert(!activeBoundary.edgePairs.has('entry\tboundary-a'));
assert(!activeBoundary.boundaryContextNodeIds.has('boundary-b'));
const provenBoundary = activeProjection(boundaryModel, {
  status: 'indeterminate', activeNodeIds: ['x::Entry#bb0'],
  activeUnknownCallIds: ['x::Entry#bb0@call'], activeCallTargets: []
}, boundaryProjection.aliases, boundaryProjection.boundaryCallsites);
assert(provenBoundary.nodeIds.has('boundary-a'));
assert(provenBoundary.edgePairs.has('entry\tboundary-a'));
const recoveredProjection = project(boundaryOverview, { calls: [{
  id: 'x::Entry#bb0@call', from: 'x::Entry#bb0', procedure: 'x::Entry',
  directKey: 'x::Display', resolvedTargets: ['x::Actual'], unavailableTargets: [], targets: ['x::Actual']
}] });
assert(!recoveredProjection.byId.has('boundary-a'));
assert(!recoveredProjection.edges.some(e => e.target === 'boundary-a'));
assert(!recoveredProjection.boundaryCallsites.has('x::Entry#bb0@call'));

const traitOverview = {
  nodes: [{ id: 'caller', path: 'x::Caller' }, { id: 'method', path: 'x::Selected::run' },
    { id: 'boundary', kind: 'boundary' }],
  aliases: [['x::Caller', 'caller'], ['x::Selected::run', 'method']],
  boundaryCallsites: [['x::Caller#bb0@call', 'boundary']],
  edges: [
    { source: 'caller', target: 'boundary', kind: 'boundary',
      callsites: [{ id: 'x::Caller#bb0@call' }] },
    { source: 'caller', target: 'method', kind: 'candidate',
      referenceKind: 'trait_method_reference', callsites: [{
        id: 'x::Caller#bb0@call', source_file: 'src/lib.rs', source_location: 23,
        reference: { kind: 'trait_method_reference', index: 1,
          receiver_type: 'x::Selected', trait_id: 'trait-id',
          target_function_id: 'method-id' }
      }] }
  ]
};
const traitModel = { nodes: [{ id: 'x::Caller#bb0', procedure: 'x::Caller' }],
  calls: [{ id: 'x::Caller#bb0@call', from: 'x::Caller#bb0',
    procedure: 'x::Caller', targets: [] }] };
const traitProjection = project(traitOverview, traitModel);
const traitEdge = traitProjection.edges.find(e => e.target === 'method');
assert.equal(traitEdge.kind, 'reference');
assert.equal(traitEdge.referenceKind, 'trait_method_reference');
assert.equal(traitEdge.execution, false);
assert.equal(traitEdge.callsites[0].reference.target_function_id, 'method-id');
assert(traitProjection.related('method').has('caller'));
assert(!traitProjection.related('method').has('boundary'));
const traitImpossible = activeProjection(traitModel, {
  status: 'impossible', activeNodeIds: [], activeCallTargets: []
}, traitProjection.aliases, traitProjection.boundaryCallsites);
assert.equal(traitImpossible.nodeIds.size, 0);
assert.equal(traitImpossible.edgePairs.size, 0);
assert.equal(traitImpossible.boundaryContextEdgePairs.size, 0);
const traitActive = activeProjection(traitModel, {
  status: 'indeterminate', activeNodeIds: ['x::Caller#bb0'], activeCallTargets: []
}, traitProjection.aliases, traitProjection.boundaryCallsites);
assert(!traitActive.edgePairs.has('caller\tmethod'));
assert(!traitActive.nodeIds.has('method'));
assert(traitActive.boundaryContextEdgePairs.has('caller\tboundary'));

const tree = { nodes: ['root-a', 'root-b', 'left', 'right', 'join', 'cycle-a', 'cycle-b',
  'self', 'boundary', ...Array.from({ length: 40 }, (_, i) => 'isolated-' + i)]
  .map(id => ({ id })), edges: [
  { source: 'root-a', target: 'left', execution: true },
  { source: 'root-a', target: 'right', execution: true },
  { source: 'root-b', target: 'right', execution: true },
  { source: 'left', target: 'join', execution: true },
  { source: 'right', target: 'join', execution: true },
  { source: 'join', target: 'cycle-a', execution: true },
  { source: 'cycle-a', target: 'cycle-b', execution: true },
  { source: 'cycle-b', target: 'cycle-a', execution: true },
  { source: 'self', target: 'self', execution: true },
  { source: 'join', target: 'boundary', execution: true },
  { source: 'root-a', target: 'self', execution: false }
] };
const originalTreeNodes = tree.nodes.map(n => n.id), originalTreeEdges = tree.edges.map(e => [e.source, e.target]);
const layout = treeLayout(tree, 8192);
assert.equal(layout.size, tree.nodes.length);
assert.deepEqual(tree.nodes.map(n => n.id), originalTreeNodes, 'tree layout does not mutate nodes');
assert.deepEqual(tree.edges.map(e => [e.source, e.target]), originalTreeEdges, 'tree layout does not mutate links');
for (const point of layout.values()) {
  assert(Number.isFinite(point.x) && point.x >= 0 && point.x <= 8192);
  assert(Number.isFinite(point.y) && point.y >= 0 && point.y <= 8192);
}
for (const [from, to] of [['root-a', 'left'], ['root-a', 'right'], ['root-b', 'right'],
  ['left', 'join'], ['right', 'join'], ['join', 'cycle-a'], ['join', 'boundary']])
  assert(layout.get(from).x < layout.get(to).x, `${from} ranks left of ${to}`);
assert.equal(layout.get('cycle-a').x, layout.get('cycle-b').x, 'cycle members share a layer');
assert(layout.get('self'), 'self-call node remains present');
assert(new Set(tree.nodes.filter(n => n.id.startsWith('isolated-')).map(n => layout.get(n.id).x)).size > 1,
  'disconnected nodes are packed across columns');
const reversed = treeLayout({ nodes: tree.nodes.slice().reverse(), edges: tree.edges.slice().reverse() }, 8192);
for (const node of tree.nodes) assert.deepEqual(reversed.get(node.id), layout.get(node.id),
  'tree positions do not depend on input order');

const fanoutLeaves = Array.from({ length: 320 }, (_, i) => `leaf-${String(i).padStart(3, '0')}`);
const fanout = { nodes: ['root', ...fanoutLeaves,
  ...Array.from({ length: 200 }, (_, i) => `detached-${i}`)].map(id => ({ id })),
edges: fanoutLeaves.map(target => ({ source: 'root', target, execution: true })) };
const fanoutLayout = treeLayout(fanout, 8192);
const fanoutX = fanoutLayout.get(fanoutLeaves[0]).x - fanoutLayout.get('root').x;
const leafY = fanoutLeaves.map(id => fanoutLayout.get(id).y);
const fanoutY = Math.max(...leafY) - Math.min(...leafY);
assert(fanoutX / fanoutY >= 1.4,
  'high-fanout component has useful horizontal extent rather than a vertical needle');
assert.equal(fanoutLayout.size, fanout.nodes.length, 'adaptive spacing keeps all nodes');
assert.equal(fanout.edges.length, fanoutLeaves.length, 'adaptive spacing keeps all projected edges');

const deepNodes = Array.from({ length: 12000 }, (_, i) => ({ id: `node-${String(i).padStart(5, '0')}` }));
const deepEdges = deepNodes.slice(1).map((node, i) => ({ source: deepNodes[i].id,
  target: node.id, execution: true }));
const deepLayout = treeLayout({ nodes: deepNodes, edges: deepEdges }, 8192);
assert.equal(deepLayout.size, deepNodes.length, 'deep chain uses iterative traversal');
assert(deepLayout.get(deepNodes[0].id).x < deepLayout.get(deepNodes.at(-1).id).x);

const baseUnion = { nodes: [
  { id: 'pkg', kind: 'package', label: 'app' },
  { id: 'dep', kind: 'package', label: 'dep' },
  { id: 'type', kind: 'struct', label: 'Record' },
  { id: 'field', kind: 'field', label: 'value' },
  { id: 'method', kind: 'method', label: 'run' },
  { id: 'caller', kind: 'function', label: 'caller', x: 30, y: 40 },
  { id: 'wrong', kind: 'function', label: 'wrong' },
  { id: 'right', kind: 'function', label: 'right' },
  { id: 'sysroot', kind: 'function', label: 'syscall', language: 'native',
    nativeBoundaryKind: 'unresolved_symbol', bodyStatus: 'unavailable' },
  { id: 'native-opaque', kind: 'function', label: 'open', language: 'native',
    nativeBoundaryKind: 'ffi_symbol', bodyStatus: 'unavailable' },
  { id: 'native-lib', kind: 'native_library', label: 'libc' }
], links: [
  { sid: 'pkg', tid: 'type', rel: 'contains' },
  { sid: 'type', tid: 'field', rel: 'has_field' },
  { sid: 'type', tid: 'method', rel: 'has_method' },
  { sid: 'pkg', tid: 'dep', rel: 'depends_on' },
  { sid: 'pkg', tid: 'native-lib', rel: 'links_native' },
  { sid: 'type', tid: 'method', rel: 'member_calls' },
  { sid: 'caller', tid: 'wrong', rel: 'calls' },
  { sid: 'caller', tid: 'right', rel: 'calls' },
  { sid: 'caller', tid: 'native-opaque', rel: 'native_calls' }
] };
const callableUnion = { nodes: [
  { id: 'caller', kind: 'function', flowPaths: ['app::caller'], bodyStatus: 'captured_mir', x: 500 },
  { id: 'right', kind: 'function', flowPaths: ['dep::right'], bodyStatus: 'captured_mir' },
  { id: 'native-opaque', kind: 'function', nativeBoundaryKind: 'ffi_symbol', bodyStatus: 'unavailable' },
  { id: 'closure', kind: 'function', label: 'closure', x: 610 },
  { id: 'boundary', kind: 'boundary', label: 'uncaptured', bodyUnavailable: true }
], links: [
  { sid: 'caller', tid: 'right', rel: 'calls', kind: 'call', cat: 'call',
    callsites: [{ id: 'app::caller#bb0@call' }] },
  { sid: 'caller', tid: 'native-opaque', rel: 'calls', kind: 'native_call',
    cat: 'native_call', uncertain: true, bodyUnavailable: true,
    callsites: [{ id: 'app::caller#bb1@call' }] },
  { sid: 'caller', tid: 'closure', rel: 'calls', kind: 'callback', cat: 'candidate', uncertain: true },
  { sid: 'caller', tid: 'boundary', rel: 'calls', kind: 'boundary', cat: 'boundary', uncertain: true },
  { sid: 'caller', tid: 'method', rel: 'references', kind: 'reference', cat: 'reference', uncertain: true }
] };
const united = unify(baseUnion, callableUnion);
const unionById = new Map(united.nodes.map(node => [node.id, node]));
assert.deepEqual(new Set(unionById.keys()), new Set(baseUnion.nodes.map(n => n.id).concat(['closure', 'boundary'])));
assert.equal(unionById.get('caller').x, 30, 'base coordinates survive metadata overlay');
assert.deepEqual(unionById.get('caller').flowPaths, ['app::caller']);
assert.equal(unionById.get('closure').x, 610, 'callable-only coordinates survive');
for (const relation of ['contains', 'has_field', 'has_method', 'depends_on', 'links_native'])
  assert(united.links.some(link => link.rel === relation), `${relation} structural evidence survives`);
assert(united.links.some(link => link.rel === 'contains' && link.execution === false));
assert(united.links.some(link => link.rel === 'depends_on' && link.execution === false));
assert(unionById.has('sysroot'), 'sysroot boundary remains in the one graph');
assert(united.links.some(link => link.sid === 'caller' && link.tid === 'wrong' &&
  link.rel === 'calls' && link.execution === false && link.cat === 'architecture_call'));
assert(united.links.some(link => link.rel === 'member_calls' && link.execution === false &&
  link.cat === 'aggregate_call'));
const direct = united.links.filter(link => link.sid === 'caller' && link.tid === 'right');
assert.equal(direct.length, 1, 'raw and projected direct call facts merge');
assert.equal(direct[0].rel, 'calls');
assert.equal(direct[0].kind, 'call');
assert.deepEqual(direct[0].callsites.map(site => site.id), ['app::caller#bb0@call']);
const native = united.links.filter(link => link.sid === 'caller' && link.tid === 'native-opaque');
assert.equal(native.length, 1, 'native call fact merges without losing opaque uncertainty');
assert.equal(native[0].rel, 'native_calls');
assert.equal(native[0].kind, 'native_call');
assert.equal(native[0].uncertain, true);
assert.equal(native[0].bodyUnavailable, true);
assert.deepEqual(native[0].callsites.map(site => site.id), ['app::caller#bb1@call']);
assert(united.links.some(link => link.tid === 'method' && link.kind === 'reference' &&
  link.execution === false));
assert(united.links.some(link => link.tid === 'boundary' && link.kind === 'boundary' &&
  link.uncertain));
assert.equal(baseUnion.nodes.find(n => n.id === 'caller').flowPaths, undefined,
  'unify does not mutate its inputs');
const reverseUnion = unify({ nodes: baseUnion.nodes.slice().reverse(), links: baseUnion.links.slice().reverse() },
  { nodes: callableUnion.nodes.slice().reverse(), links: callableUnion.links.slice().reverse() });
assert.deepEqual(reverseUnion.nodes.map(node => node.id), united.nodes.map(node => node.id));
assert.deepEqual(reverseUnion.links.map(link => [link.sid, link.tid, link.rel, link.kind || null]),
  united.links.map(link => [link.sid, link.tid, link.rel, link.kind || null]));

console.log('architecture organization projection: ok');
