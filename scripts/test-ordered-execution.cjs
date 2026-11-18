/* Ordered structural reachability: finite summaries, identities, evidence and replay. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Model = require('../src/execution-model.js');
const Evidence = require('../src/analysis-evidence.js');
const Analysis = require('../src/analysis-api.js');
const { edge, block, call, fn, graph, proc, node, site, siblings, exclusive, recursive, callbacks,
  crossPackageSummary, repeatedHelpers } = require('../tests/fixtures/ordered-execution/fixture-graphs.cjs');
const query = (raw, waypoints, extra = {}) => Analysis.create(raw).query({ op: 'orderedPath', function: 'root', waypoints, ...extra });
const matched = value => value.witness.steps.filter(s => s.progressAfter > s.progressBefore && s.kind !== 'summary' && s.kind !== 'summary-reference').map(s => ({ kind: s.kind, id: s.id }));

test('source/sink and sibling calls are ordered; old AND pins stay unordered', async () => {
  const raw = siblings(), api = Analysis.create(raw);
  const forward = await query(raw, [proc('source'), proc('sink')]);
  assert.equal(forward.status, 'exact'); assert.deepEqual(matched(forward), [proc('source'), proc('sink')]);
  const reverse = await query(raw, [proc('sink'), proc('source')]);
  assert.equal(reverse.status, 'impossible'); assert.equal(reverse.finding.definitiveNegative, true);
  const old = await api.query({ op: 'reachability', roots: 'root', pins: ['sink', 'source'] });
  assert.equal(old.status, 'exact'); assert.equal(old.pinsOrdered, false);
  assert.equal((await api.query({ op: 'capabilities' })).evidence.orderedPaths, true);
});

test('mutually exclusive branches do not concatenate into an ordered witness', async () => {
  const no = await query(exclusive(), [proc('source'), proc('sink')]);
  assert.equal(no.status, 'impossible'); assert.equal(no.witness, null);
  const yes = await query(exclusive(), [proc('source')]);
  assert.equal(yes.status, 'exact');
  const branch = yes.witness.steps.find(s => s.kind === 'edge' && s.label === 'flag = true');
  assert(branch); assert.equal(branch.predicate, 'flag'); assert.equal(branch.id, 'root#bb0->root#bb1:0');
  assert.equal(yes.semantics.branchFeasibilitySolved, false);
});

test('entry, node-arrival, and callsite events are exact and consume only one waypoint per event', async () => {
  const raw = siblings();
  const value = await query(raw, [proc('root'), node('root#bb0'), site('root#bb0@call'), proc('source')]);
  assert.equal(value.status, 'exact');
  assert.deepEqual(matched(value), [proc('root'), node('root#bb0'), site('root#bb0@call'), proc('source')]);
  assert.equal((await query(raw, [proc('source'), proc('source')])).status, 'impossible');
  assert.equal((await query(raw, [site('root#bb0@call'), site('root#bb0@call')])).status, 'impossible');
});

test('repeated waypoints traverse loop and recursion fixed points without permutation enumeration', async () => {
  const loop = graph(fn('root', [block('bb0', 'branch', [edge('bb1'), edge('bb2')]),
    call('bb1', 'source', 'bb0'), block('bb2')]), fn('source', [block('bb0')]));
  const value = await query(loop, [proc('source'), proc('source'), proc('source')]);
  assert.equal(value.status, 'exact'); assert.equal(matched(value).length, 3);
  assert(value.witness.summaries.some(s => /loop/.test(s.kind)));
  const recursion = await query(recursive(), [proc('recur'), proc('recur'), proc('recur')]);
  assert.equal(recursion.status, 'exact');
  assert(recursion.witness.summaries.some(s => /recursion/.test(s.kind)));
  assert(recursion.completion.states < 200);
  const unreachable = await query(recursive(), [proc('root'), node('root@unreachable')]);
  assert.equal(unreachable.status, 'impossible'); assert(unreachable.completion.complete);
});

test('nested forwarded callbacks remain bound to their exact caller', async () => {
  const raw = callbacks();
  const positive = await query(raw, [proc('source'), proc('sink')]);
  assert.equal(positive.status, 'exact'); assert.deepEqual(matched(positive), [proc('source'), proc('sink')]);
  assert.equal((await query(raw, [proc('sink'), proc('source')])).status, 'impossible');
  assert(positive.witness.steps.some(s => s.kind === 'call' && s.callback));
  const root = JSON.parse(raw.nodes[0].attributes.flow); root.blocks[0].callback_args[0].unknown = true;
  raw.nodes[0].attributes.flow = JSON.stringify(root);
  const unknown = await query(raw, [proc('source'), proc('sink')]);
  assert.equal(unknown.status, 'indeterminate'); assert.equal(unknown.finding.definitiveNegative, false);
});

test('multiple callers never exchange continuations of a shared callee', async () => {
  const raw = graph(fn('root', [block('bb0', 'branch', [edge('bb1'), edge('bb2')]),
    call('bb1', 'left', 'bb3'), call('bb2', 'right', 'bb3'), block('bb3')]),
    fn('left', [call('bb0', 'source', 'bb1'), call('bb1', 'shared', 'bb2'), block('bb2')]),
    fn('right', [call('bb0', 'shared', 'bb1'), call('bb1', 'sink', 'bb2'), block('bb2')]),
    fn('shared', [block('bb0')]), fn('source', [block('bb0')]), fn('sink', [block('bb0')]));
  assert.equal((await query(raw, [proc('source'), proc('sink')])).status, 'impossible');
  const route = await query(siblings(), [proc('source'), proc('sink')]);
  const continuation = route.witness.steps.find(s => s.kind === 'continuation');
  assert.equal(continuation.callsiteId, 'root#bb0@call');
  assert.equal(continuation.edgeId, 'root#bb0->root#bb1:0');
  assert.equal(continuation.target, 'source'); assert(continuation.summaryId);
});

test('call summaries resolve relative spans through the caller source owner in both evidence lists', async () => {
  for (const attribute of ['source_absolute', 'target_src_path']) {
    const raw = crossPackageSummary(attribute), value = await query(raw, [proc('callee')]);
    assert.equal(value.status, 'exact');
    const step = value.witness.steps.find(s => s.kind === 'summary' && s.target === 'callee'); assert(step);
    const summary = value.witness.summaries.find(s => s.id === step.summaryId); assert(summary);
    for (const item of [step, summary]) {
      assert.equal(item.procedure, 'callee'); assert.equal(item.identity.packageId, 'pkg-b');
      assert.equal(item.sourceProcedure, 'root'); assert.equal(item.sourceIdentity.packageId, 'pkg-a');
      assert.deepEqual(item.source, { source_file: 'src/lib.rs', source_location: 12, absolute_file: '/pkg-a/src/lib.rs' });
    }
    const entry = value.witness.steps.find(s => s.kind === 'procedure' && s.procedure === 'callee');
    assert.equal(entry.source.absolute_file, '/pkg-b/src/lib.rs'); assert.equal(entry.source.source_location, 3);
    delete raw.nodes[0].attributes[attribute];
    const relative = await query(raw, [proc('callee')]);
    assert.equal(relative.witness.steps.find(s => s.kind === 'summary').source.absolute_file, null);
    assert.equal(relative.witness.summaries.find(s => s.callsiteId === 'root#bb0@call').source.absolute_file, null);
  }
});

test('reused returning summaries retain the exact invoking callsite, target, outcome and continuation', async () => {
  for (const loop of [false, true]) {
    const value = await query(repeatedHelpers(loop), loop ? [proc('source'), proc('source'), proc('source'), proc('sink')] : [proc('sink')]);
    assert.equal(value.status, 'exact'); assert.equal(value.witness.truncated, false);
    const sites = loop ? ['root#bb1@call', 'root#bb2@call'] : ['root#bb0@call', 'root#bb1@call'];
    const calls = value.witness.steps.filter(s => s.kind === 'call' && sites.includes(s.callsiteId));
    assert.deepEqual(calls.map(s => s.callsiteId), Array(loop ? 3 : 1).fill(sites).flat());
    const refs = value.witness.steps.filter(s => s.kind === 'summary-reference' && s.target === 'helper');
    assert.equal(refs.length, loop ? 3 : 1);
    for (const ref of refs) {
      assert.equal(ref.callerProcedure, 'root'); assert.equal(ref.callsiteId, sites[1]); assert.equal(ref.procedure, 'helper');
      assert.equal(ref.outcome, 'normal');
      const at = value.witness.steps.indexOf(ref), continuation = value.witness.steps[at + 1];
      assert.equal(value.witness.steps[at - 1].callsiteId, ref.callsiteId);
      assert.equal(continuation.kind, 'continuation'); assert.equal(continuation.callsiteId, ref.callsiteId);
      assert.equal(continuation.target, ref.target); assert.equal(continuation.edgeId, ref.continuationId);
      assert.equal(continuation.summaryId, ref.summaryId); assert.equal(continuation.action, ref.outcome);
      assert(value.witness.steps.some(s => s.kind === 'continuation' && s.callsiteId === sites[0] && s.summaryId === ref.summaryId));
    }
  }
});

test('normal and unwind outcomes use only their matching continuation kinds', async () => {
  const raw = graph(fn('root', [call('bb0', 'callee', 'bb1', {}, 'bb2'), call('bb1', 'sink', 'bb3'),
    call('bb2', 'cleanup', 'bb3'), block('bb3')]), fn('callee', [block('bb0', 'unwind')]),
    fn('cleanup', [block('bb0')]), fn('sink', [block('bb0')]));
  const yes = await query(raw, [proc('callee'), proc('cleanup')]);
  assert.equal(yes.status, 'exact');
  assert(yes.witness.steps.some(s => s.kind === 'continuation' && s.action === 'unwind' && s.to === 'root#bb2'));
  assert.equal((await query(raw, [proc('callee'), proc('sink')])).status, 'impossible');
});

test('exclusions reject a guard through the target, with exclusion precedence and prefix semantics', async () => {
  const raw = siblings();
  assert.equal((await query(raw, [proc('sink')], { exclusions: [proc('source')] })).status, 'impossible');
  assert.equal((await query(raw, [proc('source')], { exclusions: [proc('source')] })).status, 'impossible');
  assert.equal((await query(raw, [proc('source')], { exclusions: [proc('sink')] })).status, 'exact');
  assert.equal((await query(raw, [proc('source')], { exclusions: [proc('root')] })).status, 'impossible');
  const target = await query(raw, [], { target: proc('sink'), exclusions: [site('root#bb0@call')] });
  assert.equal(target.status, 'impossible');
});

test('missing selections, body gaps, unsupported and malformed continuations stay unknown', async () => {
  const missing = await query(siblings(), [proc('not-captured')]);
  assert.equal(missing.status, 'indeterminate'); assert.equal(missing.witness, null);
  assert.equal(missing.queryCoverage.selections.items[0].status, 'unavailable');
  assert.equal((await query(siblings(), [proc('sink')], { exclusions: [node('missing#bb0')] })).status, 'indeterminate');
  const unknown = graph(fn('root', [call('bb0', 'missing', 'bb1'), call('bb1', 'sink', 'bb2'), block('bb2')]), fn('sink', [block('bb0')]));
  const result = await query(unknown, [proc('sink')]);
  assert.equal(result.status, 'indeterminate'); assert.equal(result.witness, null, 'unknown calls get no invented returns');
  for (const successor of [{ target: 'missing' }, { target: 'bb1', kind: 'unsupported' }, { target: 'bb1', action: 'unsupported' }]) {
    const raw = siblings(), root = JSON.parse(raw.nodes[0].attributes.flow);
    root.blocks[0].successors = [successor]; raw.nodes[0].attributes.flow = JSON.stringify(root);
    const value = await query(raw, [proc('source'), proc('sink')]);
    assert.equal(value.status, 'indeterminate'); assert.equal(value.finding.definitiveNegative, false);
  }
  const model = Model.build(siblings()); model.calls[0].normal = [model.calls[1].normal[0]];
  const malformed = await Model.analyzeOrdered(model, { root: 'root', waypoints: [proc('source'), proc('sink')] });
  assert.equal(malformed.status, 'indeterminate');
});

test('ambiguous callable identity is unknown; exact captured identities resolve and duplicate waypoints survive', async () => {
  const raw = siblings(); raw.nodes[1].attributes.display_path = raw.nodes[2].attributes.display_path = 'ambiguous';
  assert.equal((await query(raw, [proc('ambiguous')])).queryCoverage.selections.items[0].status, 'ambiguous');
  const value = await query(raw, [proc('flow:source'), proc('compiler:sink')], { function: 'flow:root' });
  assert.equal(value.status, 'exact'); assert.equal(value.resolved.root.id, 'root');
  const repeated = await query(recursive(), [proc('recur'), proc('recur')]);
  assert.equal(repeated.request.waypoints.length, 2); assert.equal(matched(repeated).length, 2);
});

test('root entry inventory uses the exact captured callable and no default entry is invented', async () => {
  const raw = siblings(), api = Analysis.create(raw);
  const entries = await api.query({ op: 'entrypoints', page: { limit: 100 } });
  const root = entries.entries.items.find(e => e.nodeId === 'flow:root'); assert(root);
  const request = { op: 'orderedPath', entryId: root.id, target: proc('sink') };
  assert.equal((await api.query(request)).status, 'exact');
  assert.equal((await api.query({ ...request, entryId: 'missing-entry' })).status, 'indeterminate');
  assert.equal((await api.query({ op: 'orderedPath', target: proc('sink') })).error.code, 'INVALID_REQUEST');
});

test('work/state/time/cancellation budgets cannot yield a definitive negative; evidence bounds do not change verdict', async () => {
  for (const budgets of [{ maxWork: 1 }, { maxStates: 1 }]) {
    const value = await query(recursive(), [proc('recur'), proc('recur')], { budgets });
    assert.equal(value.status, 'indeterminate'); assert(value.completion.budgetExceeded); assert.equal(value.finding.definitiveNegative, false);
  }
  const core = Evidence.create(recursive()), prepared = core.prepare({ op: 'orderedPath', function: 'root', waypoints: [proc('recur'), proc('recur')] });
  const cancelled = await core.analyzeOrdered(prepared, { cancelled: () => true });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.finding.definitiveNegative, false);
  let tick = 0;
  const timeout = await core.analyzeOrdered(prepared, { now: () => tick += 3000 });
  assert.equal(timeout.status, 'cancelled'); assert(timeout.completion.timedOut);
  const short = await query(siblings(), [proc('source'), proc('sink')], { budgets: { maxEvidence: 1 } });
  assert.equal(short.status, 'exact'); assert.equal(short.completion.evidenceComplete, false);
  assert(short.witness.steps.length <= 1); assert(short.witness.steps.some(s => s.kind === 'summary-reference'));
  for (const budgets of [{ maxWork: 0 }, { maxStates: 50001 }, { maxEvidence: 1001 }, { unknown: 1 }, []])
    assert.equal((await query(siblings(), [proc('sink')], { budgets })).error.code, 'INVALID_BUDGET');
});

test('ordered inputs are snapshotted, source linked, versioned and replay mismatch protected', async () => {
  const raw = siblings(), api = Analysis.create(raw), request = { op: 'orderedPath', function: 'root',
    waypoints: [proc('source'), proc('sink')], exclusions: [node('root@unreachable')], budgets: { maxEvidence: 100 } };
  const pending = api.query(request); request.waypoints.reverse(); request.exclusions[0].id = 'mutated'; request.budgets.maxEvidence = 1;
  const value = await pending; assert.equal(value.status, 'exact');
  assert.deepEqual(value.request.waypoints, [proc('source'), proc('sink')]);
  assert.equal(value.request.exclusions[0].id, 'root@unreachable');
  assert.equal(value.versions.orderedExecution, 'structural-ordered-v1');
  const replayed = await api.query({ op: 'replay', replay: value.replay });
  assert.equal(replayed.replayed, true); assert.deepEqual(replayed.witness, value.witness);
  const changed = structuredClone(raw); changed.nodes[0].source_location++;
  assert.equal((await Analysis.create(changed).query({ op: 'replay', replay: value.replay })).error.code, 'CAPTURE_MISMATCH');
  const version = structuredClone(value.replay); version.versions.orderedExecution = 'future';
  assert.equal((await api.query({ op: 'replay', replay: version })).error.code, 'VERSION_MISMATCH');
  for (const step of value.witness.steps) { assert(step.identity); assert(step.source.absolute_file); assert.equal(step.views.sequence.witnessProofId, value.witness.rootProofId); }
});

if (process.env.ORDERED_CAPTURE) test('fresh compiled generic fixture supports ordered and reversed source/sink queries', async () => {
  const bytes = fs.readFileSync(process.env.ORDERED_CAPTURE), raw = JSON.parse(bytes);
  const api = Analysis.create(raw), packages = await api.query({ op: 'packages', page: { limit: 100 } });
  const matches = packages.packages.items.filter(p => p.name === 'ordered-fixture'); assert.equal(matches.length, 1);
  const pkg = matches[0];
  const inventory = await api.query({ op: 'functions', scope: { packageIds: [pkg.id] }, page: { limit: 100 } });
  assert.equal(inventory.functions.truncated, false);
  const find = name => {
    const displayPath = 'ordered_fixture::' + name, values = inventory.functions.items.filter(f => f.displayPath === displayPath);
    assert.equal(values.length, 1, displayPath);
    const row = values[0]; assert.equal(row.packageId, pkg.id); assert.equal(row.body.status, 'captured');
    assert(row.body.procedure, 'exact captured procedure ' + displayPath); return row;
  };
  const entry = find('ordered'), source = find('source'), sink = find('sink'), generic = find('identity');
  const forward = await api.query({ op: 'orderedPath', function: entry.body.procedure, waypoints: [proc(source.body.procedure), proc(sink.body.procedure)] });
  assert.equal(forward.status, 'exact'); assert(forward.witness.steps.some(s => s.callsiteId));
  assert(forward.witness.steps.some(s => s.procedure === generic.body.procedure), 'generic instance captured in the witness');
  assert.equal((await api.query({ op: 'orderedPath', function: entry.body.procedure, waypoints: [proc(sink.body.procedure), proc(source.body.procedure)] })).status, 'impossible');
});
