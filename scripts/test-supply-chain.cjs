const test = require('node:test');
const assert = require('node:assert/strict');
const SupplyChain = require('../src/supply-chain.js');

function crate(id, name, packageId, extra = {}) {
  return { id, attributes: { kind: 'crate', crate: name,
    ...(packageId ? { package_id: packageId } : {}), ...extra } };
}
function symbol(id, crateName, packageId) {
  return { id, attributes: { kind: 'function', crate: crateName,
    ...(packageId ? { package_id: packageId } : {}) } };
}
test('same name and multiple versions keep distinct exact package identities', () => {
  const a = 'registry+example#serde@1.0.0', b = 'registry+example#serde@2.0.0';
  const index = SupplyChain.build({ nodes: [
    crate('one', 'serde', a, { version: '1.0.0', workspace_member: 'false' }),
    crate('two', 'serde', b, { version: '2.0.0', workspace_member: 'false' }),
    symbol('f1', 'serde', a), symbol('f2', 'serde', b), symbol('unowned', 'serde')], edges: [] });
  assert.deepEqual(index.packages.map(p => p.id), [a, b]);
  assert.deepEqual(index.ownership('f1'), { status: 'exact', packageIds: [a] });
  assert.deepEqual(index.ownership('unowned'), { status: 'unknown', packageIds: [] });
  assert.deepEqual(index.scope({ packageIds: [a] }).nodeIds, ['f1', 'one']);
});
test('legacy workspace normalization is explicit and ambiguous workspace collisions survive', () => {
  const index = SupplyChain.build({ nodes: [crate('legacy', 'my-crate'),
    crate('modern', 'my_crate', 'workspace-id', { workspace_member: 'true' }),
    crate('external', 'my_crate', 'external-id', { workspace_member: 'false' }),
    symbol('unknown', 'my_crate')], edges: [] });
  assert.deepEqual(index.ownership('unknown'), { status: 'ambiguous',
    packageIds: ['legacy:workspace:my_crate', 'workspace-id'] });
  const scoped = index.scope({ packageIds: ['workspace-id'] });
  assert.deepEqual(scoped.coverage.ambiguousNodeIds, ['unknown']);
  assert(index.matches('unknown', ['workspace-id']));
  assert(!index.matches('unknown', ['external-id']));
  assert.equal(index.coverage.catalogIncomplete, true);
});
test('normalized Cargo name collision never assigns a merged symbol to one workspace package', () => {
  const index = SupplyChain.build({ nodes: [
    crate('one', 'foo-bar', 'workspace-one', { workspace_member: 'true' }),
    crate('two', 'foo_bar', 'workspace-two', { workspace_member: 'true' }),
    crate('three', 'FOO', 'workspace-three', { workspace_member: 'true' }),
    crate('four', 'foo', 'workspace-four', { workspace_member: 'true' }),
    symbol('merged', 'foo-bar'), symbol('case-merged', 'Foo'),
    symbol('verified', 'foo-bar', 'workspace-one')], edges: [] });
  assert.deepEqual(index.ownership('merged'), { status: 'ambiguous',
    packageIds: ['workspace-one', 'workspace-two'] });
  assert.deepEqual(index.ownership('verified'), { status: 'exact', packageIds: ['workspace-one'] });
  assert.deepEqual(index.ownership('case-merged'),
    { status: 'ambiguous', packageIds: ['workspace-four', 'workspace-three'] });
});
test('typed dependency closure handles cycles and direct stops after one hop', () => {
  const nodes = [crate('a', 'a', 'A', { workspace_member: 'true',
    supply_chain_dependencies: JSON.stringify([{ package_id: 'B', name: 'b', kind: 'build', target: 'unix' }]) }),
    crate('b', 'b', 'B', { workspace_member: 'false',
      supply_chain_dependencies: JSON.stringify([{ package_id: 'C', name: 'c', kind: 'normal', target: null }]) }),
    crate('c', 'c', 'C', { workspace_member: 'false',
      supply_chain_dependencies: JSON.stringify([{ package_id: 'A', name: 'a', kind: 'dev', target: null }]) })];
  const index = SupplyChain.build({ nodes, edges: [] });
  assert.deepEqual(index.scope({ packageIds: ['A'], dependencies: 'direct' }).packageIds, ['A', 'B']);
  assert.deepEqual(index.scope({ packageIds: ['A'], dependencies: 'transitive' }).packageIds, ['A', 'B', 'C']);
  assert(index.dependencies.some(d => d.source === 'A' && d.target === 'B' && d.kind === 'build' &&
    d.name === 'b' && d.targetCondition === 'unix'));
});
test('projected native and boundary ownership uses exact IDs without path inference', () => {
  const index = SupplyChain.build({ nodes: [crate('pkg', 'ssl', 'pkg-ssl', { workspace_member: 'false' })], edges: [] });
  const projected = [
    { id: 'native-open', kind: 'function', package_id: 'pkg-ssl', language: 'native' },
    { id: 'native-boundary', kind: 'boundary', package_id: 'pkg-ssl', language: 'native' },
    { id: 'system-open', kind: 'boundary', crate: 'ssl', language: 'native' }
  ];
  assert.deepEqual(index.ownership(projected[0]), { status: 'exact', packageIds: ['pkg-ssl'] });
  assert.deepEqual(index.select(projected, ['pkg-ssl']).map(n => n.id),
    ['native-open', 'native-boundary']);
  assert.deepEqual(index.ownership(projected[2]), { status: 'unknown', packageIds: [] });
  assert(!index.scope({ packageIds: ['pkg-ssl'] }).nodeIds.includes('native-boundary'));
});
test('FFI declaration association scopes a boundary without claiming implementation ownership', () => {
  const index = SupplyChain.build({ nodes: [crate('libc-pkg', 'libc', 'pkg-libc', {
    workspace_member: 'false' }), { id: 'ffi-open', label: 'open', attributes: {
    kind: 'function', language: 'native', body_status: 'unavailable',
    native_boundary_kind: 'ffi_symbol', native_declaration_package_id: 'pkg-libc',
    package_role: 'ffi_declaration' } }], edges: [] });
  assert.deepEqual(index.ownership('ffi-open'), { status: 'unknown', packageIds: [] });
  assert.deepEqual(index.association('ffi-open'), {
    role: 'ffi_declaration', status: 'exact', packageIds: ['pkg-libc'] });
  assert(index.scope({ packageIds: ['pkg-libc'] }).nodeIds.includes('ffi-open'));
  assert(index.matches({ id: 'projected-ffi', native_boundary_kind: 'ffi_symbol',
    native_declaration_package_id: 'pkg-libc' }, ['pkg-libc']));
});
test('package capture summaries distinguish imported zero from missing or invalid coverage', () => {
  const policy = 'workspace_and_compiler_reachable_dependencies';
  const index = SupplyChain.build({ nodes: [
    crate('captured', 'dep', 'pkg-dep', { workspace_member: 'false',
      capture_summary: JSON.stringify({ policy, scopes: [{ capture_scope: 'runtime_dependency',
        captured: 3, validated: 2, imported: 0 }] }) }),
    crate('missing', 'other', 'pkg-other', { workspace_member: 'false' }),
    crate('invalid', 'bad', 'pkg-bad', { workspace_member: 'false',
      capture_summary: JSON.stringify({ policy, scopes: [{ capture_scope: 'workspace',
        captured: 1, validated: 2, imported: 0 }] }) })
  ], edges: [] });
  const byId = new Map(index.packages.map(p => [p.id, p]));
  assert.equal(byId.get('pkg-dep').captureSummary.scopes[0].imported, 0);
  assert.equal(byId.get('pkg-dep').captureStatus, 'captured');
  assert.equal(byId.get('pkg-other').captureSummary, null);
  assert.equal(byId.get('pkg-other').captureStatus, 'unknown');
  assert.equal(byId.get('pkg-bad').captureStatus, 'invalid');
  assert.equal(index.coverage.invalidCaptureSummaries, 1);
});
