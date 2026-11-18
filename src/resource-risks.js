/* Static resource candidates under explicit versioned models. No measured costs. */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./failure-obligations.js') : root.FailureObligations);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ResourceRisks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Walker) {
  'use strict';
  var VERSION = 'resource-risks-v1', LIMITS = Walker.LIMITS;
  function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function text(x) { return typeof x === 'string' && x.length > 0 && x.length <= 16384; }
  function integer(x) { return Number.isSafeInteger(x) && x >= 0; }
  function keys(x, allowed) { return Object.keys(x).every(function (k) { return allowed.includes(k); }); }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function fail(message) { var e = new Error(message); e.code = 'INVALID_RESOURCE_RISKS'; throw e; }
  function normalize(input) {
    var wire; try { wire = JSON.stringify(input); } catch (_) { fail('request must be JSON serializable'); }
    if (!wire || wire.length > 262144) fail('resource model exceeds 256 KiB');
    var q = JSON.parse(wire); if (!object(q)) fail('request must be an object');
    var m = q.model, ids = new Set();
    function list(x, max) { return Array.isArray(x) && x.length <= max; }
    function id(x) { if (!object(x) || !text(x.id) || ids.has(x.id)) fail('unique model IDs required'); ids.add(x.id); }
    function subject(p, parameter) {
      if (!object(p) || !keys(p, parameter ? ['procedure','port','index','fields'] : ['port','index','fields']) ||
          !(parameter ? p.port === 'parameter' && text(p.procedure) : ['argument','result'].includes(p.port)) ||
          p.port !== 'result' && !integer(p.index) || p.port === 'result' && p.index != null) fail('exact typed subject required');
      p.fields = p.fields || []; if (!list(p.fields, 16) || !p.fields.every(integer)) fail('typed field indices required');
    }
    if (!object(q) || q.op !== 'resourceRisks' || !text(q.function) || !keys(q, ['op','function','actors','model','budgets','timeoutMs','scope','page'])) fail('exact root and resource model required');
    q.actors = q.actors || []; if (!list(q.actors, 7) || !q.actors.every(text) || new Set([q.function].concat(q.actors)).size !== q.actors.length + 1) fail('at most 8 distinct exact actor roots');
    if (!object(m) || m.version !== 1 || !text(m.provenance) || !keys(m, ['version','provenance','sources','operations','guardBounds','loopBounds','summaries'])) fail('model.version:1 and provenance required');
    for (var name of ['sources','operations','guardBounds','loopBounds','summaries']) { m[name] = m[name] || []; if (!list(m[name], 100)) fail('at most 100 ' + name); }
    var sourceSelectors = new Set(), guardSelectors = new Set(), loopSelectors = new Set();
    m.sources.forEach(function (s) { id(s); subject(s.at, true); if (!keys(s, ['id','at','maximum']) || s.maximum != null && !integer(s.maximum)) fail('source maximum must be a declared finite nonnegative integer'); var selector = JSON.stringify(s.at); if (sourceSelectors.has(selector)) fail('one source declaration per typed selector'); sourceSelectors.add(selector); });
    var selections = new Set();
    m.operations.forEach(function (o) {
      id(o); var selector = (o.call || o.node) + ':' + o.kind + ':' + o.outcome;
      if (!keys(o, ['id','version','kind','call','node','outcome','subject','lockId','cost']) || o.version !== 1 ||
          !['allocation','clone','io','work','acquire','release','drop','suspend'].includes(o.kind) ||
          (o.call != null) === (o.node != null) || !text(o.call || o.node) || selections.has(selector) ||
          o.call && !['normal','unwind','invoke'].includes(o.outcome) || o.node && o.outcome != null) fail('operation needs one exact call completion/invocation or node');
      selections.add(selector);
      if (o.kind === 'suspend') { if (o.call && o.outcome !== 'invoke' || o.subject || o.lockId || o.cost) fail('suspension is declared at invocation start or exact node'); }
      else { subject(o.subject, false); if (o.outcome === 'invoke' || o.node) fail('value/lock effects require matching normal/unwind completion'); }
      if (['acquire','release','drop'].includes(o.kind)) { if (!text(o.lockId) || o.cost) fail('locks require explicit shared lock identity assumption'); }
      else if (o.kind !== 'suspend') {
        if (!object(o.cost) || !keys(o.cost, ['perUnit','unit']) || !integer(o.cost.perUnit) || !['bytes','operations','io-operations'].includes(o.cost.unit) || o.lockId) fail('explicit cost weight and unit required');
      }
      if (o.kind === 'suspend' && o.subject) fail('suspension has no value effect');
      if (o.subject && o.subject.port === 'result' && o.outcome !== 'normal') fail('unwind has no result subject');
    });
    m.guardBounds.forEach(function (g) { id(g); subject(g.subject, false); if (!keys(g, ['id','version','call','subject','success','maximum']) || g.version !== 1 || !text(g.call) || g.subject.port !== 'argument' || typeof g.success !== 'boolean' || !integer(g.maximum)) fail('guard bound needs exact predicate argument and success result'); var selector = g.call + ':' + JSON.stringify(g.subject) + ':' + g.success; if (guardSelectors.has(selector)) fail('one bound per predicate subject/success'); guardSelectors.add(selector); });
    m.loopBounds.forEach(function (b) { id(b); if (!keys(b, ['id','version','node','maximum']) || b.version !== 1 || !text(b.node) || !integer(b.maximum)) fail('loop bound needs exact header and declared maximum'); if (loopSelectors.has(b.node)) fail('one bound per loop header'); loopSelectors.add(b.node); });
    selections.clear(); m.summaries.forEach(function (s) {
      id(s); if (!keys(s, ['id','version','call','outcomes','returns','argument','effects']) || s.version !== 1 || !text(s.call) || selections.has(s.call) || !list(s.outcomes, 2) || !s.outcomes.length || new Set(s.outcomes).size !== s.outcomes.length || !s.outcomes.every(function (o) { return ['normal','unwind'].includes(o); }) || !['fresh','argument','unknown'].includes(s.returns) || s.returns === 'argument' && !integer(s.argument) || s.returns !== 'argument' && s.argument != null || s.effects !== 'declared-resource-only') fail('summary requires explicit returns, outcomes and complete declared resource effects');
      selections.add(s.call);
    });
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!integer(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000 || q.budgets != null && !object(q.budgets)) fail('invalid timeout/budgets');
    q.budgets = Object.assign({}, LIMITS, { maxEvidence: 200, maxVisits: 1 }, q.budgets || {});
    Object.keys(q.budgets).forEach(function (k) { if (!LIMITS[k] || !integer(q.budgets[k]) || q.budgets[k] < 1 || q.budgets[k] > LIMITS[k]) fail('invalid budget ' + k); });
    // Resource analysis always uses one representative visit, never unrolls iterations.
    q.budgets.maxVisits = 1;
    return q;
  }
  function build(failureIndex) {
    return { walker: failureIndex, capability: { version: VERSION, modelVersion: 1,
      valueCapability: 'rustc-mir-values-v1', guardCapability: 'rustc-mir-guards-v1', measured: false, namesInferPolicy: false } };
  }
  async function analyze(index, input, runtime, enrichStep) {
    var q = normalize(input), control = runtime || {}, now = control.now || Date.now, started = now(), work = 0, retained = 0, lastYield = 0;
    var STOP = {}, cancelled = false, timedOut = false, budget = false, truncated = false, states = 0;
    var totalRows = 0, candidates = false, rows = [], orders = [], gaps = [], gapCount = 0, loopsAt = new Map(), completedActors = 0, contexts = 0;
    async function spend(n, bytes) {
      work += n || 1; retained += bytes || 0;
      if (work - lastYield >= 128) { lastYield = work; await new Promise(function (r) { setTimeout(r, 0); }); }
      cancelled = cancelled || !!(control.cancelled && control.cancelled()); timedOut = timedOut || now() - started >= q.timeoutMs;
      budget = budget || work > q.budgets.maxWork || retained > q.budgets.maxRetainedBytes || states > q.budgets.maxStates;
      if (cancelled || timedOut || budget) throw STOP;
    }
    async function retain(v) {
      if (v == null || typeof v !== 'object') { await spend(1, typeof v === 'string' ? v.length * 6 + 16 : 16); return v; }
      await spend(1, 64); var out = Array.isArray(v) ? [] : {}, stack = [[v, out]];
      while (stack.length) { var pair = stack.pop(); for (var k in pair[0]) { if (!Object.prototype.hasOwnProperty.call(pair[0], k)) continue;
        var x = pair[0][k]; await spend(1, k.length * 6 + 32 + (typeof x === 'string' ? x.length * 6 : 0));
        if (x && typeof x === 'object') { var child = Array.isArray(x) ? [] : {}; pair[1][k] = child; stack.push([x, child]); } else pair[1][k] = x;
      } } return out;
    }
    async function gap(kind, procedure, detail) {
      await spend(); gapCount++;
      if (gaps.length >= q.budgets.maxEvidence) { truncated = true; return; }
      gaps.push(await retain({ kind: kind, procedure: procedure || q.function, detail: detail || null, classification: 'unknown' }));
    }
    async function record(data, support) {
      await spend(); totalRows++; if (rows.length >= q.budgets.maxEvidence) { truncated = true; return null; }
      var witness = support ? await support.capture() : data;
      var row = await retain(Object.assign({ classification: 'static-candidate', measured: false, deadlockProven: false,
        provenance: q.model.provenance, modelled: true }, witness, data));
      rows.push(row); candidates = candidates || row.classification === 'static-candidate'; return row;
    }
    async function select(packet, fields) { for (var field of fields) { await spend(); packet = packet && packet.fields && packet.fields[field]; } return packet; }
    function packetAt(event, at) { return at.port === 'result' ? event.result : event.args && event.args[at.index]; }
    // DFS backedges plus predecessor closure produce natural regions. An entry
    // path bypassing the header makes the region irreducible and explicitly unknown.
    async function buildLoops() {
      var outgoing = new Map(), incoming = new Map();
      for (var edge of index.walker.edges.values()) {
        await spend(); var from = index.walker.nodes.get(edge.from), to = index.walker.nodes.get(edge.to);
        if (!from || !to || from.procedure !== to.procedure || from.block == null || to.block == null) continue;
        await spend(1, 64); if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge.to);
        if (!incoming.has(edge.to)) incoming.set(edge.to, []); incoming.get(edge.to).push(edge.from);
      }
      for (var pair of index.walker.procedures) {
        await spend(); var procedure = pair[0], entry = pair[1].value, flow = entry.flow;
        if (entry.status !== 'captured' || !flow) continue;
        var start = procedure + '#' + flow.entry, colors = new Map(), stack = [[start, 0]], backedges = [];
        while (stack.length) {
          await spend(); var top = stack[stack.length - 1], node = top[0], next = outgoing.get(node) || [];
          if (!colors.has(node)) { await spend(1, 48); colors.set(node, 1); }
          if (top[1] >= next.length) { colors.set(node, 2); stack.pop(); continue; }
          var target = next[top[1]++];
          if (colors.get(target) === 1) { await spend(1, 64); backedges.push([node, target]); }
          else if (!colors.has(target)) { await spend(1, 48); stack.push([target, 0]); }
        }
        var headers = new Map();
        for (var back of backedges) {
          await spend(); var header = back[1], latch = back[0], members = new Set([header]), pending = [latch]; await spend(1, 96);
          while (pending.length) { await spend(); var n = pending.pop(); if (members.has(n)) continue; await spend(1, 48); members.add(n);
            for (var pred of incoming.get(n) || []) { await spend(1, 16); if (!members.has(pred)) pending.push(pred); }
          }
          var bypass = [start], seen = new Set(), irreducible = false; await spend(1, 64);
          while (bypass.length) { await spend(); var n = bypass.pop(); if (n === header || seen.has(n)) continue; await spend(1, 48); seen.add(n); if (n === latch) irreducible = true;
            for (var to of outgoing.get(n) || []) { await spend(1, 16); if (!seen.has(to)) bypass.push(to); }
          }
          if (headers.has(header)) { for (var member of members) { await spend(1, 32); headers.get(header).members.add(member); } headers.get(header).irreducible = headers.get(header).irreducible || irreducible; }
          else { await spend(1, 96); headers.set(header, { header: header, members: members, irreducible: irreducible }); }
        }
        for (var region of headers.values()) {
          await spend(); var bound = null;
          for (var declared of q.model.loopBounds) { await spend(); if (declared.node === region.header) bound = declared; }
          // Reachability is checked by the observer; disjoint loops are not query gaps.
          for (var member of region.members) {
            await spend(1, 64); if (!loopsAt.has(member)) loopsAt.set(member, []);
            loopsAt.get(member).push({ header: region.header, maximum: bound && !region.irreducible ? bound.maximum : null, boundId: bound && bound.id || null, irreducible: region.irreducible });
          }
        }
      }
    }
    async function observe(event, state, support, actor) {
      await spend(); state.sources = state.sources || {}; state.bounds = state.bounds || {}; state.predicates = state.predicates || {}; state.held = state.held || {}; state.loopGaps = state.loopGaps || {};
      if (event.kind === 'node') for (var region of loopsAt.get(event.nodeId) || []) { await spend(); if (region.irreducible && !state.loopGaps[region.header]) { state.loopGaps[region.header] = true; await support.gap('irreducible-loop-region', region.header); } }
      if (event.kind === 'entry') for (var source of q.model.sources) {
        await spend(); if (source.at.procedure !== event.procedure) continue;
        var p = await select(event.parameters[source.at.index], source.at.fields);
        if (!p || !p.identity) { await support.gap('unknown-source-subject', source.id); continue; }
        state.sources[p.identity] = await retain({ id: source.id, maximum: source.maximum == null ? null : source.maximum });
      }
      if (event.kind === 'branch') for (var predicateKey in state.predicates) {
        await spend(); var predicate = state.predicates[predicateKey]; if (predicate.result === event.discriminant.identity && predicate.success === event.value) state.bounds[predicate.subject] = await retain(predicate);
      }
      if (event.kind === 'completion') for (var guard of q.model.guardBounds) {
        await spend(); if (guard.call !== event.callsiteId || event.outcome !== 'normal') continue;
        var p = await select(packetAt(event, guard.subject), guard.subject.fields);
        if (!p || !p.identity || !event.result || !event.result.identity || event.result.opaque) { await support.gap('unknown-predicate-subject-or-result', guard.id); continue; }
        state.predicates[guard.id + ':' + event.invocationId] = await retain({ id: guard.id, subject: p.identity, result: event.result.identity, maximum: guard.maximum, success: guard.success });
      }
      for (var operation of q.model.operations) {
        await spend(); var matches = operation.node ? event.kind === 'node' && operation.node === event.nodeId :
          operation.call === event.callsiteId && (operation.outcome === 'invoke' ? event.kind === 'invoke' : event.kind === 'completion' && event.outcome === operation.outcome);
        if (!matches) continue;
        if (operation.kind === 'suspend') {
          for (var lockKey in state.held) { await spend(); var lock = state.held[lockKey];
            for (var acquisition of lock.acquisitions) { await spend(); await record({ kind: 'lock-held-across-suspension', operationId: operation.id, lockId: lock.lockId,
              subject: acquisition.subject, acquisitionOperationId: acquisition.operationId,
              acquisitionBasis: 'declared completed acquisition; runtime reentrancy is not assumed', actor: actor,
              suspensionPoint: event.nodeId, identityBasis: 'declared shared lock identity assumption', outcome: 'suspension' }, support); }
          }
          continue;
        }
        var p = await select(packetAt(event, operation.subject), operation.subject.fields);
        if (!p || !p.identity || p.opaque) { await support.gap('unknown-operation-subject', operation.id); continue; }
        if (['acquire','release','drop'].includes(operation.kind)) {
          // Value identity correlates this action to the exact typed argument.
          // Cross-actor object identity is a visible model assumption, never origin inequality.
          if (p.derived) { await support.gap('derived-lock-subject-identity', operation.id); continue; }
          if (operation.kind === 'acquire') {
            for (var heldKey in state.held) { await spend(); var held = state.held[heldKey]; if (held.lockId === operation.lockId) continue;
              if (orders.length >= q.budgets.maxInstances) { budget = true; throw STOP; }
              var order = await record({ kind: 'lock-order', from: held.lockId, to: operation.lockId, actor: actor,
                constraints: event.constraints, invocationId: event.invocationId, subject: p.identity,
                operationId: operation.id, identityBasis: 'declared shared lock identity assumption', classification: 'structural-order' }, support);
              if (order) orders.push(order);
            }
            var held = state.held['declared:' + operation.lockId];
            if (!held) held = state.held['declared:' + operation.lockId] = await retain({ lockId: operation.lockId, acquisitions: [] });
            // Count declared completed acquisitions, without assuming runtime
            // reentrancy/idempotence or treating reacquisition as a self-cycle.
            for (var acquisition of held.acquisitions) { await spend(); if (acquisition.subject !== p.identity) { await support.gap('unproven-reacquired-lock-subject', operation.id); break; } }
            await spend(1, 16); held.acquisitions.push(await retain({ subject: p.identity, operationId: operation.id }));
          } else {
            var held = state.held['declared:' + operation.lockId], matched = -1;
            if (held) for (var i = held.acquisitions.length - 1; i >= 0; i--) { await spend(); if (held.acquisitions[i].subject === p.identity) { matched = i; break; } }
            if (matched < 0) { await support.gap('unmatched-lock-release-or-alias', operation.id); continue; }
            await spend(held.acquisitions.length - matched); held.acquisitions.splice(matched, 1);
            if (!held.acquisitions.length) delete state.held['declared:' + operation.lockId];
          }
          continue;
        }
        var origins = p.origins || [p.identity], sources = [], maximum = null, bound = state.bounds[p.identity];
        for (var origin of origins) { await spend(); if (state.sources[origin]) sources.push(await retain(state.sources[origin])); }
        // A range attached to an input cannot bound an arbitrary derived compute.
        if (bound) maximum = bound.maximum;
        else if (state.sources[p.identity]) maximum = state.sources[p.identity].maximum;
        var regions = loopsAt.get(event.nodeId) || [], regionCopies = await retain(regions), inputDriven = sources.length > 0;
        if (!inputDriven && !regions.length) continue;
        var upper = maximum == null ? null : maximum * operation.cost.perUnit;
        if (!Number.isSafeInteger(upper)) upper = null;
        await record({ kind: inputDriven ? 'input-driven-' + operation.kind : 'repeated-' + operation.kind, operationId: operation.id,
          subject: p.identity, actor: actor, sources: sources, bound: { status: maximum == null ? 'unknown' : 'declared-supported', maximum: maximum,
            guardId: bound && bound.id || null, arithmeticProven: false }, repeated: regions.length > 0, nestingDepth: regions.length,
          loops: regionCopies, cost: { perUnit: operation.cost.perUnit, unit: operation.cost.unit, upperPerInvocation: upper,
            measured: false, basis: 'declared static weight; loop totals require all declared loop bounds' },
          classification: maximum != null && !regions.length ? 'supported-bounded' : 'static-candidate', outcome: event.outcome }, support);
      }
      if (event.kind === 'repeat' || event.kind === 'recursion') {
        var recurrenceSources = [], packets = await retain(event.args || []);
        while (packets.length) { await spend(); var packet = packets.pop();
          for (var origin of packet && packet.origins || []) { await spend(); if (state.sources[origin]) recurrenceSources.push(await retain(state.sources[origin])); }
          for (var field of packet && packet.fields || []) { await spend(1, 16); packets.push(field); }
        }
        await record({ kind: event.kind === 'repeat' ? 'loop-work-frontier' : 'recursive-work-frontier', actor: actor,
          callsiteId: event.callsiteId || null, sources: recurrenceSources, inputDerived: recurrenceSources.length > 0,
          limit: 'unknown', classification: 'static-candidate', sourceDependency: 'supported argument dependencies where present; no numeric recurrence solved', outcome: event.kind }, support);
      }
      return state;
    }
    async function cycles() {
      // Finite simple lock cycles; one representative union, never executions or
      // iteration enumeration. Constraint keys retain their value's scoped
      // identity, including inherited facts from enclosing helper invocations.
      var emitted = new Set();
      for (var first of orders) {
        await spend(1, 64); var pending = [{ node: first.to, path: [first], locks: [first.from, first.to] }];
        while (pending.length) {
          await spend(); var current = pending.pop();
          for (var edge of orders) {
            await spend(); if (edge.from !== current.node) continue;
            var compatible = true;
            for (var prior of current.path) { await spend(); if (prior.actor !== edge.actor) continue;
              for (var key in prior.constraints) { await spend(); if (Object.prototype.hasOwnProperty.call(edge.constraints, key) && prior.constraints[key] !== edge.constraints[key]) compatible = false; }
            }
            if (!compatible) continue;
            if (edge.to === first.from) {
              await spend(current.locks.length, current.locks.length * 64);
              var signature = current.locks.slice(0).sort().join('\u0000'); await spend(1, signature.length * 6 + 64);
              if (emitted.has(signature)) continue; emitted.add(signature);
              await spend(current.path.length + 1, (current.path.length + 1) * 32);
              var path = await retain(current.path.concat([edge])), orderPaths = [];
              for (var order of path) { await spend(1, 128); orderPaths.push({ from: order.from, to: order.to, actor: order.actor, root: order.root, invocationId: order.invocationId, constraints: order.constraints, steps: order.steps, truncated: order.truncated }); }
              await record({ kind: 'possible-lock-order-cycle', from: first.from, to: first.from,
                classification: 'static-candidate', conditionalUnion: true, concreteExecutionProven: false,
                conditionsSharedAcrossActors: false, identityBasis: 'declared shared lock identity assumptions',
                root: first.root, steps: first.steps, truncated: first.truncated,
                orders: orderPaths });
            } else if (!current.locks.includes(edge.to)) {
              await spend(current.path.length + current.locks.length + 2, (current.path.length + current.locks.length + 2) * 32);
              var next = await retain({ node: edge.to, path: current.path.concat([edge]), locks: current.locks.concat([edge.to]) }); pending.push(next);
            }
          }
        }
      }
    }
    try {
      // Reserve fixed result/envelope scaffolding before any generated evidence.
      await spend(1, 8192 + q.model.provenance.length * 6);
      await retain({ model: q.model, scope: q.scope || null, capability: index.capability });
      for (var operation of q.model.operations) { await spend(); if (operation.call ? !index.walker.calls.has(operation.call) : !index.walker.nodes.has(operation.node)) await gap('unavailable-exact-operation', null, operation.id); }
      for (var source of q.model.sources) { await spend(); if (!index.walker.procedures.has(source.at.procedure)) await gap('unavailable-exact-source', source.at.procedure, source.id); }
      for (var guard of q.model.guardBounds) { await spend(); if (!index.walker.calls.has(guard.call)) await gap('unavailable-exact-guard', null, guard.id); }
      for (var bound of q.model.loopBounds) { await spend(); if (!index.walker.nodes.has(bound.node)) await gap('unavailable-exact-loop-bound', null, bound.id); }
      await buildLoops();
      for (var actor of [q.function].concat(q.actors)) {
        await spend(); var summaries = [];
        for (var summary of q.model.summaries) { await spend(); summaries.push(await retain(Object.assign({}, summary, { effects: 'declared-protocol-only' })));
        }
        // Reserve the internal walker's normalized declaration snapshot as well.
        await retain({ summaries: summaries });
        var walked = await Walker.walk(index.walker, { function: actor, timeoutMs: q.timeoutMs, budgets: q.budgets, summaries: summaries },
          { now: now, cancelled: function () { return cancelled || !!(control.cancelled && control.cancelled()); }, account: spend, state: async function () { states++; await spend(); } },
          { event: function (event, state, support) { return observe(event, state, support, actor); } }, enrichStep);
        contexts += walked.queryCoverage.contexts; await spend();
        for (var g of walked.queryCoverage.gaps) await gap(g.kind, g.procedure, g.detail);
        gapCount += walked.queryCoverage.totalGaps - walked.queryCoverage.gaps.length;
        truncated = truncated || walked.witnesses.truncated; budget = budget || walked.completion.budgetExceeded;
        cancelled = cancelled || walked.completion.cancelled; timedOut = timedOut || walked.completion.timedOut;
        completedActors++; if (budget || cancelled || timedOut) throw STOP;
      }
      await cycles();
    } catch (error) { if (error !== STOP) throw error; }
    var partial = gapCount > 0 || budget || cancelled || timedOut || truncated;
    return { schemaVersion: 1, operation: 'resourceRisks', status: cancelled || timedOut ? 'cancelled' : partial ? 'indeterminate' : candidates ? 'static-candidate' : 'supported',
      capability: copy(index.capability), partialCoverage: partial,
      witnesses: { total: totalRows, items: rows, truncated: truncated || budget || cancelled || timedOut },
      queryCoverage: { partial: partial, gaps: gaps, totalGaps: gapCount, gapsTruncated: gapCount > gaps.length, contexts: contexts,
        completedActors: completedActors, scope: 'bounded representative structural paths from exact independent actors' },
      completion: { complete: !budget && !cancelled && !timedOut, cancelled: cancelled, timedOut: timedOut, budgetExceeded: budget,
        evidenceComplete: !truncated && !budget && !cancelled && !timedOut, work: work, states: states, retainedBytes: retained,
        limits: copy(q.budgets), timeoutMs: q.timeoutMs },
      finding: { classification: rows.length ? 'modeled' : 'unknown', candidateRisk: candidates, measuredHotspot: false,
        deadlockProven: false, definitiveNegative: false, vulnerabilityAbsenceProven: false, runtimeExploitabilityProven: false },
      semantics: { version: VERSION, namesInferPolicy: false, measured: false, branchFeasibilitySolved: false,
        loops: 'finite CFG regions and representative repeat frontiers, never iteration enumeration',
        identity: 'typed value identity correlates effects; shared lock object identity is a declared assumption',
        numericBounds: 'declared range/predicate/cost assumptions, no compiler arithmetic proof',
        cycles: 'conditional structural union, not a concrete schedule or deadlock' },
      assumptions: ['All resource operations, shared lock identities, ranges, bounds, suspension points and cost weights are declared: ' + q.model.provenance,
        'Input dependency is not arithmetic range proof or distinct runtime object identity. Independent actor conditions are not shared global facts.',
        'Unknown aliases, wrappers, native/async/callback control and bounded frontiers remain unknown. Static candidates are neither measured hotspots nor proven deadlocks.'],
      scope: q.scope ? { role: 'view context; full captured resource paths traversed', requested: copy(q.scope) } : null };
  }
  return { VERSION: VERSION, LIMITS: copy(LIMITS), normalize: normalize, build: build, analyze: analyze };
});
