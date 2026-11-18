/* Declared failure protocols over accepted typed MIR. Shared API/worker/fallback. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FailureObligations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'failure-obligations-v1';
  var OUTCOMES = ['normal','error','unwind','cancel','drop'];
  var LIMITS = { maxWork: 2000000, maxStates: 20000, maxFrames: 64, maxInstances: 2000,
    maxRetainedBytes: 8388608, maxEvidence: 1000, maxVisits: 4 };
  function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function text(x) { return typeof x === 'string' && x.length > 0 && x.length <= 16384; }
  function integer(x) { return Number.isSafeInteger(x) && x >= 0; }
  function keys(x, names) { return Object.keys(x).every(function (k) { return names.includes(k); }); }
  function fail(message) { var e = new Error(message); e.code = 'INVALID_FAILURE_OBLIGATIONS'; throw e; }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function normalize(input) {
    var serialized; try { serialized = JSON.stringify(input); } catch (_) { fail('request must be JSON serializable'); }
    if (!serialized || serialized.length > 262144) fail('failure model exceeds 256 KiB');
    var q = JSON.parse(serialized);
    if (!object(q) || q.op !== 'failureObligations' || !text(q.function) ||
        !keys(q, ['op','function','model','budgets','timeoutMs','scope','page'])) fail('exact root and declared failure model required');
    var m = q.model, ids = new Set(), selectors = new Set();
    function id(r) { if (!object(r) || !text(r.id) || ids.has(r.id)) fail('unique declared IDs required'); ids.add(r.id); }
    function list(v, limit) { return Array.isArray(v) && v.length <= limit; }
    if (!object(m) || m.version !== 1 || !text(m.provenance) || !keys(m, ['version','provenance','rules','summaries','outcomes']) ||
        !list(m.rules, 16) || !m.rules.length) fail('model.version:1, provenance and 1..16 protocols required');
    m.rules.forEach(function (r) {
      id(r);
      if (!keys(r, ['id','states','initial','terminal','transitions']) || !list(r.states, 16) || !r.states.length ||
          !r.states.every(text) || new Set(r.states).size !== r.states.length || !r.states.includes(r.initial) ||
          !object(r.terminal) || !keys(r.terminal, OUTCOMES) || !OUTCOMES.every(function (o) {
            return list(r.terminal[o], 16) && r.terminal[o].every(function (s) { return r.states.includes(s); });
          }) || !list(r.transitions, 64) || !r.transitions.length) fail('protocol requires finite states, explicit terminal states for all outcomes and transitions');
      var at = new Set();
      r.transitions.forEach(function (t) {
        id(t); var p = t.subject;
        if (!keys(t, ['id','call','outcome','subject','from','to']) || !text(t.call) || !['normal','unwind'].includes(t.outcome) ||
            !list(t.from, 16) || !t.from.length || !t.from.every(function (s) { return r.states.includes(s); }) || !r.states.includes(t.to) ||
            !object(p) || !keys(p, ['port','index','fields']) || !['argument','result'].includes(p.port) ||
            p.port === 'argument' && !integer(p.index) || p.port === 'result' && (p.index != null || t.outcome !== 'normal')) fail('transition requires exact call completion, typed subject and from/to states');
        p.fields = p.fields || []; if (!list(p.fields, 16) || !p.fields.every(integer)) fail('subject fields must be typed indices');
        var key = t.call + ':' + t.outcome;
        if (at.has(key)) fail('one transition per protocol/call/outcome avoids ambiguous ordering'); at.add(key);
      });
    });
    m.summaries = m.summaries || []; m.outcomes = m.outcomes || [];
    if (!list(m.summaries, 100) || !list(m.outcomes, 100)) fail('at most 100 summaries/outcome annotations');
    m.summaries.forEach(function (s) {
      id(s); if (!keys(s, ['id','version','call','outcomes','returns','argument','effects']) || s.version !== 1 || !text(s.call) ||
          selectors.has(s.call) || !list(s.outcomes, 2) || !s.outcomes.length || new Set(s.outcomes).size !== s.outcomes.length ||
          !s.outcomes.every(function (o) { return ['normal','unwind'].includes(o); }) || !['fresh','argument','unknown'].includes(s.returns) ||
          s.returns === 'argument' && !integer(s.argument) || s.returns !== 'argument' && s.argument != null ||
          s.effects !== 'declared-protocol-only') fail('summary must explicitly cover outcomes and all effects under the declared protocols');
      selectors.add(s.call);
    });
    selectors.clear();
    m.outcomes.forEach(function (o) {
      id(o); var selected = o.node || o.edge;
      if (!keys(o, ['id','node','edge','outcome']) || (o.node != null) === (o.edge != null) || !text(selected) ||
          !OUTCOMES.includes(o.outcome) || o.edge && !['normal','error'].includes(o.outcome) || selectors.has(selected)) fail('outcome requires one unique exact node/edge; cancel/drop must be node declarations');
      selectors.add(selected);
    });
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!integer(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000 || q.budgets != null && !object(q.budgets)) fail('invalid timeout/budgets');
    q.budgets = Object.assign({}, LIMITS, { maxEvidence: 200 }, q.budgets || {});
    Object.keys(q.budgets).forEach(function (k) { if (!LIMITS[k] || !integer(q.budgets[k]) || q.budgets[k] < 1 || q.budgets[k] > LIMITS[k]) fail('invalid budget ' + k); });
    return q;
  }
  // Reuse validated value ownership and boolean/function-value indexes. No raw MIR parser.
  function build(guardIndex, model) {
    return { guards: guardIndex, procedures: guardIndex.procedures, calls: guardIndex.calls,
      edges: guardIndex.edges, nodes: new Map(model.nodes.map(function (n) { return [n.id, copy(n)]; })),
      capability: { version: VERSION, modelVersion: 1, valueCapability: 'rustc-mir-values-v1',
        guardCapability: 'rustc-mir-guards-v1', inferredBusinessSemantics: false } };
  }
  async function run(index, input, runtime, enrichStep, hooks) {
    var q = hooks ? input : normalize(input), control = runtime || {}, now = control.now || Date.now, started = now();
    var work = 0, states = 0, retained = 0, contexts = 0, serial = 0, lastYield = 0, instances = 0, outputSteps = 0;
    var cancelled = false, timedOut = false, budget = false, truncated = false, violations = 0, completed = 0, compliantPaths = 0;
    var rows = [], gaps = [], gapCount = 0, STOP = {}, FRONTIER = {};
    async function spend(n, bytes) {
      if (hooks && control.account) await control.account(n || 1, bytes || 0);
      work += n || 1; retained += bytes || 0;
      if (work - lastYield >= 128) { lastYield = work; await new Promise(function (r) { setTimeout(r, 0); }); }
      cancelled = cancelled || !!(control.cancelled && control.cancelled()); timedOut = timedOut || now() - started >= q.timeoutMs;
      budget = budget || work > q.budgets.maxWork || states > q.budgets.maxStates || retained > q.budgets.maxRetainedBytes || instances > q.budgets.maxInstances;
      if (cancelled || timedOut || budget) throw STOP;
    }
    // Iterative and cooperative: account allocation before retaining each nested
    // item. Six bytes per code unit also bounds JSON escaping and UTF-8 transport.
    async function clone(v) {
      if (v == null || typeof v !== 'object') { await spend(1, typeof v === 'string' ? v.length * 6 + 16 : 16); return v; }
      var out = Array.isArray(v) ? [] : {}, queue = [[v, out]]; await spend(1, 64);
      while (queue.length) {
        var pair = queue.pop();
        for (var k of Object.keys(pair[0])) {
          var x = pair[0][k]; await spend(1, k.length * 6 + 32 + (typeof x === 'string' ? x.length * 6 : 0));
          if (x && typeof x === 'object') { var child = Array.isArray(x) ? [] : {}; pair[1][k] = child; queue.push([x, child]); }
          else pair[1][k] = x;
        }
      } return out;
    }
    async function gap(kind, f, detail) {
      await spend(); gapCount++;
      if (gaps.length >= q.budgets.maxEvidence) { truncated = true; return; }
      await spend(1, 128 + String(detail || '').length * 2);
      gaps.push({ kind: kind, procedure: f && f.procedure || q.function, detail: detail || null, classification: 'unknown' });
    }
    async function frontier(kind, f, detail) { await gap(kind, f, detail); throw FRONTIER; }
    async function token() { await spend(1, 48); return 'object:' + (++serial); }
    async function packet(shape, prefix, fresh) {
      await spend(1, 64); var p = { identity: null, fresh: !!fresh };
      if (!shape || !['scalar','fields'].includes(shape.kind)) return p;
      p.identity = prefix || await token();
      if (hooks) p.origins = [p.identity];
      if (shape.kind === 'fields') { p.fields = []; for (var i = 0; i < shape.fields.length; i++) p.fields.push(await packet(shape.fields[i], p.identity + '/' + i, false)); }
      return p;
    }
    async function select(p, fields, f) {
      for (var field of fields) { await spend(); p = p && p.fields && p.fields[field]; }
      if (!p || !p.identity) await frontier('unknown-or-aliased-subject', f);
      return clone(p);
    }
    async function read(f, place) {
      if (!place || place.projection.some(function (p) { return p.kind !== 'field'; })) await frontier('unsupported-reference-or-projection', f);
      return select(f.slots[place.local], place.projection.map(function (p) { return p.index; }), f);
    }
    async function operand(f, o) {
      await spend(); if (o.kind === 'constant') return { identity: await token(), opaque: true };
      var p = await read(f, o.place);
      if (o.kind === 'move') await write(f, o.place, { identity: null });
      return p;
    }
    async function shapeOf(f, place) {
      await spend(); var entry = index.procedures.get(f.procedure).value, local = place && entry.locals.get(place.local), shape = local && local.shape;
      for (var part of place && place.projection || []) { await spend(); shape = part.kind === 'field' && shape && shape.kind === 'fields' ? shape.fields[part.index] : null; }
      return shape;
    }
    async function write(f, place, p) {
      await spend(); if (!place || place.projection.some(function (v) { return v.kind !== 'field'; })) await frontier('unsupported-reference-write', f);
      if (!place.projection.length) { f.slots[place.local] = await clone(p); return; }
      var owner = f.slots[place.local];
      for (var i = 0; i < place.projection.length; i++) {
        await spend(); var field = place.projection[i].index;
        if (!owner || !owner.fields || !owner.fields[field]) await frontier('unknown-field-write', f);
        owner.identity = await token(); owner.fresh = false;
        if (i === place.projection.length - 1) owner.fields[field] = await clone(p); else owner = owner.fields[field];
      }
    }
    async function add(s, f, b, kind, extra) {
      await spend(1, 320 + f.procedure.length * 4 + b.id.length * 2); s.history = { parent: s.history, step: Object.assign({ kind: kind, procedure: f.procedure,
        sourceProcedure: f.procedure, invocationId: f.invocation, nodeId: f.procedure + '#' + b.id,
        source: { source_file: b.source_file || null, source_location: b.source_location || null } }, extra || {}) };
    }
    // Internal product seam. Observer JSON is snapshotted on both sides; only
    // the core can expose bounded history and no live interpreter object escapes.
    async function observe(s, f, b, kind, data) {
      if (!hooks) return;
      await spend();
      var event = await clone(Object.assign({ kind: kind, procedure: f.procedure,
        invocationId: f.invocation, nodeId: f.procedure + '#' + b.id,
        sourceProcedure: f.procedure, constraints: s.constraints,
        source: { source_file: b.source_file || null, source_location: b.source_location || null } }, data || {}));
      var state = await hooks.event(event, await clone(s.observer || {}), {
        spend: spend, retain: clone,
        gap: function (kind, detail) { return gap(kind, f, detail); },
        capture: async function () {
          var steps = [], h = s.history;
          while (h) {
            await spend();
            if (outputSteps >= q.budgets.maxEvidence) { truncated = true; break; }
            var step = enrichStep ? await enrichStep(h.step, clone) : h.step;
            steps.push(await clone(step)); outputSteps++; h = h.parent;
          }
          return { root: q.function, steps: steps.reverse(), truncated: !!h };
        }
      });
      s.observer = await clone(state || {});
    }
    // Validate execution metadata on the accepted raw block before Model's
    // discarded fields can turn a reachable malformed invocation into coverage.
    async function validateControl(b, f) {
      for (var field of ['callee','callee_id','callee_package_id','callee_crate','callee_artifact','callee_abi']) {
        await spend(); if (b[field] != null && typeof b[field] !== 'string') await frontier('malformed-execution-record', f, b.id);
      }
      async function targets(xs) {
        await spend(); if (xs == null) return;
        if (!Array.isArray(xs)) await frontier('malformed-execution-record', f, b.id);
        for (var target of xs) { await spend(); if (typeof target !== 'string') await frontier('malformed-execution-record', f, b.id); }
      }
      await targets(b.callee_targets); await targets(b.native_target_ids);
      if (b.callback_parameter != null && !integer(b.callback_parameter) ||
          b.callback_unknown != null && typeof b.callback_unknown !== 'boolean' || b.native_call != null && !object(b.native_call))
        await frontier('malformed-execution-record', f, b.id);
      if (b.callback_args != null) {
        if (!Array.isArray(b.callback_args)) await frontier('malformed-execution-record', f, b.id);
        for (var arg of b.callback_args) {
          await spend();
          if (!object(arg) || !integer(arg.index) || arg.parameter != null && !integer(arg.parameter) ||
              Object.prototype.hasOwnProperty.call(arg, 'unknown') && typeof arg.unknown !== 'boolean') await frontier('malformed-execution-record', f, b.id);
          await targets(arg.targets);
          if (arg.unknown) await frontier('unknown-callback-binding', f, b.id);
        }
      }
    }
    async function frame(proc, args, continuation) {
      await spend(); var e = index.procedures.get(proc);
      if (!e || e.value.status !== 'captured' || e.status === 'invalid') await frontier(e && (e.value.reason || e.reason) || 'missing-body', { procedure: proc });
      if (args && args.length !== e.value.facts.parameter_locals.length) await frontier('call-argument-arity-mismatch', { procedure: proc });
      var f = { procedure: proc, invocation: 'invocation:' + (++contexts), block: e.value.flow.entry, slots: {}, visits: {}, continuation: continuation || null };
      for (var l of e.value.facts.locals) { await spend(1, 64); f.slots[l.local] = { identity: null }; }
      for (var i = 0; i < e.value.facts.parameter_locals.length; i++) {
        var n = e.value.facts.parameter_locals[i];
        f.slots[n] = args ? await clone(args[i]) : await packet(e.value.locals.get(n).shape, f.invocation + ':parameter:' + i);
      } return f;
    }
    async function witness(s, f, b, rule, subject, state, outcome, reason) {
      await spend(); if (reason) { violations++; s.violation = true; } else completed++;
      if (rows.length >= q.budgets.maxEvidence) { truncated = true; return; }
      var steps = [], h = s.history;
      while (h) {
        await spend(); if (outputSteps >= q.budgets.maxEvidence) { truncated = true; break; }
        // Enrichment is generated evidence too: retain it through the same
        // cooperative accounting before finalizing status, counters or coverage.
        var step = enrichStep ? await enrichStep(h.step, clone) : h.step;
        steps.push(await clone(step)); outputSteps++; h = h.parent;
      }
      await spend(1, 256); rows.push({ ruleId: rule.id, subject: subject, state: state, outcome: outcome,
        classification: reason ? 'candidate-violation' : 'supported-compliant', reason: reason || 'declared-terminal-state',
        root: q.function, steps: steps.reverse(), truncated: !!h });
    }
    async function transitions(s, f, b, c, args, result, outcome) {
      for (var rule of q.model.rules) for (var t of rule.transitions) {
        await spend(); if (t.call !== c.id || t.outcome !== outcome) continue;
        var p = await select(t.subject.port === 'result' ? result : args[t.subject.index], t.subject.fields, f), key = rule.id + '\u0000' + p.identity;
        if (p.opaque) await frontier('opaque-subject', f, t.id);
        var instance = s.obligations[key];
        if (!instance) for (var existing of Object.values(s.obligations)) {
          await spend();
          if (existing.ruleId === rule.id && existing.subject !== p.identity && !(existing.fresh && p.fresh))
            await frontier('unproven-subject-alias', f, t.id);
        }
        if (!instance) {
          instances++; await spend(1, 160); instance = s.obligations[key] = { ruleId: rule.id, subject: p.identity, fresh: !!p.fresh, state: rule.initial };
        }
        var before = instance.state;
        await add(s, f, b, 'protocol-transition', { callsiteId: c.id, ruleId: rule.id, transitionId: t.id,
          subject: p.identity, from: before, to: t.to, outcome: outcome, provenance: q.model.provenance, modelled: true });
        if (!t.from.includes(before)) await witness(s, f, b, rule, p.identity, before, outcome, 'unexpected-transition');
        else instance.state = t.to;
      }
    }
    async function terminal(s, f, b, outcome) {
      await add(s, f, b, 'exit', { outcome: outcome });
      var allAllowed = true, keys = Object.keys(s.obligations);
      for (var key of keys) {
        await spend(); var a = s.obligations[key], rule = q.model.rules.find(function (r) { return r.id === a.ruleId; });
        var allowed = rule.terminal[outcome].includes(a.state); allAllowed = allAllowed && allowed;
        if (!allowed || !s.violation) await witness(s, f, b, rule, a.subject, a.state, outcome, allowed ? null : 'required-compensation-or-cleanup-missing');
      }
      if (keys.length && allAllowed && !s.violation) compliantPaths++;
    }
    async function fork(s) { await spend(1, 80); var next = { frames: await clone(s.frames), obligations: await clone(s.obligations), constraints: await clone(s.constraints), outcome: s.outcome, violation: !!s.violation, history: s.history }; if (hooks) next.observer = await clone(s.observer || {}); return next; }
    var annotations = new Map(), summaries = new Map(), outgoing = new Map();
    async function takeEdge(s, f, b, edge) {
      if (!edge || edge.procedure !== f.procedure || edge.from !== f.procedure + '#' + b.id) await frontier('invalid-continuation', f);
      var o = annotations.get(edge.id);
      if (o) { s.outcome = o.outcome; await add(s, f, b, 'declared-outcome', { edgeId: edge.id, outcome: o.outcome, annotationId: o.id, modelled: true, provenance: q.model.provenance }); }
      await add(s, f, b, 'edge', { edgeId: edge.id, outcome: edge.action || edge.kind, targetNodeId: edge.to });
      var n = index.nodes.get(edge.to);
      if (!n || n.procedure !== f.procedure) await frontier('missing-continuation-node', f, edge.id);
      if (n.block == null) await finish(s, f, b, n.kind === 'return' ? 'normal' : n.kind);
      else { f.block = n.block; queue.push(s); }
    }
    async function finish(s, f, b, outcome) {
      if (!['normal','unwind'].includes(outcome)) { await frontier('unsupported-terminal-' + outcome, f, b.id); }
      if (s.frames.length === 1) { await terminal(s, f, b, outcome === 'unwind' ? 'unwind' : s.outcome); return; }
      var returned = outcome === 'normal' ? await read(f, { local: 0, projection: [] }) : null, ret = f.continuation;
      s.frames.pop(); var parent = s.frames[s.frames.length - 1], pe = index.procedures.get(parent.procedure).value;
      var pb = pe.flow.blocks.find(function (v) { return v.id === ret.block; }), c = index.calls.get(ret.call);
      await completeCall(s, parent, pb, c, ret.args, ret.destination, returned, outcome);
    }
    async function completeCall(s, f, b, c, args, destination, result, outcome) {
      await transitions(s, f, b, c, args, result, outcome);
      await observe(s, f, b, 'completion', { callsiteId: c.id, args: args, result: result, outcome: outcome });
      if (outcome === 'normal') await write(f, destination, result);
      var edges = outcome === 'normal' ? c.normal : c.unwind;
      if (!edges.length) { await frontier('missing-' + outcome + '-continuation', f, c.id); }
      for (var i = 0; i < edges.length; i++) {
        await spend(); var next = i === edges.length - 1 ? s : await fork(s);
        try { await takeEdge(next, next.frames[next.frames.length - 1], b, index.edges.get(edges[i])); } catch (error) { if (error !== FRONTIER) throw error; }
      }
    }
    var queue = [];
    try {
      for (var annotation of q.model.outcomes) {
        await spend(); if (annotation.node ? !index.nodes.has(annotation.node) || index.nodes.get(annotation.node).block == null : !index.edges.has(annotation.edge)) {
          await frontier('unavailable-exact-outcome-selection', null, annotation.id);
        } annotations.set(annotation.node || annotation.edge, annotation);
      }
      for (var summary of q.model.summaries) { await spend(); if (!index.calls.has(summary.call)) await frontier('unavailable-exact-call-selection', null, summary.call); summaries.set(summary.call, summary); }
      for (var rule of q.model.rules) for (var t of rule.transitions) { await spend(); if (!index.calls.has(t.call)) await frontier('unavailable-exact-call-selection', null, t.call); }
      for (var edge of index.edges.values()) { await spend(1, 16); var list = outgoing.get(edge.from); if (!list) { list = []; outgoing.set(edge.from, list); } list.push(edge); }
      queue.push({ frames: [await frame(q.function)], obligations: {}, constraints: {}, outcome: 'normal', history: null });
      while (queue.length) {
        states++; if (hooks && control.state) await control.state(); await spend(); var s = queue.pop(), f = s.frames[s.frames.length - 1], e = index.procedures.get(f.procedure), entry = e.value;
        var b = null, values = null;
        try {
          for (var block of entry.flow.blocks) { await spend(); if (block.id === f.block) { b = block; break; } }
          for (var facts of entry.facts.blocks) { await spend(); if (facts.id === f.block) { values = facts; break; } }
          if (!b || !values) await frontier('missing-block', f, f.block);
          await validateControl(b, f);
          f.visits[b.id] = (f.visits[b.id] || 0) + 1;
          if (f.visits[b.id] > q.budgets.maxVisits) { await observe(s, f, b, 'repeat', {}); await frontier('loop-bound-frontier', f, b.id); }
          await add(s, f, b, 'node');
          if (hooks && !f.entered) { f.entered = true; var parameters = []; for (var local of entry.facts.parameter_locals) { await spend(); parameters.push(await clone(f.slots[local])); } await observe(s, f, b, 'entry', { parameters: parameters }); }
          await observe(s, f, b, 'node', {});
          var annotation = annotations.get(f.procedure + '#' + b.id);
          if (annotation) {
            await add(s, f, b, 'declared-outcome', { outcome: annotation.outcome, annotationId: annotation.id, modelled: true, provenance: q.model.provenance });
            if (['cancel','drop'].includes(annotation.outcome)) { await terminal(s, f, b, annotation.outcome); continue; }
            s.outcome = annotation.outcome;
          }
          for (var statement of values.statements) {
            await spend(); if (statement.kind === 'unsupported') await frontier('unsupported-memory-effect', f, statement.id);
            if (statement.kind === 'storage') { f.slots[statement.local] = { identity: null }; continue; }
            if (statement.kind !== 'assign') continue;
            var v = statement.value, p;
            if (v.kind === 'use') p = await operand(f, v.operands[0]);
            else if (v.kind === 'aggregate') { p = { identity: await token(), fields: [] }; for (var o of v.operands) p.fields.push(await operand(f, o)); }
            else if (v.kind === 'compute') {
              var dependencies = []; for (var o of v.operands) { var inputPacket = await operand(f, o); if (hooks) for (var origin of inputPacket.origins || []) { await spend(1, 32 + origin.length * 6); if (!dependencies.includes(origin)) dependencies.push(origin); } }
              p = await packet(await shapeOf(f, statement.destination)); if (hooks) {
                // A later source declaration can name this value itself. Carry
                // that identity forward without adding it to older operands.
                if (p.identity) { await spend(1, 32 + p.identity.length * 6); dependencies.push(p.identity); }
                p.origins = dependencies; p.derived = true;
              }
            }
            else if (e.functionValues.has(statement.id)) p = { identity: await token(), functionId: e.functionValues.get(statement.id).function_id };
            else await frontier('unsupported-value-operation', f, statement.id);
            await write(f, statement.destination, p);
            await add(s, f, b, 'assignment', { factId: statement.id, subject: p.identity, source: { source_file: statement.source_file || null, source_location: statement.source_location || null } });
          }
          if (values.call) {
            var c = index.calls.get(f.procedure + '#' + b.id + '@call'), cv = values.call;
            if (hooks && c) {
              // Reaching the declared invocation point precedes unknown callee
              // effects. Do not attach a target, arguments or completion yet.
              await add(s, f, b, 'invocation', { callsiteId: c.id });
              await observe(s, f, b, 'invoke', { callsiteId: c.id });
            }
            if (!c || cv.argument_convention !== 'direct' || c.tail || !cv.destination) await frontier('unsupported-call-abi', f, c && c.id);
            var summary = summaries.get(c.id);
            // Exact direct target only unless the complete invocation is explicitly summarized.
            if (!summary && (c.nativeCall || c.possibleDispatch || c.possibleUnknown || c.idMismatch || c.legacyUnverified || c.unknown || c.callbackParameter != null || c.targets.length !== 1))
              await frontier('unsupported-call-target', f, c.id);
            var chosen = c.targets[0], chosenEntry = index.procedures.get(chosen), args = [];
            if (chosenEntry && chosenEntry.value.status === 'captured' && cv.arguments.length !== chosenEntry.value.facts.parameter_locals.length) await frontier('call-argument-arity-mismatch', f, c.id);
            if (cv.function.kind !== 'constant') {
              var pointer = await operand(f, cv.function);
              if (!pointer.functionId || !chosenEntry || pointer.functionId !== chosenEntry.value.procedure.function_id) await frontier('unproven-function-pointer', f, c.id);
            }
            for (var o of cv.arguments) args.push(await operand(f, o));
            // A declared summary may cover a call without a captured target.
            await add(s, f, b, 'call', { callsiteId: c.id, target: chosen == null ? null : chosen, normal: await clone(c.normal), unwind: await clone(c.unwind) });
            if (summary) {
              if (c.normal.length && !summary.outcomes.includes('normal') || c.unwind.length && !summary.outcomes.includes('unwind'))
                await gap('summary-uncovered-continuation', f, c.id);
              for (var oi = 0; oi < summary.outcomes.length; oi++) {
                await spend(); var next = await fork(s), nf = next.frames[next.frames.length - 1], outcome = summary.outcomes[oi];
                await add(next, nf, b, 'declared-summary', { callsiteId: c.id, summaryId: summary.id, summaryVersion: 1, outcome: outcome, modelled: true, provenance: q.model.provenance });
                var result = outcome === 'unwind' ? null : summary.returns === 'argument' ? await select(args[summary.argument], [], f) : summary.returns === 'fresh' ? await packet(await shapeOf(f, cv.destination), null, true) : { identity: null };
                try { await completeCall(next, nf, b, c, args, cv.destination, result, outcome); } catch (error) { if (error !== FRONTIER) throw error; }
              } continue;
            }
            if (s.frames.length >= q.budgets.maxFrames) { budget = true; throw STOP; }
            if (s.frames.some(function (fr) { return fr.procedure === chosen; })) { await observe(s, f, b, 'recursion', { callsiteId: c.id, target: chosen, args: args }); await frontier('recursion-frontier', f, c.id); }
            var child = await frame(chosen, args, { call: c.id, block: b.id, args: args, destination: cv.destination });
            s.frames.push(child); queue.push(s); continue;
          }
          if (b.kind === 'return' || b.kind === 'unwind') { await finish(s, f, b, b.kind === 'return' ? 'normal' : 'unwind'); continue; }
          if (!['goto','branch'].includes(b.kind)) await frontier('unsupported-control-' + b.kind, f, b.id);
          var choices = outgoing.get(f.procedure + '#' + b.id) || [], branch = e.branches.get(b.id), discr = null;
          if (b.kind === 'branch') {
            if (!branch || branch.kind !== 'boolean') await frontier('unsupported-branch-outcome', f, b.id);
            discr = await operand(f, branch.discriminant);
          }
          if (!choices.length) await frontier('missing-control-successor', f, b.id);
          for (var edge of choices) {
            await spend(); var branchValue = null;
            if (discr) {
              var target = index.nodes.get(edge.to), matches = branch.targets.filter(function (t) { return target && t.target === target.block; });
              if (matches.length !== 1) await frontier('invalid-boolean-successor', f, edge.id);
              branchValue = matches[0].value;
              if (Object.prototype.hasOwnProperty.call(s.constraints, discr.identity) && s.constraints[discr.identity] !== branchValue) continue;
            }
            var next = await fork(s), nf = next.frames[next.frames.length - 1];
            if (discr) { next.constraints[discr.identity] = branchValue; await observe(next, nf, b, 'branch', { discriminant: discr, value: branchValue, edgeId: edge.id }); }
            try { await takeEdge(next, nf, b, edge); } catch (error) { if (error !== FRONTIER) throw error; }
          }
        } catch (error) { if (error !== FRONTIER) throw error; }
      }
    } catch (error) { if (error !== STOP && error !== FRONTIER) throw error; }
    var partial = gapCount > 0 || budget || cancelled || timedOut;
    truncated = truncated || budget || cancelled || timedOut;
    return { schemaVersion: 1, operation: 'failureObligations', status: cancelled || timedOut ? 'cancelled' : partial ? 'indeterminate' : violations ? 'candidate-violation' : compliantPaths ? 'supported-compliant' : 'not-reached',
      partialCoverage: partial, scope: q.scope ? { role: 'view context; full captured failure protocols traversed', requested: copy(q.scope) } : null, capability: copy(index.capability), rules: copy(q.model.rules),
      witnesses: { total: violations + completed, items: rows, truncated: truncated },
      queryCoverage: { partial: partial, gaps: gaps, totalGaps: gapCount, gapsTruncated: gapCount > gaps.length, contexts: contexts,
        scope: 'supported structural executions from the exact root under the declared protocols' },
      completion: { complete: !budget && !cancelled && !timedOut, cancelled: cancelled, timedOut: timedOut, budgetExceeded: budget,
        evidenceComplete: !truncated, work: work, states: states, retainedBytes: retained, instances: instances, limits: copy(q.budgets), timeoutMs: q.timeoutMs },
      finding: { classification: violations || completed ? 'modeled' : 'unknown', candidateViolation: violations > 0,
        supportedCompliantPath: compliantPaths > 0, definitiveNegative: false, vulnerabilityAbsenceProven: false, runtimeExploitabilityProven: false },
      semantics: { version: VERSION, basis: 'Declared finite protocols with typed object identity and explicit call outcomes',
        branchFeasibilitySolved: false, namesInferPolicy: false, cancellation: 'only exact declared node outcomes; no invented observed edges',
        loops: 'bounded repeat visits retain witnesses but exhaustion is unknown', policyCorrectnessProven: false },
      assumptions: ['Protocol states, terminal obligations, outcome annotations and summaries are declared model assumptions: ' + q.model.provenance,
        'No business transaction or external effect is inferred from a name. Unknown bodies, aliasing and control remain unknown.',
        'Captured structural branches overapproximate feasibility; candidate violations and compliant paths do not prove runtime behavior or absence.'] };
  }
  async function analyze(index, input, runtime, enrichStep) { return run(index, input, runtime, enrichStep, null); }
  async function walk(index, input, runtime, hooks, enrichStep) {
    // The seam is callable only by product code. Reuse strict budget validation
    // through an inert valid protocol, then remove it before interpretation.
    if (!hooks || typeof hooks.event !== 'function' || !index || !index.capability || index.capability.version !== VERSION ||
        !(index.procedures instanceof Map) || !(index.calls instanceof Map) || !(index.edges instanceof Map) || !(index.nodes instanceof Map)) fail('internal walker requires validated ownership indexes and observer');
    var seed = normalize({ op: 'failureObligations', function: input.function,
      timeoutMs: input.timeoutMs, budgets: input.budgets,
      model: { version: 1, provenance: 'internal-resource-walker-v1', rules: [{ id: 'internal', states: ['idle'], initial: 'idle',
        terminal: { normal: ['idle'], error: ['idle'], unwind: ['idle'], cancel: ['idle'], drop: ['idle'] },
        transitions: [{ id: 'inert', call: 'internal-inert', outcome: 'normal', subject: { port: 'argument', index: 0 }, from: ['idle'], to: 'idle' }] }], summaries: input.summaries || [] } });
    seed.model.rules = [];
    return run(index, seed, runtime, enrichStep, hooks);
  }
  return { VERSION: VERSION, LIMITS: copy(LIMITS), normalize: normalize, build: build, analyze: analyze, walk: walk };
});
