/* Finite MIR procedure/state model. Browser global and CommonJS. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ExecutionModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function unique(values) { return Array.from(new Set(values)).sort(); }
  function blockId(procedure, block) { return procedure + '#' + block; }
  function portId(procedure, port) { return procedure + '@' + port; }
  function pathKeys(node) {
    var a = node && node.attributes || {};
    if (typeof a.path !== 'string') return [];
    var keys = [a.path];
    if (typeof a.crate === 'string') keys.push(a.crate.replace(/-/g, '_') + '::' + a.path);
    return unique(keys);
  }
  function lastPathSeparator(path) {
    var depth = 0, result = -1;
    for (var i = 0; i < path.length - 1; i++) {
      if (path[i] === '<') depth++;
      else if (path[i] === '>' && path[i - 1] !== '-' && depth > 0) depth--;
      else if (depth === 0 && path.slice(i, i + 2) === '::') { result = i; i++; }
    }
    return result;
  }
  function resolutionIndex(graph, flowById) {
    var rich = new Map((graph.nodes || []).map(function (node) { return [node.id, node]; }));
    var flowNodes = new Map(), ids = new Map(), symbols = new Map(), owners = new Map();
    var packages = new Map(), canonicalPaths = new Set();
    var methods = new Map(), aliases = new Map();
    function append(map, key, value) {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(value);
    }
    flowById.forEach(function (entry, path) {
      flowNodes.set(entry.node.id, path);
      packages.set(path, entry.node.attributes && entry.node.attributes.package_id || null);
      if (entry.node.attributes && typeof entry.node.attributes.display_path === 'string' &&
          entry.node.attributes.display_path !== path) canonicalPaths.add(path);
      if (typeof entry.flow.function_id === 'string' && entry.flow.function_id)
        append(ids, entry.flow.function_id, path);
    });
    (graph.nodes || []).forEach(function (node) {
      var a = node && node.attributes || {};
      pathKeys(node).forEach(function (key) { append(owners, key, node.id); });
      if (a.kind === 'function' || a.kind === 'method')
        pathKeys(node).forEach(function (key) { append(symbols, key, node.id); });
    });
    (graph.edges || []).forEach(function (edge) {
      if (edge.relation === 'has_flow' && flowNodes.has(edge.target)) append(methods, edge.source, flowNodes.get(edge.target));
      if (edge.relation === 'has_method') append(aliases, edge.source, edge.target);
    });
    flowById.forEach(function (entry, path) {
      if (entry.node.attributes && entry.node.attributes.symbol_id)
        append(methods, entry.node.attributes.symbol_id, path);
    });
    var typeAliases = new Map();
    (graph.edges || []).forEach(function (edge) {
      if (edge.relation === 'aliases' && rich.has(edge.source) && rich.has(edge.target))
        append(typeAliases, edge.source, edge.target);
    });
    function symbolBodies(key) {
      var found = new Set();
      (symbols.get(key) || []).forEach(function (symbol) {
        (methods.get(symbol) || []).forEach(function (path) { found.add(path); });
        (typeAliases.get(symbol) || []).forEach(function (target) {
          (methods.get(target) || []).forEach(function (path) { found.add(path); });
        });
      });
      return unique(found);
    }
    function ownerMethodBodies(key) {
      var separator = lastPathSeparator(key);
      if (separator < 0) return [];
      var owner = key.slice(0, separator), name = key.slice(separator + 2), found = new Set();
      (owners.get(owner) || []).forEach(function (ownerId) {
        var resolvedOwners = new Set([ownerId]);
        (typeAliases.get(ownerId) || []).forEach(function (target) { resolvedOwners.add(target); });
        resolvedOwners.forEach(function (resolvedOwner) {
          (aliases.get(resolvedOwner) || []).forEach(function (methodId) {
            var method = rich.get(methodId), path = method && method.attributes && method.attributes.path;
            if (typeof path !== 'string' || lastPathSeparator(path) < 0 ||
                path.slice(lastPathSeparator(path) + 2) !== name) return;
            (methods.get(methodId) || []).forEach(function (body) { found.add(body); });
          });
        });
      });
      return unique(found);
    }
    function textTarget(key) {
      if (flowById.has(key)) return { kind: 'pathMatched', paths: [key] };
      var bodies = unique(symbolBodies(key).concat(ownerMethodBodies(key)));
      if (bodies.length > 1) return { kind: 'ambiguous', paths: bodies };
      if (bodies.length === 1) return { kind: 'aliasMatched', paths: bodies };
      var matchingSymbols = symbols.get(key);
      var explicitlyExternal = matchingSymbols && Array.from(matchingSymbols).some(function (id) {
        var a = rich.get(id).attributes || {};
        return a.external === true || a.kind === 'external';
      });
      return { kind: explicitlyExternal ? 'external' : 'unresolved', paths: [] };
    }
    return { packageOf: function (path) { return packages.get(path) || null; }, idTarget: function (id, packageId, canonical) {
      var paths = unique(ids.get(id) || []).filter(function (path) {
        return !packageId || packages.get(path) === packageId;
      });
      if (paths.length > 1 && paths.includes(canonical) && canonicalPaths.has(canonical))
        paths = [canonical];
      return paths.length > 1 ? { kind: 'ambiguous', paths: paths } :
        paths.length ? { kind: 'idMatched', paths: paths } : { kind: 'unresolved', paths: [] };
    }, textTarget: textTarget, rich: rich };
  }
  function source(node) {
    return { source_file: node.source_file || null, source_location: node.source_location || null };
  }
  function disconnectedRoots(procedures, calls, application) {
    // One representative of each source SCC covers an isolated recursion
    // region that a simple zero-indegree search would omit.
    var ids = procedures.map(function (p) { return p.id; }).sort();
    var next = new Map(ids.map(function (id) { return [id, []]; }));
    var prev = new Map(ids.map(function (id) { return [id, []]; }));
    calls.forEach(function (call) { call.targets.forEach(function (target) {
      next.get(call.procedure).push(target); prev.get(target).push(call.procedure);
    }); });
    var seen = new Set(), order = [];
    ids.forEach(function (id) {
      if (seen.has(id)) return;
      seen.add(id);
      var stack = [{ id: id, index: 0 }];
      while (stack.length) {
        var top = stack[stack.length - 1], children = next.get(top.id);
        if (top.index < children.length) {
          var child = children[top.index++];
          if (!seen.has(child)) { seen.add(child); stack.push({ id: child, index: 0 }); }
        } else order.push(stack.pop().id);
      }
    });
    var component = new Map(), members = [];
    order.reverse().forEach(function (id) {
      if (component.has(id)) return;
      var index = members.length, group = [], stack = [id]; component.set(id, index);
      while (stack.length) {
        var current = stack.pop(); group.push(current);
        prev.get(current).forEach(function (parent) {
          if (!component.has(parent)) { component.set(parent, index); stack.push(parent); }
        });
      }
      members.push(group.sort());
    });
    var incoming = new Set();
    next.forEach(function (children, id) { children.forEach(function (child) {
      if (component.get(id) !== component.get(child)) incoming.add(component.get(child));
    }); });
    var app = new Set(application);
    return members.filter(function (group, index) { return !incoming.has(index) && !group.some(function (id) { return app.has(id); }); })
      .map(function (group) { return group[0]; }).sort();
  }
  function possibleCallbackTargets(procedures, calls) {
    // This union is for the unpinned diagram only. Analyze retains the
    // per-call binding environment, so targets from different callers never
    // become interchangeable on a selected route.
    var byProcedure = new Map(procedures.map(function (p) { return [p.id, []]; }));
    var bindings = new Map(procedures.map(function (p) { return [p.id, new Map()]; }));
    calls.forEach(function (call) {
      byProcedure.get(call.procedure).push(call);
      call.possibleTargets = call.targets.slice();
      call.possibleUnknown = call.unknown || call.callbackParameter !== null;
    });
    var queue = procedures.map(function (p) { return p.id; }), queued = new Set(queue), head = 0;
    while (head < queue.length) {
      var procedure = queue[head++]; queued.delete(procedure);
      var parentBindings = bindings.get(procedure);
      byProcedure.get(procedure).forEach(function (call) {
        var known = new Set(call.possibleTargets);
        if (call.callbackParameter !== null) {
          var bound = parentBindings.get(call.callbackParameter);
          if (bound) bound.targets.forEach(function (target) { known.add(target); });
        }
        if (known.size !== call.possibleTargets.length) call.possibleTargets = Array.from(known).sort();
        call.possibleTargets.forEach(function (target) {
          var childBindings = bindings.get(target);
          if (!childBindings) return;
          call.callbackArgs.forEach(function (arg) {
            if (!arg || !Number.isInteger(arg.index) || arg.index < 0) return;
            var inherited = Number.isInteger(arg.parameter) ? parentBindings.get(arg.parameter) : null;
            var values = new Set(Array.isArray(arg.targets) ? arg.targets : []);
            if (inherited) inherited.targets.forEach(function (value) { values.add(value); });
            var unknown = !!arg.unknown || (Number.isInteger(arg.parameter) && !inherited) || !!(inherited && inherited.unknown);
            var old = childBindings.get(arg.index);
            if (!old) { old = { targets: new Set(), unknown: false }; childBindings.set(arg.index, old); }
            var changed = false;
            values.forEach(function (value) { if (!old.targets.has(value)) { old.targets.add(value); changed = true; } });
            if (unknown && !old.unknown) { old.unknown = true; changed = true; }
            if (changed && !queued.has(target)) { queued.add(target); queue.push(target); }
          });
        });
      });
    }
  }
  function addPossibleTraitDispatch(graph, flowById, calls) {
    var rich = new Map((graph.nodes || []).map(function (node) { return [node.id, node]; }));
    var flowNodeToProcedure = new Map();
    flowById.forEach(function (entry, id) { flowNodeToProcedure.set(entry.node.id, id); });
    var methods = new Map(), implementors = new Map(), methodFlows = new Map(), declarations = new Map();
    (Array.isArray(graph.edges) ? graph.edges : []).forEach(function (edge) {
      if (edge.relation === 'has_method') {
        if (!methods.has(edge.source)) methods.set(edge.source, []);
        methods.get(edge.source).push(edge.target);
      } else if (edge.relation === 'implements') {
        if (!implementors.has(edge.target)) implementors.set(edge.target, []);
        implementors.get(edge.target).push(edge.source);
      } else if (edge.relation === 'has_flow') {
        if (!methodFlows.has(edge.source)) methodFlows.set(edge.source, []);
        methodFlows.get(edge.source).push(edge.target);
      }
    });
    methods.forEach(function (methodIds, traitId) {
      var trait = rich.get(traitId);
      if (!trait || !trait.attributes || trait.attributes.kind !== 'trait') return;
      methodIds.forEach(function (methodId) {
        var method = rich.get(methodId), attrs = method && method.attributes;
        if (!attrs || attrs.kind !== 'method' || typeof attrs.path !== 'string') return;
        var keys = [attrs.path];
        if (typeof attrs.crate === 'string') keys.push(attrs.crate.replace(/-/g, '_') + '::' + attrs.path);
        keys.forEach(function (key) {
          if (!declarations.has(key)) declarations.set(key, []);
          declarations.get(key).push({ trait: trait, method: method });
        });
      });
    });
    calls.forEach(function (call) {
      var candidates = [];
      call.unavailableTargets.forEach(function (rawPath) {
        (declarations.get(rawPath) || []).forEach(function (decl) {
          var traitPath = decl.trait.attributes.path;
          var methodName = decl.method.attributes.path.split('::').pop();
          if (typeof traitPath !== 'string') return;
          (implementors.get(decl.trait.id) || []).forEach(function (ownerId) {
            var owner = rich.get(ownerId), ownerPath = owner && owner.attributes && owner.attributes.path;
            if (typeof ownerPath !== 'string') return;
            (methods.get(ownerId) || []).forEach(function (methodId) {
              var method = rich.get(methodId), attrs = method && method.attributes;
              if (!attrs || attrs.kind !== 'method' || typeof attrs.path !== 'string' ||
                  attrs.path.split('::').pop() !== methodName) return;
              (methodFlows.get(methodId) || []).forEach(function (flowNodeId) {
                var procedure = flowNodeToProcedure.get(flowNodeId);
                // The impl-qualified rustc key prevents an inherent or
                // unrelated same-name method from masquerading as this trait.
                if (procedure && procedure.includes('::<'+ ownerPath + ' as ' + traitPath + '>::' + methodName))
                  candidates.push(procedure);
              });
            });
          });
        });
      });
      if (candidates.length) {
        call.dispatchTargets = unique(candidates);
        call.targets = unique(call.targets.concat(call.dispatchTargets));
        call.possibleDispatch = true;
        call.unknown = true; // A concrete runtime implementation was not proven.
      }
    });
  }
  function build(graph) {
    var procedures = [], nodes = [], edges = [], calls = [];
    var unavailable = [], errors = [], procById = new Map(), flowById = new Map();
    var mirBlocks = 0, mirSuccessors = 0;
    var raw = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    raw.forEach(function (node) {
      var a = node && node.attributes;
      if (!a || a.kind !== 'flow_function') return;
      var flow;
      try { flow = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; }
      catch (_) { unavailable.push({ function: a.path || node.id, reason: 'invalid flow JSON' }); return; }
      if (!flow || flow.version !== 1 || typeof flow.function !== 'string' ||
          !Array.isArray(flow.blocks) || typeof flow.entry !== 'string') {
        unavailable.push({ function: a.path || node.id, reason: 'invalid flow schema' }); return;
      }
      var id = flow.function;
      if (flowById.has(id)) { unavailable.push({ function: id, reason: 'duplicate function body' }); return; }
      var seen = new Set(), malformed = false;
      flow.blocks.forEach(function (b) {
        if (!b || typeof b.id !== 'string' || seen.has(b.id)) malformed = true;
        else seen.add(b.id);
      });
      if (malformed || !seen.has(flow.entry)) {
        unavailable.push({ function: id, reason: 'malformed or missing entry block' }); return;
      }
      flowById.set(id, { flow: flow, node: node });
      mirBlocks += flow.blocks.length;
      flow.blocks.forEach(function (b) { if (Array.isArray(b.successors)) mirSuccessors += b.successors.length; });
    });
    var resolver = resolutionIndex(graph, flowById);
    flowById.forEach(function (entry, id) {
      var flow = entry.flow, node = entry.node;
      var procedure = { id: id, rawFlowNodeId: node.id, entry: blockId(id, flow.entry), start: portId(id, 'start'),
        normalExit: portId(id, 'return'), unwindExit: portId(id, 'unwind'),
        terminateExit: portId(id, 'terminate'), unreachableExit: portId(id, 'unreachable'),
        nodeIds: [], source_file: node.source_file || null, source_location: node.source_location || null,
        symbol_id: node.attributes.symbol_id || null, function_id: flow.function_id || null,
        crate: node.attributes.crate || null, package_id: node.attributes.package_id || null,
        capture_scope: node.attributes.capture_scope || null,
        display_path: node.attributes.display_path || id, language: "rust",
        body_status: "captured_mir" };
      procedures.push(procedure); procById.set(id, procedure);
      ['start', 'return', 'unwind', 'terminate', 'unreachable'].forEach(function (port) {
        var portNode = { id: portId(id, port), procedure: id, block: null, kind: port,
          label: port === 'start' ? 'Start' : port === 'return' ? 'Return' :
            port === 'unwind' ? 'Unwind' : port === 'terminate' ? 'Terminate' : 'Unreachable',
          source_file: procedure.source_file, source_location: procedure.source_location };
        nodes.push(portNode); procedure.nodeIds.push(portNode.id);
      });
      flow.blocks.forEach(function (b) {
        var n = { id: blockId(id, b.id), procedure: id, block: b.id,
          kind: b.kind || 'opaque', label: b.label || b.kind || b.id };
        Object.assign(n, source(b));
        if (typeof b.source_snippet === 'string') n.source_snippet = b.source_snippet;
        if (typeof b.condition === 'string') n.condition = b.condition;
        if (typeof b.predicate === 'string') n.predicate = b.predicate;
        nodes.push(n); procedure.nodeIds.push(n.id);
      });
      edges.push({ id: procedure.start + '->' + procedure.entry, from: procedure.start,
        to: procedure.entry, kind: 'start', label: 'start', action: null, procedure: id });
    });
    flowById.forEach(function (entry, id) {
      var flow = entry.flow, procedure = procById.get(id);
      var knownBlocks = new Set(flow.blocks.map(function (b) { return b.id; }));
      flow.blocks.forEach(function (b) {
        var from = blockId(id, b.id), isCall = b.kind === 'call' || b.kind === 'tail_call';
        var call = null;
        if (isCall) {
          var targetKeys = [];
          if (typeof b.callee === 'string') targetKeys.push(b.callee);
          if (Array.isArray(b.callee_targets)) targetKeys.push.apply(targetKeys, b.callee_targets.filter(function (p) { return typeof p === 'string'; }));
          targetKeys = unique(targetKeys);
          var known = [], missing = [], resolutionParts = [], ambiguousTargets = [];
          var direct = typeof b.callee === 'string' ? b.callee : null;
          var idResult = typeof b.callee_id === 'string' && b.callee_id ?
            resolver.idTarget(b.callee_id, b.callee_package_id || null, b.callee) : null;
          var legacyUnverified = false, idMismatch = false;
          if (direct !== null) {
            var result = b.native_call ? { kind: 'external', paths: [] } :
              idResult && idResult.kind !== 'unresolved' ? idResult : resolver.textTarget(direct);
            if (idResult && idResult.kind === 'unresolved' && result.paths.length) {
              var legacy = result.paths.filter(function (path) {
                return !procById.get(path).function_id && !b.callee_package_id;
              });
              if (legacy.length === result.paths.length) legacyUnverified = true;
              else { result = { kind: 'unresolved', paths: [] }; idMismatch = true; }
            }
            if (b.callee_package_id && result.paths.length) {
              var exact = result.paths.filter(function (path) {
                return resolver.packageOf(path) === b.callee_package_id;
              });
              if (exact.length !== result.paths.length) {
                result = exact.length ? { kind: 'ambiguous', paths: exact } :
                  { kind: 'unresolved', paths: [] };
                idMismatch = true;
              }
            }
            resolutionParts.push(result.kind);
            if (result.kind === 'ambiguous') ambiguousTargets.push({ key: direct, candidates: result.paths });
            else if (result.paths.length) known.push.apply(known, result.paths);
            else missing.push(direct);
          } else if (idResult) {
            resolutionParts.push(b.native_call ? 'external' : idResult.kind);
            if (b.native_call) { /* A native symbol has no MIR procedure in this model. */ }
            else if (idResult.kind === 'ambiguous') ambiguousTargets.push({ key: b.callee_id, candidates: idResult.paths });
            else known.push.apply(known, idResult.paths);
          }
          targetKeys.filter(function (key) { return key !== direct; }).forEach(function (key) {
            var result = resolver.textTarget(key);
            resolutionParts.push(result.kind);
            if (result.kind === 'ambiguous') ambiguousTargets.push({ key: key, candidates: result.paths });
            else if (result.paths.length) known.push.apply(known, result.paths);
            else missing.push(key);
          });
          known = unique(known); missing = unique(missing);
          var resolution = b.native_call ? 'nativeSymbol' :
            resolutionParts.includes('ambiguous') ? 'ambiguous' :
            resolutionParts.includes('unresolved') ? 'unresolved' :
            resolutionParts.includes('external') ? 'external' :
            resolutionParts.includes('idMatched') ? 'idMatched' :
            resolutionParts.includes('aliasMatched') ? 'aliasMatched' :
            resolutionParts.includes('pathMatched') ? 'pathMatched' : 'unresolved';
          call = { id: from + '@call', from: from, procedure: id, targets: known,
            targetKeys: targetKeys, directKey: direct, unavailableTargets: missing,
            ambiguousTargets: ambiguousTargets,
            resolvedTargets: known.slice(), resolution: resolution,
            calleeId: typeof b.callee_id === 'string' ? b.callee_id : null,
            calleePackageId: b.callee_package_id || null,
            calleeCrate: b.callee_crate || null,
            calleeArtifact: b.callee_artifact || null,
            calleeAbi: b.callee_abi || null,
            nativeCall: b.native_call || null,
            nativeTargetIds: Array.isArray(b.native_target_ids) ? b.native_target_ids.slice() : [],
            nativeResolution: b.native_resolution || null,
            boundaryKind: b.native_call ? 'native_symbol' : missing.length ? 'uncaptured_callee' : null,
            idUnmatched: !!(idResult && idResult.kind === 'unresolved'),
            idMismatch: idMismatch, legacyUnverified: legacyUnverified,
            callbackArgs: Array.isArray(b.callback_args) ? b.callback_args : [],
            callbackParameter: Number.isInteger(b.callback_parameter) ? b.callback_parameter : null,
            unknown: !!b.callback_unknown || missing.length > 0 || ambiguousTargets.length > 0 ||
              legacyUnverified || idMismatch ||
              (!known.length && !Number.isInteger(b.callback_parameter)),
            tail: b.kind === 'tail_call', normal: [], unwind: [], possibleDispatch: false };
          calls.push(call);
        }
        var successors = Array.isArray(b.successors) ? b.successors : [];
        if (!Array.isArray(b.successors)) errors.push('Missing successors for ' + from);
        successors.forEach(function (s, ordinal) {
          if (!s || typeof s !== 'object') { errors.push('Malformed successor for ' + from); return; }
          var action = s.action || null, kind = s.kind === 'unwind' ? 'unwind' : 'normal';
          var to = null;
          if (typeof s.target === 'string' && knownBlocks.has(s.target)) to = blockId(id, s.target);
          else if (s.target != null) { errors.push('Missing target ' + s.target + ' from ' + from); return; }
          else if (action === 'continue') to = portId(id, kind === 'unwind' ? 'unwind' : 'return');
          else if (action === 'terminate') to = procedure.terminateExit;
          else if (action === 'unreachable') to = procedure.unreachableExit;
          else { errors.push('Successor has no target/action at ' + from); return; }
          var e = { id: from + '->' + to + ':' + ordinal, from: from, to: to,
            kind: isCall ? 'continuation' : kind, label: s.label || kind,
            action: isCall ? kind : action, procedure: id, guard: action,
            callsite: isCall ? call.id : null };
          if (typeof s.condition === 'string') e.condition = s.condition;
          if (typeof s.predicate === 'string') e.predicate = s.predicate;
          edges.push(e);
          if (call) (kind === 'unwind' ? call.unwind : call.normal).push(e.id);
        });
        var terminal = b.kind === 'return' ? 'return' : b.kind === 'unwind' ? 'unwind' :
          b.kind === 'abort' ? 'terminate' : b.kind === 'unreachable' ? 'unreachable' : null;
        if (terminal) edges.push({ id: from + '->' + portId(id, terminal), from: from,
          to: portId(id, terminal), kind: terminal, label: terminal,
          action: terminal, procedure: id, guard: null, callsite: null });
      });
    });
    addPossibleTraitDispatch(graph, flowById, calls);
    possibleCallbackTargets(procedures, calls);
    var application = procedures.filter(function (p) { return /^bin::.+::main$/.test(p.id); }).map(function (p) { return p.id; }).sort();
    var disconnected = disconnectedRoots(procedures, calls, application);
    var unavailableCallees = calls.reduce(function (sum, c) { return sum + c.unavailableTargets.length; }, 0);
    var unresolvedCalls = calls.filter(function (c) { return c.unknown; }).length;
    var dynamicCalls = calls.filter(function (c) { return c.callbackParameter !== null; }).length;
    var possibleDispatchCalls = calls.filter(function (c) { return c.possibleDispatch; }).length;
    var opaqueBlocks = nodes.filter(function (n) { return n.kind === 'opaque'; }).length;
    var yieldBlocks = nodes.filter(function (n) { return n.kind === 'yield'; }).length;
    var nodeById = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var missingMirStubs = procedures.filter(function (p) {
      var body = p.nodeIds.map(function (id) { return nodeById.get(id); }).filter(function (n) { return n.block !== null; });
      return body.length === 1 && body[0].kind === 'opaque' && /pre-optimization MIR unavailable/.test(body[0].label);
    }).length;
    var flowNodeIds = new Set(Array.from(flowById.values()).map(function (entry) { return entry.node.id; }));
    var symbolFlows = new Set(), linkedSymbols = new Set();
    (graph.edges || []).forEach(function (edge) {
      if (edge.relation === 'has_flow' && flowNodeIds.has(edge.target)) {
        symbolFlows.add(edge.target); linkedSymbols.add(edge.source);
      }
    });
    flowById.forEach(function (entry) {
      var symbol = entry.node.attributes && entry.node.attributes.symbol_id;
      if (symbol && resolver.rich.has(symbol)) linkedSymbols.add(symbol);
    });
    var symbolMapped = Array.from(flowById.values()).filter(function (entry) {
      return symbolFlows.has(entry.node.id) || !!(entry.node.attributes &&
        entry.node.attributes.symbol_id && resolver.rich.has(entry.node.attributes.symbol_id));
    }).length;
    var rawFlowBodies = raw.filter(function (node) { return node && node.attributes &&
      node.attributes.kind === 'flow_function'; }).length;
    var bodySymbols = { total: 0, eligibleWithBody: 0, declarationWithoutBody: 0,
      unknownBodyStatus: 0, linked: 0, unlinkedEligible: 0 };
    var nativeSymbols = { total: 0, disassembled: 0, unavailable: 0 };
    (graph.nodes || []).forEach(function (node) {
      var a = node && node.attributes || {};
      if (a.kind !== 'function' && a.kind !== 'method') return;
      if (a.language === 'native') {
        nativeSymbols.total++;
        if (a.body_status === 'native_disassembly') nativeSymbols.disassembled++;
        else nativeSymbols.unavailable++;
        return;
      }
      bodySymbols.total++;
      if (a.has_body === 'true' || a.has_body === true) {
        bodySymbols.eligibleWithBody++;
        if (!linkedSymbols.has(node.id)) bodySymbols.unlinkedEligible++;
      } else if (a.has_body === 'false' || a.has_body === false) bodySymbols.declarationWithoutBody++;
      else bodySymbols.unknownBodyStatus++;
      if (linkedSymbols.has(node.id)) bodySymbols.linked++;
    });
    var nativePartial = nativeSymbols.unavailable > 0 || (graph.nodes || []).some(function (node) {
      return node && node.attributes && node.attributes.native_call_coverage === 'partial';
    });
    var resolutionCounts = { total: calls.length, idMatched: 0, pathMatched: 0,
      aliasMatched: 0, possibleDispatch: 0, ambiguous: 0, external: 0, unresolved: 0,
      nativeSymbol: 0, idUnmatched: 0, idMismatch: 0, legacyUnverified: 0 };
    calls.forEach(function (call) {
      var category = call.resolution === 'ambiguous' ? 'ambiguous' :
        call.possibleDispatch ? 'possibleDispatch' : call.resolution;
      resolutionCounts[category]++;
      if (call.idUnmatched) resolutionCounts.idUnmatched++;
      if (call.idMismatch) resolutionCounts.idMismatch++;
      if (call.legacyUnverified) resolutionCounts.legacyUnverified++;
    });
    return { version: 1, procedures: procedures, nodes: nodes, edges: edges, calls: calls,
      roots: { application: application, disconnected: disconnected },
      counts: { procedures: procedures.length, mirBlocks: mirBlocks, mirSuccessors: mirSuccessors,
        nodes: nodes.length, edges: edges.length, calls: calls.length },
      coverage: { unavailable: unavailable, errors: errors, unavailableCallees: unavailableCallees,
        unresolvedCalls: unresolvedCalls, dynamicCalls: dynamicCalls, possibleDispatchCalls: possibleDispatchCalls,
        bodyMapping: { total: rawFlowBodies, imported: procedures.length,
          unavailable: rawFlowBodies - procedures.length, symbolMapped: symbolMapped,
          symbolUnmapped: procedures.length - symbolMapped, mirImported: procedures.length - missingMirStubs,
          mirUnavailable: missingMirStubs, importedBlocks: mirBlocks, importedSuccessors: mirSuccessors },
        bodySymbols: bodySymbols,
        nativeSymbols: nativeSymbols,
        nativePartial: nativePartial,
        callsiteResolution: resolutionCounts,
        opaqueBlocks: opaqueBlocks,
        yieldBlocks: yieldBlocks, missingMirStubs: missingMirStubs,
        partial: unavailable.length > 0 || errors.length > 0 || unresolvedCalls > 0 || dynamicCalls > 0 || opaqueBlocks > 0 || yieldBlocks > 0 || nativePartial } };
  }

  // Proofs are shared references. A loop or recursive call may point back to an
  // earlier proof; expanding the references once at the end retains every
  // alternative without copying transitive node sets during fixed point.
  function proofNode(id) { return { id: id, derivations: [], seen: new Set() }; }
  function derive(into, refs, local) {
    local = local || {};
    var key = JSON.stringify([refs.map(function (r) { return r.id; }),
      local.node || '', local.edge || '', local.call || '', local.target || '']);
    if (into.seen.has(key)) return;
    into.seen.add(key);
    into.derivations.push({ refs: refs, node: local.node, edge: local.edge,
      call: local.call, target: local.target });
  }
  function blankSummary() {
    return { prefix: new Map(), normal: new Map(), unwind: new Map(), terminate: new Map() };
  }
  function normalizeBindings(bindings) {
    var result = {};
    Object.keys(bindings || {}).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (index) {
      var b = bindings[index];
      result[index] = { targets: unique(Array.isArray(b.targets) ? b.targets.filter(function (x) { return typeof x === 'string'; }) : []),
        unknown: !!b.unknown };
    });
    return result;
  }
  function childBindings(call, parent) {
    var result = {};
    call.callbackArgs.forEach(function (arg) {
      if (!arg || !Number.isInteger(arg.index) || arg.index < 0) return;
      var targets = Array.isArray(arg.targets) ? arg.targets.slice() : [];
      var forwarding = Number.isInteger(arg.parameter);
      var inherited = forwarding ? parent[arg.parameter] : null;
      if (inherited) targets.push.apply(targets, inherited.targets);
      result[arg.index] = { targets: unique(targets), unknown: !!arg.unknown || (forwarding && !inherited) || !!(inherited && inherited.unknown) };
    });
    return normalizeBindings(result);
  }

  async function analyze(model, pins, options) {
    options = options || {};
    function cancelled() { return typeof options.cancelled === 'function' && options.cancelled(); }
    function cancelledResult(roots) { return { status: 'cancelled', partialCoverage: true,
      diagnostics: ['Analysis was cancelled.'], roots: roots,
      activeNodeIds: [], activeEdgeIds: [], activeCallIds: [], activeCallTargets: [] }; }
    var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
    var edges = model && Array.isArray(model.edges) ? model.edges : [];
    var calls = model && Array.isArray(model.calls) ? model.calls : [];
    var procedures = model && Array.isArray(model.procedures) ? model.procedures : [];
    var selected = unique((Array.isArray(pins) ? pins : []).filter(function (p) { return typeof p === 'string'; }));
    var byProc = new Map(procedures.map(function (p) { return [p.id, p]; }));
    var byNode = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var byEdge = new Map(edges.map(function (e) { return [e.id, e]; }));
    var byCallFrom = new Map(calls.map(function (c) { return [c.from, c]; }));
    var outgoing = new Map();
    edges.forEach(function (e) {
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from).push(e);
    });
    var rootOption = options.roots;
    var explicitRoots = Array.isArray(rootOption) || typeof rootOption === 'string';
    var roots = Array.isArray(rootOption) ? unique(rootOption) :
      typeof rootOption === 'string' ? [rootOption] :
      unique((model.roots && model.roots.application || []).concat(model.roots && model.roots.disconnected || []));
    if (!selected.length) return {
      status: 'exact', partialCoverage: !!(model.coverage && model.coverage.partial), diagnostics: [], roots: roots,
      activeNodeIds: nodes.map(function (n) { return n.id; }),
      activeEdgeIds: edges.map(function (e) { return e.id; }),
      activeCallIds: calls.map(function (c) { return c.id; }),
      activeCallTargets: calls.reduce(function (all, c) { c.possibleTargets.forEach(function (t) { all.push(c.id + '->' + t); });
        if (c.possibleUnknown) all.push(c.id + '->?'); return all; }, [])
    };
    var missing = selected.filter(function (p) { return !byProc.has(p); });
    if (missing.length) return { status: 'indeterminate', partialCoverage: true,
      diagnostics: ['Selected procedures lack MIR bodies: ' + missing.join(', ')], roots: roots,
      activeNodeIds: [], activeEdgeIds: [], activeCallIds: [], activeCallTargets: [] };
    var prunedRoots = 0;
    if (!explicitRoots) {
      // A root can contain every pin only if each pin is reachable from it in
      // the known, context-insensitive call graph. This is a necessary filter,
      // not a proof of execution: unknown effects remain indeterminate.
      var reverse = new Map(procedures.map(function (p) { return [p.id, []]; }));
      calls.forEach(function (call) {
        call.possibleTargets.forEach(function (target) {
          if (reverse.has(target)) reverse.get(target).push(call.procedure);
        });
      });
      var ancestors = selected.map(function (pin) {
        var seen = new Set([pin]), queue = [pin];
        for (var i = 0; i < queue.length; i++) (reverse.get(queue[i]) || []).forEach(function (parent) {
          if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
        });
        return seen;
      });
      var allRoots = roots;
      roots = roots.filter(function (root) { return ancestors.every(function (set) { return set.has(root); }); });
      prunedRoots = allRoots.length - roots.length;
    }
    var pinBit = new Map(selected.map(function (p, i) { return [p, 1n << BigInt(i)]; }));
    var full = (1n << BigInt(selected.length)) - 1n;
    var contexts = new Map(), rootContexts = [], work = 0;
    var unknownSeen = !!(model.coverage && model.coverage.nativePartial) ||
      prunedRoots > 0 && !!(model.coverage && model.coverage.partial);
    var WORK_LIMIT = 2000000;
    function contextFor(procedure, bindings) {
      bindings = normalizeBindings(bindings);
      var id = procedure + '|' + JSON.stringify(bindings);
      if (!contexts.has(id)) contexts.set(id, { id: id, procedure: procedure, bindings: bindings,
        summary: blankSummary(), states: new Map() });
      return contexts.get(id);
    }
    roots.forEach(function (p) { if (byProc.has(p)) rootContexts.push(contextFor(p, {})); });
    async function runContext(context) {
      var procedure = byProc.get(context.procedure);
      var at = new Map(), queue = [], head = 0;
      var startEdge = procedure.start + '->' + procedure.entry;
      function addOutcome(kind, mask, refs, local) {
        var map = context.summary[kind], outcome = map.get(mask);
        if (!outcome) {
          outcome = proofNode(context.id + '\u0000' + kind + '\u0000' + mask.toString());
          map.set(mask, outcome); changed = true;
        }
        derive(outcome, refs, local);
      }
      function put(nodeId, mask, refs, local) {
        var key = nodeId + '|' + mask.toString(), state = context.states.get(key);
        if (!state) {
          state = proofNode(context.id + '\u0000state\u0000' + key);
          state.nodeId = nodeId; state.mask = mask;
          context.states.set(key, state);
        }
        derive(state, refs, local);
        if (!at.has(key)) { at.set(key, state); queue.push(state); }
      }
      function traverse(edge, mask, refs, local) {
        if (edge.guard === 'unreachable' || edge.action === 'unreachable') return;
        put(edge.to, mask, refs, Object.assign({}, local || {}, { edge: edge.id, node: edge.to }));
      }
      put(procedure.entry, pinBit.get(procedure.id) || 0n, [], { node: procedure.entry,
        edge: byEdge.has(startEdge) ? startEdge : undefined });
      derive(queue[0], [], { node: procedure.start });
      while (head < queue.length) {
        if (++work > WORK_LIMIT) return null;
        if (work % 256 === 0 && cancelled()) return false;
        if (work % 2048 === 0) {
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          if (cancelled()) return false;
        }
        var state = queue[head++], node = byNode.get(state.nodeId);
        if (!node) continue;
        addOutcome('prefix', state.mask, [state]);
        if (node.kind === 'return' && node.block === null) { addOutcome('normal', state.mask, [state]); continue; }
        if (node.kind === 'unwind' && node.block === null) { addOutcome('unwind', state.mask, [state]); continue; }
        if (node.kind === 'terminate' && node.block === null) { addOutcome('terminate', state.mask, [state]); continue; }
        if (node.block === null) continue;
        var call = byCallFrom.get(node.id), outgoingEdges = outgoing.get(node.id) || [];
        if (call) {
          var targets = call.targets.slice(), unresolved = call.unknown;
          if (Number.isInteger(call.callbackParameter)) {
            var binding = context.bindings[call.callbackParameter];
            if (binding) { targets.push.apply(targets, binding.targets); unresolved = unresolved || binding.unknown; }
            else unresolved = true;
          }
          targets = unique(targets);
          if (!targets.length) unresolved = true;
          var bindings = childBindings(call, context.bindings);
          targets.forEach(function (target) {
            if (!byProc.has(target)) { unresolved = true; return; }
            var child = contextFor(target, bindings);
            var callLocal = { call: call.id, target: call.id + '->' + target };
            child.summary.prefix.forEach(function (proof, mask) {
              addOutcome('prefix', state.mask | mask, [state, proof], callLocal);
            });
            [['normal', call.normal], ['unwind', call.unwind]].forEach(function (pair) {
              child.summary[pair[0]].forEach(function (proof, mask) {
                var joined = state.mask | mask;
                if (call.tail) addOutcome(pair[0], joined, [state, proof], callLocal);
                else pair[1].forEach(function (edgeId) { var edge = byEdge.get(edgeId);
                  if (edge) traverse(edge, joined, [state, proof], callLocal); });
              });
            });
            child.summary.terminate.forEach(function (proof, mask) {
              addOutcome('prefix', state.mask | mask, [state, proof], callLocal);
            });
          });
          if (unresolved) {
            unknownSeen = true;
            var opaque = { call: call.id, target: call.id + '->?' };
            addOutcome('prefix', state.mask, [state], opaque);
            if (!call.tail) call.normal.concat(call.unwind).forEach(function (edgeId) {
              var edge = byEdge.get(edgeId); if (edge) traverse(edge, state.mask, [state], opaque);
            });
            else { addOutcome('normal', state.mask, [state], opaque); addOutcome('unwind', state.mask, [state], opaque); }
          }
          continue;
        }
        if (node.kind === 'opaque' || node.kind === 'yield' || node.kind === 'drop') {
          unknownSeen = true;
          if (node.kind === 'opaque' && procedure.nodeIds.filter(function (id) { return byNode.get(id).block !== null; }).length === 1 && !outgoingEdges.length) {
            addOutcome('normal', state.mask, [state]);
            addOutcome('unwind', state.mask, [state]);
          }
        }
        outgoingEdges.forEach(function (edge) { if (edge.kind !== 'continuation') traverse(edge, state.mask, [state]); });
      }
      return true;
    }
    var changed = true, passes = 0;
    while (changed) {
      if (cancelled()) return cancelledResult(roots);
      changed = false; passes++;
      var current = Array.from(contexts.values());
      for (var i = 0; i < current.length; i++) {
        var next = await runContext(current[i]);
        if (next === false) return cancelledResult(roots);
        if (!next) return { status: 'indeterminate', partialCoverage: true,
          diagnostics: ['Procedure summary budget reached; full model retained.'], roots: roots,
          activeNodeIds: [], activeEdgeIds: [], activeCallIds: [], activeCallTargets: [] };
      }
      if (contexts.size > current.length) changed = true;
      if (passes % 2 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    var active = { nodes: new Set(), edges: new Set(), calls: new Set(), callTargets: new Set() };
    var found = false, proofStack = [];
    rootContexts.forEach(function (context) {
      var proof = context.summary.prefix.get(full);
      if (proof) { found = true; proofStack.push(proof); }
    });
    var proofSeen = new Set();
    while (proofStack.length) {
      var currentProof = proofStack.pop();
      if (proofSeen.has(currentProof.id)) continue;
      proofSeen.add(currentProof.id);
      currentProof.derivations.forEach(function (d) {
        if (d.node) active.nodes.add(d.node);
        if (d.edge) active.edges.add(d.edge);
        if (d.call) active.calls.add(d.call);
        if (d.target) active.callTargets.add(d.target);
        d.refs.forEach(function (r) { proofStack.push(r); });
      });
    }
    var diagnostics = [];
    if (unknownSeen) diagnostics.push('Unresolved or opaque execution effects may contain additional routes.');
    if (prunedRoots) diagnostics.push(prunedRoots + ' roots cannot reach all pins through known calls; they remain in the full model.');
    if (!found && !unknownSeen) diagnostics.push('No route in the captured structural CFG visits every selected procedure.');
    var status = unknownSeen ? 'indeterminate' : found ? 'exact' : 'impossible';
    return { status: status, partialCoverage: unknownSeen || !!(model.coverage && model.coverage.partial),
      diagnostics: diagnostics, roots: roots,
      activeNodeIds: Array.from(active.nodes), activeEdgeIds: Array.from(active.edges),
      activeCallIds: Array.from(active.calls), activeCallTargets: Array.from(active.callTargets) };
  }

  // Ordered queries use a finite automaton (the next waypoint index), composed
  // with procedure summaries. Unlike AND masks, composition is not commutative.
  // Each summary is parameterized by its input index and exact callback bindings;
  // only that callsite's normal/unwind continuation can consume its result.
  var orderedIndexes = new WeakMap();
  function orderedIndex(model) {
    if (orderedIndexes.has(model)) return orderedIndexes.get(model);
    var index = { procedures: new Map(), nodes: new Map(), edges: new Map(), calls: new Map(), callIds: new Map(), outgoing: new Map() };
    model.procedures.forEach(function (p) { index.procedures.set(p.id, p); });
    model.nodes.forEach(function (n) { index.nodes.set(n.id, n); });
    model.calls.forEach(function (c) { index.calls.set(c.from, c); index.callIds.set(c.id, c); });
    model.edges.forEach(function (e) {
      index.edges.set(e.id, e);
      if (!index.outgoing.has(e.from)) index.outgoing.set(e.from, []);
      index.outgoing.get(e.from).push(e);
    });
    orderedIndexes.set(model, index); return index;
  }
  async function analyzeOrdered(model, query, options) {
    options = options || {};
    var index = orderedIndex(model), waypoints = query.waypoints, exclusions = query.exclusions || [];
    var limits = Object.assign({ maxWork: 2000000, maxStates: 50000, maxEvidence: 200 }, query.budgets || {});
    var work = 0, stateCount = 0, nextProof = 0, changed = true, unknown = false, stopped = null;
    var contexts = new Map(), diagnostics = [], root = index.procedures.get(query.root);
    if (waypoints.concat(exclusions).some(function (s) { return !s ||
      !(s.kind === 'procedure' ? index.procedures : s.kind === 'node' ? index.nodes : s.kind === 'call' ? index.callIds : new Map()).has(s.id); })) unknown = true;
    var full = waypoints.length, now = options.now || Date.now, started = now();
    function stop() {
      if (options.cancelled && options.cancelled()) stopped = 'cancelled';
      if (now() - started >= (query.timeoutMs || 2000)) stopped = 'timeout';
      return !!stopped;
    }
    function spend() { if (stopped) return false; if (++work > limits.maxWork) stopped = 'work'; return !stopped; }
    function proof(refs, step) { return { id: 'ordered-proof:' + (++nextProof), refs: refs, step: step }; }
    function match(selection, event) { return selection.kind === event.kind && selection.id === event.id; }
    function consume(progress, event) {
      if (exclusions.some(function (s) { return match(s, event); })) return -1;
      return progress < full && match(waypoints[progress], event) ? progress + 1 : progress;
    }
    function eventStep(event, progress, next) {
      var n = index.nodes.get(event.nodeId), p = index.procedures.get(event.procedure);
      var c = event.kind === 'call' && index.calls.get(event.nodeId);
      return { kind: event.kind, id: event.id, procedure: event.procedure, nodeId: event.nodeId || null,
        callsiteId: event.kind === 'call' ? event.id : null,
        nodeKind: n && n.kind || null, block: n && n.block || null,
        callback: !!(c && Number.isInteger(c.callbackParameter)),
        label: n && n.label || p && p.display_path || null,
        condition: n && n.condition || null, predicate: n && n.predicate || null,
        sourceSnippet: n && typeof n.source_snippet === 'string' ? n.source_snippet.slice(0, 500) : null,
        source: source(n || p || {}), progressBefore: progress, progressAfter: next };
    }
    function eventProof(previous, event, progress) {
      var next = consume(progress, event);
      return next < 0 ? null : { progress: next, proof: proof(previous ? [previous] : [], eventStep(event, progress, next)) };
    }
    function contextFor(procedure, bindings, input) {
      bindings = normalizeBindings(bindings);
      var key = JSON.stringify([procedure, bindings, input]);
      if (!contexts.has(key)) {
        if (stateCount >= limits.maxStates) { stopped = 'states'; return null; }
        stateCount++;
        contexts.set(key, { id: key, procedure: procedure, bindings: bindings, input: input,
          states: new Map(), calls: new Map(), summary: blankSummary(), seeded: false });
        changed = true;
      }
      return contexts.get(key);
    }
    function outcome(context, kind, progress, ref) {
      if (!context.summary[kind].has(progress)) {
        context.summary[kind].set(progress, ref); changed = true;
      }
    }
    async function run(context) {
      var p = index.procedures.get(context.procedure), queue = [], queued = new Set(), head = 0;
      function schedule(state) { if (!queued.has(state.key)) { queued.add(state.key); queue.push(state); } }
      function put(nodeId, progress, previous) {
        if (stopped) return;
        var n = index.nodes.get(nodeId);
        if (!n || n.procedure !== p.id) { unknown = true; return; }
        var next = consume(progress, { kind: 'node', id: nodeId });
        if (next < 0) return;
        var key = JSON.stringify([nodeId, next]), state = context.states.get(key);
        if (!state) {
          if (stateCount >= limits.maxStates) { stopped = 'states'; return; }
          stateCount++;
          var event = { kind: 'node', id: nodeId, nodeId: nodeId, procedure: p.id };
          state = { key: key, nodeId: nodeId, progress: next, proof: proof([previous], eventStep(event, progress, next)) };
          context.states.set(key, state);
        }
        schedule(state);
      }
      function traverse(edge, progress, previous, call, target, child) {
        if (!spend() || stop()) return;
        if (!edge || edge.from !== (call ? call.from : previous.step.nodeId) || edge.procedure !== p.id ||
            call && (edge.kind !== 'continuation' || edge.callsite !== call.id)) { unknown = true; return; }
        if (edge.guard === 'unreachable' || edge.action === 'unreachable') return;
        var step = { kind: call ? 'continuation' : 'edge', id: edge.id, edgeId: edge.id,
          nodeId: edge.from, procedure: p.id, from: edge.from, to: edge.to,
          label: edge.label || null, guard: edge.guard || null, action: edge.action || null,
          condition: edge.condition || null, predicate: edge.predicate || null,
          callsiteId: call ? call.id : null, target: target || null, summaryId: child ? child.id : null,
          source: source(index.nodes.get(edge.from) || p), progressBefore: progress, progressAfter: progress };
        put(edge.to, progress, proof(child ? [previous, child] : [previous], step));
      }
      if (!context.seeded) {
        context.seeded = true;
        var entry = eventProof(null, { kind: 'procedure', id: p.id, procedure: p.id, nodeId: p.start }, context.input);
        if (entry && entry.progress === full) outcome(context, 'prefix', full, entry.proof);
        else if (entry) {
          var start = eventProof(entry.proof, { kind: 'node', id: p.start, procedure: p.id, nodeId: p.start }, entry.progress);
          if (start && start.progress === full) outcome(context, 'prefix', full, start.proof);
          else if (start) {
            var startEdge = index.edges.get(p.start + '->' + p.entry);
            if (startEdge) traverse(startEdge, start.progress, start.proof);
            else unknown = true;
          }
        }
      }
      context.states.forEach(schedule);
      while (head < queue.length && !stopped) {
        if (!spend() || stop()) break;
        if (work % 512 === 0) { await new Promise(function (resolve) { setTimeout(resolve, 0); }); if (stop()) break; }
        var state = queue[head++], n = index.nodes.get(state.nodeId), progress = state.progress, ref = state.proof;
        outcome(context, 'prefix', progress, ref);
        if (progress === full) continue; // A reachability prefix ends at its final waypoint.
        if (n.block === null) {
          if (['return', 'unwind', 'terminate'].includes(n.kind)) outcome(context, n.kind === 'return' ? 'normal' : n.kind, progress, ref);
          continue;
        }
        var call = index.calls.get(n.id), outgoing = index.outgoing.get(n.id) || [];
        if (call) {
          var invoked = context.calls.get(state.key);
          if (!context.calls.has(state.key)) {
            invoked = eventProof(ref, { kind: 'call', id: call.id, procedure: p.id, nodeId: call.from }, progress);
            context.calls.set(state.key, invoked);
          }
          if (!invoked) continue;
          progress = invoked.progress; ref = invoked.proof;
          outcome(context, 'prefix', progress, ref);
          if (progress === full) continue;
          var targets = call.targets.slice(), unresolved = call.unknown || !!call.nativeCall || !!call.possibleDispatch;
          if (Number.isInteger(call.callbackParameter)) {
            var binding = context.bindings[call.callbackParameter];
            if (binding) { targets.push.apply(targets, binding.targets); unresolved = unresolved || binding.unknown; }
            else unresolved = true;
          }
          targets = unique(targets);
          if (!targets.length) unresolved = true;
          var bindings = childBindings(call, context.bindings);
          // Validate every recorded continuation even if no callee exit exists yet.
          [['normal', call.normal], ['unwind', call.unwind]].forEach(function (pair) {
            for (var vi = 0; vi < pair[1].length && !stopped; vi++) {
              if (!spend() || stop()) break;
              var e = index.edges.get(pair[1][vi]);
              if (!e || e.from !== call.from || e.callsite !== call.id || e.kind !== 'continuation' ||
                  e.action !== pair[0] || !index.nodes.has(e.to)) unknown = true;
            }
          });
          for (var t = 0; t < targets.length && !stopped; t++) {
            var target = targets[t];
            if (!index.procedures.has(target)) { unresolved = true; continue; }
            var child = contextFor(target, bindings, progress);
            if (!child) break;
            child.summary.prefix.forEach(function (childProof, out) {
              if (!spend()) return;
              if (out === full) outcome(context, 'prefix', out, proof([ref, childProof], {
                kind: 'summary', id: childProof.id, summaryId: childProof.id, procedure: target,
                callsiteId: call.id, target: target, outcome: 'prefix', sourceProcedure: p.id,
                source: source(index.nodes.get(call.from) || p),
                progressBefore: progress, progressAfter: out }));
            });
            [['normal', call.normal], ['unwind', call.unwind]].forEach(function (pair) {
              child.summary[pair[0]].forEach(function (childProof, out) {
                if (!spend()) return;
                if (!call.tail && !pair[1].length) unknown = true;
                if (call.tail) outcome(context, pair[0], out, proof([ref, childProof], {
                  kind: 'summary', id: childProof.id, summaryId: childProof.id, procedure: target,
                  callsiteId: call.id, target: target, outcome: pair[0], sourceProcedure: p.id,
                  source: source(index.nodes.get(call.from) || p),
                  progressBefore: progress, progressAfter: out }));
                else for (var ci = 0; ci < pair[1].length && !stopped; ci++) {
                  var e = index.edges.get(pair[1][ci]);
                  if (e && e.action === pair[0]) traverse(e, out, ref, call, target, childProof);
                }
              });
            });
          }
          // Unknown bodies do not acquire invented returns or witness edges.
          if (unresolved) unknown = true;
          continue;
        }
        if (['opaque', 'yield', 'drop'].includes(n.kind)) unknown = true;
        if (!outgoing.length && !['abort', 'unreachable'].includes(n.kind)) unknown = true;
        for (var oi = 0; oi < outgoing.length && !stopped; oi++) {
          var e = outgoing[oi];
          if (e.kind === 'continuation') { unknown = true; continue; }
          traverse(e, progress, ref);
        }
      }
    }
    var rootContext = root ? contextFor(root.id, {}, 0) : null;
    if (!rootContext) unknown = true;
    while (changed && !stopped) {
      changed = false;
      var pass = Array.from(contexts.values());
      for (var i = 0; i < pass.length && !stopped; i++) await run(pass[i]);
      if (changed) { await new Promise(function (resolve) { setTimeout(resolve, 0); }); stop(); }
    }
    var winning = rootContext && rootContext.summary.prefix.get(full), steps = [], summaries = [], seen = new Set();
    var stack = winning ? [{ proof: winning, emit: false }] : [], evidenceWork = 0, truncated = false;
    // One representative derivation, in execution order. Reused derivations are
    // explicit summary references, never sorted union slices or mixed traces.
    while (stack.length) {
      if (stop()) break;
      if (++evidenceWork > limits.maxEvidence * 16 || steps.length >= limits.maxEvidence) { truncated = true; break; }
      var item = stack.pop(), current = item.proof;
      if (item.emit) { if (current.step) steps.push(current.step); continue; }
      if (seen.has(current.id)) {
        steps.push({ kind: 'summary-reference', summaryId: current.id, procedure: current.step.procedure,
          sourceProcedure: current.step.sourceProcedure || current.step.procedure, source: current.step.source,
          progressBefore: current.step.progressBefore, progressAfter: current.step.progressAfter,
          ...(item.invocation || {}) });
        continue;
      }
      seen.add(current.id);
      if (current.step && current.step.summaryId) summaries.push({ id: current.step.summaryId,
        procedure: current.step.target || current.step.procedure, callsiteId: current.step.callsiteId,
        kind: 'fixed-point-derivation', outcome: current.step.outcome || current.step.action,
        sourceProcedure: current.step.sourceProcedure || current.step.procedure, source: current.step.source });
      stack.push({ proof: current, emit: true });
      for (var r = current.refs.length - 1; r >= 0; r--) {
        // A reused child proof still belongs to this exact invocation, not a bounded boundary.
        var invocation = current.step && current.step.summaryId === current.refs[r].id && current.step.callsiteId ? {
          callerProcedure: current.step.sourceProcedure || current.step.procedure,
          callsiteId: current.step.callsiteId, target: current.step.target,
          outcome: current.step.outcome || current.step.action,
          continuationId: current.step.kind === 'continuation' ? current.step.edgeId : null
        } : null;
        stack.push({ proof: current.refs[r], emit: false, invocation: invocation });
      }
    }
    if (winning && (truncated || stopped)) {
      if (!steps.length && limits.maxEvidence > 1) steps.push(eventStep({ kind: 'procedure', id: root.id, procedure: root.id, nodeId: root.start },
        0, match(waypoints[0], { kind: 'procedure', id: root.id }) ? 1 : 0));
      if (steps.length >= limits.maxEvidence) steps.pop();
      steps.push({ kind: 'summary-reference', summaryId: winning.id, summaryKind: 'evidence-budget',
        procedure: root.id, source: source(root), progressBefore: steps.length ? steps[steps.length - 1].progressAfter : 0,
        progressAfter: full, label: 'Remaining ordered proof evidence; replay this exact request to expand.' });
    }
    var frames = [];
    steps.forEach(function (step) {
      if (step.kind === 'procedure') {
        if (frames.some(function (f) { return f.procedure === step.procedure; })) {
          step.summaryId = 'recursion:' + step.procedure; step.summaryKind = 'recursion';
        }
        frames.push({ procedure: step.procedure, nodes: new Set() });
      }
      if (step.kind === 'continuation') {
        while (frames.length && frames[frames.length - 1].procedure !== step.procedure) frames.pop();
      }
      if (step.kind === 'node' && step.block && frames.length) {
        var frame = frames[frames.length - 1];
        if (frame.nodes.has(step.id)) { step.summaryId = 'loop:' + step.id; step.summaryKind = 'loop'; }
        frame.nodes.add(step.id);
      }
      if (step.summaryKind) summaries.push({ id: step.summaryId, procedure: step.procedure,
        kind: step.summaryKind + '-fixed-point', source: step.source });
      if (step.kind === 'node' && !step.block && ['return', 'unwind', 'terminate'].includes(step.nodeKind)) frames.pop();
    });
    if (stopped) diagnostics.push('Ordered analysis ' + stopped + ' budget/cancellation reached; no negative conclusion.');
    if (unknown) diagnostics.push('Reachable unresolved bodies or unsupported execution/continuations remain unknown.');
    if (!winning && !unknown && !stopped) diagnostics.push('No captured structural prefix visits these waypoints in order while avoiding exclusions.');
    return { status: stopped === 'cancelled' || stopped === 'timeout' ? 'cancelled' : stopped || unknown ? 'indeterminate' : winning ? 'exact' : 'impossible',
      partialCoverage: unknown || !!stopped, diagnostics: diagnostics, roots: [query.root],
      witness: winning ? { kind: 'ordered-structural-prefix', rootProofId: winning.id, steps: steps,
        summaries: summaries.slice(0, limits.maxEvidence), truncated: truncated || !!stopped,
        matchedWaypoints: full, branchFeasibilitySolved: false } : null,
      completion: { complete: !stopped, cancelled: stopped === 'cancelled', timedOut: stopped === 'timeout',
        budgetExceeded: stopped === 'work' || stopped === 'states', evidenceComplete: !truncated && !stopped,
        work: work, states: stateCount, limits: limits, timeoutMs: query.timeoutMs || 2000 } };
  }

  return { build: build, analyze: analyze, analyzeOrdered: analyzeOrdered, disconnectedRoots: disconnectedRoots };
});
