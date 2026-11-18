const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditGraph, markdown } = require('./audit-call-graph.cjs');

const block = (id, kind, extra = {}) => ({ id, kind, successors: [], ...extra });
const symbol = (id, name, kind = 'function', hasBody = 'true') => ({ id,
  label: name.split('::').pop(), source_file: 'src/lib.rs', source_location: 1,
  attributes: { kind, path: name, crate: 'x', has_body: hasBody } });
const flow = (id, name, owner, blocks, functionId) => ({ id,
  source_file: 'src/lib.rs', source_location: 1,
  attributes: { kind: 'flow_function', path: name, crate: 'x', symbol_id: owner,
    function_id: functionId,
    flow: JSON.stringify({ version: 1, function: name, function_id: functionId,
      entry: 'bb0', blocks }) } });
const edge = (source, target, relation) => ({ source, target, relation });
const fixture = () => ({ nodes: [
  symbol('leaf', 'x::leaf'), flow('fl', 'x::leaf', 'leaf', [block('bb0', 'return')], 'leaf-id'),
  symbol('missing', 'x::missing'), symbol('decl', 'x::declaration', 'method', 'false'),
  symbol('bad', 'x::bad'), { id: 'fb', attributes: { kind: 'flow_function',
    path: 'x::bad', symbol_id: 'bad', crate: 'x', flow: '{invalid' } },
  symbol('wrong', 'x::a::Widget::run', 'method'),
  flow('fw', 'x::a::Widget::run', 'wrong', [block('bb0', 'return')], 'wrong-id'),
  symbol('caller', 'x::caller'), flow('fc', 'x::caller', 'caller', [block('bb0', 'call', {
    callee: 'x::a::Widget::run', callee_id: 'other-id',
    source_file: 'src/lib.rs', source_location: 11
  })], 'caller-id'),
  symbol('reference', 'x::reference'),
  flow('fr', 'x::reference', 'reference', [block('bb0', 'return')], 'reference-id'),
  symbol('register', 'x::register'), flow('freg', 'x::register', 'register', [block('bb0', 'call', {
    callee: 'dep::register', callee_id: 'external-id',
    callback_references: [{ kind: 'trait_method_reference', index: 0,
      receiver_type: 'x::Receiver', trait: 'x::Trait', trait_id: 'trait-id',
      targets: [{ function: 'x::reference', function_id: 'reference-id' }] }]
  })], 'register-id'),
  symbol('loop', 'x::loop'), flow('floop', 'x::loop', 'loop', [block('bb0', 'goto', {
    successors: [{ kind: 'normal', target: 'bb0' }] })], 'loop-id'),
  symbol('trait', 'x::Trait', 'trait'), symbol('trait_method', 'x::Trait::run', 'method', 'false'),
  symbol('impl', 'x::Thing', 'impl'), symbol('impl_method', 'x::Thing::run', 'method'),
  flow('fim', 'x::<x::Thing as x::Trait>::run', 'impl_method', [block('bb0', 'return')], 'impl-id'),
  symbol('dispatch_caller', 'x::dispatch_caller'),
  flow('fdc', 'x::dispatch_caller', 'dispatch_caller', [block('bb0', 'call', {
    callee: 'x::Trait::run', source_file: 'src/lib.rs', source_location: 17
  })], 'dispatch-id')
], edges: [
  edge('caller', 'wrong', 'calls'),
  edge('trait', 'trait_method', 'has_method'), edge('impl', 'trait', 'implements'),
  edge('impl', 'impl_method', 'has_method'), edge('impl_method', 'fim', 'has_flow')
] });

test('final Function graph isolation preserves body and identity evidence', () => {
  const report = auditGraph(fixture(), { path: '/fixture/graph.json', sha256: 'fixture-sha' });
  const byPath = new Map(report.isolated.map(item => [item.path, item]));
  assert.equal(report.counts.totalCallables, 12);
  assert.equal(report.counts.isolated, 7);
  assert.equal(report.counts.overviewLoopOnlyIsolated, 1);
  assert.equal(byPath.get('x::leaf').reason, 'captured_leaf_no_captured_caller');
  assert.equal(byPath.get('x::leaf').body.blockKinds.return, 1);
  assert.equal(byPath.get('x::missing').reason, 'missing_body');
  assert.equal(byPath.get('x::declaration').reason, 'declaration_no_body');
  assert.equal(byPath.get('x::Trait::run').reason, 'declaration_no_body');
  assert.equal(byPath.get('x::bad').reason, 'invalid_or_uncataloged_body');
  assert(report.catalogErrors.some(error => error.includes('Invalid flow JSON')));
  assert.equal(byPath.get('x::a::Widget::run').reason, 'identity_conflict_text_evidence');
  assert.equal(byPath.get('x::a::Widget::run').evidence.incomingConflictingText.count, 1);
  assert.equal(byPath.get('x::a::Widget::run').evidence.incomingId.count, 0);
  assert.equal(byPath.get('x::a::Widget::run').evidence.rawCallEdges.count, 1);
  assert.equal(byPath.get('x::loop').reason, 'control_flow_loop_only');
  assert.equal(byPath.get('x::loop').evidence.overviewLoopEdges, 1);
  assert(!byPath.has('x::reference')); // A reference is an edge, but not a captured call.
  assert(!byPath.has('x::Thing::run')); // Model-only possible dispatch is visible.
  assert.equal(report.counts.noCapturedCaller, 11);
  assert.equal(report.counts.noCapturedDirectMirCaller, 12);
  assert(markdown(report).includes('not necessarily unused'));
});

