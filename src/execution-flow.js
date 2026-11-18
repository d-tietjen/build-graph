/* Bounded, dependency-free MIR control-flow interpreter. Browser global and CommonJS. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ExecutionFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LIMITS = { maxPaths: 80, maxSteps: 160, maxVisits: 2, maxDepth: 12, maxStates: 30000 };
  var HARD = { maxPaths: 200, maxSteps: 400, maxVisits: 5, maxDepth: 24, maxStates: 60000 };
  function clamp(value, name) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(HARD[name], Math.floor(n))) : LIMITS[name];
  }
  function options(raw) {
    raw = raw || {};
    var out = {};
    Object.keys(LIMITS).forEach(function (k) { out[k] = clamp(raw[k] == null ? LIMITS[k] : raw[k], k); });
    out.includeUnwind = raw.includeUnwind === true;
    return out;
  }
  function source(block) {
    return { source_file: block.source_file || null, source_location: block.source_location || null };
  }
  function context(frames) {
    var parts = [], seen = new Set();
    frames.forEach(function (frame, i) {
      var caller = i ? frames[i - 1].fn + "::" + (frame.callBlock || "?") : "entry";
      var site = frame.fn + "@" + caller;
      if (!seen.has(site)) { parts.push(site); seen.add(site); }
    });
    return parts.join(" > ");
  }
  function event(type, fn, block, depth, extra, frames) {
    var e = { type: type, function: fn, block: block.id, label: block.label || block.kind,
      depth: depth, context: context(frames || []), source_file: source(block).source_file, source_location: source(block).source_location };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function catalog(graph) {
    var functions = new Map(), errors = [], count = 0, blocks = 0;
    var nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], a = n && n.attributes;
      if (!a || a.kind !== "flow_function") continue;
      if (++count > 200000) { errors.push("Function catalog limit (200000) reached."); break; }
      var flow;
      try { flow = typeof a.flow === "string" ? JSON.parse(a.flow) : a.flow; }
      catch (_) { errors.push("Invalid flow JSON for " + (a.path || n.id)); continue; }
      if (!flow || flow.version !== 1 || !Array.isArray(flow.blocks) || typeof flow.function !== "string") {
        errors.push("Invalid flow schema for " + (a.path || n.id)); continue;
      }
      if (blocks + flow.blocks.length > 1000000) { errors.push("Block catalog limit (1000000) reached."); break; }
      blocks += flow.blocks.length;
      var byId = new Map(), duplicate = false;
      flow.blocks.forEach(function (b) {
        if (!b || typeof b.id !== "string" || byId.has(b.id)) duplicate = true;
        else byId.set(b.id, b);
      });
      if (duplicate || !byId.has(flow.entry)) { errors.push("Malformed blocks or entry for " + flow.function); continue; }
      if (functions.has(flow.function)) { errors.push("Duplicate flow function " + flow.function); continue; }
      functions.set(flow.function, { path: flow.function, crate: a.crate || "",
        package_id: a.package_id || null, capture_scope: a.capture_scope || null,
        display_path: a.display_path || flow.function, source_file: n.source_file || "",
        source_location: n.source_location || null, symbol_id: a.symbol_id || null, entry: flow.entry, blocks: byId });
    }
    var callers = new Map(), calls = new Map();
    functions.forEach(function (f) {
      var children = new Set();
      f.blocks.forEach(function (b) {
        if (b.kind === "call" || b.kind === "tail_call") {
          if (functions.has(b.callee)) children.add(b.callee);
          if (Array.isArray(b.callee_targets)) b.callee_targets.forEach(function (p) { if (functions.has(p)) children.add(p); });
          if (Array.isArray(b.callback_args)) b.callback_args.forEach(function (arg) {
            if (Array.isArray(arg.targets)) arg.targets.forEach(function (p) { if (functions.has(p)) children.add(p); });
          });
        }
      });
      calls.set(f.path, children);
      children.forEach(function (child) {
        if (!callers.has(child)) callers.set(child, new Set());
        callers.get(child).add(f.path);
      });
    });
    return { functions: functions, calls: calls, callers: callers, errors: errors };
  }
  function applyModelTargets(index, model) {
    if (!index || !index.functions || !model || !Array.isArray(model.calls)) return index;
    var changed = false;
    model.calls.forEach(function (call) {
      if (!call) return;
      var f = index.functions.get(call.procedure), prefix = call.procedure + "#";
      if (!f || typeof call.from !== "string" || !call.from.startsWith(prefix)) return;
      var block = f.blocks.get(call.from.slice(prefix.length));
      if (!block || (block.kind !== "call" && block.kind !== "tail_call")) return;
      var dispatch = Array.isArray(call.dispatchTargets) ? call.dispatchTargets.filter(function (target) {
        return index.functions.has(target);
      }) : [];
      block.dispatch_targets = Array.from(new Set(dispatch));
      // Callback-parameter calls are bound per activation in begin(). A
      // union of possibleTargets here would invent routes between callers.
      if (call.callbackParameter === null && Array.isArray(call.resolvedTargets)) {
        block.model_targets = call.resolvedTargets.filter(function (target) { return index.functions.has(target); });
        block.model_unknown = !!call.unknown;
        block.model_id_mismatch = !!call.idMismatch;
      }
      changed = true;
    });
    if (changed) {
      index.calls = new Map(); index.callers = new Map();
      index.functions.forEach(function (f) {
        var children = new Set();
        f.blocks.forEach(function (block) {
          if (block.kind !== "call" && block.kind !== "tail_call") return;
          if (Array.isArray(block.model_targets)) block.model_targets.forEach(function (target) { children.add(target); });
          else {
            if (index.functions.has(block.callee)) children.add(block.callee);
            (Array.isArray(block.callee_targets) ? block.callee_targets : []).forEach(function (target) {
              if (index.functions.has(target)) children.add(target);
            });
          }
          (block.dispatch_targets || []).forEach(function (target) { children.add(target); });
          (Array.isArray(block.callback_args) ? block.callback_args : []).forEach(function (arg) {
            (arg && Array.isArray(arg.targets) ? arg.targets : []).forEach(function (target) {
              if (index.functions.has(target)) children.add(target);
            });
          });
        });
        index.calls.set(f.path, children);
        children.forEach(function (target) {
          if (!index.callers.has(target)) index.callers.set(target, new Set());
          index.callers.get(target).add(f.path);
        });
      });
    }
    return index;
  }
  function rootsFor(index, selected) {
    if (!index.functions.has(selected)) return { roots: [], incomplete: false };
    var ancestors = new Set([selected]), queue = [selected];
    for (var i = 0; i < queue.length; i++) {
      var ps = index.callers.get(queue[i]);
      if (ps) ps.forEach(function (p) { if (!ancestors.has(p)) { ancestors.add(p); queue.push(p); } });
    }
    var roots = [];
    ancestors.forEach(function (p) {
      var parents = index.callers.get(p);
      if (!parents || !Array.from(parents).some(function (x) { return ancestors.has(x); })) roots.push(p);
    });
    roots.sort();
    // Any ancestor caller SCC without an incoming edge has no graph root. Keep
    // one representative as a visible boundary even when other roots exist.
    var covered = new Set(), incomplete = false;
    function cover(start) {
      var pending = [start];
      for (var j = 0; j < pending.length; j++) {
        var p = pending[j]; if (covered.has(p)) continue;
        covered.add(p);
        var children = index.calls.get(p);
        if (children) children.forEach(function (c) { if (ancestors.has(c) && !covered.has(c)) pending.push(c); });
      }
    }
    roots.forEach(cover);
    Array.from(ancestors).sort().forEach(function (p) {
      if (!covered.has(p)) { roots.push(p); cover(p); incomplete = true; }
    });
    return { roots: roots, incomplete: incomplete };
  }
  function nextState(s, fields, countStep) {
    var n = { frames: s.frames.slice(), events: s.events.slice(), seen: new Set(s.seen),
      steps: s.steps + (countStep === false ? 0 : 1),
      incomplete: s.incomplete, coveragePartial: s.coveragePartial, reasons: s.reasons.slice() };
    if (fields) Object.keys(fields).forEach(function (k) { n[k] = fields[k]; });
    return n;
  }
  function begin(index, selected, raw) {
    raw = raw || {};
    var limit = options(raw), required = Array.from(new Set((selected || []).filter(function (x) { return typeof x === "string"; })));
    var result = { traces: [], diagnostics: (index.errors || []).slice(), truncated: false, exploredStates: 0,
      roots: [], selected: required.slice(), limits: limit, incomplete: !!(index.errors && index.errors.length),
      coverage: { unavailableCount: 0, unavailableTargets: [] } };
    var unavailableSeen = new Set();
    if (!required.length && !raw.root) { result.diagnostics.push("Select a function or entry to explore its execution flows."); return { run: function () { return result; }, result: result, done: true }; }
    var missing = required.filter(function (x) { return !index.functions.has(x); });
    if (missing.length) { result.diagnostics.push("No flow data for: " + missing.join(", ")); return { run: function () { return result; }, result: result, done: true }; }
    var rootChoice = raw.root || null;
    if (rootChoice && !index.functions.has(rootChoice)) { result.diagnostics.push("Explicit entry has no flow data: " + rootChoice); return { run: function () { return result; }, result: result, done: true }; }
    var inferred = rootChoice ? { roots: [rootChoice], incomplete: false } : rootsFor(index, required[0]);
    result.roots = inferred.roots;
    if (inferred.incomplete) { result.incomplete = true; result.diagnostics.push("A caller cycle has no known entry; one function in that cycle is used as a boundary."); }
    // Do not prune roots solely by direct-call reachability. An opaque or
    // indirect call may reach a pin even when the known call graph cannot.
    var roots = inferred.roots, maxPending = Math.min(limit.maxStates, 5000);
    var stack = roots.slice(0, maxPending).map(function (r) {
      var f = index.functions.get(r);
      var rootFrame = { fn: r, block: f.entry, visits: {}, returnTo: null, unwindTo: null, bindings: {} };
      return { frames: [rootFrame],
        events: [{ type: "enter", function: r, block: f.entry, label: r, depth: 0,
          context: context([rootFrame]), source_file: f.source_file || null, source_location: f.source_location || null }],
        seen: new Set([r]), steps: 0, incomplete: inferred.incomplete, coveragePartial: false, reasons: [] };
    }).reverse();
    if (roots.length > maxPending) {
      result.truncated = true; result.incomplete = true;
      result.diagnostics.push("Pending-state cap reached (" + maxPending + ").");
    }
    var done = false;
    function addReason(reason) {
      result.incomplete = true;
      if (result.diagnostics.indexOf(reason) < 0) result.diagnostics.push(reason);
    }
    function finish(s, complete, reason) {
      if (reason) { s.incomplete = true; s.reasons.push(reason); addReason(reason); }
      if (required.every(function (p) { return s.seen.has(p); })) {
        result.traces.push({ events: s.events, functions: Array.from(s.seen),
          complete: complete && !s.incomplete && !s.coveragePartial,
          reachedExit: !!complete, coveragePartial: !!s.coveragePartial,
          reasons: Array.from(new Set(s.reasons)) });
      }
    }
    function unavailable(s, target, b, kind) {
      s.coveragePartial = true; result.incomplete = true;
      if (unavailableSeen.has(target)) return;
      unavailableSeen.add(target); result.coverage.unavailableCount++;
      if (result.coverage.unavailableTargets.length < 80) result.coverage.unavailableTargets.push({
        target: target, kind: kind, source_file: b.source_file || null,
        source_location: b.source_location || null });
    }
    function enqueue(s) {
      if (stack.length >= maxPending) {
        result.truncated = true;
        addReason("Pending-state cap reached (" + maxPending + ").");
      } else stack.push(s);
    }
    function bindingsFor(block, frame) {
      var out = {};
      if (!Array.isArray(block.callback_args)) return out;
      block.callback_args.forEach(function (arg) {
        if (!arg || !Number.isInteger(arg.index) || arg.index < 0) return;
        var targets = Array.isArray(arg.targets) ? arg.targets.slice() : [];
        var forwarding = Number.isInteger(arg.parameter);
        var forwarded = forwarding && frame.bindings && frame.bindings[arg.parameter];
        if (forwarded) targets.push.apply(targets, forwarded.targets);
        out[arg.index] = { targets: Array.from(new Set(targets.filter(function (p) { return typeof p === "string"; }))),
          unknown: !!arg.unknown || !!(forwarded && forwarded.unknown) || !!(forwarding && !forwarded) };
      });
      return out;
    }
    function pushTarget(s, frame, b, edge) {
      if (!limit.includeUnwind && edge && edge.kind === "unwind") return;
      if (!edge || typeof edge !== "object" || (edge.target != null && typeof edge.target !== "string") ||
          (edge.action && ["continue", "terminate", "unreachable"].indexOf(edge.action) < 0)) {
        finish(s, false, "Malformed successor in " + frame.fn + "::" + b.id + "."); return;
      }
      var n = nextState(s, null, false);
      n.events.push(event("branch", frame.fn, b, n.frames.length - 1, { branch: edge.label || "next", edgeKind: edge.kind || "normal", target: edge.target || null }, n.frames));
      if (edge.action === "unreachable") return;
      if (edge.action === "terminate") { finish(n, true); return; }
      if (edge.target == null) {
        if (edge.action === "continue") {
          n.frames[n.frames.length - 1] = Object.assign({}, frame, { block: edge.kind === "unwind" ? "__unwind__" : "__return__" });
          enqueue(n); return;
        }
        finish(n, false, "Successor has no target or action."); return;
      }
      n.frames[n.frames.length - 1] = Object.assign({}, frame, { block: edge.target });
      enqueue(n);
    }
    function pushChoices(s, frame, b, choices) {
      if (!limit.includeUnwind) { choices.forEach(function (e) { pushTarget(s, frame, b, e); }); return; }
      // The frontier is LIFO: push unwind first, then normal. Keep recorded
      // order within each class so normal DFS choices match the default scope.
      var unwinds = choices.filter(function (e) { return e && e.kind === "unwind"; });
      var normals = choices.filter(function (e) { return !e || e.kind !== "unwind"; });
      unwinds.forEach(function (e) { pushTarget(s, frame, b, e); });
      normals.forEach(function (e) { pushTarget(s, frame, b, e); });
    }
    function advance(s) {
      var frame = s.frames[s.frames.length - 1];
      if (frame.block === "__unwind__" || frame.block === "__return__") {
        var u = nextState(s, null, false);
        u.frames.pop();
        var unwinding = frame.block === "__unwind__";
        if (!u.frames.length) { finish(u, !unwinding, unwinding ? "Unwind left the known entry." : null); return; }
        var cleanup = unwinding ? frame.unwindTo : frame.returnTo;
        if (cleanup && cleanup.length) {
          var outer = u.frames[u.frames.length - 1], callBlock = index.functions.get(outer.fn).blocks.get(frame.callBlock);
          cleanup.forEach(function (e) { pushTarget(u, outer, callBlock || { id: frame.callBlock, kind: "unwind" }, e); });
        } else {
          var parent = u.frames[u.frames.length - 1];
          if (unwinding) {
            u.frames[u.frames.length - 1] = Object.assign({}, parent, { block: "__unwind__" });
            enqueue(u);
          } else finish(u, false, "Call has no return continuation.");
        }
        return;
      }
      if (s.steps >= limit.maxSteps) { finish(s, false, "Step bound reached (" + limit.maxSteps + ")."); return; }
      var f = index.functions.get(frame.fn), b = f && f.blocks.get(frame.block);
      if (!b) { finish(s, false, "Missing block " + frame.fn + "::" + frame.block + "."); return; }
      var visits = (frame.visits[frame.block] || 0) + 1;
      if (visits > limit.maxVisits) { finish(s, false, "Visit bound reached (" + limit.maxVisits + ")."); return; }
      var current = nextState(s), updated = Object.assign({}, frame, { visits: Object.assign({}, frame.visits) });
      updated.visits[frame.block] = visits; current.frames[current.frames.length - 1] = updated;
      var candidates = Array.isArray(b.callback_args) ? b.callback_args.reduce(function (all, arg) {
        if (!arg) return all;
        if (Array.isArray(arg.targets)) all.push.apply(all, arg.targets);
        if (Number.isInteger(arg.parameter) && frame.bindings && frame.bindings[arg.parameter])
          all.push.apply(all, frame.bindings[arg.parameter].targets);
        return all;
      }, []) : [];
      current.events.push(event(b.kind, frame.fn, b, current.frames.length - 1,
        { callee: b.callee || null, native_call: b.native_call || null,
          native_target_ids: Array.isArray(b.native_target_ids) ? b.native_target_ids : [],
          callee_package_id: b.callee_package_id || null,
          callee_artifact: b.callee_artifact || null, callee_abi: b.callee_abi || null,
          boundaryKind: b.native_call ? "native_symbol" : null,
          callback_candidates: Array.from(new Set(candidates)),
          callback_reference: !!(candidates.length &&
            !(Array.isArray(b.model_targets) ? b.model_targets.length : b.callee && index.functions.has(b.callee)) &&
            !Array.isArray(b.callee_targets)),
          callback_unknown: !!b.callback_unknown || !!(Array.isArray(b.callback_args) && b.callback_args.some(function (arg) { return arg && arg.unknown; })) }, current.frames));
      var edges = Array.isArray(b.successors) ? b.successors : [];
      if (!Array.isArray(b.successors) || edges.some(function (e) { return !e || typeof e !== "object"; })) {
        finish(current, false, "Malformed successors in " + frame.fn + "::" + b.id + "."); return;
      }
      if (!limit.includeUnwind && b.kind === "unwind") return;
      var normalReturns = (frame.returnTo || []).filter(function (e) {
        return e && e.kind !== "unwind" && e.action !== "unreachable";
      });
      var recordedReturns = limit.includeUnwind ? normalReturns.concat((frame.unwindTo || []).filter(function (e) {
        return e && e.kind === "unwind" && e.action !== "unreachable";
      })) : normalReturns;
      if (b.kind === "opaque" && f.blocks.size === 1 && b.id === f.entry && !edges.length &&
          current.frames.length > 1 && recordedReturns.length) {
        unavailable(current, frame.fn, b, "opaque MIR body");
        current.events[current.events.length - 1] = Object.assign({}, current.events[current.events.length - 1],
          { type: "body_unavailable", callee: frame.fn,
            label: "Opaque MIR body; following recorded callsite continuation" });
        current.frames.pop();
        var parent = current.frames[current.frames.length - 1];
        var site = index.functions.get(parent.fn).blocks.get(frame.callBlock);
        pushChoices(current, parent, site || b, recordedReturns);
        return;
      }
      if (b.kind === "opaque" || b.kind === "yield" || b.kind === "drop" ||
          ["call", "tail_call", "branch", "return", "goto", "assert", "unwind", "abort", "unreachable"].indexOf(b.kind) < 0) {
        current.incomplete = true;
        var boundary = b.kind === "yield" ? "Coroutine yield/resume boundary; scheduler behavior is unknown." :
          b.kind === "drop" ? "Drop glue or destructor behavior may be omitted." :
          "Opaque or unknown terminator: " + b.kind + ".";
        current.reasons.push(boundary); addReason(boundary);
      }
      if (b.kind === "return" || b.kind === "unwind") {
        current.frames.pop();
        if (!current.frames.length) { finish(current, b.kind === "return", b.kind === "unwind" ? "Unwind left the known entry." : null); return; }
        var continuation = b.kind === "return" ? frame.returnTo : frame.unwindTo;
        if (!continuation || !continuation.length) {
          if (b.kind === "unwind") {
            // No cleanup at this callsite: continue unwinding through its caller.
            var parent = current.frames[current.frames.length - 1];
            current.frames[current.frames.length - 1] = Object.assign({}, parent, { block: "__unwind__" });
            enqueue(current);
          } else finish(current, false, "Call has no return continuation.");
          return;
        }
        var caller = current.frames[current.frames.length - 1];
        var callsite = index.functions.get(caller.fn).blocks.get(frame.callBlock);
        continuation.forEach(function (e) { pushTarget(current, caller, callsite || b, e); });
        return;
      }
      if (b.kind === "unreachable") return;
      if (b.kind === "abort") { finish(current, true); return; }
      if (b.kind === "call" || b.kind === "tail_call") {
        var normals = edges.filter(function (e) { return e && e.kind !== "unwind"; });
        var unwinds = limit.includeUnwind ? edges.filter(function (e) { return e && e.kind === "unwind"; }) : [];
        var targets = [], mapped = Array.isArray(b.model_targets),
          directKnown = mapped ? b.model_targets.length > 0 : !!(b.callee && index.functions.has(b.callee));
        var unknown = mapped ? !!b.model_unknown : !!b.callback_unknown && !directKnown;
        if (mapped) targets.push.apply(targets, b.model_targets);
        else {
          if (directKnown) targets.push(b.callee);
          if (Array.isArray(b.callee_targets)) b.callee_targets.forEach(function (p) {
            if (index.functions.has(p)) targets.push(p); else unknown = true;
          });
        }
        if (Array.isArray(b.dispatch_targets) && b.dispatch_targets.length) {
          b.dispatch_targets.forEach(function (p) { if (index.functions.has(p)) targets.push(p); });
          unknown = true; // graph-owned implementation candidates are not proven runtime choices
        }
        if (Number.isInteger(b.callback_parameter)) {
          var binding = frame.bindings && frame.bindings[b.callback_parameter];
          (binding ? binding.targets : []).forEach(function (p) {
            if (index.functions.has(p)) targets.push(p); else unknown = true;
          });
          if (!binding || binding.unknown) unknown = true;
        }
        targets = Array.from(new Set(targets));
        if (!targets.length) unknown = true;
        targets.forEach(function (target) {
          var branch = nextState(current, { steps: current.steps });
          var possibleDispatch = Array.isArray(b.dispatch_targets) && b.dispatch_targets.indexOf(target) >= 0;
          if (mapped && b.model_unknown) branch.coveragePartial = true;
          if (possibleDispatch) {
            branch.coveragePartial = true;
            branch.reasons.push("Possible trait dispatch; concrete runtime target is unknown.");
          }
          var recursive = branch.frames.some(function (ancestor) { return ancestor.fn === target; });
          if (b.kind !== "tail_call" && branch.frames.length >= limit.maxDepth) {
            finish(branch, false, "Call depth bound reached (" + limit.maxDepth + ")."); return;
          }
          var child = index.functions.get(target), bindings = bindingsFor(b, frame);
          var childFrame = b.kind === "tail_call"
            ? { fn: target, block: child.entry, visits: {}, returnTo: frame.returnTo, unwindTo: frame.unwindTo, callBlock: frame.callBlock, bindings: bindings }
            : { fn: target, block: child.entry, visits: {}, returnTo: normals, unwindTo: unwinds, callBlock: b.id, bindings: bindings };
          if (b.kind === "tail_call") branch.frames.pop();
          branch.frames.push(childFrame);
          branch.seen.add(target);
          branch.events.push({ type: "enter", function: target, block: child.entry, label: target,
            depth: branch.frames.length - 1, context: context(branch.frames),
            via: possibleDispatch ? "possible-dispatch" : (Number.isInteger(b.callback_parameter) ||
              (Array.isArray(b.callee_targets) && b.callee_targets.length > 0)) ? "callback" : "call",
            recursive: recursive,
            source_file: child.source_file || null, source_location: child.source_location || null });
          enqueue(branch);
        });
        if (!unknown) return;
        var opaque = targets.length ? nextState(current, { steps: current.steps }) : current;
        var namedUnavailable = (typeof b.callee === "string" || !!b.native_call) && !directKnown &&
          !Number.isInteger(b.callback_parameter);
        var missingName = b.callee || b.native_call && b.native_call.symbol || "unknown native symbol";
        var reason = b.model_id_mismatch ? "Callee identity mismatch: " + missingName :
          namedUnavailable ? "Body unavailable: " + missingName : "Indirect or unknown callee.";
        if (namedUnavailable) unavailable(opaque, missingName, b,
          b.model_id_mismatch ? "identity mismatch" : "external or uncatalogued body");
        else { opaque.incomplete = true; opaque.reasons.push(reason); addReason(reason); }
        if (namedUnavailable) {
          var callIndex = opaque.events.length - 1;
          opaque.events[callIndex] = Object.assign({}, opaque.events[callIndex],
            { type: "body_unavailable", callee: missingName, label: reason,
              boundaryKind: b.native_call ? "native_symbol" : "uncaptured_callee",
              native_call: b.native_call || null, native_target_ids: b.native_target_ids || [],
              callee_package_id: b.callee_package_id || null,
              callee_artifact: b.callee_artifact || null, callee_abi: b.callee_abi || null });
        } else opaque.events.push(event("opaque", frame.fn, b, opaque.frames.length - 1,
          { callee: b.callee || null, label: reason,
            boundaryKind: b.native_call ? "native_symbol" : "unknown_call",
            native_call: b.native_call || null,
            native_target_ids: Array.isArray(b.native_target_ids) ? b.native_target_ids : [] }, opaque.frames));
        var reachable = edges.filter(function (e) {
          return e.action !== "unreachable" && (limit.includeUnwind || e.kind !== "unwind");
        });
        if (!reachable.length) { finish(opaque, false, "Call has no recorded continuation in this scope."); return; }
        pushChoices(opaque, updated, b, reachable); return;
      }
      if (!edges.length) { finish(current, false, "No successor for " + frame.fn + "::" + b.id + " (" + b.kind + ")."); return; }
      pushChoices(current, updated, b, edges);
    }
    function run(work) {
      if (done) return result;
      var quota = Math.max(1, Math.min(2000, Math.floor(Number(work) || 2000)));
      while (quota-- > 0 && stack.length && result.traces.length < limit.maxPaths && result.exploredStates < limit.maxStates) {
        result.exploredStates++;
        advance(stack.pop());
      }
      if (stack.length && (result.traces.length >= limit.maxPaths || result.exploredStates >= limit.maxStates)) {
        result.truncated = true;
        addReason(result.traces.length >= limit.maxPaths ? "Path cap reached (" + limit.maxPaths + ")." : "Explored-state cap reached (" + limit.maxStates + ").");
        stack.length = 0;
      }
      done = stack.length === 0;
      if (done && !result.traces.length && !result.diagnostics.length) result.diagnostics.push("No matching flow within the current bounds.");
      return result;
    }
    return { run: run, result: result, get done() { return done; } };
  }
  function explore(index, selected, opts) { var job = begin(index, selected, opts); while (!job.done) job.run(2000); return job.result; }
  return { catalog: catalog, applyModelTargets: applyModelTargets, rootsFor: rootsFor,
    begin: begin, explore: explore, options: options };
});
