/* Shared, bounded map of already-qualified static execution traces. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FlowMap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function project(events, calls) {
    return events.filter(function (e, i) {
      if (e.type === "goto") return false;
      if (e.type === "branch" && e.edgeKind === "normal" && (e.branch === "next" || e.branch === "return")) return false;
      if ((e.type === "call" || e.type === "tail_call") && events[i + 1] &&
          events[i + 1].type === "enter" && events[i + 1].function === e.callee) return false;
      if (e.type === "return" && e.depth > 0 && calls) {
        var children = calls instanceof Map ? calls.get(e.function) : calls[e.function];
        if (!children || !children.length && !children.size) return false;
      }
      return true;
    });
  }
  function identity(e) {
    return JSON.stringify([e.context || e.function || "", e.type, e.function || "", e.block || "",
      e.callee || "", e.branch || "", e.target || "", e.edgeKind || "", e.via || "", e.label || ""]);
  }
  function build(traces, opts) {
    opts = opts || {};
    var nodes = [], edges = [], nodeIds = new Map(), edgePairs = new Map();
    function nodeFor(e, key) {
      key = key || identity(e);
      var id = nodeIds.get(key);
      if (id !== undefined) return id;
      id = nodes.length;
      nodeIds.set(key, id);
      nodes.push({ id: id, event: e, rank: 0, lane: 0 });
      return id;
    }
    function connect(from, to, kind) {
      var key = from + "|" + to, prior = edgePairs.get(key);
      if (prior) {
        if (kind === "loop" || kind === "recursion") prior.kind = kind;
      } else {
        var edge = { from: from, to: to, kind: kind };
        edgePairs.set(key, edge); edges.push(edge);
      }
    }
    (traces || []).forEach(function (trace) {
      var events = project(trace.events || [], opts.calls), seen = new Set(), previous = null, previousEvent = null;
      events.forEach(function (e) {
        var id = nodeFor(e);
        if (previous !== null) {
          var kind = seen.has(id) ? (e.type === "enter" && e.recursive ? "recursion" : "loop") :
            e.type === "enter" && e.via === "callback" ? "callback" :
            e.type === "enter" && e.depth > (previousEvent.depth || 0) ? "call" : "normal";
          connect(previous, id, kind);
        }
        if (e.callback_reference && Array.isArray(e.callback_candidates)) {
          e.callback_candidates.forEach(function (target) {
            if (typeof target !== "string") return;
            var definition = opts.functions instanceof Map ? opts.functions.get(target) : opts.functions && opts.functions[target];
            var candidate = { type: "candidate", function: target, label: target,
              block: e.block, context: e.context,
              source_file: definition && definition.source_file || null,
              source_location: definition && definition.source_location || null,
              registered_at_file: e.source_file, registered_at_location: e.source_location };
            connect(id, nodeFor(candidate, "candidate|" + id + "|" + target), "candidate");
          });
        }
        seen.add(id); previous = id; previousEvent = e;
      });
      if (previous !== null) {
        var reachedExit = trace.reachedExit === undefined ? trace.complete : trace.reachedExit;
        var type = reachedExit ? "exit" : "boundary";
        connect(previous, nodeFor({ type: type, label: reachedExit ? "recorded exit" : "boundary/bound",
          coveragePartial: !!trace.coveragePartial, context: previousEvent.context },
          "terminal|" + previous + "|" + type), "normal");
      }
    });
    return { nodes: nodes, edges: edges, pathCount: (traces || []).length };
  }
  function layout(map, opts) {
    opts = opts || {};
    var nodes = map.nodes, edges = map.edges, n = nodes.length;
    var outgoing = Array.from({ length: n }, function () { return []; });
    edges.forEach(function (e) { outgoing[e.from].push(e); });
    // Iterative DFS marks cycle-closing edges. The remaining graph is a DAG.
    var color = new Uint8Array(n);
    for (var start = 0; start < n; start++) {
      if (color[start]) continue;
      var stack = [{ id: start, next: 0 }]; color[start] = 1;
      while (stack.length) {
        var frame = stack[stack.length - 1], next = outgoing[frame.id];
        if (frame.next >= next.length) { color[frame.id] = 2; stack.pop(); continue; }
        var edge = next[frame.next++];
        if (edge.kind === "loop" || edge.kind === "recursion") continue;
        if (color[edge.to] === 1) { edge.kind = nodes[edge.to].event.recursive ? "recursion" : "loop"; continue; }
        if (!color[edge.to]) { color[edge.to] = 1; stack.push({ id: edge.to, next: 0 }); }
      }
    }
    var indegree = new Uint32Array(n), incoming = Array.from({ length: n }, function () { return []; });
    edges.forEach(function (e) {
      if (e.kind === "loop" || e.kind === "recursion") return;
      indegree[e.to]++; incoming[e.to].push(e.from);
    });
    var queue = [];
    for (var i = 0; i < n; i++) if (!indegree[i]) queue.push(i);
    for (var head = 0; head < queue.length; head++) {
      var id = queue[head];
      outgoing[id].forEach(function (e) {
        if (e.kind === "loop" || e.kind === "recursion") return;
        nodes[e.to].rank = Math.max(nodes[e.to].rank, nodes[id].rank + 1);
        if (!--indegree[e.to]) queue.push(e.to);
      });
    }
    var ranks = new Map(), maxRank = 0;
    nodes.forEach(function (node) {
      maxRank = Math.max(maxRank, node.rank);
      if (!ranks.has(node.rank)) ranks.set(node.rank, []);
      ranks.get(node.rank).push(node);
    });
    var maxLane = 0;
    for (var rank = 0; rank <= maxRank; rank++) {
      var group = ranks.get(rank) || [];
      group.forEach(function (node, position) {
        var parents = incoming[node.id];
        node.desired = parents.length ? parents.reduce(function (sum, id) { return sum + nodes[id].lane; }, 0) / parents.length : position;
      });
      group.sort(function (a, b) { return a.desired - b.desired || a.id - b.id; });
      var previous = -1;
      group.forEach(function (node) {
        node.lane = Math.max(node.desired, previous + 1);
        previous = node.lane; maxLane = Math.max(maxLane, node.lane);
      });
    }
    var lr = opts.direction !== "td", spacing = Math.max(.5, Math.min(3, Number(opts.spacing) || 1));
    var depthStep = (lr ? 210 : 96) * spacing, laneStep = (lr ? 96 : 210) * spacing;
    nodes.forEach(function (node) {
      node.x = lr ? 110 + node.rank * depthStep : 110 + node.lane * laneStep;
      node.y = lr ? 80 + node.lane * laneStep : 70 + node.rank * depthStep;
    });
    var width = lr ? 220 + maxRank * depthStep : 220 + maxLane * laneStep;
    var height = lr ? 160 + maxLane * laneStep : 140 + maxRank * depthStep;
    return { nodes: nodes, edges: edges, width: width, height: height,
      nodeCount: nodes.length, edgeCount: edges.length, pathCount: map.pathCount };
  }
  function visible(map, view, cap) {
    var pins = cap && typeof cap === "object" ? new Set(cap.pins || []) : new Set();
    cap = typeof cap === "number" ? cap : cap && cap.limit || 250;
    var margin = 180, candidates = [], pinned = [], nodes = [], ids = new Set();
    for (var i = 0; i < map.nodes.length; i++) {
      var n = map.nodes[i];
      if (n.x >= view.x - margin && n.x <= view.x + view.width + margin &&
          n.y >= view.y - margin && n.y <= view.y + view.height + margin) {
        (pins.has(n.event && n.event.function) ? pinned : candidates).push(n);
      }
    }
    nodes = pinned.concat(candidates).slice(0, Math.floor(cap / 2));
    nodes.forEach(function (n) { ids.add(n.id); });
    var edges = [], visibleEdges = 0;
    for (var j = 0; j < map.edges.length; j++) {
      var e = map.edges[j];
      var a = map.nodes[e.from], b = map.nodes[e.to];
      var crosses = Math.max(a.x, b.x) >= view.x - margin && Math.min(a.x, b.x) <= view.x + view.width + margin &&
        Math.max(a.y, b.y) >= view.y - margin && Math.min(a.y, b.y) <= view.y + view.height + margin;
      if (ids.has(e.from) && ids.has(e.to) || crosses) {
        visibleEdges++;
        if (edges.length < cap - nodes.length) edges.push(e);
      }
    }
    return { nodes: nodes, edges: edges, nodeCount: map.nodes.length, edgeCount: map.edges.length,
      limited: pinned.length + candidates.length > nodes.length || visibleEdges > edges.length };
  }
  return { project: project, build: build, layout: layout, visible: visible };
});
