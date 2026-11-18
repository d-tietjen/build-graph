/* Whole-codebase callable projection. Browser global and CommonJS. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CallGraph = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function callable(n) {
    var kind = n && n.attributes && n.attributes.kind;
    return kind === "function" || kind === "method";
  }
  function closure(path) { return /\{(?:closure|coroutine|generator|async)[^}]*\}/.test(path); }
  function hasLoop(f) {
    var color = new Map(), blocks = f.blocks;
    for (var id of blocks.keys()) {
      if (color.has(id)) continue;
      var stack = [{ id: id, next: 0 }]; color.set(id, 1);
      while (stack.length) {
        var at = stack[stack.length - 1], b = blocks.get(at.id);
        var successors = b && Array.isArray(b.successors) ? b.successors : [];
        if (at.next >= successors.length) { color.set(at.id, 2); stack.pop(); continue; }
        var successor = successors[at.next++], target = successor && successor.target;
        if (!blocks.has(target)) continue;
        if (color.get(target) === 1) return true;
        if (!color.has(target)) { color.set(target, 1); stack.push({ id: target, next: 0 }); }
      }
    }
    return false;
  }
  function build(graph, index) {
    graph = graph || { nodes: [], edges: [] };
    index = index || { functions: new Map() };
    var nodes = [], byId = new Map(), pathToId = new Map(), edgeByKey = new Map(), edges = [];
    var flowIdPaths = new Map(), flowIdVertices = new Map(), canonicalFlowPaths = new Set();
    var flowNodeToVertexId = new Map();
    var boundaryNodes = new Map(), boundaryPaths = new Map(), boundaryCallsites = new Map();
    var rawById = new Map((graph.nodes || []).map(function (n) { return [n.id, n]; }));
    function details(a) {
      return { package_id: a.package_id || null, capture_scope: a.capture_scope || null,
        package_role: a.package_role ||
          (a.native_boundary_kind === "ffi_symbol" && a.native_declaration_package_id ? "ffi_declaration" : null),
        display_path: a.display_path || (a.language === "native" ? a.native_symbol || null : null),
        language: a.language || "rust", body_status: a.body_status || null,
        native_symbol: a.native_symbol || null, native_artifact: a.native_artifact || null,
        native_library_id: a.native_library_id || null,
        native_declaration_package_id: a.native_declaration_package_id || null,
        native_abi: a.native_abi || null,
        native_link_libraries: a.native_link_libraries || null,
        native_call_origin_flow_id: a.native_call_origin_flow_id || null,
        native_callsite_block: a.native_callsite_block || null,
        native_call_evidence: a.native_call_evidence || null,
        native_boundary_kind: a.native_boundary_kind || null,
        native_call_origin_artifact: a.native_call_origin_artifact || null,
        native_call_origin_library_id: a.native_call_origin_library_id || null,
        native_call_origin_object_member: a.native_call_origin_object_member || null,
        native_callsite_address: a.native_callsite_address || null,
        native_resolution: a.native_resolution || null,
        native_direct_calls: a.native_direct_calls || null,
        native_call_diagnostics: a.native_call_diagnostics || null,
        native_call_coverage: a.native_call_coverage || null,
        native_analysis_scope: a.native_analysis_scope || null,
        native_instruction_set_status: a.native_instruction_set_status || null,
        native_diagnostic: a.native_diagnostic || null };
    }
    function addNode(node) {
      if (byId.has(node.id)) return byId.get(node.id);
      byId.set(node.id, node); nodes.push(node); return node;
    }
    (graph.nodes || []).forEach(function (n) {
      if (!callable(n)) return;
      var a = n.attributes || {}, path = a.path || (a.language === "native" ? n.id : n.label || n.id);
      addNode({ id: n.id, path: path, label: n.label || path.split("::").pop(),
        kind: a.kind, crate: a.crate || "", source_file: n.source_file || null,
        source_location: n.source_location || null, flowPaths: [], unknownCalls: 0,
        ...details(a),
        display_path: a.display_path || (a.language === "native" ? a.native_symbol || n.label || path : null) });
      if (!pathToId.has(path)) pathToId.set(path, n.id);
    });
    var architectureCount = nodes.length, flowCount = 0;
    (graph.nodes || []).forEach(function (n) {
      var a = n.attributes || {};
      if (a.kind !== "flow_function") return;
      var path = a.path, f = index.functions && index.functions.get(path);
      if (!path) return;
      var owner = byId.get(a.symbol_id), synthetic = closure(path);
      var vertex = owner && !synthetic ? owner : addNode({
        id: n.id, path: path, label: n.label || path.split("::").pop(),
        kind: synthetic ? "closure" : "function", crate: a.crate || (f && f.crate) || "",
        source_file: n.source_file || (f && f.source_file) || null,
        source_location: n.source_location || (f && f.source_location) || null,
        symbol_id: a.symbol_id || null, flowPaths: [], unknownCalls: 0,
        ...details(a)
      });
      if (a.package_id) vertex.package_id = a.package_id;
      if (a.capture_scope) vertex.capture_scope = a.capture_scope;
      if (a.display_path) vertex.display_path = a.display_path;
      vertex.body_status = "captured_mir";
      vertex.flowPaths.push(path);
      flowNodeToVertexId.set(n.id, vertex.id);
      if (!pathToId.has(path) || pathToId.get(path) === a.symbol_id) pathToId.set(path, vertex.id);
      var functionId = a.function_id;
      if (!functionId && a.flow) {
        try { functionId = (typeof a.flow === "string" ? JSON.parse(a.flow) : a.flow).function_id; }
        catch (_) { /* Invalid flow bodies cannot supply a trusted identity. */ }
      }
      if (typeof functionId === "string" && functionId && index.functions.has(path)) {
        if (typeof a.display_path === "string" && a.display_path !== path) canonicalFlowPaths.add(path);
        if (!flowIdPaths.has(functionId)) flowIdPaths.set(functionId, new Set());
        flowIdPaths.get(functionId).add(path);
        if (!flowIdVertices.has(functionId)) flowIdVertices.set(functionId, new Set());
        flowIdVertices.get(functionId).add(vertex.id);
      }
      flowCount++;
    });
    function addEdge(from, to, kind, meta) {
      if (!byId.has(from) || !byId.has(to)) return;
      var referenceKind = kind === "candidate" ?
        meta && meta.referenceKind || "callback_registration" : null;
      var key = from + "\t" + to + "\t" + kind + "\t" + (referenceKind || "");
      var existing = edgeByKey.get(key);
      var callsite = meta && meta.callsite ? { id: meta.callsite,
        source_file: meta.source_file || null, source_location: meta.source_location || null } : null;
      if (callsite && meta.reference) callsite.reference = meta.reference;
      if (callsite && meta.native_call) callsite.native_call = meta.native_call;
      if (existing) {
        if (callsite) existing.callsites.push(callsite);
        return;
      }
      var edge = { source: from, target: to, kind: kind,
        relation: meta && meta.relation || null,
        referenceKind: referenceKind,
        boundaryKind: meta && meta.boundaryKind || null,
        native_call: meta && meta.native_call || null,
        callee_package_id: meta && meta.callee_package_id || null,
        callee_artifact: meta && meta.callee_artifact || null,
        callee_abi: meta && meta.callee_abi || null,
        source_file: meta && meta.source_file || null,
        source_location: meta && meta.source_location || null, callsites: [] };
      if (callsite) edge.callsites.push(callsite);
      edgeByKey.set(key, edge); edges.push(edge);
    }
    function boundaryFor(calleeId, displayPath, callsite, block) {
      var native = block && block.native_call;
      var packageId = block && block.callee_package_id || null;
      var key = calleeId ? "id:" + JSON.stringify([
        packageId, block && block.callee_artifact || null, calleeId]) : "path:" + JSON.stringify([
        packageId, block && block.callee_artifact || null, native && native.symbol || null, displayPath]);
      var node = boundaryNodes.get(key);
      if (!node) {
        node = addNode({ id: "boundary::" + encodeURIComponent(key), path: displayPath,
          canonicalPath: displayPath, label: "Uncaptured callee", kind: "boundary",
          crate: "", source_file: null, source_location: null, flowPaths: [],
          calleeId: calleeId || null, calleePaths: [], unknownCalls: 0,
          package_id: packageId, language: native ? "native" : "rust",
          package_role: native && packageId ? "ffi_declaration" : null,
          body_status: "unavailable", boundaryKind: native ? "native_symbol" : "uncaptured_callee",
          native_symbol: native && native.symbol || null,
          native_declaration_package_id: native ? packageId : null,
          native_artifact: block && block.callee_artifact || null,
          native_call: native || null });
        boundaryNodes.set(key, node); boundaryPaths.set(key, new Set());
      }
      boundaryPaths.get(key).add(displayPath);
      boundaryCallsites.set(callsite, node.id);
      return node;
    }
    function referencedBody(target) {
      if (!target || typeof target.function !== "string") return null;
      var id = typeof target.function_id === "string" && target.function_id ? target.function_id : null;
      if (id) {
        var vertices = flowIdVertices.get(id);
        if (!vertices) return null;
        return vertices.size === 1 ? vertices.values().next().value : null;
      }
      // Old metadata had only a fully qualified path. An ID-bearing target
      // never falls through to display text when its identity is unavailable.
      return index.functions.has(target.function) ? pathToId.get(target.function) || null : null;
    }
    (graph.edges || []).forEach(function (e) {
      if (e.relation !== "calls" && e.relation !== "member_calls" && e.relation !== "native_calls") return;
      var source = flowNodeToVertexId.get(e.source) || e.source;
      var target = flowNodeToVertexId.get(e.target) || e.target;
      addEdge(source, target, e.relation === "native_calls" ? "native_call" :
        source === target ? "recursion" : "call", e);
    });
    var bindings = new Map(), forwards = new Map(), invocations = new Map(), queue = [], externalRefs = [];
    function bindingKey(path, parameter) { return JSON.stringify([path, parameter]); }
    function addBinding(key, target) {
      if (!index.functions.has(target)) return;
      if (!bindings.has(key)) bindings.set(key, new Set());
      var set = bindings.get(key);
      if (!set.has(target)) { set.add(target); queue.push([key, target]); }
    }
    function bindArgs(f, b, callee) {
      (Array.isArray(b.callback_args) ? b.callback_args : []).forEach(function (arg) {
        if (!arg || !Number.isInteger(arg.index)) return;
        var dest = bindingKey(callee, arg.index);
        (Array.isArray(arg.targets) ? arg.targets : []).forEach(function (target) { addBinding(dest, target); });
        if (Number.isInteger(arg.parameter)) {
          var src = bindingKey(f.path, arg.parameter);
          if (!forwards.has(src)) forwards.set(src, new Set());
          forwards.get(src).add(dest);
          var known = bindings.get(src);
          if (known) known.forEach(function (target) { addBinding(dest, target); });
        }
      });
    }
    index.functions.forEach(function (f) {
      var from = pathToId.get(f.path);
      if (!from) return;
      if (hasLoop(f)) addEdge(from, from, "loop");
      f.blocks.forEach(function (b) {
        if (b.kind !== "call" && b.kind !== "tail_call") return;
        var meta = { source_file: b.source_file, source_location: b.source_location,
          callsite: f.path + "#" + b.id + "@call",
          callee_package_id: b.callee_package_id || null,
          callee_artifact: b.callee_artifact || null,
          callee_abi: b.callee_abi || null };
        (Array.isArray(b.callback_references) ? b.callback_references : []).forEach(function (ref) {
          if (!ref || ref.kind !== "trait_method_reference" || !Number.isInteger(ref.index) ||
              !Array.isArray(ref.targets)) return;
          ref.targets.forEach(function (target) {
            var to = referencedBody(target);
            if (!to) return;
            var provenance = { kind: ref.kind, index: ref.index,
              receiver_type: ref.receiver_type || null,
              receiver_type_id: ref.receiver_type_id || null,
              trait: ref.trait || null, trait_id: ref.trait_id || null,
              target_function: target.function, target_function_id: target.function_id || null };
            addEdge(from, to, "candidate", { referenceKind: ref.kind,
              callsite: f.path + "#" + b.id + "@call", reference: provenance,
              source_file: b.source_file, source_location: b.source_location });
          });
        });
        var calleeId = typeof b.callee_id === "string" && b.callee_id ? b.callee_id : null;
        var identityPaths = calleeId ? flowIdPaths.get(calleeId) : null;
        var identified = identityPaths ? Array.from(identityPaths).filter(function (path) {
          return !b.callee_package_id || index.functions.get(path).package_id === b.callee_package_id;
        }) : [];
        var textBody = !calleeId && index.functions.has(b.callee) ? index.functions.get(b.callee) : null;
        var directPath = b.native_call ? null : calleeId ? identified.length === 1 ? identified[0] :
          identified.includes(b.callee) && canonicalFlowPaths.has(b.callee) ? b.callee : null : textBody &&
          (!b.callee_package_id || textBody.package_id === b.callee_package_id) ? b.callee : null;
        var direct = directPath ? pathToId.get(directPath) : null;
        var callsite = f.path + "#" + b.id + "@call";
        var nativeIds = Array.isArray(b.native_target_ids) ? b.native_target_ids.filter(function (id) {
          var target = rawById.get(id), a = target && target.attributes || {};
          return a.language === "native" && callable(target) && byId.has(id);
        }) : [];
        if (direct) addEdge(from, direct, from === direct ? "recursion" : "call", meta);
        nativeIds.forEach(function (id) {
          if (!boundaryCallsites.has(callsite)) boundaryCallsites.set(callsite, id);
          addEdge(from, id, "native_call", { relation: "native_calls", callsite: callsite,
            native_call: b.native_call || null, callee_package_id: b.callee_package_id || null,
            callee_artifact: b.callee_artifact || null, callee_abi: b.callee_abi || null,
            source_file: b.source_file, source_location: b.source_location });
        });
        if (!direct && !nativeIds.length && ((typeof b.callee === "string" && b.callee) || b.native_call)) {
          var display = b.callee || b.native_call.symbol || "unknown native symbol";
          var boundary = boundaryFor(calleeId, display, callsite, b);
          addEdge(from, boundary.id, "boundary", { relation: "calls", callsite: callsite,
            boundaryKind: boundary.boundaryKind, native_call: b.native_call || null,
            callee_package_id: b.callee_package_id || null,
            callee_artifact: b.callee_artifact || null, callee_abi: b.callee_abi || null,
            source_file: b.source_file, source_location: b.source_location });
        }
        if (Array.isArray(b.callee_targets)) b.callee_targets.forEach(function (target) {
          var to = pathToId.get(target);
          if (to) addEdge(from, to, from === to ? "recursion" : "indirect", meta);
        });
        var callees = [];
        if (directPath && direct) callees.push(directPath);
        if (Array.isArray(b.callee_targets)) b.callee_targets.forEach(function (p) {
          if (index.functions.has(p)) callees.push(p);
        });
        callees.forEach(function (callee) { bindArgs(f, b, callee); });
        if (Number.isInteger(b.callback_parameter)) {
          var key = bindingKey(f.path, b.callback_parameter);
          if (!invocations.has(key)) invocations.set(key, []);
          invocations.get(key).push({ from: from, function: f, block: b, meta: meta });
        } else if (!callees.length && Array.isArray(b.callback_args)) {
          b.callback_args.forEach(function (arg) {
            if (arg && Number.isInteger(arg.index)) externalRefs.push({ from: from, caller: f.path,
              block: b.id, arg: arg, meta: meta });
          });
        }
        if (!direct && !nativeIds.length && !callees.length && !Array.isArray(b.callee_targets)) byId.get(from).unknownCalls++;
      });
    });
    for (var head = 0; head < queue.length; head++) {
      var item = queue[head], next = forwards.get(item[0]);
      if (next) next.forEach(function (key) { addBinding(key, item[1]); });
      var sites = invocations.get(item[0]);
      if (sites) sites.forEach(function (site) {
        var to = pathToId.get(item[1]);
        if (to) addEdge(site.from, to, site.from === to ? "recursion" : "callback", site.meta);
        bindArgs(site.function, site.block, item[1]);
      });
    }
    externalRefs.forEach(function (ref) {
      var targets = new Set(Array.isArray(ref.arg.targets) ? ref.arg.targets : []);
      if (Number.isInteger(ref.arg.parameter)) {
        var bound = bindings.get(bindingKey(ref.caller, ref.arg.parameter));
        if (bound) bound.forEach(function (p) { targets.add(p); });
      }
      targets.forEach(function (target) {
        var to = pathToId.get(target);
        if (to) addEdge(ref.from, to, "candidate", {
          referenceKind: "callback_registration",
          callsite: ref.caller + "#" + ref.block + "@call",
          reference: { kind: "callback_registration", index: ref.arg.index,
            parameter: Number.isInteger(ref.arg.parameter) ? ref.arg.parameter : null,
            target_function: target },
          source_file: ref.meta.source_file, source_location: ref.meta.source_location
        });
      });
    });
    boundaryNodes.forEach(function (node, key) {
      var aliases = Array.from(boundaryPaths.get(key)).sort();
      node.calleePaths = aliases;
      node.canonicalPath = aliases[0];
      node.path = aliases[0];
      var names = Array.from(new Set(aliases.map(function (path) { return path.split("::").pop(); })));
      node.label = "Uncaptured " + (names.length === 1 ? names[0] : "callee") +
        (aliases.length > 1 ? " (" + aliases.length + " spellings)" : "");
    });
    edges.forEach(function (edge) { edge.callsites.sort(function (a, b) { return a.id.localeCompare(b.id); }); });
    return { nodes: nodes, edges: edges, aliases: Array.from(pathToId),
      boundaryCallsites: Array.from(boundaryCallsites),
      counts: { architectureCallables: architectureCount,
        boundaries: boundaryNodes.size,
        closures: nodes.filter(function (n) { return n.kind === "closure"; }).length,
        flowIdentities: flowCount,
        disconnected: 0 } };
  }
  function layout(map) {
    var nodes = map.nodes.slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    var byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var outgoing = new Map(), indegree = new Map(), degree = new Map();
    map.edges.forEach(function (edge) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) return;
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
      if (edge.source === edge.target || edge.kind === "loop" || edge.kind === "candidate") return;
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source).push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    });
    outgoing.forEach(function (targets) { targets.sort(); });
    var depths = new Map(), queue = [];
    function seed(node) { depths.set(node.id, 0); queue.push(node.id); }
    nodes.forEach(function (n) { if (degree.has(n.id) && !indegree.has(n.id)) seed(n); });
    function expand() {
      for (var head = 0; head < queue.length; head++) {
        var id = queue[head], depth = depths.get(id);
        (outgoing.get(id) || []).forEach(function (target) {
          if (!depths.has(target)) { depths.set(target, depth + 1); queue.push(target); }
        });
      }
      queue.length = 0;
    }
    expand();
    // A rootless call cycle still gets a deterministic seed and visible depth.
    nodes.forEach(function (n) { if (degree.has(n.id) && !depths.has(n.id)) { seed(n); expand(); } });
    var maxDepth = 0;
    nodes.forEach(function (n) {
      if (!degree.has(n.id) || n.unknownCalls) return;
      maxDepth = Math.max(maxDepth, Math.min(6, depths.get(n.id) || 0));
    });
    var unknownRing = maxDepth + 1, disconnectedRing = unknownRing + 1;
    nodes.forEach(function (n) {
      n.callDepth = depths.has(n.id) ? depths.get(n.id) : null;
      n.ring = !degree.has(n.id) ? disconnectedRing : n.unknownCalls ? unknownRing :
        Math.min(6, n.callDepth);
    });
    map.counts.disconnected = nodes.filter(function (n) { return n.ring === disconnectedRing; }).length;
    var byCrate = new Map();
    nodes.forEach(function (n) {
      var crate = n.crate || "(unknown)";
      if (!byCrate.has(crate)) byCrate.set(crate, []);
      byCrate.get(crate).push(n);
    });
    var crates = Array.from(byCrate.keys()).sort();
    var weight = crates.reduce(function (sum, crate) { return sum + Math.sqrt(byCrate.get(crate).length); }, 0);
    var angle = -Math.PI / 2, groups = [];
    crates.forEach(function (crate, i) {
      var span = i === crates.length - 1 ? -Math.PI / 2 + Math.PI * 2 - angle :
        Math.PI * 2 * Math.sqrt(byCrate.get(crate).length) / weight;
      groups.push({ crate: crate, startAngle: angle, endAngle: angle + span,
        count: byCrate.get(crate).length });
      angle += span;
    });
    var rings = [], radius = 180;
    for (var level = 0; level <= disconnectedRing; level++) {
      var membersAtLevel = nodes.filter(function (n) { return n.ring === level; });
      if (!membersAtLevel.length) continue;
      var maxLanes = 1;
      groups.forEach(function (group) {
        var members = byCrate.get(group.crate).filter(function (n) { return n.ring === level; });
        if (!members.length) return;
        members.sort(function (a, b) { return String(a.path).localeCompare(String(b.path)) ||
          String(a.id).localeCompare(String(b.id)); });
        var padding = Math.min(.035, (group.endAngle - group.startAngle) / 8);
        var span = group.endAngle - group.startAngle - 2 * padding;
        var slots = Math.min(members.length, Math.max(1, Math.floor(span * radius / 18)));
        maxLanes = Math.max(maxLanes, Math.ceil(members.length / slots));
        members.forEach(function (n, i) {
          n.radius = radius + Math.floor(i / slots) * 22;
          n.angle = group.startAngle + padding + (i % slots + .5) * span / slots;
        });
      });
      var outer = radius + (maxLanes - 1) * 22;
      rings.push({ level: level, radius: radius, outerRadius: outer,
        count: membersAtLevel.length, label: level === disconnectedRing ? "Disconnected" :
          level === unknownRing ? "Has unknown callees" : "Call depth " + level +
            (level === 6 && membersAtLevel.some(function (n) { return n.callDepth > 6; }) ? "+" : "") });
      radius = outer + 76;
    }
    var outerRadius = radius + 50, center = { x: outerRadius + 20, y: outerRadius + 20 };
    nodes.forEach(function (n) {
      n.x = center.x + n.radius * Math.cos(n.angle);
      n.y = center.y + n.radius * Math.sin(n.angle);
    });
    groups.forEach(function (g) {
      var middle = (g.startAngle + g.endAngle) / 2;
      g.x = center.x + (outerRadius - 90) * Math.cos(middle);
      g.y = center.y + (outerRadius - 90) * Math.sin(middle);
    });
    map.groups = groups; map.rings = rings; map.center = center; map.outerRadius = outerRadius;
    map.width = Math.max(600, 2 * center.x); map.height = Math.max(600, 2 * center.y);
    return map;
  }
  return { build: build, layout: layout, hasLoop: hasLoop };
});
