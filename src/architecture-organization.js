/* Architecture function organization. Browser global and CommonJS. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ArchitectureOrganization = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Combine the rendered architecture and callable projections without
  // changing either source graph. IDs stay canonical across presets.
  function unify(base, callable) {
    base = base || { nodes: [], links: [] };
    callable = callable || { nodes: [], links: [] };
    var nodesById = new Map();
    (base.nodes || []).forEach(function (node) {
      if (node && typeof node.id === "string") nodesById.set(node.id, Object.assign({}, node));
    });
    var structural = new Set(["id", "kind", "label", "crate", "layoutGroup", "packageVersion",
      "packageSource", "workspaceMember", "x", "y", "sx", "sy", "px", "py", "vx", "vy",
      "fx", "fy", "cax", "cay"]);
    (callable.nodes || []).forEach(function (node) {
      if (!node || typeof node.id !== "string") return;
      var existing = nodesById.get(node.id);
      if (!existing) { nodesById.set(node.id, Object.assign({}, node)); return; }
      Object.keys(node).forEach(function (key) {
        if (structural.has(key) || node[key] == null) return;
        if (key === "flowPaths") {
          existing.flowPaths = Array.from(new Set((existing.flowPaths || []).concat(node.flowPaths || []))).sort();
        } else {
          if (key === "path" && existing.path && existing.path !== node.path)
            existing.architecturePath = existing.path;
          existing[key] = node[key];
        }
      });
    });
    function endpoint(link, side) {
      var value = side === "source" ? link.sid || link.source : link.tid || link.target;
      return value && typeof value === "object" ? value.id : value;
    }
    function copyLink(link) {
      var source = endpoint(link, "source"), target = endpoint(link, "target");
      return Object.assign({}, link, { source: source, target: target, sid: source, tid: target,
        callsites: Array.isArray(link.callsites) ? link.callsites.slice() : [] });
    }
    function callClass(link, fromCallable) {
      if (fromCallable) {
        if (link.kind === "native_call") return "native_calls";
        if (link.kind === "call" || link.kind === "recursion") return "calls";
        return null;
      }
      return link.rel === "calls" || link.rel === "native_calls" ? link.rel : null;
    }
    function key(link, category) { return link.sid + "\t" + link.tid + "\t" + category; }
    var confirmed = new Set();
    (callable.links || []).forEach(function (link) {
      var category = callClass(link, true);
      if (category) confirmed.add(key(copyLink(link), category));
    });
    var links = [], mergeIndex = new Map();
    (base.links || []).forEach(function (raw) {
      var link = copyLink(raw), category = callClass(link, false);
      if (link.rel === "member_calls") {
        link.execution = false; link.uncertain = true; link.cat = "aggregate_call";
      } else if (link.rel === "calls" && !confirmed.has(key(link, "calls"))) {
        // Architecture text cannot override a MIR identity mismatch.
        link.execution = false; link.uncertain = true; link.cat = "architecture_call";
      } else if (category) {
        link.execution = true;
        if (category === "native_calls" && nodesById.get(link.tid) &&
            nodesById.get(link.tid).nativeBoundaryKind) {
          link.uncertain = true; link.bodyUnavailable = true;
        }
        mergeIndex.set(key(link, category), links.length);
      } else {
        link.execution = false;
      }
      links.push(link);
    });
    (callable.links || []).forEach(function (raw) {
      var link = copyLink(raw), category = callClass(link, true);
      var duplicate = category && mergeIndex.get(key(link, category));
      if (category && duplicate !== undefined) {
        var existing = links[duplicate], callsites = new Map();
        existing.callsites.concat(link.callsites).forEach(function (site) {
          callsites.set(JSON.stringify(site), site);
        });
        var rel = existing.rel, wasUncertain = !!existing.uncertain;
        Object.assign(existing, link);
        existing.rel = rel;
        existing.execution = true;
        existing.uncertain = wasUncertain || !!link.uncertain;
        existing.callsites = Array.from(callsites.values()).sort(function (a, b) {
          return String(a.id || "").localeCompare(String(b.id || ""));
        });
      } else {
        if (link.kind === "reference" || link.rel === "references") link.execution = false;
        links.push(link);
        if (category) mergeIndex.set(key(link, category), links.length - 1);
      }
    });
    var nodes = Array.from(nodesById.values()).sort(function (a, b) { return a.id.localeCompare(b.id); });
    links.sort(function (a, b) { return String(a.sid).localeCompare(String(b.sid)) ||
      String(a.tid).localeCompare(String(b.tid)) || String(a.rel).localeCompare(String(b.rel)) ||
      String(a.kind || "").localeCompare(String(b.kind || "")); });
    return { nodes: nodes, links: links };
  }

  function project(overview, model) {
    overview = overview || { nodes: [], edges: [], aliases: [] };
    model = model || { calls: [] };
    var nodes = overview.nodes.map(function (node) { return Object.assign({}, node); });
    var byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
    var aliases = new Map(overview.aliases || []), edges = [], keys = new Set();
    var boundaryCallsites = new Map(overview.boundaryCallsites || []);
    var modelCalls = new Map((model.calls || []).map(function (call) { return [call.id, call]; }));
    boundaryCallsites.forEach(function (_, id) {
      var call = modelCalls.get(id);
      if (call && (call.resolvedTargets || []).length &&
          !(call.unavailableTargets || []).includes(call.directKey)) boundaryCallsites.delete(id);
    });
    var modeledPairs = new Set(), mismatchedLiteralPairs = new Set();
    (model.calls || []).forEach(function (call) {
      var source = aliases.get(call.procedure);
      if (!source) return;
      new Set([].concat(call.targets || [], call.possibleTargets || [], call.dispatchTargets || []))
        .forEach(function (path) {
        var target = aliases.get(path);
        if (target) modeledPairs.add(source + "\t" + target);
      });
      if (call.calleeId && call.directKey) {
        var rawTarget = aliases.get(call.directKey);
        if (rawTarget && !(call.resolvedTargets || []).includes(call.directKey))
          mismatchedLiteralPairs.add(source + "\t" + rawTarget);
      }
    });
    function add(source, target, kind, uncertain, meta) {
      if (!byId.has(source) || !byId.has(target)) return;
      var referenceKind = kind === "reference" && meta ? meta.referenceKind || "callback_registration" : null;
      var key = source + "\t" + target + "\t" + kind + "\t" + (referenceKind || "");
      if (keys.has(key)) return;
      keys.add(key);
      var targetNode = byId.get(target);
      edges.push({ source: source, target: target, kind: kind, uncertain: !!uncertain,
        execution: kind !== "reference", bodyUnavailable: kind === "boundary" ||
          !!(targetNode && targetNode.language === "native"),
        referenceKind: referenceKind,
        boundaryKind: meta && meta.boundaryKind || targetNode && targetNode.native_boundary_kind || null,
        native_call: meta && meta.native_call || null,
        callee_package_id: meta && meta.callee_package_id || null,
        callee_artifact: meta && meta.callee_artifact || null,
        callee_abi: meta && meta.callee_abi || null,
        callsites: meta && meta.callsites ? meta.callsites.slice() : [] });
    }
    (overview.edges || []).forEach(function (edge) {
      // An external callback argument is a registration, not an invocation.
      if (edge.kind === "candidate") {
        add(edge.source, edge.target, "reference", true,
          Object.assign({}, edge, { referenceKind: edge.referenceKind || "callback_registration" }));
        return;
      }
      if (edge.kind === "loop") return;
      if (edge.kind === "boundary") {
        var retained = (edge.callsites || []).filter(function (site) { return boundaryCallsites.has(site.id); });
        if (!retained.length) return;
        edge = Object.assign({}, edge, { callsites: retained });
      }
      var pair = edge.source + "\t" + edge.target;
      if (modeledPairs.has(pair) || mismatchedLiteralPairs.has(pair)) return;
      add(edge.source, edge.target, edge.kind,
        edge.kind === "indirect" || edge.kind === "callback" || edge.kind === "boundary" ||
          !!(byId.get(edge.target) && byId.get(edge.target).native_boundary_kind), edge);
    });
    (model.calls || []).forEach(function (call) {
      var source = aliases.get(call.procedure);
      if (!source) return;
      var direct = new Set(call.targets || []), dispatch = new Set(call.dispatchTargets || []);
      var all = new Set([].concat(call.targets || [], call.possibleTargets || [], call.dispatchTargets || []));
      all.forEach(function (path) {
        var target = aliases.get(path);
        if (!target) return;
        var kind = dispatch.has(path) ? "dispatch" : direct.has(path) ? "call" : "callback";
        add(source, target, source === target ? "recursion" : kind,
          dispatch.has(path) || !direct.has(path) || !!call.unknown);
      });
    });
    var retainedBoundaries = new Set(boundaryCallsites.values());
    nodes = nodes.filter(function (node) { return node.kind !== "boundary" || retainedBoundaries.has(node.id); });
    byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
    var outgoing = new Map(), incoming = new Map(), references = new Map();
    nodes.forEach(function (node) { outgoing.set(node.id, []); incoming.set(node.id, []);
      references.set(node.id, []); });
    edges.forEach(function (edge) {
      if (!edge.execution) {
        references.get(edge.source).push(edge.target);
        references.get(edge.target).push(edge.source);
        return;
      }
      outgoing.get(edge.source).push(edge.target);
      incoming.get(edge.target).push(edge.source);
    });
    function walk(start, links) {
      var seen = new Set([start]), queue = [start];
      for (var head = 0; head < queue.length; head++) {
        (links.get(queue[head]) || []).forEach(function (id) {
          if (!seen.has(id)) { seen.add(id); queue.push(id); }
        });
      }
      return seen;
    }
    function related(id) {
      if (!byId.has(id)) return new Set();
      var result = walk(id, outgoing);
      walk(id, incoming).forEach(function (other) { result.add(other); });
      // Show direct registrations attached to the selected node, but do not
      // traverse a callback reference as an execution route.
      references.get(id).forEach(function (other) { result.add(other); });
      return result;
    }
    function refine(ids) {
      var result = null;
      (ids || []).forEach(function (id) {
        var current = related(id);
        if (result === null) result = current;
        else result.forEach(function (other) { if (!current.has(other)) result.delete(other); });
      });
      return result || new Set();
    }
    return { nodes: nodes, edges: edges, references: edges.filter(function (edge) { return !edge.execution; }),
      boundaryCallsites: boundaryCallsites,
      aliases: aliases, related: related,
      refine: refine, byId: byId };
  }
  function activeProjection(model, result, aliases, boundaryCallsites) {
    var byNode = new Map((model.nodes || []).map(function (node) { return [node.id, node.procedure]; }));
    var nodeIds = new Set(), edgePairs = new Set();
    var boundaryContextNodeIds = new Set(), boundaryContextEdgePairs = new Set();
    var activeBlocks = new Set(result.activeNodeIds || []);
    var confirmedUnknown = new Set(result.activeUnknownCallIds || []);
    var boundaries = boundaryCallsites instanceof Map ? boundaryCallsites : new Map(boundaryCallsites || []);
    (result.activeNodeIds || []).forEach(function (id) {
      var procedure = byNode.get(id), nodeId = aliases.get(procedure);
      if (nodeId) nodeIds.add(nodeId);
    });
    var targets = new Set(result.activeCallTargets || []);
    (model.calls || []).forEach(function (call) {
      var source = aliases.get(call.procedure);
      if (!source) return;
      var boundary = boundaries.get(call.id);
      if (boundary && activeBlocks.has(call.from)) {
        var pair = source + "\t" + boundary;
        if (confirmedUnknown.has(call.id)) { nodeIds.add(boundary); edgePairs.add(pair); }
        else { boundaryContextNodeIds.add(boundary); boundaryContextEdgePairs.add(pair); }
      }
      new Set([].concat(call.targets || [], call.possibleTargets || [], call.dispatchTargets || []))
        .forEach(function (path) {
          var target = aliases.get(path);
          if (target && targets.has(call.id + "->" + path)) edgePairs.add(source + "\t" + target);
        });
    });
    return { nodeIds: nodeIds, edgePairs: edgePairs,
      boundaryContextNodeIds: boundaryContextNodeIds,
      boundaryContextEdgePairs: boundaryContextEdgePairs };
  }
  // Layout coordinates only. The projected nodes and links remain unchanged.
  function treeLayout(projection, spaceSize) {
    var nodes = (projection.nodes || []).slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    var count = nodes.length, positions = new Map();
    if (!count) return positions;
    var index = new Map(nodes.map(function (node, i) { return [node.id, i]; }));
    var out = Array.from({ length: count }, function () { return []; });
    var incoming = Array.from({ length: count }, function () { return []; });
    var adjacent = Array.from({ length: count }, function () { return []; });
    (projection.edges || []).slice()
      .sort(function (a, b) {
        return String(a.source).localeCompare(String(b.source)) || String(a.target).localeCompare(String(b.target));
      }).forEach(function (edge) {
        var source = index.get(edge.source), target = index.get(edge.target);
        if (source === undefined || target === undefined) return;
        adjacent[source].push(target); adjacent[target].push(source);
        if (edge.execution === false) return;
        out[source].push(target); incoming[target].push(source);
      });
    var weak = new Int32Array(count).fill(-1), groups = [];
    for (var i = 0; i < count; i++) {
      if (weak[i] !== -1) continue;
      var group = [], queue = [i], groupId = groups.length;
      weak[i] = groupId;
      for (var head = 0; head < queue.length; head++) {
        var current = queue[head]; group.push(current);
        adjacent[current].forEach(function (next) {
          if (weak[next] === -1) { weak[next] = groupId; queue.push(next); }
        });
      }
      groups.push(group);
    }
    var seen = new Uint8Array(count), order = [];
    for (var start = 0; start < count; start++) {
      if (seen[start]) continue;
      seen[start] = 1;
      var stack = [[start, 0]];
      while (stack.length) {
        var top = stack[stack.length - 1], next = out[top[0]][top[1]++];
        if (next === undefined) { order.push(top[0]); stack.pop(); }
        else if (!seen[next]) { seen[next] = 1; stack.push([next, 0]); }
      }
    }
    var scc = new Int32Array(count).fill(-1), sccMembers = [];
    for (var at = order.length - 1; at >= 0; at--) {
      var root = order[at];
      if (scc[root] !== -1) continue;
      var members = [], pending = [root], component = sccMembers.length;
      scc[root] = component;
      while (pending.length) {
        var vertex = pending.pop(); members.push(vertex);
        incoming[vertex].forEach(function (other) {
          if (scc[other] === -1) { scc[other] = component; pending.push(other); }
        });
      }
      sccMembers.push(members);
    }
    var dag = sccMembers.map(function () { return new Set(); });
    var indegree = new Int32Array(sccMembers.length), rank = new Int32Array(sccMembers.length);
    for (var from = 0; from < count; from++) out[from].forEach(function (to) {
      var a = scc[from], b = scc[to];
      if (a !== b && !dag[a].has(b)) { dag[a].add(b); indegree[b]++; }
    });
    var ready = [];
    for (var c = 0; c < sccMembers.length; c++) if (!indegree[c]) ready.push(c);
    for (var item = 0; item < ready.length; item++) {
      var sourceScc = ready[item];
      dag[sourceScc].forEach(function (targetScc) {
        rank[targetScc] = Math.max(rank[targetScc], rank[sourceScc] + 1);
        if (!--indegree[targetScc]) ready.push(targetScc);
      });
    }
    var baseColumnGap = 90, rowGap = 28, componentGap = 42, boxes = [];
    groups.forEach(function (members) {
      var layers = new Map(), maxRank = 0, maxRows = 0;
      members.forEach(function (vertex) {
        var level = rank[scc[vertex]];
        if (!layers.has(level)) layers.set(level, []);
        layers.get(level).push(vertex); maxRank = Math.max(maxRank, level);
      });
      var row = new Map();
      for (var level = 0; level <= maxRank; level++) {
        var layer = layers.get(level) || [];
        layer.sort(function (a, b) {
          function center(vertex) {
            var refs = incoming[vertex].filter(function (parent) { return rank[scc[parent]] < level; });
            return refs.length ? refs.reduce(function (sum, parent) { return sum + row.get(parent); }, 0) / refs.length : Infinity;
          }
          return center(a) - center(b) || String(nodes[a].id).localeCompare(String(nodes[b].id));
        });
        layer.forEach(function (vertex, position) { row.set(vertex, position); });
        maxRows = Math.max(maxRows, layer.length);
      }
      var height = Math.max(1, maxRows) * rowGap;
      var columnGap = maxRank ? Math.max(baseColumnGap, height * 1.5 / maxRank) : baseColumnGap;
      boxes.push({ members: members, layers: layers, columnGap: columnGap,
        width: maxRank * columnGap + 40, height: height, key: String(nodes[members[0]].id) });
    });
    boxes.sort(function (a, b) {
      return b.width * b.height - a.width * a.height || b.width - a.width || a.key.localeCompare(b.key);
    });
    var area = boxes.reduce(function (sum, box) { return sum + box.width * box.height; }, 0);
    var maxWidth = boxes.reduce(function (width, box) { return Math.max(width, box.width); }, 0);
    var targetWidth = Math.max(900, maxWidth, Math.sqrt(area) * 1.35);
    var cursorX = 0, cursorY = 0, shelfHeight = 0, raw = new Array(count);
    boxes.forEach(function (box) {
      if (cursorX && cursorX + box.width > targetWidth) {
        cursorX = 0; cursorY += shelfHeight + componentGap; shelfHeight = 0;
      }
      box.layers.forEach(function (layer, level) {
        layer.forEach(function (vertex, row) {
          raw[vertex] = { x: cursorX + level * box.columnGap,
            y: cursorY + (row + (box.height / rowGap - layer.length) / 2) * rowGap };
        });
      });
      cursorX += box.width + componentGap;
      shelfHeight = Math.max(shelfHeight, box.height);
    });
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    raw.forEach(function (point) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    });
    var size = spaceSize || 8192, margin = size * 0.04;
    var scale = Math.min((size - 2 * margin) / Math.max(1, maxX - minX),
      (size - 2 * margin) / Math.max(1, maxY - minY));
    raw.forEach(function (point, vertex) {
      positions.set(nodes[vertex].id, { x: size / 2 + (point.x - (minX + maxX) / 2) * scale,
        y: size / 2 + (point.y - (minY + maxY) / 2) * scale });
    });
    return positions;
  }
  function minimapGeometry(points, width, height, padding, flipY) {
    var valid = (points || []).filter(function (point) { return isFinite(point.x) && isFinite(point.y); });
    if (!valid.length || width <= 0 || height <= 0) return null;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    valid.forEach(function (point) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    });
    var pad = padding == null ? 8 : padding;
    var scale = Math.min((width - 2 * pad) / Math.max(1, maxX - minX),
      (height - 2 * pad) / Math.max(1, maxY - minY));
    if (!(scale > 0)) return null;
    var centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    function project(point) {
      return { x: width / 2 + (point.x - centerX) * scale,
        y: height / 2 + (point.y - centerY) * scale * (flipY ? -1 : 1) };
    }
    function invert(point) {
      return { x: centerX + (point.x - width / 2) / scale,
        y: centerY + (point.y - height / 2) / scale * (flipY ? -1 : 1) };
    }
    function viewport(bounds) {
      if (!bounds) return null;
      var a = project({ x: bounds.x0, y: bounds.y0 });
      var b = project({ x: bounds.x1, y: bounds.y1 });
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    }
    return { project: project, invert: invert, viewport: viewport, scale: scale,
      bounds: { x0: minX, y0: minY, x1: maxX, y1: maxY } };
  }
  function cosmosViewport(spaceToScreen, width, height) {
    var origin = spaceToScreen([0, 0]), xUnit = spaceToScreen([1, 0]), yUnit = spaceToScreen([0, 1]);
    var dx = xUnit[0] - origin[0], dy = yUnit[1] - origin[1];
    if (!isFinite(dx) || !isFinite(dy) || !dx || !dy) return null;
    var x0 = (0 - origin[0]) / dx, x1 = (width - origin[0]) / dx;
    var y0 = (0 - origin[1]) / dy, y1 = (height - origin[1]) / dy;
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }
  function nearestMinimapNode(points, target) {
    var nearest = null, best = Infinity;
    (points || []).forEach(function (point) {
      var distance = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
      if (distance < best) { nearest = point; best = distance; }
    });
    return nearest;
  }
  return { unify: unify, project: project, activeProjection: activeProjection, treeLayout: treeLayout,
    minimapGeometry: minimapGeometry, cosmosViewport: cosmosViewport, nearestMinimapNode: nearestMinimapNode };
});
