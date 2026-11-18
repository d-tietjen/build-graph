/* Exact guard obligations over supported execution prefixes. Portable API/worker/fallback. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GuardObligations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'guard-obligations-v1', CAPABILITY = 'rustc-mir-guards-v1';
  var LIMITS = { maxWork: 2000000, maxStates: 50000, maxEvidence: 1000 };
  function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function text(x) { return typeof x === 'string' && x.length > 0 && x.length <= 16384; }
  function integer(x) { return Number.isSafeInteger(x) && x >= 0; }
  function keys(x, allowed) { return Object.keys(x).every(function (k) { return allowed.includes(k); }); }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function fail(message) { var e = new Error(message); e.code = 'INVALID_GUARD_OBLIGATIONS'; throw e; }
  function normalize(input) {
    var q = copy(input);
    if (!object(q) || q.op !== 'guardObligations' || !text(q.function) ||
        !keys(q, ['op','function','model','budgets','timeoutMs','scope','page'])) fail('guardObligations requires an exact function and model');
    if (!object(q.model) || q.model.version !== 1 || !keys(q.model, ['version','rules','summaries']) ||
        !Array.isArray(q.model.rules) || !q.model.rules.length || q.model.rules.length > 32) fail('model.version:1 requires 1..32 rules');
    var ids = new Set(), summaryCalls = new Set();
    function id(r) { if (!object(r) || !text(r.id) || ids.has(r.id)) fail('unique rule/requirement/summary IDs required'); ids.add(r.id); }
    function endpoint(e) {
      if (!object(e) || !text(e.call) || !object(e.bindings) || !keys(e, ['call','bindings'])) fail('endpoint requires exact call and argument bindings');
      var names = Object.keys(e.bindings);
      if (!names.length || names.length > 16 || !names.every(text)) fail('1..16 named subject/value bindings required');
      names.forEach(function (name) {
        var p = e.bindings[name];
        if (!object(p) || !keys(p, ['index','fields']) || !integer(p.index)) fail('binding requires argument index and optional fields');
        p.fields = p.fields || [];
        if (!Array.isArray(p.fields) || p.fields.length > 16 || !p.fields.every(integer)) fail('at most 16 typed field indices');
      });
    }
    q.model.rules.forEach(function (r) {
      id(r); if (!keys(r, ['id','operation','requires']) || !Array.isArray(r.requires) || !r.requires.length || r.requires.length > 16) fail('rule requires operation and 1..16 guard requirements');
      endpoint(r.operation);
      r.requires.forEach(function (g) {
        id(g); if (!keys(g, ['id','at','success']) || typeof g.success !== 'boolean') fail('requirement requires at and boolean success');
        endpoint(g.at);
        if (JSON.stringify(Object.keys(g.at.bindings).sort()) !== JSON.stringify(Object.keys(r.operation.bindings).sort())) fail('guard and operation must bind the same named subjects/values');
      });
    });
    q.model.summaries = q.model.summaries || [];
    if (!Array.isArray(q.model.summaries) || q.model.summaries.length > 100) fail('at most 100 summaries');
    q.model.summaries.forEach(function (s) {
      id(s); if (!keys(s, ['id','version','call','returns','argument','effects']) || s.version !== 1 || !text(s.call) || summaryCalls.has(s.call) ||
          !['fresh','argument'].includes(s.returns) || s.effects !== 'none' ||
          s.returns === 'argument' && !integer(s.argument) || s.returns === 'fresh' && s.argument != null) fail('summary requires version:1, exact call, returns:fresh|argument, effects:none');
      if (q.model.rules.some(function (r) { return r.operation.call === s.call; })) fail('pure helper summary cannot replace the declared sensitive operation');
      summaryCalls.add(s.call);
    });
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!integer(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000) fail('timeoutMs must be 1..5000');
    if (q.budgets != null && !object(q.budgets)) fail('budgets must be an object');
    q.budgets = Object.assign({ maxWork: LIMITS.maxWork, maxStates: LIMITS.maxStates, maxEvidence: 200 }, q.budgets || {});
    Object.keys(q.budgets).forEach(function (k) { if (!LIMITS[k] || !integer(q.budgets[k]) || q.budgets[k] < 1 || q.budgets[k] > LIMITS[k]) fail('invalid budget ' + k); });
    if (JSON.stringify(q).length > 262144) fail('guard model exceeds 256 KiB');
    return q;
  }
  // ValueFlow.build already validates ownership, typed places, call arguments and
  // control continuations. Guard facts are independent: legacy value v1 is unchanged.
  function build(valueIndex, model) {
    var procedures = new Map();
    valueIndex.procedures.forEach(function (entry, id) {
      var g = entry.flow && entry.flow.guard_facts, status = entry.status, reason = entry.reason, branches = new Map(), functionValues = new Map();
      if (status === 'captured') {
        status = 'unavailable'; reason = 'legacy capture has no typed guard capability';
        if (g != null) try {
          if (!object(g) || g.version !== 1 || g.capability !== CAPABILITY || g.status !== 'captured' || !Array.isArray(g.branches) || !Array.isArray(g.function_values)) fail('unsupported guard capability');
          var controls = new Map(entry.flow.blocks.filter(function (b) { return b.kind === 'branch'; }).map(function (b) { return [b.id, b]; }));
          if (g.branches.length !== controls.size) fail('guard/control branch count mismatch');
          g.branches.forEach(function (b) {
            var control = object(b) && controls.get(b.block);
            if (!control || branches.has(b.block) || !['boolean','unsupported'].includes(b.kind)) fail('malformed guard branch ownership');
            if (b.kind === 'boolean') {
              var d = b.discriminant;
              if (!object(d) || !['copy','move'].includes(d.kind) || !object(d.place) || !integer(d.place.local) ||
                  !entry.locals.has(d.place.local) || !Array.isArray(d.place.projection) || d.place.projection.length > 16 ||
                  !d.place.projection.every(function (p) { return object(p) && p.kind === 'field' && integer(p.index); }) ||
                  !Array.isArray(b.targets) || b.targets.length !== 2 || b.targets[0].value !== false || b.targets[1].value !== true ||
                  !b.targets.every(function (t) { return object(t) && text(t.target) && control.successors.some(function (s) { return s.kind === 'normal' && s.target === t.target; }); }) ||
                  control.successors.some(function (s) { return s.kind !== 'normal' || !b.targets.some(function (t) { return t.target === s.target; }); })) fail('malformed boolean outcome correlation');
              var shape = entry.locals.get(d.place.local).shape;
              d.place.projection.forEach(function (p) { shape = shape && shape.kind === 'fields' && shape.fields[p.index]; });
              if (!shape || shape.kind !== 'scalar') fail('unsupported boolean discriminant place');
            }
            branches.set(b.block, b);
          });
          var statements = new Map(entry.facts.blocks.flatMap(function (b) { return b.statements; }).map(function (s) { return [s.id, s]; }));
          g.function_values.forEach(function (r) {
            var found = object(r) && statements.get(r.statement);
            if (!object(r) || r.kind !== 'function-pointer' || !text(r.function_id) || functionValues.has(r.statement) || !found ||
                found.kind !== 'assign' || found.value.kind !== 'unsupported' || found.value.reason !== 'pointer/representation cast' ||
                JSON.stringify(r.destination) !== JSON.stringify(found.destination) || !Array.isArray(found.value.operands) || found.value.operands.length !== 1 ||
                JSON.stringify(r.source) !== JSON.stringify(found.value.operands[0]) || r.source_file !== found.source_file ||
                r.source_location !== found.source_location) fail('malformed function-pointer reification');
            functionValues.set(r.statement, r);
          });
          status = 'captured'; reason = null;
        } catch (error) { status = 'invalid'; reason = error.message; }
      }
      procedures.set(id, { value: entry, status: status, reason: reason, branches: branches, functionValues: functionValues });
    });
    return { procedures: procedures, calls: valueIndex.calls, edges: new Map(model.edges.map(function (e) { return [e.id, copy(e)]; })), capability: { version: VERSION, capability: CAPABILITY, factVersion: 1, modelVersion: 1,
      availableProcedures: Array.from(procedures.values()).filter(function (e) { return e.status === 'captured'; }).length,
      unavailableProcedures: Array.from(procedures.values()).filter(function (e) { return e.status !== 'captured'; }).length } };
  }
  async function analyze(index, input, runtime) {
    var q = normalize(input), control = runtime || {}, now = control.now || Date.now, start = now();
    var work = 0, states = 0, serial = 0, lastYield = 0, cancelled = false, timedOut = false, budget = false, truncated = false;
    var gaps = new Map(), rows = [], total = 0, bypass = false, compliant = false, contexts = 0, emittedSteps = 0, STOP = {}, FRONTIER = {};
    function tick(n) {
      work += n || 1; cancelled = cancelled || !!(control.cancelled && control.cancelled()); timedOut = timedOut || now() - start >= q.timeoutMs;
      budget = budget || work > q.budgets.maxWork || states > q.budgets.maxStates;
      if (cancelled || timedOut || budget) throw STOP;
    }
    async function cooperate() { if (work - lastYield >= 512) { await new Promise(function (r) { setTimeout(r, 0); }); lastYield = work; tick(); } }
    function clone(v) { var str = JSON.stringify(v); tick(str.length + 1); return JSON.parse(str); }
    function gap(kind, procedure, detail) { tick(); var key = JSON.stringify([kind,procedure,detail]); gaps.set(key, { kind: kind, procedure: procedure, detail: detail, classification: 'unknown' }); }
    function frontier(kind, f, detail) { gap(kind, f && f.procedure || q.function, detail || null); throw FRONTIER; }
    function token() { tick(); return 'g' + (++serial); }
    function packet(shape, prefix) {
      tick(); if (!shape || !['scalar','fields'].includes(shape.kind)) return { identity: null, guards: [] };
      var p = { identity: prefix || token(), guards: [] };
      if (shape.kind === 'fields') p.fields = shape.fields.map(function (s, i) { return packet(s, p.identity + '/' + i); });
      return p;
    }
    function add(s, step) { tick(); s.history = { step: step, parent: s.history }; }
    function step(f, b, kind, extra) {
      return Object.assign({ kind: kind, procedure: f.procedure, sourceProcedure: f.procedure, invocationId: f.invocation,
        nodeId: f.procedure + '#' + b.id, source: { source_file: b.source_file || null, source_location: b.source_location || null } }, extra || {});
    }
    function frame(proc, args, bindings, continuation) {
      tick(); var e = index.procedures.get(proc);
      if (!e || e.status !== 'captured') frontier(e ? e.reason : 'missing-body', { procedure: proc }, continuation && continuation.call);
      if (args && args.length !== e.value.facts.parameter_locals.length) frontier('call-argument-arity-mismatch', { procedure: proc }, continuation.call);
      if (!e.value.flow.blocks.some(function (b) { tick(); return b.id === e.value.flow.entry; })) frontier('missing-body-entry', { procedure: proc });
      var slots = {}, invocation = 'invocation:' + (++contexts);
      e.value.facts.locals.forEach(function (l) { tick(); slots[l.local] = { identity: null, guards: [] }; });
      e.value.facts.parameter_locals.forEach(function (l, i) { tick(); slots[l] = args ? clone(args[i]) : packet(e.value.locals.get(l).shape, invocation + ':parameter:' + i); });
      return { procedure: proc, invocation: invocation, block: e.value.flow.entry, slots: slots, bindings: bindings || {}, visited: [], continuation: continuation || null };
    }
    function select(p, fields, f) {
      for (var part of fields) { tick(); if (!p || !p.fields || !p.fields[part]) frontier('unsupported-field-binding', f, String(part)); p = p.fields[part]; }
      if (!p || !p.identity) frontier('unknown-value-identity', f);
      return clone(p);
    }
    function read(f, place) {
      if (!place || !Array.isArray(place.projection) || place.projection.some(function (p) { tick(); return p.kind !== 'field'; })) frontier('unsupported-reference-or-projection', f);
      return select(f.slots[place.local], place.projection.map(function (p) { return p.index; }), f);
    }
    function operand(f, o) {
      tick(); return o.kind === 'constant' ? { identity: token(), guards: [], opaque: true } : read(f, o.place);
    }
    function shapeOf(f, place) {
      if (!place) return null;
      var entry = index.procedures.get(f.procedure).value, local = entry.locals.get(place.local), shape = local && local.shape;
      for (var part of place.projection) { tick(); shape = part.kind === 'field' && shape && shape.kind === 'fields' ? shape.fields[part.index] : null; }
      return shape;
    }
    function write(f, place, p) {
      tick(); if (!place || place.projection.some(function (v) { tick(); return v.kind !== 'field'; })) frontier('unsupported-reference-write', f);
      if (!place.projection.length) { f.slots[place.local] = clone(p); return; }
      var owner = f.slots[place.local];
      for (var i = 0; i < place.projection.length; i++) {
        tick(); var field = place.projection[i].index;
        if (!owner || !owner.fields || !owner.fields[field]) frontier('unsupported-field-write', f);
        owner.identity = token(); owner.guards = [];
        if (i === place.projection.length - 1) owner.fields[field] = clone(p); else owner = owner.fields[field];
      }
    }
    function fullyKnown(p) { tick(); return !!(p && p.identity && !p.opaque && (!p.fields || p.fields.every(fullyKnown))); }
    function bindings(endpoint, args, f) {
      var out = Object.create(null);
      Object.keys(endpoint.bindings).sort().forEach(function (name) {
        var p = endpoint.bindings[name]; tick(); var value = select(args[p.index], p.fields, f);
        if (!fullyKnown(value)) frontier('opaque-subject-or-value-binding', f, name);
        out[name] = value.identity;
      }); return out;
    }
    function childBindings(c, f, args) {
      var out = {};
      c.callbackArgs.forEach(function (arg) {
        tick(); if (!object(arg) || !integer(arg.index) || out[arg.index] || !Array.isArray(arg.targets) ||
            Object.prototype.hasOwnProperty.call(arg, 'unknown') && typeof arg.unknown !== 'boolean' || arg.parameter != null && !integer(arg.parameter)) frontier('ambiguous-callback-binding', f, c.id);
        var targets = arg.targets.slice(), inherited = arg.parameter == null ? null : f.bindings[arg.parameter];
        if (arg.unknown || arg.parameter != null && !inherited) frontier('unknown-callback-binding', f, c.id);
        if (inherited) targets = targets.concat(inherited);
        targets = Array.from(new Set(targets));
        if (targets.length !== 1 || !index.procedures.has(targets[0])) frontier('unsupported-callback-target', f, c.id);
        var supplied = args[arg.index], targetEntry = index.procedures.get(targets[0]);
        if (!supplied || supplied.functionId && supplied.functionId !== targetEntry.value.procedure.function_id) frontier('contradictory-function-pointer-binding', f, c.id);
        out[arg.index] = targets;
      }); return out;
    }
    function target(c, f) {
      tick(); var targets = c.callbackParameter == null ? c.targets : f.bindings[c.callbackParameter] || [];
      if (c.nativeCall || c.possibleDispatch || c.possibleUnknown && c.callbackParameter == null || c.idMismatch || c.legacyUnverified || c.unknown || targets.length !== 1)
        frontier('unsupported-call-target', f, c.id);
      return targets[0];
    }
    function callBoundary(c, f, cv, args, chosen) {
      var targets = c.callbackParameter == null ? c.targets : f.bindings[c.callbackParameter] || [];
      var known = targets.length === 1 && !c.possibleDispatch && !c.idMismatch && !c.legacyUnverified && index.procedures.get(targets[0]);
      if (known && known.value.status === 'captured' && args.length !== known.value.facts.parameter_locals.length)
        frontier('call-argument-arity-mismatch', f, c.id);
      if (cv.function.kind !== 'constant') {
        var active = operand(f, cv.function), selected = index.procedures.get(chosen || target(c, f));
        if (!active.functionId || !selected || active.functionId !== selected.value.procedure.function_id)
          frontier('contradictory-or-unproven-function-pointer', f, c.id);
      }
    }
    function record(s, f, b, rule, args) {
      var inputBindings = bindings(rule.operation, args, f), results = rule.requires.map(function (r) {
        var attempts = s.attempts.filter(function (a) { return a.requirementId === r.id; });
        var matched = attempts.find(function (a) { return a.success && Object.keys(inputBindings).every(function (k) { return a.bindings[k] === inputBindings[k]; }); });
        return { requirementId: r.id, guardCall: r.at.call, requiredOutcome: r.success, satisfied: !!matched,
          successfulInvocation: matched && matched.invocationId || null, attempts: clone(attempts),
          reason: matched ? 'same-path-success-and-exact-bindings' : !attempts.length ? 'missing-successful-check' :
            attempts.some(function (a) { return a.success; }) ? 'subject-or-value-binding-not-proven' :
              attempts.some(function (a) { return a.outcome != null; }) ? 'failed-guard-outcome' : 'ignored-or-unchecked-result' };
      });
      var satisfied = results.every(function (r) { return r.satisfied; });
      bypass = bypass || !satisfied; compliant = compliant || satisfied; total++;
      add(s, step(f, b, 'sensitive-operation', { callsiteId: rule.operation.call, ruleId: rule.id, bindings: inputBindings }));
      if (rows.length >= q.budgets.maxEvidence) { truncated = true; return; }
      var steps = [], h = s.history;
      while (h) { tick(); if (emittedSteps >= q.budgets.maxEvidence) { truncated = true; break; } emittedSteps++; steps.push(h.step); h = h.parent; }
      rows.push({ ruleId: rule.id, operation: clone(rule.operation), classification: satisfied ? 'supported-compliant' : 'bypass',
        bindings: inputBindings, requirements: results, steps: steps.reverse(), truncated: !!h });
    }
    function finishCall(s, f, b, callValues, result, c, rule) {
      rule.requires.filter(function (r) { return r.at.call === c.id; }).forEach(function (r) {
        var a = { id: token(), requirementId: r.id, callsiteId: c.id, invocationId: f.invocation,
          bindings: bindings(r.at, callValues.arguments, f), resultIdentity: result.identity, success: false, outcome: null };
        if (!a.resultIdentity) frontier('unknown-guard-result', f, c.id);
        s.attempts.push(a); result.guards.push(a.id);
        add(s, step(f, b, 'guard-result', { callsiteId: c.id, requirementId: r.id, resultIdentity: result.identity, bindings: a.bindings }));
      });
      if (!callValues.destination) frontier('unsupported-tail-call', f, c.id);
      write(f, callValues.destination, result);
      if (c.normal.length !== 1) frontier('unsupported-normal-continuation', f, c.id);
      var edge = index.edges.get(c.normal[0]), continuation = edge && edge.to;
      if (!edge || edge.callsite !== c.id || edge.action !== 'normal' || typeof continuation !== 'string' ||
          !continuation.startsWith(f.procedure + '#')) frontier('missing-call-continuation', f, c.id);
      f.block = continuation.slice((f.procedure + '#').length);
      add(s, step(f, b, 'return-to-continuation', { callsiteId: c.id, continuationId: continuation, edgeId: edge.id }));
    }
    try {
      for (var rule of q.model.rules) {
        var summaries = new Map(q.model.summaries.map(function (s) { return [s.call, s]; }));
        var selections = [rule.operation.call].concat(rule.requires.map(function (r) { return r.at.call; }), Array.from(summaries.keys()));
        if (selections.some(function (id) { tick(); return !index.calls.has(id); })) { gap('unavailable-exact-call-selection', q.function, rule.id); continue; }
        var queue = [];
        try { queue.push({ frames: [frame(q.function)], attempts: [], constraints: {}, history: null }); } catch (e) { if (e !== FRONTIER) throw e; }
        while (queue.length) {
          await cooperate(); tick(); states++;
          var s = queue.pop(), f = s.frames[s.frames.length - 1], e = index.procedures.get(f.procedure), entry = e.value;
          var b = entry.flow.blocks.find(function (b) { tick(); return b.id === f.block; });
          var values = entry.facts.blocks.find(function (v) { tick(); return v.id === f.block; });
          try {
            if (!b || !values) frontier('missing-block', f, f.block);
            if (f.visited.includes(b.id)) frontier('loop-frontier', f, b.id);
            f.visited.push(b.id); add(s, step(f, b, 'node'));
            for (var statement of values.statements) {
              await cooperate(); tick();
              if (statement.kind === 'unsupported') frontier('unsupported-memory-effect', f, statement.id);
              if (statement.kind === 'storage') { f.slots[statement.local] = { identity: null, guards: [] }; continue; }
              if (statement.kind !== 'assign') continue;
              var v = statement.value, p;
              if (v.kind === 'use') p = operand(f, v.operands[0]);
              else if (v.kind === 'aggregate') p = { identity: token(), guards: [], fields: v.operands.map(function (o) { return operand(f, o); }) };
              else if (e.functionValues.has(statement.id)) p = { identity: token(), guards: [], functionId: e.functionValues.get(statement.id).function_id };
              else if (v.kind === 'compute') { v.operands.forEach(function (o) { operand(f, o); }); p = packet(shapeOf(f, statement.destination)); }
              else frontier('unsupported-value-operation', f, statement.id);
              write(f, statement.destination, p);
              add(s, step(f, b, 'assignment', { factId: statement.id, identity: p.identity, place: clone(statement.destination), source: {
                source_file: statement.source_file || null, source_location: statement.source_location || null } }));
            }
            if (values.call) {
              var c = index.calls.get(f.procedure + '#' + b.id + '@call'), cv = values.call;
              if (!c || cv.argument_convention !== 'direct') frontier('unsupported-call-abi', f, c && c.id);
              var args = cv.arguments.map(function (o) { return operand(f, o); }), summary = summaries.get(c.id), chosen = null;
              if (!summary) chosen = target(c, f);
              callBoundary(c, f, cv, args, chosen);
              add(s, step(f, b, 'call', { callsiteId: c.id, target: chosen, normal: clone(c.normal), unwind: clone(c.unwind) }));
              if (c.id === rule.operation.call) { record(s, f, b, rule, args); continue; }
              if (c.unwind.some(function (id) { var edge = index.edges.get(id); return !edge || edge.to.startsWith(f.procedure + '#bb'); })) gap('unwind-frontier', f.procedure, c.id);
              if (summary) {
                var result = summary.returns === 'argument' ? select(args[summary.argument], [], f) : packet(shapeOf(f, cv.destination));
                add(s, step(f, b, 'declared-summary', { callsiteId: c.id, summaryId: summary.id, summaryVersion: summary.version }));
                finishCall(s, f, b, { arguments: args, destination: cv.destination }, result, c, rule); queue.push(s); continue;
              }
              if (s.frames.some(function (p) { return p.procedure === chosen; })) frontier('recursion-frontier', f, c.id);
              var child = frame(chosen, args, childBindings(c, f, args), { call: c.id, arguments: args, destination: cv.destination, block: b.id });
              s.frames.push(child); add(s, step(child, index.procedures.get(chosen).value.flow.blocks.find(function (b) { return b.id === child.block; }), 'procedure-entry', { caller: f.procedure, callsiteId: c.id, target: chosen }));
              queue.push(s); continue;
            }
            if (b.kind === 'return') {
              if (s.frames.length === 1) continue;
              var returned = read(f, { local: 0, projection: [] }), ret = f.continuation;
              s.frames.pop(); var parent = s.frames[s.frames.length - 1], pe = index.procedures.get(parent.procedure).value;
              var pb = pe.flow.blocks.find(function (b) { return b.id === ret.block; });
              finishCall(s, parent, pb, ret, returned, index.calls.get(ret.call), rule); queue.push(s); continue;
            }
            if (['unreachable','abort','unwind'].includes(b.kind)) continue;
            if (!['goto','branch'].includes(b.kind)) frontier('unsupported-control', f, b.id);
            var branch = e.branches.get(b.id);
            if (b.kind === 'branch' && (!branch || branch.kind !== 'boolean')) frontier('unsupported-branch-outcome', f, b.id);
            if (b.kind === 'goto' && b.successors.some(function (edge) { return edge.kind !== 'normal' || !edge.target; })) frontier('unsupported-control-successor', f, b.id);
            var choices = b.kind === 'branch' ? branch.targets : b.successors;
            var discr = b.kind === 'branch' ? operand(f, branch.discriminant) : null;
            for (var choice of choices) {
              tick(); if (b.kind === 'branch' && Object.prototype.hasOwnProperty.call(s.constraints, discr.identity) && s.constraints[discr.identity] !== choice.value) continue;
              var next = { frames: clone(s.frames), attempts: clone(s.attempts), constraints: clone(s.constraints), history: s.history };
              var nf = next.frames[next.frames.length - 1]; nf.block = choice.target;
              if (discr) {
                next.constraints[discr.identity] = choice.value;
                next.attempts.forEach(function (a) {
                  if (!discr.guards.includes(a.id)) return;
                  var requirement = rule.requires.find(function (r) { return r.id === a.requirementId; });
                  a.outcome = choice.value; a.success = choice.value === requirement.success;
                  add(next, step(f, b, 'guard-outcome', { callsiteId: a.callsiteId, requirementId: a.requirementId,
                    guardInvocationId: a.invocationId, outcome: choice.value, requiredOutcome: requirement.success, successful: a.success }));
                });
              }
              add(next, step(f, b, 'branch', { outcome: discr ? choice.value : null, targetNodeId: f.procedure + '#' + choice.target })); queue.push(next);
            }
          } catch (error) { if (error !== FRONTIER) throw error; }
        }
      }
    } catch (error) { if (error !== STOP) throw error; }
    var partial = gaps.size > 0 || budget || cancelled || timedOut;
    return { schemaVersion: 1, operation: 'guardObligations', status: cancelled || timedOut ? 'cancelled' : partial ? 'indeterminate' : bypass ? 'bypass' : compliant ? 'supported-compliant' : 'not-reached',
      partialCoverage: partial, capability: copy(index.capability), rules: copy(q.model.rules),
      witnesses: { total: total, items: rows, truncated: truncated },
      queryCoverage: { partial: partial, gaps: Array.from(gaps.values()).slice(0, q.budgets.maxEvidence), totalGaps: gaps.size,
        gapsTruncated: gaps.size > q.budgets.maxEvidence, contexts: contexts, scope: 'prefixes from the explicit root through each declared sensitive call' },
      completion: { complete: !budget && !cancelled && !timedOut, cancelled: cancelled, timedOut: timedOut, budgetExceeded: budget,
        evidenceComplete: !truncated && gaps.size <= q.budgets.maxEvidence, work: work, states: states, limits: q.budgets, timeoutMs: q.timeoutMs },
      finding: { classification: bypass || compliant ? 'modeled' : 'unknown', candidateBypass: bypass, supportedCompliantPath: compliant,
        definitiveNegative: false, vulnerabilityAbsenceProven: false, runtimeExploitabilityProven: false },
      semantics: { version: VERSION, basis: 'Declared successful guard obligations and exact value identities on supported captured structural prefixes',
        branchFeasibilitySolved: false, namesInferPolicy: false, binding: 'copy/parameter/return/field identity; computations replace identity; no may-taint label equality',
        loops: 'repeated blocks and recursion stop at an explicit unknown frontier', policyCorrectnessProven: false },
      assumptions: ['The declared operation, required boolean success and named argument bindings define the business policy.',
        'Only supported captured prefixes are inspected; structural branch feasibility and policy correctness are unproven.',
        'A supported compliant path is scoped evidence, never universal compliance or vulnerability absence.'].concat(q.model.summaries.map(function (s) {
          return 'Declared summary ' + s.id + '@' + s.version + ' for exact ' + s.call + ': returns ' + s.returns + ', effects none.';
        })) };
  }
  return { VERSION: VERSION, CAPABILITY: CAPABILITY, normalize: normalize, build: build, analyze: analyze };
});