test('object-valued flow metadata supplies the same authoritative ID as string flow', () => {
  const targetFlow = flow('ft', 'x::target', 'target', [block('bb0', 'return')], 'target-id');
  targetFlow.attributes.flow = JSON.parse(targetFlow.attributes.flow);
  delete targetFlow.attributes.function_id;
  const graph = { nodes: [symbol('target', 'x::target'), targetFlow,
    symbol('caller', 'x::caller'), flow('fc', 'x::caller', 'caller', [
      block('bb0', 'call', { callee: 'x::target', callee_id: 'target-id' })
    ], 'caller-id')], edges: [] };
  const report = auditGraph(graph, { path: '/fixture/object.json', sha256: 'fixture-sha' });
  assert.equal(report.counts.totalCallables, 2);
  assert.equal(report.counts.isolated, 0);
  assert.equal(report.counts.noCapturedCaller, 1);
  assert.equal(report.counts.noCapturedDirectMirCaller, 1);
});

test('const and module relations remain context, not callable projection gaps', () => {
  const graph = { nodes: [symbol('target', 'x::target'),
    flow('ft', 'x::target', 'target', [block('bb0', 'return')], 'target-id'),
    symbol('constant', 'x::TABLE', 'const', 'false'),
    symbol('module', 'x', 'module', 'false')], edges: [
    edge('constant', 'target', 'calls'), edge('module', 'target', 'member_calls')
  ] };
  const report = auditGraph(graph, { path: '/fixture/context.json', sha256: 'fixture-sha' });
  assert.equal(report.counts.isolated, 1);
  assert.equal(report.isolated[0].reason, 'noncallable_caller_context');
  assert.deepEqual(report.isolated[0].evidence.rawCallEdges.sample.map(item => item.sourceKind),
    ['const', 'module']);
  assert(report.isolated[0].evidence.rawCallEdges.sample.every(item =>
    item.targetKind === 'function' && !item.sourceProjectedCallable && item.targetProjectedCallable));
  assert.equal(report.reasonCounts.callable_raw_edge_discrepancy, undefined);
});

test('CLI output is deterministic and source occurrences stay lexical', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'call-graph-audit-'));
  try {
    const graphPath = path.join(temp, 'graph.json'), source = path.join(temp, 'source');
    const out = path.join(temp, 'out');
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'lib.rs'),
      'fn leaf() {}\n// leaf\nlet _ = leaf;\nleaf\nleaf\nleaf\nleaf\n');
    fs.writeFileSync(graphPath, JSON.stringify(fixture()));
    const args = ['scripts/audit-call-graph.cjs', '--graph', graphPath,
      '--source-root', source, '--out', out];
    execFileSync(process.execPath, args, { cwd: path.resolve(__dirname, '..') });
    const firstJson = fs.readFileSync(path.join(out, 'call-graph-audit.json'));
    const firstMd = fs.readFileSync(path.join(out, 'call-graph-audit.md'));
    execFileSync(process.execPath, args, { cwd: path.resolve(__dirname, '..') });
    assert.deepEqual(fs.readFileSync(path.join(out, 'call-graph-audit.json')), firstJson);
    assert.deepEqual(fs.readFileSync(path.join(out, 'call-graph-audit.md')), firstMd);
    const report = JSON.parse(firstJson);
    const leaf = report.isolated.find(item => item.path === 'x::leaf');
    assert.equal(leaf.evidence.lexicalIdentifier.count, 7);
    assert.equal(leaf.evidence.lexicalIdentifier.sample.length, 5);
    assert.equal(leaf.evidence.lexicalIdentifier.omitted, 2);
    assert.equal(leaf.evidence.lexicalIdentifier.sample[0].file, 'src/lib.rs');
    assert(report.scope.sourceScan.scope.includes('comments'));
    assert(report.scope.sourceScan.treeSha256);
    assert.equal(report.input.sha256.length, 64);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
