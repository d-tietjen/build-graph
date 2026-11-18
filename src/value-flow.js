/* Optional typed MIR value analysis. One portable engine for API, worker and fallback. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ValueFlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'mir-values-v1', CAPABILITY = 'rustc-mir-values-v1';
  var LIMITS = { maxWork: 2000000, maxStates: 50000, maxEvidence: 1000 };
  function fail(message) { var e = new Error(message); e.code = 'INVALID_VALUE_FLOW'; throw e; }
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function text(x) { return typeof x === 'string' && x.length > 0 && x.length <= 16384; }
  function integer(x) { return Number.isSafeInteger(x) && x >= 0; }
  function keys(x, allowed) { return Object.keys(x).every(function (k) { return allowed.includes(k); }); }
  function normalize(input) {
    var q = copy(input);
    if (!object(q) || q.op !== 'valueFlow' || !text(q.function)) fail('valueFlow requires an exact function procedure ID');
    if (!keys(q, ['op','function','model','budgets','timeoutMs','scope','page'])) fail('unknown valueFlow request field');
    if (!object(q.model) || q.model.version !== 1 || !keys(q.model, ['version','sources','sinks','summaries'])) fail('model.version must be 1');
    var ids = new Set();
    function port(p) {
      if (!object(p) || !keys(p, ['call','procedure','port','index','fields']) || (p.call != null) === (p.procedure != null) ||
          !text(p.call || p.procedure) || !['argument','result','parameter','return'].includes(p.port) ||
          p.call != null && !['argument','result'].includes(p.port) || p.procedure != null && !['parameter','return'].includes(p.port) ||
          ['argument','parameter'].includes(p.port) && !integer(p.index) || ['result','return'].includes(p.port) && p.index != null)
        fail('endpoint requires one exact call/procedure and its indexed argument/parameter or result/return');
      p.fields = p.fields || [];
      if (!Array.isArray(p.fields) || p.fields.length > 16 || !p.fields.every(integer)) fail('fields requires at most 16 typed field indices');
      return p;
    }
    ['sources','sinks','summaries'].forEach(function (list) {
      q.model[list] = q.model[list] || [];
      if (!Array.isArray(q.model[list]) || q.model[list].length > 100) fail(list + ' accepts at most 100 rules');
      q.model[list].forEach(function (r) {
        if (!object(r) || !text(r.id) || ids.has(r.id)) fail('rules require unique nonempty IDs');
        ids.add(r.id);
        if (list !== 'summaries') {
          if (!keys(r, ['id','at'])) fail('unknown endpoint rule field');
          r.at = port(r.at);
        } else {
          if (!keys(r, ['id','version','call','kind','from','to','referenceEffects']) || r.version !== 1 || !text(r.call) ||
              !['transfer','sanitize'].includes(r.kind) || !Array.isArray(r.from) || r.from.length > 32 || !r.from.every(integer) ||
              r.to !== 'result' || !['none','unknown'].includes(r.referenceEffects))
            fail('summary requires version 1, exact call, transfer/sanitize, from argument indices, to:result and referenceEffects:none|unknown');
          if (r.kind === 'sanitize' && r.from.length) fail('sanitizer result has no transferred inputs');
        }
      });
    });
    if (!q.model.sources.length || !q.model.sinks.length) fail('at least one source and sink is required');
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!integer(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000) fail('timeoutMs must be 1..5000');
    if (q.budgets != null && !object(q.budgets)) fail('budgets must be an object');
    q.budgets = Object.assign({ maxWork: LIMITS.maxWork, maxStates: LIMITS.maxStates, maxEvidence: 200 }, q.budgets || {});
    Object.keys(q.budgets).forEach(function (k) {
      if (!LIMITS[k] || !integer(q.budgets[k]) || q.budgets[k] < 1 || q.budgets[k] > LIMITS[k]) fail('invalid budget ' + k);
    });
    if (JSON.stringify(q).length > 262144) fail('value model exceeds 256 KiB');
    return q;
  }
  function build(graph, model) {
    var raw = new Map(graph.nodes.map(function (n) { return [n.id, n]; }));
    var claims = new Map(), flows = new Map(), procedures = new Map(), calls = new Map();
    graph.nodes.forEach(function (n) {
      if ((n.attributes || {}).kind !== 'flow_function') return;
      try { var f = typeof n.attributes.flow === 'string' ? JSON.parse(n.attributes.flow) : copy(n.attributes.flow);
        flows.set(n.id, f);
        if (f && typeof f.function === 'string') claims.set(f.function, (claims.get(f.function) || 0) + 1);
      } catch (_) { /* An unavailable body has no invented value facts. */ }
    });
    model.calls.forEach(function (c) { calls.set(c.id, copy(c)); });
    model.procedures.forEach(function (p) {
      // Only the raw node actually accepted by Model can own these facts.
      var n = raw.get(p.rawFlowNodeId), flow = n && flows.get(n.id), attrs = n && n.attributes || {};
      var snapshot = n ? { id: n.id, source_file: n.source_file || null, source_location: n.source_location || null, attributes: copy({
        unit_key: attrs.unit_key, source_digest: attrs.source_digest, source_absolute: attrs.source_absolute, target_src_path: attrs.target_src_path }) } : null;
      var entry = { procedure: copy(p), raw: snapshot, flow: flow, facts: flow && flow.value_facts,
        status: 'unavailable', reason: 'legacy capture has no typed value capability' };
      if (!n || !flow || flow.function !== p.id || !text(flow.function_id) || flow.function_id !== p.function_id ||
          !text(attrs.function_id) || attrs.function_id !== flow.function_id ||
          attrs.path != null && attrs.path !== p.id || claims.get(p.id) !== 1) {
        entry.reason = 'missing or ambiguous imported value-body ownership';
      } else if (entry.facts != null) {
        try { validate(entry); entry.status = 'captured'; entry.reason = null; }
        catch (error) { entry.status = 'invalid'; entry.reason = error.message; }
      }
      entry.locals = new Map(entry.status === 'captured' ? entry.facts.locals.map(function (l) { return [l.local, l]; }) : []);
      entry.localKinds = new Map(entry.status === 'captured' ? entry.facts.locals.map(function (l) { return [l.local, l.kind]; }) : []);
      procedures.set(p.id, entry);
    });
    function validate(e) {
      var f = e.facts;
      if (!object(f) || f.version !== 1 || f.capability !== CAPABILITY || f.status !== 'captured' ||
          f.return_local !== 0 || !Array.isArray(f.locals) || f.locals.length > 100000 || !Array.isArray(f.parameter_locals) ||
          !Array.isArray(f.blocks) || f.blocks.length !== e.flow.blocks.length) fail('unsupported or malformed value capability');
      var locals = new Set(), declarations = new Map(), parameters = [], shapeWork = 0;
      function shape(v, depth) {
        if (++shapeWork > 1000000 || depth > 16 || !object(v) || !['scalar','fields','reference','unknown'].includes(v.kind)) fail('malformed compiler value shape');
        if (v.kind === 'fields') { if (!Array.isArray(v.fields) || v.fields.length > 10000) fail('malformed compiler fields'); v.fields.forEach(function (f) { shape(f, depth + 1); }); }
        if (v.kind === 'reference') shape(v.target, depth + 1);
      }
      function span(s) { if (s.source_file != null && typeof s.source_file !== 'string' || s.source_location != null && (!integer(s.source_location) || s.source_location < 1)) fail('malformed value source span'); }
      f.locals.forEach(function (l) {
        if (!object(l) || !integer(l.local) || locals.has(l.local) || typeof l.type !== 'string' ||
            !['value','reference','raw_pointer'].includes(l.kind) || !['local','parameter','return'].includes(l.role)) fail('malformed local');
        if ((l.local === f.return_local) !== (l.role === 'return')) fail('malformed parameter/return locals');
        if (l.role === 'parameter') parameters.push(l.local);
        span(l); if (l.shape != null) { shape(l.shape, 0); if ((l.kind === 'reference') !== (l.shape.kind === 'reference') && l.shape.kind !== 'unknown') fail('conflicting compiler local kind'); } locals.add(l.local); declarations.set(l.local, l);
      });
      if (!locals.has(0) || f.parameter_locals.length !== parameters.length ||
          !f.parameter_locals.every(function (l, i) { return l === i + 1 && l === parameters[i]; })) fail('malformed parameter/return locals');
      function sameShape(a, b) {
        if (!a || !b || a.kind === 'unknown' || b.kind === 'unknown') return true;
        if (a.kind !== b.kind) return false;
        if (a.kind === 'reference') return sameShape(a.target, b.target);
        return a.kind !== 'fields' || a.fields.length === b.fields.length && a.fields.every(function (f, i) { return sameShape(f, b.fields[i]); });
      }
      function place(p) {
        if (!object(p) || !locals.has(p.local) || !Array.isArray(p.projection) || p.projection.length > 64 || typeof p.type !== 'string') fail('malformed place');
        var current = declarations.get(p.local).shape;
        p.projection.forEach(function (v) {
          if (!object(v) || !['field','deref','unsupported'].includes(v.kind) || v.kind === 'field' && !integer(v.index) ||
              v.kind === 'unsupported' && !text(v.reason)) fail('malformed typed projection');
          if (v.kind === 'unsupported' || !current || current.kind === 'unknown') { current = null; return; }
          if (v.kind === 'field') {
            if (current.kind !== 'fields' || v.index >= current.fields.length) fail('nonexistent compiler field');
            current = current.fields[v.index];
          } else {
            if (current.kind !== 'reference') fail('invalid compiler dereference base');
            current = current.target;
          }
          if (v.shape != null) shape(v.shape, 0);
          if (v.shape != null && !sameShape(v.shape, current)) fail('conflicting compiler projection descriptor');
        });
        if (p.shape != null) { shape(p.shape, 0); if (current && !sameShape(p.shape, current)) fail('conflicting compiler place descriptor'); }
        return current;
      }
      function operand(o) {
        if (!object(o) || !['copy','move','constant'].includes(o.kind)) fail('malformed operand');
        if (o.kind === 'constant') { if (typeof o.type !== 'string') fail('malformed constant'); }
        else place(o.place);
      }
      var blocks = new Set(), facts = new Set(), flowBlocks = new Map(e.flow.blocks.map(function (b) { return [b.id, b]; }));
      f.blocks.forEach(function (b) {
        if (!object(b) || !flowBlocks.has(b.id) || blocks.has(b.id) || !Array.isArray(b.statements) || b.statements.length > 100000) fail('malformed value block');
        blocks.add(b.id);
        var control = flowBlocks.get(b.id);
        if (!['goto','branch','call','tail_call','return','opaque','drop','assert','yield','unwind','abort','unreachable'].includes(control.kind) || !Array.isArray(control.successors) || control.callback_args != null && !Array.isArray(control.callback_args)) fail('malformed value control block');
        if (Object.prototype.hasOwnProperty.call(control, 'callback_unknown') && typeof control.callback_unknown !== 'boolean') fail('malformed callback certainty');
        control.successors.forEach(function (edge) {
          if (!object(edge) || !['normal','unwind'].includes(edge.kind) ||
              edge.target != null && (!flowBlocks.has(edge.target) || edge.action != null) ||
              edge.target == null && !['continue','terminate','unreachable'].includes(edge.action) ||
              edge.action != null && !['continue','terminate','unreachable'].includes(edge.action)) fail('malformed value control successor');
        });
        if (control.kind === 'goto' && control.successors.filter(function (e) { return e.kind === 'normal'; }).length !== 1 ||
            control.kind === 'call' && !control.successors.some(function (e) { return e.kind === 'normal' && e.target != null; }) ||
            control.kind === 'call' && control.successors.some(function (e) { return e.kind === 'normal' && e.target == null; }) ||
            ['goto','branch','assert'].includes(control.kind) && !control.successors.some(function (e) { return e.kind === 'normal' && e.target != null; }) ||
            ['return','tail_call','unreachable'].includes(control.kind) && control.successors.length) fail('malformed value control continuation');
        b.statements.forEach(function (s, i) {
          if (!object(s) || s.id !== b.id + ':s' + i || facts.has(s.id) || !['assign','storage','nop','unsupported'].includes(s.kind)) fail('malformed statement');
          span(s); facts.add(s.id);
          if (s.kind === 'storage' && !locals.has(s.local)) fail('malformed storage local');
          if (s.kind === 'assign') {
            var destinationShape = place(s.destination), v = s.value;
            if (!object(v) || !['use','compute','ref','aggregate','unsupported'].includes(v.kind)) fail('malformed rvalue');
            if (v.kind === 'ref') place(v.place);
            if (v.operands != null && (!Array.isArray(v.operands) || v.operands.length > 10000)) fail('malformed operands');
            (v.operands || []).forEach(operand);
            if (v.kind === 'use' && (!v.operands || v.operands.length !== 1) ||
                ['compute','aggregate'].includes(v.kind) && !Array.isArray(v.operands)) fail('missing operands');
            if (v.kind === 'aggregate' && destinationShape && destinationShape.kind !== 'unknown' &&
                (destinationShape.kind !== 'fields' || destinationShape.fields.length !== v.operands.length)) fail('conflicting compiler aggregate fields');
          }
        });
        var isCall = ['call','tail_call'].includes(flowBlocks.get(b.id).kind);
        if (isCall !== (b.call != null)) fail('call value/control mismatch');
        if (isCall) {
          if (!object(b.call) || !Array.isArray(b.call.arguments) || b.call.arguments.length > 10000) fail('malformed call arguments');
          if (!['direct','fn-trait-tuple'].includes(b.call.argument_convention)) fail('missing typed call argument convention');
          span(b.call); operand(b.call.function); b.call.arguments.forEach(operand);
          if (b.call.destination != null) place(b.call.destination);
          else if (flowBlocks.get(b.id).kind !== 'tail_call') fail('missing call destination');
        }
      });
    }
    return { procedures: procedures, calls: calls,
      capability: { version: VERSION, factVersion: 1, capability: CAPABILITY,
        availableProcedures: Array.from(procedures.values()).filter(function (e) { return e.status === 'captured'; }).length,
        unavailableProcedures: Array.from(procedures.values()).filter(function (e) { return e.status !== 'captured'; }).length,
        status: Array.from(procedures.values()).some(function (e) { return e.status === 'captured'; }) ? 'available' : 'unavailable' } };
  }
  async function analyze(index, request, runtime) {
    var q = normalize(request), control = runtime || {}, now = control.now || Date.now, started = now();
    var work = 0, states = 0, cancelled = false, timedOut = false, budget = false, evidenceTruncated = false;
    var contexts = new Map(), gaps = new Map(), findings = new Map(), proofs = new Map(), stepIds = new WeakMap(), nextStep = 0, nextProof = 0, dirty = true;
    function tick(amount) {
      work += amount || 1;
      cancelled = cancelled || !!(control.cancelled && control.cancelled());
      timedOut = timedOut || now() - started >= q.timeoutMs;
      budget = budget || work > q.budgets.maxWork || states > q.budgets.maxStates;
      if (cancelled || timedOut || budget) throw STOP;
    }
    var STOP = {}, activeEntry = null, yieldedWork = 0;
    async function cooperate() { if (work - yieldedWork >= 1024) { await new Promise(function (r) { setTimeout(r, 0); }); yieldedWork = work; tick(); } }
    function gap(kind, procedure, detail) {
      tick(); var id = JSON.stringify([kind, procedure, detail]);
      if (!gaps.has(id)) gaps.set(id, { kind: kind, procedure: procedure, detail: detail, classification: 'unknown' });
      return id;
    }
    function proof(step, parent) {
      var stepId = stepIds.get(step);
      if (!stepId) { var payload = JSON.stringify(step); tick(payload.length + 1); stepId = ++nextStep; stepIds.set(step, stepId); }
      tick(16); var id = stepId + ':' + (parent ? parent.id : 'root');
      if (!proofs.has(id)) proofs.set(id, { id: 'v' + (++nextProof), step: step, parent: parent || null, unknown: step.classification === 'unknown' || !!(parent && parent.unknown) });
      return proofs.get(id);
    }
    function placeRef(p) { return p && { local: p.local, projection: p.projection.map(function (part) { tick(); return { kind: part.kind, index: part.index }; }) }; }
    function at(ctx, block, record, kind, extra) {
      return Object.assign({ kind: kind, procedure: ctx.proc, sourceProcedure: ctx.proc, nodeId: ctx.proc + '#' + block, contextId: ctx.id,
        factId: record && (record.id || (integer(record.local) ? 'local:' + record.local : null)) || null, source: { source_file: record && record.source_file || null,
          source_location: record && record.source_location || null } }, extra || {});
    }
    function facts() { return new Map(); }
    function union(a, b) { b.forEach(function (p, k) { tick(); if (!a.has(k)) a.set(k, p); }); return a; }
    function tagged(a, step) { var out = facts(); a.forEach(function (p, k) { out.set(k, proof(step, p)); }); return out; }
    function unknown(ctx, block, record, reason, inherited) {
      var id = gap(reason, ctx.proc, record && record.id || block), out = tagged(new Map(inherited || []),
        at(ctx, block, record, 'unknown-propagation', { reason: reason, classification: 'unknown' }));
      out.set('u:' + id, proof(at(ctx, block, record, 'unknown', { reason: reason }))); return out;
    }
    function state() { return { slots: new Map(), aliases: new Map(), masks: new Set(), present: false }; }
    function cloneState(s) { var out = state();
      s.slots.forEach(function (v, k) { tick(); out.slots.set(k, union(facts(), v)); });
      s.aliases.forEach(function (v, k) { tick(); out.aliases.set(k, v); }); s.masks.forEach(function (k) { tick(); out.masks.add(k); }); out.present = s.present; return out; }
    function merge(a, b) {
      if (!b.present) return false; // An evaluation waiting for a return is lattice bottom.
      var changed = false, first = !a.present;
      if (first) { b.masks.forEach(function (k) { tick(); a.masks.add(k); }); a.present = true; changed = true; }
      else Array.from(a.masks).forEach(function (k) { tick(); if (!b.masks.has(k)) { a.masks.delete(k); changed = true; } });
      b.slots.forEach(function (v, k) { tick(); var old = a.slots.get(k) || facts(), size = old.size; union(old, v); a.slots.set(k, old); if (old.size !== size) changed = true; });
      tick(a.aliases.size + b.aliases.size + 1); var aliasKeys = new Set(Array.from(a.aliases.keys()).concat(Array.from(b.aliases.keys())));
      aliasKeys.forEach(function (k) { tick(); var value = first && b.aliases.has(k) ? b.aliases.get(k) : a.aliases.has(k) && b.aliases.has(k) && a.aliases.get(k) === b.aliases.get(k) ? a.aliases.get(k) : null;
        if (!a.aliases.has(k) || a.aliases.get(k) !== value) { a.aliases.set(k, value); changed = true; } });
      return changed;
    }
    function clear(s, key) { tick(s.slots.size + s.aliases.size + s.masks.size + 1); s.present = true;
      Array.from(s.masks).forEach(function (k) { tick(); if (k === key || k.startsWith(key + '/')) s.masks.delete(k); });
      if (key.includes('/')) s.masks.add(key);
      Array.from(s.slots.keys()).forEach(function (k) { tick(); if (k === key || k.startsWith(key + '/')) s.slots.delete(k); });
      Array.from(s.aliases.keys()).forEach(function (k) { tick(); if (k === key || k.startsWith(key + '/')) s.aliases.delete(k); }); }
    function resolve(s, p) {
      var shape = activeEntry && activeEntry.locals.get(p.local), current = shape && shape.shape;
      var key = 'l' + p.local;
      for (var part of p.projection) {
        tick();
        if (part.kind === 'field' && current && current.kind === 'fields' && part.index < current.fields.length) { key += '/f' + part.index; current = current.fields[part.index]; }
        else if (part.kind === 'deref' && current && current.kind === 'reference' && s.aliases.get(key) != null) { key = s.aliases.get(key); current = current.target; }
        else return null;
      }
      return key;
    }
    function masked(s, ancestor, key) {
      for (var m of s.masks) { tick(); if (m !== ancestor && m.startsWith(ancestor + '/') && (key === m || key.startsWith(m + '/'))) return true; }
      return false;
    }
    function read(s, key) {
      var out = facts();
      if (key == null) return out;
      s.slots.forEach(function (v, k) { tick(); if (k === '*' || k === key || k.startsWith(key + '/') || key.startsWith(k + '/') && !masked(s, k, key)) union(out, v); });
      return out;
    }
    function packet(s, key) {
      var out = { slots: [], aliases: [], masks: [], reference: false, target: null };
      if (key == null) return out;
      var base = key;
      if (s.aliases.has(key)) { out.reference = true; out.target = s.aliases.get(key); base = out.target; }
      if (base == null) return out;
      // Keep field payloads separate; whole-aggregate reads join them only at use.
      out.slots.push(['', facts()]);
      s.slots.forEach(function (v, k) { tick(); if (k === '*' || k === base || base.startsWith(k + '/') && !masked(s, k, base)) union(out.slots[0][1], v); });
      s.slots.forEach(function (v, k) { tick(); if (k.startsWith(base + '/')) { tick(v.size + 1); out.slots.push([k.slice(base.length), new Map(v)]); } });
      s.aliases.forEach(function (v, k) { tick(); if (k.startsWith(base + '/')) { var path = k.slice(base.length); out.aliases.push([path, v]); out.slots.push([path, read(s, v)]); } });
      s.masks.forEach(function (k) { tick(); if (k.startsWith(base + '/')) out.masks.push(k.slice(base.length)); });
      var rows = new Map(); out.slots.forEach(function (row) { rows.set(row[0], union(rows.get(row[0]) || facts(), row[1])); }); out.slots = Array.from(rows);
      return out;
    }
    async function install(s, dest, value, step) {
      for (var row of value.slots) { await cooperate(); s.slots.set(dest + row[0], tagged(row[1], step)); }
      (value.aliases || []).forEach(function (row) { tick(); s.aliases.set(dest + row[0], row[1]); });
      (value.masks || []).forEach(function (path) { tick(); s.masks.add(dest + path); });
    }
    function operand(ctx, block, record, s, o) {
      tick(); if (o.kind === 'constant') return facts();
      var key = resolve(s, o.place);
      if (key == null) return unknown(ctx, block, record, 'unsupported-alias-or-projection', read(s, 'l' + o.place.local));
      return union(new Map(s.slots.get(key) || []), read(s, s.aliases.has(key) ? s.aliases.get(key) : key));
    }
    function set(s, key, values) { if (key == null) return; clear(s, key); s.slots.set(key, values); }
    async function assign(ctx, block, s, r) {
      tick();
      if (r.kind === 'nop') return;
      if (r.kind === 'storage') { clear(s, 'l' + r.local); return; }
      if (r.kind === 'unsupported') { var u = unknown(ctx, block, r, 'unsupported-memory-effect');
        s.slots.set('*', union(read(s, '*'), u)); return; }
      var dest = resolve(s, r.destination), v = r.value;
      if (dest == null) {
        var uncertain = unknown(ctx, block, r, 'unsupported-write-alias');
        s.slots.set('*', union(read(s, '*'), uncertain)); return;
      }
      var step = at(ctx, block, r, 'assignment', { destination: placeRef(r.destination), valueKind: v.kind, operandCount: (v.operands || []).length, referent: placeRef(v.place) });
      if (v.kind === 'ref') {
        // An unavailable pointee still has possible incoming value provenance.
        // Capture it before a same-local reborrow clears its own source.
        var target = resolve(s, v.place), inherited = target == null ? read(s, 'l' + v.place.local) : null;
        clear(s, dest); s.aliases.set(dest, target);
        if (target == null) s.slots.set(dest, unknown(ctx, block, r, 'unsupported-reference', inherited));
        else s.slots.forEach(function (values, k) { tick(); if (k === target || k.startsWith(target + '/')) s.slots.set(k, tagged(values, Object.assign({}, step, { kind: 'reference-alias', referent: placeRef(v.place) }))); });
      } else if (v.kind === 'use' && v.operands[0].kind !== 'constant') {
        var sourceKey = resolve(s, v.operands[0].place), value = packet(s, sourceKey);
        var incoming = sourceKey == null ? read(s, 'l' + v.operands[0].place.local) :
          value.reference && value.target == null ? operand(ctx, block, r, s, v.operands[0]) : null;
        clear(s, dest);
        if (sourceKey == null) s.slots.set(dest, unknown(ctx, block, r, 'unsupported-read-alias', incoming));
        else if (value.reference) { s.aliases.set(dest, value.target); if (value.target == null) s.slots.set(dest, unknown(ctx, block, r, 'unsupported-reference-copy', incoming)); }
        else await install(s, dest, value, step);
      } else if (v.kind === 'aggregate') {
        var values = [];
        for (var o of v.operands) { await cooperate(); var key = o.place && resolve(s, o.place); values.push(o.kind === 'constant' ? { slots: [['', facts()]] } : key == null ? { slots: [['', operand(ctx, block, r, s, o)]] } : packet(s, key)); }
        clear(s, dest);
        for (var i = 0; i < values.length; i++) { await cooperate(); var value = values[i], field = dest + '/f' + i;
          if (value.reference) s.aliases.set(field, value.target);
          else await install(s, field, value, Object.assign({}, step, { field: i }));
        }
      } else {
        var a = facts(); for (var o of v.operands || []) { await cooperate(); union(a, operand(ctx, block, r, s, o)); }
        if (v.kind === 'unsupported') a = unknown(ctx, block, r, 'unsupported-rvalue', a);
        set(s, dest, tagged(a, step));
      }
    }
    var sources = q.model.sources, sinks = q.model.sinks, summaries = new Map();
    q.model.summaries.forEach(function (r) { if (summaries.has(r.call)) fail('ambiguous summaries at ' + r.call); summaries.set(r.call, r); });
    function binding(r) {
      var p = r.at, e = p.procedure && index.procedures.get(p.procedure), c = p.call && index.calls.get(p.call);
      if (!e && !c) fail('unavailable exact endpoint ' + (p.procedure || p.call));
      if (e && ['parameter'].includes(p.port) && e.status === 'captured' && p.index >= e.facts.parameter_locals.length) fail('parameter index out of range');
      if (c) { var owner = index.procedures.get(c.procedure), b = owner && owner.status === 'captured' && owner.facts.blocks.find(function (b) { return c.from === c.procedure + '#' + b.id; });
        if (b && p.port === 'argument' && p.index >= b.call.arguments.length) fail('argument index out of range'); }
    }
    sources.concat(sinks).forEach(binding);
    summaries.forEach(function (r, id) { if (!index.calls.has(id)) fail('unavailable summary callsite ' + id); });
    if (!index.procedures.has(q.function)) fail('unavailable exact root procedure');
    function endpointShape(ctx, record, port, i) {
      var declaration, p;
      if (port === 'parameter') declaration = ctx.entry.locals.get(ctx.entry.facts.parameter_locals[i]);
      else if (port === 'return') declaration = ctx.entry.locals.get(0);
      else p = port === 'result' ? record.destination : record.arguments[i] && record.arguments[i].place;
      if (declaration) return declaration.shape && declaration.shape.kind === 'reference' ? declaration.shape.target : declaration.shape;
      if (!p) return { kind: 'scalar' };
      var shape = ctx.entry.locals.get(p.local).shape;
      for (var part of p.projection) {
        tick();
        if (!shape || shape.kind === 'unknown') return null;
        shape = part.kind === 'field' && shape.kind === 'fields' ? shape.fields[part.index] : part.kind === 'deref' && shape.kind === 'reference' ? shape.target : null;
      }
      // Argument endpoints denote the reference's referent, as do value packets.
      return shape && shape.kind === 'reference' ? shape.target : shape;
    }
    function endpointKey(ctx, record, port, i, key, fields) {
      var shape = endpointShape(ctx, record, port, i);
      for (var f of fields) {
        tick();
        if (!shape || shape.kind === 'unknown') { gap('unavailable-endpoint-field-shape', ctx.proc, record && record.id); return null; }
        if (shape.kind !== 'fields' || f >= shape.fields.length) { gap('nonexistent-endpoint-field', ctx.proc, record && record.id); return null; }
        shape = shape.fields[f]; key += '/f' + f;
      }
      return key;
    }
    function matches(p, owner, port, i) { return (p.call || p.procedure) === owner && p.port === port && (p.index == null || p.index === i); }
    function applySources(ctx, block, record, s, owner, port, i, key) {
      sources.forEach(function (r) { tick(); if (!matches(r.at, owner, port, i) || key == null) return;
        var k = endpointKey(ctx, record, port, i, key, r.at.fields);
        if (k == null) { s.slots.set('*', union(read(s, '*'), unknown(ctx, block, record, 'invalid-source-field'))); return; }
        var a = read(s, k);
        a.set('s:' + r.id, proof(at(ctx, block, record, 'source', Object.assign({ sourceId: r.id, endpoint: r.at, place: k, classification: 'modeled' },
          r.at.call ? { callsiteId: r.at.call } : {}))));
        set(s, k, a);
      });
    }
    function checkSinks(ctx, block, record, s, owner, port, i, key, value) {
      sinks.forEach(function (r) { tick(); if (!matches(r.at, owner, port, i)) return;
        // Validate selectors even when a valid operand has no precise caller key.
        // A packet uses relative field paths and is the operand already evaluated below.
        var k = endpointKey(ctx, record, port, i, value ? '' : key, r.at.fields), a;
        if (k == null || !value && key == null) a = unknown(ctx, block, record, 'unsupported-sink-place');
        else if (value) {
          tick((value.masks || []).length + 1); var selected = state(); selected.masks = new Set(value.masks || []);
          value.slots.forEach(function (row) { tick(); selected.slots.set(row[0], row[1]); });
          a = read(selected, k);
        } else a = read(s, k);
        a.forEach(function (parent, token) {
          tick(); var id = JSON.stringify([r.id, ctx.id, token]);
          if (!findings.has(id)) findings.set(id, { sinkId: r.id, sourceId: token.startsWith('s:') ? token.slice(2) : null,
            classification: token.startsWith('s:') ? parent.unknown ? 'possible' : 'modeled' : 'unknown', contextId: ctx.id,
            proof: proof(at(ctx, block, record, 'sink', Object.assign({ sinkId: r.id, endpoint: r.at, place: key, classification: 'modeled' },
              r.at.call ? { callsiteId: r.at.call } : {})), parent) });
        });
      });
    }
    function context(proc, inputs, callbacks, callsite) {
      tick(); var signature = inputs.map(function (p) { tick(); return [p.reference, p.target == null && p.reference, p.masks || [], (p.aliases || []).map(function (a) { return [a[0], a[1] == null]; }), p.slots.map(function (r) { tick(r[1].size + 1); return [r[0], Array.from(r[1].keys()).sort()]; })]; });
      var id = JSON.stringify([proc, callsite, signature, callbacks]);
      if (!contexts.has(id)) {
        states++; tick();
        var e = index.procedures.get(proc), ctx = { id: 'context:' + (contexts.size + 1), proc: proc, inputs: inputs, callbacks: callbacks,
          output: state(), returns: false, entry: e, isRoot: callsite === 'root' };
        contexts.set(id, ctx); dirty = true;
      }
      return contexts.get(id);
    }
    // Summary proofs name their input dependencies. Rebind them at each use;
    // proof identity is deliberately absent from the finite semantic cache key.
    async function instantiate(child, args, caller, site) {
      var out = cloneState(child.output), memo = new Map(), invocation = caller.id + '/' + site + '->' + child.proc;
      function rebound(p, token) {
        var chain = [], base = null, key = p.id + ':' + token;
        if (memo.has(key)) return memo.get(key);
        while (p) {
          tick();
          if (p.step.inputDependency && p.step.contextId === child.id) {
            var input = args[p.step.parameter], row = input && input.slots.find(function (r) { tick(); return r[0] === p.step.fieldPath; });
            base = row && row[1].get(token) || null;
            // An empty current input cannot inherit a previous caller's proof.
            if (!base) return null;
            chain.push(p.step); break;
          }
          chain.push(p.step); p = p.parent;
        }
        for (var i = chain.length - 1; i >= 0; i--) {
          var step = Object.assign({}, chain[i]);
          ['contextId','callerContextId','targetContextId'].forEach(function (field) {
            if (typeof step[field] === 'string' && (step[field] === child.id || step[field].startsWith(child.id + '/'))) step[field] = invocation + step[field].slice(child.id.length);
          });
          base = proof(step, base);
        }
        memo.set(key, base); return base;
      }
      for (var row of out.slots) { await cooperate(); var bound = facts();
        for (var entry of row[1]) { await cooperate(); var value = rebound(entry[1], entry[0]); if (value) bound.set(entry[0], value); }
        out.slots.set(row[0], bound);
      }
      return out;
    }
    function callbackBindings(ctx, c, arity) {
      var result = new Map();
      (c.callbackArgs || []).forEach(function (a) {
        tick(); var invalid = !object(a) || !integer(a.index) || a.index >= arity ||
          Object.prototype.hasOwnProperty.call(a, 'unknown') && typeof a.unknown !== 'boolean' ||
          a.parameter != null && a.targets != null && a.targets.length > 0 ||
          a.parameter != null && (!integer(a.parameter) || a.parameter >= ctx.entry.facts.parameter_locals.length) ||
          a.targets != null && (!Array.isArray(a.targets) || new Set(a.targets).size !== a.targets.length || !a.targets.every(function (t) { tick(); return text(t) && index.procedures.has(t); }));
        if (!object(a)) { gap('invalid-callback-binding', ctx.proc, c.id); return; }
        var forwarded = a.parameter != null && ctx.callbacks.find(function (b) { tick(); return b.index === a.parameter; });
        var targets = forwarded ? forwarded.targets : Array.isArray(a.targets) ? a.targets.filter(function (t) { return index.procedures.has(t); }) : [];
        var old = result.get(a.index), duplicate = !!old;
        if (duplicate || invalid) gap('invalid-callback-binding', ctx.proc, c.id);
        result.set(a.index, { index: a.index, targets: Array.from(new Set((old ? old.targets : []).concat(targets))).sort(),
          unknown: duplicate || invalid || !!a.unknown || !!(old && old.unknown) || !!(forwarded && forwarded.unknown) || a.parameter != null && !forwarded });
      });
      return Array.from(result.values()).sort(function (a, b) { return a.index - b.index; });
    }
    async function entryState(ctx) {
      var s = state(), f = ctx.entry.facts; s.present = true;
      for (var i = 0; i < f.parameter_locals.length; i++) {
        await cooperate(); var local = f.parameter_locals[i]; tick(); var kind = ctx.entry.localKinds.get(local);
        var p = ctx.inputs[i] || { slots: [], masks: [], aliases: [], reference: ctx.isRoot && kind === 'reference', target: 'root' }, key = 'l' + local;
        if (p.reference) { s.aliases.set(key, p.target == null ? null : 'input' + i); key = 'input' + i; }
        (p.masks || []).forEach(function (path) { s.masks.add(key + path); });
        (p.aliases || []).forEach(function (row) { tick(); s.aliases.set(key + row[0], null); });
        for (var pair of p.slots) { await cooperate(); s.slots.set(key + pair[0], tagged(pair[1], at(ctx, ctx.entry.flow.entry, ctx.entry.locals.get(local), 'parameter', { parameter: i, local: local, fieldPath: pair[0], inputDependency: true }))); }
        if (!ctx.inputs[i] && !ctx.isRoot) s.slots.set(key, unknown(ctx, ctx.entry.flow.entry, null, 'missing-call-argument'));
        applySources(ctx, ctx.entry.flow.entry, ctx.entry.locals.get(local), s, ctx.proc, 'parameter', i, key);
        checkSinks(ctx, ctx.entry.flow.entry, ctx.entry.locals.get(local), s, ctx.proc, 'parameter', i, key);
      }
      return s;
    }
    async function call(ctx, block, s, b) {
      var c = index.calls.get(ctx.proc + '#' + block + '@call'), r = b.call;
      if (!c) { gap('missing-control-call', ctx.proc, block); return false; }
      var argKeys = [], args = [];
      for (var i = 0; i < r.arguments.length; i++) {
        await cooperate(); var o = r.arguments[i], k = o.kind === 'constant' ? 'constant' + i : resolve(s, o.place);
        if (o.kind === 'constant') s.slots.set(k, facts());
        var effective = k != null && s.aliases.has(k) ? s.aliases.get(k) : k;
        applySources(ctx, block, r, s, c.id, 'argument', i, effective);
        argKeys.push(k); var p = packet(s, k);
        if (k == null || p.reference && p.target == null) p.slots = [['', unknown(ctx, block, r, 'unsupported-call-argument', o.place ? read(s, 'l' + o.place.local) : null)]];
        checkSinks(ctx, block, r, s, c.id, 'argument', i, effective, p);
        args.push(p);
      }
      var referenceTargets = args.filter(function (p) { return p.reference && p.target != null; }).map(function (p) { return p.target; });
      // Sorted adjacent intervals suffice for prefix overlap; charge every comparison.
      referenceTargets.sort(function (a, b) { tick(a.length + b.length); return a < b ? -1 : a > b ? 1 : 0; });
      var overlappingReferences = false;
      for (var i = 1; i < referenceTargets.length; i++) { await cooperate(); tick(); var a = referenceTargets[i - 1], b = referenceTargets[i];
        if (a === b || b.startsWith(a + '/')) overlappingReferences = true;
      }
      if (overlappingReferences) { var overlap = unknown(ctx, block, r, 'overlapping-reference-arguments'); s.slots.set('*', union(read(s, '*'), overlap)); }
      var dest = r.destination ? resolve(s, r.destination) : 'l0', summary = summaries.get(c.id), output = state(), canReturn = false, callTargets = c.targets.slice();
      if (summary) {
        var a = facts();
        summary.from.forEach(function (i) { if (i >= args.length) fail('summary argument index out of range'); args[i].slots.forEach(function (row) { union(a, row[1]); }); });
        var summaryStep = at(ctx, block, r, summary.kind === 'sanitize' ? 'sanitizer' : 'transformation',
          { callsiteId: c.id, summaryId: summary.id, summaryVersion: summary.version, classification: 'modeled' });
        if (summary.kind === 'transfer' && summary.from.length === 1 && endpointShape(ctx, r, 'result', null) && endpointShape(ctx, r, 'result', null).kind === 'fields') await install(output, 'l0', args[summary.from[0]], summaryStep);
        else output.slots.set('l0', tagged(a, summaryStep));
        canReturn = true;
        if (summary.referenceEffects === 'unknown') argKeys.forEach(function (k) { if (s.aliases.has(k)) {
          var u = unknown(ctx, block, r, 'summary-reference-effects'); union(s.slots.get(s.aliases.get(k)) || (s.slots.set(s.aliases.get(k), facts()), s.slots.get(s.aliases.get(k))), u);
        } });
      } else {
        var targets = c.targets.slice(), unknownTarget = !!c.unknown || !!c.possibleDispatch;
        if (r.argument_convention !== 'direct') { targets = []; unknownTarget = true; gap('unsupported-fn-trait-tuple-abi', ctx.proc, c.id); }
        if (c.callbackParameter != null && r.argument_convention === 'direct') {
          var binding = ctx.callbacks.find(function (a) { tick(); return a.index === c.callbackParameter; });
          if (!integer(c.callbackParameter) || c.callbackParameter >= ctx.entry.facts.parameter_locals.length) gap('invalid-callback-parameter', ctx.proc, c.id);
          targets = binding ? binding.targets : []; unknownTarget = unknownTarget || !binding || binding.unknown || !targets.length;
        }
        if (targets.length > 1 || c.possibleDispatch) { unknownTarget = true; gap('unsupported-dispatch', ctx.proc, c.id); }
        callTargets = targets.slice();
        for (var target of targets) {
          await cooperate();
          var e = index.procedures.get(target);
          if (!e || e.status !== 'captured') { unknownTarget = true; gap(e ? e.reason : 'missing-dependency-body', target, c.id); continue; }
          if (args.length !== e.facts.parameter_locals.length) { unknownTarget = true; gap('call-argument-arity-mismatch', target, c.id); continue; }
          var boundArgs = [];
          for (var i = 0; i < args.length; i++) {
            await cooperate(); var rows = [];
            for (var row of args[i].slots) { await cooperate(); rows.push([row[0], tagged(row[1], at(ctx, block, r, 'argument-to-parameter',
              { callsiteId: c.id, argument: i, parameter: i, callerPlace: argKeys[i], fieldPath: row[0], target: target, callerContextId: ctx.id, targetContextId: ctx.id + '/' + c.id + '->' + target }))]); }
            boundArgs.push(Object.assign({}, args[i], { slots: rows }));
          }
          var child = context(target, boundArgs, callbackBindings(ctx, c, r.arguments.length), c.id);
          if (child.returns) { canReturn = true; merge(output, await instantiate(child, boundArgs, ctx, c.id)); }
        }
        if (unknownTarget || !targets.length) {
          var inherited = facts(); args.forEach(function (p) { p.slots.forEach(function (row) { union(inherited, row[1]); }); });
          var alternative = state(); alternative.present = true;
          alternative.slots.set('l0', unknown(ctx, block, r, c.nativeCall ? 'unknown-native-call' : 'unknown-call-effects', inherited));
          // Every alternative starts from the same pre-call packets. Join memory,
          // masks and alias uncertainty before the single caller writeback.
          args.forEach(function (p, i) { if (!p.reference || p.target == null) return;
            var key = 'input' + i;
            p.slots.forEach(function (row) { tick(row[1].size + 1); alternative.slots.set(key + row[0], new Map(row[1])); });
            alternative.slots.set(key, union(unknown(ctx, block, r, 'unknown-reference-effects', inherited), alternative.slots.get(key) || facts()));
            (p.aliases || []).forEach(function (row) { tick(); alternative.aliases.set(key + row[0], null); });
            if (s.aliases.has(p.target)) alternative.aliases.set(key, null);
          });
          // Prefer the possible incoming proof when both alternatives carry the
          // same token; known-only internal sources and field rows still join.
          merge(alternative, output); output = alternative; canReturn = true;
        }
      }
      function returned(values, kind, extra) {
        var out = facts();
        values.forEach(function (parent, token) {
          var target = null, invocation = null;
          for (var p = parent; p; p = p.parent) {
            tick();
            if (p.step.contextId === ctx.id && p.step.nodeId === ctx.proc + '#' + block && p.step.kind === 'unknown-propagation' && ['unknown-call-effects','unknown-native-call'].includes(p.step.reason)) break;
            for (var candidate of callTargets) { tick(); var id = ctx.id + '/' + c.id + '->' + candidate;
              if (p.step.contextId === id || p.step.contextId && p.step.contextId.startsWith(id + '/')) { target = candidate; invocation = id; break; }
            }
            if (target) break;
          }
          out.set(token, proof(at(ctx, block, r, kind, Object.assign({ callsiteId: c.id, target: target, targetContextId: invocation, callerContextId: ctx.id }, extra)), parent));
        });
        return out;
      }
      if (!canReturn) return false;
      if (output.slots.has('*')) s.slots.set('*', union(read(s, '*'), output.slots.get('*')));
      // Callee reference writes happen before its returned value is assigned
      // to the caller destination (which may itself overlap a referent).
      args.forEach(function (p, i) {
        if (!p.reference || p.target == null) return;
        var key = 'input' + i, refOutput = packet(output, key);
        if (output.aliases.has(key)) { s.aliases.delete(p.target); set(s, p.target, unknown(ctx, block, r, 'reference-memory-escape', read(output, key))); }
        else if (Array.from(output.slots.keys()).some(function (k) { tick(); return k === key || k.startsWith(key + '/'); }) && !summary && !overlappingReferences) { clear(s, p.target); refOutput.slots.forEach(function (row) { s.slots.set(p.target + row[0], returned(row[1], 'reference-return', { argument: i, destination: p.target })); }); (refOutput.masks || []).forEach(function (path) { tick(); s.masks.add(p.target + path); });
          (refOutput.aliases || []).forEach(function (row) { tick(); s.aliases.set(p.target + row[0], null); }); }
      });
      if (dest == null) { var u = unknown(ctx, block, r, 'unsupported-result-alias'); s.slots.set('*', union(read(s, '*'), u)); }
      else {
        clear(s, dest);
        output.slots.forEach(function (v, k) { if (k === 'l0' || k.startsWith('l0/')) s.slots.set(dest + k.slice(2), returned(v, 'return-to-destination', { destination: placeRef(r.destination), returnLocal: 0 })); });
        output.masks.forEach(function (k) { if (k.startsWith('l0/')) s.masks.add(dest + k.slice(2)); });
        output.aliases.forEach(function (v, k) { if (k === 'l0' || k.startsWith('l0/')) { var destination = dest + k.slice(2); s.aliases.set(destination, null); s.slots.set(destination, unknown(ctx, block, r, 'returned-reference-alias', read(output, k))); } });
      }
      applySources(ctx, block, r, s, c.id, 'result', null, dest);
      checkSinks(ctx, block, r, s, c.id, 'result', null, dest);
      return true;
    }
    async function evaluate(ctx) {
      tick(); var e = ctx.entry;
      if (!e || e.status !== 'captured') { gap(e ? e.reason : 'missing-body', ctx.proc, null); return; }
      activeEntry = e;
      var flowBlocks = new Map(e.flow.blocks.map(function (b) { return [b.id, b]; }));
      var valueBlocks = new Map(e.facts.blocks.map(function (b) { return [b.id, b]; }));
      var inputs = new Map([[e.flow.entry, await entryState(ctx)]]), queue = [e.flow.entry], queued = new Set(queue);
      var returned = state(), returns = false, visits = 0;
      while (queue.length) {
        tick(); if (++visits % 64 === 0) { await new Promise(function (r) { setTimeout(r, 0); }); tick(); }
        var id = queue.shift(); queued.delete(id); var s = cloneState(inputs.get(id)), b = valueBlocks.get(id), fb = flowBlocks.get(id);
        for (var r of b.statements) { await cooperate(); await assign(ctx, id, s, r); }
        if (['opaque','yield','drop'].includes(fb.kind)) { var u = unknown(ctx, id, fb, 'unsupported-control-memory-effect'); s.slots.set('*', union(read(s, '*'), u)); }
        var proceeds = !b.call || await call(ctx, id, s, b);
        if (!proceeds) continue;
        if (fb.kind === 'return' || fb.kind === 'tail_call') {
          applySources(ctx, id, fb, s, ctx.proc, 'return', null, 'l0'); checkSinks(ctx, id, fb, s, ctx.proc, 'return', null, 'l0');
          merge(returned, s); returns = true;
        }
        (fb.successors || []).forEach(function (edge) {
          tick();
          if (edge.kind === 'unwind') { if (edge.target != null) gap('unwind-value-effects', ctx.proc, id); return; }
          if (edge.target == null) return;
          if (!flowBlocks.has(edge.target)) { gap('missing-value-successor', ctx.proc, id); return; }
          var changed;
          if (!inputs.has(edge.target)) { states++; tick(); inputs.set(edge.target, cloneState(s)); changed = true; }
          else changed = merge(inputs.get(edge.target), s);
          if (changed && !queued.has(edge.target)) { queue.push(edge.target); queued.add(edge.target); }
        });
      }
      // Export only the return value and reference parameter memory, never locals.
      var exported = state(); exported.present = returns; returned.slots.forEach(function (v, k) { tick(); if (k === 'l0' || k.startsWith('l0/') || k.startsWith('input') || k === '*') exported.slots.set(k, v); });
      returned.masks.forEach(function (k) { if (k.startsWith('input') || k.startsWith('l0/')) exported.masks.add(k); });
      returned.aliases.forEach(function (v, k) { if (k.startsWith('input') || k === 'l0' || k.startsWith('l0/')) {
        var inherited = facts(); ctx.inputs.forEach(function (p, i) { p.slots.forEach(function (row) { union(inherited, tagged(row[1], at(ctx, e.flow.entry, e.locals.get(e.facts.parameter_locals[i]), 'parameter',
          { parameter: i, local: e.facts.parameter_locals[i], fieldPath: row[0], inputDependency: true }))); }); });
        union(inherited, read(returned, v)); exported.aliases.set(k, null); exported.slots.set(k, unknown(ctx, e.flow.entry, null, k.startsWith('input') ? 'reference-memory-escape' : 'returned-reference-alias', inherited));
      } });
      if (merge(ctx.output, exported) || returns && !ctx.returns) { ctx.returns = ctx.returns || returns; dirty = true; }
    }
    try {
      context(q.function, [], [], 'root');
      while (dirty) {
        dirty = false;
        for (var ctx of Array.from(contexts.values())) { await evaluate(ctx); await new Promise(function (r) { setTimeout(r, 0); }); tick(); }
      }
    } catch (error) { if (error !== STOP) throw error; }
    var witnessRows = [], rowCount = findings.size, emittedSteps = 0;
    var candidateInfluence = Array.from(findings.values()).some(function (f) { return f.sourceId != null; });
    try {
      for (var finding of findings.values()) {
        tick(); if (witnessRows.length >= q.budgets.maxEvidence) { evidenceTruncated = true; break; }
        var steps = [], p = finding.proof, omitted = false;
        while (p) { tick(); if (emittedSteps >= q.budgets.maxEvidence) { omitted = evidenceTruncated = true; break; } emittedSteps++; steps.push(Object.assign({ proofId: p.id }, p.step)); p = p.parent; }
        witnessRows.push(Object.assign({}, finding, { proof: undefined, steps: steps.reverse(), truncated: omitted }));
      }
    } catch (error) { if (error !== STOP) throw error; evidenceTruncated = true; }
    var partial = gaps.size > 0 || budget || timedOut || cancelled;
    return { schemaVersion: 1, operation: 'valueFlow', status: cancelled || timedOut ? 'cancelled' : partial ? 'indeterminate' : candidateInfluence ? 'influenced' : 'not-found',
      partialCoverage: partial, capability: copy(index.capability), witnesses: { total: rowCount, items: witnessRows, truncated: evidenceTruncated },
      queryCoverage: { partial: partial, gaps: Array.from(gaps.values()).slice(0, q.budgets.maxEvidence),
        totalGaps: gaps.size, gapsTruncated: gaps.size > q.budgets.maxEvidence, contexts: contexts.size },
      completion: { complete: !budget && !timedOut && !cancelled, cancelled: cancelled, timedOut: timedOut, budgetExceeded: budget,
        evidenceComplete: !evidenceTruncated, work: work, states: states, limits: q.budgets, timeoutMs: q.timeoutMs },
      finding: { classification: candidateInfluence ? 'modeled' : 'unknown', candidateInfluence: candidateInfluence,
        definitiveNegative: false, vulnerabilityAbsenceProven: false, domain: 'configured sources/sinks in the supported captured value model' },
      semantics: { basis: 'VALUE propagation; control reachability alone is insufficient', version: VERSION,
        branchFeasibilitySolved: false, implicitControlTaint: false, runtimeExploitabilityProven: false,
        joins: 'may-analysis joins CFG branches; call contexts retain argument positions, value labels, exact callsite and callback bindings',
        aliases: 'precise local/field references and synchronous by-reference return effects; other aliasing remains unknown',
        sanitization: 'configured result only, per value and call context; input aliases are unchanged unless referenceEffects is unknown' } };
  }
  return { VERSION: VERSION, CAPABILITY: CAPABILITY, LIMITS: LIMITS, normalize: normalize, build: build, analyze: analyze };
});
