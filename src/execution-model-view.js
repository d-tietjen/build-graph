/* Deterministic geometry for the complete MIR execution statechart. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ExecutionModelView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function layout(model) {
    var procedures = model.procedures || [], nodes = model.nodes || [], edges = model.edges || [], calls = model.calls || [];
    edges.forEach(function (e) { delete e.loopBack; });
    var procById = new Map(procedures.map(function (p) { return [p.id, p]; }));
    var nodeById = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var outgoing = new Map(), callsByProcedure = new Map();
    edges.forEach(function (e) {
      var from = nodeById.get(e.from), to = nodeById.get(e.to);
      if (!from || !to || from.procedure !== to.procedure) return;
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from).push(e);
    });
    calls.forEach(function (c) {
      var source = nodeById.get(c.from);
      if (!source) return;
      if (!callsByProcedure.has(source.procedure)) callsByProcedure.set(source.procedure, []);
      callsByProcedure.get(source.procedure).push(c);
    });
    procedures.forEach(function (p) {
      var members = (p.nodeIds || []).map(function (id) { return nodeById.get(id); }).filter(Boolean);
      p.stateCount = members.length;
      p.transitionCount = 0; p.branchCount = 0; p.loopCount = 0;
      members.forEach(function (n) {
        var next = outgoing.get(n.id) || [];
        p.transitionCount += next.length;
        if (next.length > 1) p.branchCount++;
      });
      // Mark actual DFS backedges. A join into a shallow BFS rank is not a cycle.
      var visit = new Map();
      members.forEach(function (root) {
        if (visit.has(root.id)) return;
        visit.set(root.id, 1);
        var stack = [{ id: root.id, next: 0 }];
        while (stack.length) {
          var frame = stack[stack.length - 1], list = outgoing.get(frame.id) || [];
          if (frame.next >= list.length) { visit.set(frame.id, 2); stack.pop(); continue; }
          var edge = list[frame.next++], state = visit.get(edge.to) || 0;
          if (state === 1) { edge.loopBack = true; p.loopCount++; }
          else if (state === 0) { visit.set(edge.to, 1); stack.push({ id: edge.to, next: 0 }); }
        }
      });
      // Removing DFS backedges leaves a DAG. Longest-path ranks keep every
      // acyclic successor moving to the right, even after unequal branch joins.
      var indegree = new Map(), rank = new Map();
      members.forEach(function (n) { indegree.set(n.id, 0); rank.set(n.id, 0); });
      members.forEach(function (n) { (outgoing.get(n.id) || []).forEach(function (e) {
        if (!e.loopBack) indegree.set(e.to, indegree.get(e.to) + 1);
      }); });
      var queue = members.filter(function (n) { return indegree.get(n.id) === 0; }).map(function (n) { return n.id; });
      for (var q = 0; q < queue.length; q++) {
        var id = queue[q];
        (outgoing.get(id) || []).forEach(function (e) {
          if (e.loopBack) return;
          rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
          indegree.set(e.to, indegree.get(e.to) - 1);
          if (indegree.get(e.to) === 0) queue.push(e.to);
        });
      }
      var byRank = new Map(), maxRank = 0;
      members.forEach(function (n) {
        var r = rank.get(n.id); maxRank = Math.max(maxRank, r);
        if (!byRank.has(r)) byRank.set(r, []);
        byRank.get(r).push(n);
      });
      byRank.forEach(function (group) { group.sort(function (a, b) { return String(a.block).localeCompare(String(b.block)); }); });
      var maxLane = 1;
      byRank.forEach(function (group) { maxLane = Math.max(maxLane, group.length); });
      p.width = Math.max(350, 110 + (maxRank + 1) * 186);
      p.height = Math.max(176, 106 + maxLane * 72);
      p.callCount = (callsByProcedure.get(p.id) || []).length;
      p._ranks = byRank;
    });
    var application = model.roots && Array.isArray(model.roots.application) ? model.roots.application : [];
    var depth = new Map(), queue = [];
    application.forEach(function (id) {
      if (procById.has(id) && !depth.has(id)) { depth.set(id, 0); queue.push(id); }
    });
    for (var at = 0; at < queue.length; at++) {
      var source = queue[at];
      (callsByProcedure.get(source) || []).forEach(function (call) {
        (call.targets || []).forEach(function (target) {
          if (procById.has(target) && !depth.has(target)) { depth.set(target, depth.get(source) + 1); queue.push(target); }
        });
      });
    }
    var byDepth = new Map(), disconnected = [];
    procedures.forEach(function (p) {
      if (!depth.has(p.id)) { p.section = "disconnected or unknown entry"; disconnected.push(p); return; }
      p.section = "application entry flow";
      var d = depth.get(p.id);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(p);
    });
    var x = 28, applicationBottom = 28, worldRight = 28;
    Array.from(byDepth.keys()).sort(function (a, b) { return a - b; }).forEach(function (d) {
      var column = byDepth.get(d), y = 34, columnWidth = 0;
      column.sort(function (a, b) { return a.id.localeCompare(b.id); });
      column.forEach(function (p) {
        p.x = x; p.y = y; p.callDepth = d;
        y += p.height + 38; columnWidth = Math.max(columnWidth, p.width);
      });
      applicationBottom = Math.max(applicationBottom, y); worldRight = Math.max(worldRight, x + columnWidth);
      x += columnWidth + 96;
    });
    var disconnectedY = applicationBottom + 190, dx = 28, dy = disconnectedY, rowHeight = 0;
    var targetWidth = Math.max(2200, Math.min(9000, Math.sqrt(procedures.length) * 90));
    disconnected.sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (p) {
      if (dx > 28 && dx + p.width > targetWidth) { dx = 28; dy += rowHeight + 40; rowHeight = 0; }
      p.x = dx; p.y = dy; p.callDepth = null;
      dx += p.width + 40; rowHeight = Math.max(rowHeight, p.height);
      worldRight = Math.max(worldRight, dx);
    });
    procedures.forEach(function (p) {
      p._ranks.forEach(function (group, rank) {
        group.forEach(function (n, lane) {
          n.x = p.x + 58 + rank * 186;
          n.y = p.y + 76 + lane * 72;
          n.rank = rank; n.lane = lane;
        });
      });
      delete p._ranks;
    });
    model.layout = { width: Math.max(700, worldRight + 50),
      height: Math.max(500, dy + rowHeight + 70, applicationBottom + 70),
      applicationProcedures: depth.size, disconnectedProcedures: disconnected.length,
      disconnectedY: disconnectedY,
      branchStates: procedures.reduce(function (sum, p) { return sum + p.branchCount; }, 0),
      loopTransitions: procedures.reduce(function (sum, p) { return sum + p.loopCount; }, 0) };
    return model;
  }
  function selfLoopGeometry(n, z) {
    return { x1: n.x + 79 * z, y1: n.y - 10 * z, x2: n.x + 79 * z, y2: n.y + 10 * z,
      c1x: n.x + 150 * z, c1y: n.y - 55 * z, c2x: n.x + 150 * z, c2y: n.y + 55 * z };
  }
  function groupOverview(model) {
    var roots = new Set(model.roots && model.roots.application || []), byKey = new Map();
    (model.procedures || []).forEach(function (p) {
      var root = roots.has(p.id), crate = p.crate || '(unknown crate)';
      var key = root ? '0|' + p.id : (p.section === 'application entry flow' ? '1|' : '2|') + crate;
      if (!byKey.has(key)) byKey.set(key, { key: key,
        title: root ? p.id : (p.section === 'application entry flow' ? 'Application · ' : 'Other entries · ') + crate,
        section: p.section, crate: crate, count: 0, states: 0, transitions: 0,
        branches: 0, loops: 0, members: [], representative: p.id, score: -1 });
      var group = byKey.get(key), score = (p.branchCount || 0) + (p.loopCount || 0) * 3;
      group.count++; group.members.push(p.id);
      group.states += p.stateCount || 0; group.transitions += p.transitionCount || 0;
      group.branches += p.branchCount || 0; group.loops += p.loopCount || 0;
      if (!root && score > group.score) { group.representative = p.id; group.score = score; }
    });
    return Array.from(byKey.values()).sort(function (a, b) { return a.key.localeCompare(b.key); });
  }
  function minimapGeometry(procedures, width, height, padding) {
    if (!procedures.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    procedures.forEach(function (p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width); maxY = Math.max(maxY, p.y + p.height);
    });
    var scale = Math.min((width - 2 * padding) / Math.max(1, maxX - minX),
      (height - 2 * padding) / Math.max(1, maxY - minY));
    var left = (width - (maxX - minX) * scale) / 2;
    var top = (height - (maxY - minY) * scale) / 2;
    function project(x, y) { return { x: left + (x - minX) * scale, y: top + (y - minY) * scale }; }
    return {
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      project: project,
      invert: function (x, y) { return { x: minX + (x - left) / scale, y: minY + (y - top) / scale }; },
      viewport: function (camera, screenWidth, screenHeight) {
        var a = project(-camera.x / camera.z, -camera.y / camera.z);
        var b = project((screenWidth - camera.x) / camera.z, (screenHeight - camera.y) / camera.z);
        return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
      }
    };
  }
  function callEdgeActive(callId, target, activeCalls, activeTargets) {
    return (!activeCalls || activeCalls.has(callId)) && (!activeTargets || activeTargets.has(callId + '->' + target));
  }
  function mount(doc, onPins, onTrace) {
    var canvas = doc.getElementById('state-canvas'), ctx = canvas.getContext('2d');
    var side = doc.getElementById('state-side'), counts = doc.getElementById('state-counts');
    var status = doc.getElementById('state-status'), renderCounts = doc.getElementById('state-render-counts');
    var pinsBox = doc.getElementById('state-pins'), search = doc.getElementById('state-search');
    var results = doc.getElementById('state-search-results'), detail = doc.getElementById('state-detail');
    var model = null, procedures = [], procedureById = new Map(), nodes = new Map(), edges = new Map(), calls = new Map();
    var edgesByProc = new Map(), callsByProc = new Map(), pins = [], analysis = null;
    var activeNodes = null, activeEdges = null, activeCalls = null, activeTargets = null;
    var camera = { x: 24, y: 24, z: 1 }, drawn = { procedures: 0, states: 0, transitions: 0, calls: 0 };
    var width = 1, height = 1, drag = null, changed = false, hover = null, visible = false, focusedProcedure = null, dataGeneration = 0;
    var overviewMode = false, overviewGroups = [], overviewTiles = [], overviewGroup = null, overviewPage = 0;
    var activeProcedureIds = null;
    var procedureFilter = null, visibleProcedures = [], boundaryCounts = { outsideTargets: 0, unknownCallsites: 0 };
    var colors = { normal: '#5db8d4', start: '#64d2a2', return: '#64d2a2', unwind: '#f2a45d',
      terminate: '#ef6b6b', unreachable: '#8993a2', continuation: '#a38ad6' };
    var minimap = doc.createElement('div'); minimap.className = 'execution-minimap';
    minimap.setAttribute('role', 'group'); minimap.setAttribute('aria-label', 'Execution flow overview and navigation');
    minimap.style.cssText = 'position:absolute;right:12px;bottom:12px;width:220px;height:154px;' +
      'background:rgba(13,17,23,.94);border:1px solid #30363d;border-radius:8px;z-index:8;' +
      'box-shadow:0 5px 20px #0008;overflow:hidden;'; minimap.hidden = true;
    var minimapHead = doc.createElement('div'); minimapHead.style.cssText =
      'height:24px;padding:5px 8px 0;box-sizing:border-box;color:#c9d1d9;font-size:11px;';
    minimap.appendChild(minimapHead);
    var miniBase = doc.createElement('canvas'), miniOverlay = doc.createElement('canvas');
    miniBase.width = miniOverlay.width = 220; miniBase.height = miniOverlay.height = 130;
    miniBase.style.cssText = miniOverlay.style.cssText = 'position:absolute;left:0;top:24px;width:220px;height:130px;';
    miniOverlay.style.cursor = 'crosshair'; miniOverlay.style.touchAction = 'none';
    miniOverlay.setAttribute('aria-label', 'Move the execution camera without changing zoom');
    minimap.appendChild(miniBase); minimap.appendChild(miniOverlay);
    canvas.parentNode.appendChild(minimap);
    var miniBaseCtx = miniBase.getContext('2d'), miniOverlayCtx = miniOverlay.getContext('2d');
    var miniGeometry = null, miniDragging = false;
    function drawMinimapBase() {
      miniGeometry = minimapGeometry(procedures, miniBase.width, miniBase.height, 8);
      miniBaseCtx.fillStyle = '#0e1116'; miniBaseCtx.fillRect(0, 0, miniBase.width, miniBase.height);
      if (!miniGeometry) return;
      procedures.forEach(function (p) {
        var at = miniGeometry.project(p.x, p.y), size = miniGeometry.project(p.x + p.width, p.y + p.height);
        miniBaseCtx.fillStyle = procedureFilter && !procedureFilter.has(p.id) ? '#26313c' :
          p.section === 'application entry flow' ? '#5189b9' : '#526477';
        miniBaseCtx.fillRect(at.x, at.y, Math.max(1, size.x - at.x), Math.max(1, size.y - at.y));
      });
    }
    function drawMinimapViewport() {
      miniOverlayCtx.clearRect(0, 0, miniOverlay.width, miniOverlay.height);
      if (!visible || !model || !miniGeometry) return;
      minimapHead.textContent = overviewMode ? 'World map · select to inspect' : 'Overview · click or drag to move';
      if (overviewMode) return;
      var view = miniGeometry.viewport(camera, width, height);
      var left = Math.max(0, Math.min(miniOverlay.width, view.x));
      var top = Math.max(0, Math.min(miniOverlay.height, view.y));
      var right = Math.max(0, Math.min(miniOverlay.width, view.x + view.width));
      var bottom = Math.max(0, Math.min(miniOverlay.height, view.y + view.height));
      if (right <= left || bottom <= top) return;
      miniOverlayCtx.fillStyle = 'rgba(88,166,255,.14)';
      miniOverlayCtx.fillRect(left, top, right - left, bottom - top);
      miniOverlayCtx.strokeStyle = '#c9d1d9'; miniOverlayCtx.lineWidth = 1.5;
      miniOverlayCtx.strokeRect(left + .75, top + .75, Math.max(0, right - left - 1.5),
        Math.max(0, bottom - top - 1.5));
    }
    function navigateMinimap(e) {
      if (!visible || !miniGeometry) return;
      var rect = miniOverlay.getBoundingClientRect();
      var x = Math.max(0, Math.min(miniOverlay.width, (e.clientX - rect.left) * miniOverlay.width / rect.width));
      var y = Math.max(0, Math.min(miniOverlay.height, (e.clientY - rect.top) * miniOverlay.height / rect.height));
      var point = miniGeometry.invert(x, y);
      if (overviewMode) { overviewMode = false; overviewGroup = null; overviewPage = 0; detail.style.display = 'none'; }
      camera.x = width / 2 - point.x * camera.z;
      camera.y = height / 2 - point.y * camera.z;
      draw();
    }
    miniOverlay.addEventListener('pointerdown', function (e) {
      e.stopPropagation(); miniDragging = true; miniOverlay.setPointerCapture(e.pointerId); navigateMinimap(e);
    });
    miniOverlay.addEventListener('pointermove', function (e) {
      if (miniDragging) { e.stopPropagation(); navigateMinimap(e); }
    });
    miniOverlay.addEventListener('pointerup', function (e) {
      if (!miniDragging) return;
      e.stopPropagation(); navigateMinimap(e); miniDragging = false; miniOverlay.releasePointerCapture(e.pointerId);
    });
    miniOverlay.addEventListener('pointercancel', function () { miniDragging = false; });
    function callTargets(c) {
      return Array.from(new Set((c.possibleTargets || []).concat(c.targets || [], c.dispatchTargets || [])));
    }
    function rebuildScope() {
      visibleProcedures = procedureFilter ? procedures.filter(function (p) { return procedureFilter.has(p.id); }) : procedures;
      overviewGroups = model ? groupOverview({ roots: model.roots, procedures: visibleProcedures }) : [];
      overviewTiles = []; overviewGroup = null; overviewPage = 0;
      boundaryCounts = { outsideTargets: 0, unknownCallsites: 0 };
      if (!model || !procedureFilter) return;
      visibleProcedures.forEach(function (p) {
        (callsByProc.get(p.id) || []).forEach(function (c) {
          var targets = callTargets(c);
          boundaryCounts.outsideTargets += targets.filter(function (id) {
            return procedureById.has(id) && !procedureFilter.has(id);
          }).length;
          if (c.unknown || c.possibleUnknown || (c.unavailableTargets || []).length ||
              targets.some(function (id) { return !procedureById.has(id); })) boundaryCounts.unknownCallsites++;
        });
      });
    }
    function scopeSummary() {
      if (!procedureFilter || !model) return '';
      var outsidePins = pins.filter(function (id) { return !procedureFilter.has(id); }).length;
      return ' · Scope: ' + visibleProcedures.length.toLocaleString() + ' of ' + procedures.length.toLocaleString() +
        ' procedures · ' + boundaryCounts.outsideTargets.toLocaleString() + ' targets outside scope · ' +
        boundaryCounts.unknownCallsites.toLocaleString() + ' MIR-unavailable/unknown callsites' +
        (outsidePins ? ' · ' + outsidePins + ' AND pins outside scope (analysis covers full model)' : '');
    }
    function isActive(id, set) { return !set || set.has(id); }
    function xy(n) { return { x: camera.x + n.x * camera.z, y: camera.y + n.y * camera.z }; }
    function inView(p) { return camera.x + (p.x + p.width) * camera.z >= 0 && camera.x + p.x * camera.z <= width &&
      camera.y + (p.y + p.height) * camera.z >= 0 && camera.y + p.y * camera.z <= height; }
    function radiusBox(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
    function resetCanvas() {
      if (!visible) return;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, canvas.clientWidth); height = Math.max(1, canvas.clientHeight);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0c1420'; ctx.fillRect(0, 0, width, height);
      drawn = { procedures: 0, states: 0, transitions: 0, calls: 0 };
    }
    function line(a, b, color, faded, dashed, bent, label, arrow) {
      var p = xy(a), q = xy(b), x1 = p.x, y1 = p.y, x2 = q.x, y2 = q.y;
      if (x1 < -500 && x2 < -500 || x1 > width + 500 && x2 > width + 500 ||
          y1 < -500 && y2 < -500 || y1 > height + 500 && y2 > height + 500) return false;
      function inset(node, vx, vy) {
        if (!node.id) return 0;
        var hw = node.block == null ? 7 : 72, hh = node.block == null ? 7 : 22;
        var ratio = Math.max(Math.abs(vx) / hw, Math.abs(vy) / hh);
        return ratio ? Math.min(.48, 1 / ratio) : 0;
      }
      var selfLoop = a.id && a.id === b.id, loop = null;
      if (selfLoop) {
        loop = selfLoopGeometry(p, camera.z);
        x1 = loop.x1; y1 = loop.y1; x2 = loop.x2; y2 = loop.y2;
      } else {
        var vx = x2 - x1, vy = y2 - y1;
        var start = inset(a, vx / camera.z, vy / camera.z), end = inset(b, vx / camera.z, vy / camera.z);
        x1 += vx * start; y1 += vy * start; x2 -= vx * end; y2 -= vy * end;
      }
      ctx.save(); ctx.globalAlpha = faded ? .13 : .72; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, camera.z * 1.4);
      if (dashed) ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(x1, y1);
      if (selfLoop) ctx.bezierCurveTo(loop.c1x, loop.c1y, loop.c2x, loop.c2y, x2, y2);
      else if (bent) ctx.bezierCurveTo(x1 + 42 * camera.z, y1 + 58 * camera.z,
        x2 - 42 * camera.z, y2 + 58 * camera.z, x2, y2);
      else ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
      ctx.stroke();
      if (arrow && camera.z >= .4) {
        var angle = selfLoop ? Math.atan2(y2 - loop.c2y, x2 - loop.c2x) : Math.atan2(y2 - y1, x2 - x1);
        var size = Math.max(4, 7 * camera.z);
        ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - size * Math.cos(angle - .5), y2 - size * Math.sin(angle - .5));
        ctx.lineTo(x2 - size * Math.cos(angle + .5), y2 - size * Math.sin(angle + .5)); ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
      }
      if (label && camera.z >= .85 && Math.abs(x2 - x1) + Math.abs(y2 - y1) > 65) {
        ctx.fillStyle = color; ctx.font = '10px ui-sans-serif, system-ui';
        ctx.fillText(String(label).slice(0, 48), (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 5);
      }
      ctx.restore();
      return true;
    }
    function drawState(n, faded) {
      var p = xy(n), x = p.x - 72 * camera.z, y = p.y - 22 * camera.z;
      if (p.x < -100 || p.x > width + 100 || p.y < -60 || p.y > height + 60) return;
      var port = n.block == null;
      ctx.save(); ctx.globalAlpha = faded ? .2 : 1;
      if (port) {
        var r = Math.max(3, 7 * camera.z); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.kind === 'start' ? '#64d2a2' : n.kind === 'return' ? '#0c1420' :
          n.kind === 'unwind' ? '#f2a45d' : '#ef6b6b'; ctx.fill();
        ctx.strokeStyle = colors[n.kind] || '#aab8c9'; ctx.lineWidth = 2; ctx.stroke();
        if (camera.z >= .7) { ctx.fillStyle = '#b9c9db'; ctx.font = '10px ui-sans-serif, system-ui'; ctx.fillText(n.label, p.x + 11, p.y + 3); }
      } else {
        radiusBox(x, y, 144 * camera.z, 44 * camera.z, 8 * camera.z);
        ctx.fillStyle = n.kind === 'branch' || n.kind === 'assert' ? '#263340' : '#1a2a3a'; ctx.fill();
        ctx.strokeStyle = n.kind === 'unwind' ? '#f2a45d' : n.kind === 'branch' || n.kind === 'assert' ? '#d5ad62' : '#6a91aa';
        ctx.lineWidth = Math.max(1, camera.z); ctx.stroke();
        if (camera.z >= .58) {
          ctx.save(); ctx.beginPath(); ctx.rect(x + 6, y + 2, 132 * camera.z, 42 * camera.z); ctx.clip();
          ctx.fillStyle = '#e4edf6'; ctx.font = Math.max(9, 11 * camera.z) + 'px ui-sans-serif, system-ui';
          ctx.fillText(String(n.block || '') + ' · ' + String(n.kind || ''), x + 8, y + 15 * camera.z);
          ctx.fillStyle = '#9ab0c2'; ctx.font = Math.max(8, 9 * camera.z) + 'px ui-sans-serif, system-ui';
          ctx.fillText(String(n.label || '').slice(0, 72), x + 8, y + 31 * camera.z); ctx.restore();
        }
      }
      ctx.restore(); drawn.states++;
    }
    function drawProcedure(p, detailLevel) {
      var a = xy(p), w = p.width * camera.z, h = p.height * camera.z;
      var focused = pins.indexOf(p.id) >= 0, faded = activeProcedureIds && !activeProcedureIds.has(p.id);
      ctx.save(); ctx.globalAlpha = faded ? .25 : 1;
      radiusBox(a.x, a.y, w, h, Math.max(5, 13 * camera.z));
      ctx.fillStyle = p.section === 'application entry flow' ? '#132438' : '#19202b'; ctx.fill();
      ctx.strokeStyle = focused ? '#89bbff' : p.section === 'application entry flow' ? '#5189b9' : '#526477';
      ctx.lineWidth = focused ? 2.5 : 1.2; ctx.stroke();
      if (camera.z >= .16) {
        ctx.save(); ctx.beginPath(); ctx.rect(a.x + 10, a.y + 3, w - 18, Math.max(16, 45 * camera.z)); ctx.clip();
        ctx.font = Math.max(10, 12 * camera.z) + 'px ui-sans-serif, system-ui'; ctx.fillStyle = '#e3edf7';
        ctx.fillText(p.id, a.x + 13, a.y + Math.max(14, 21 * camera.z));
        ctx.fillStyle = '#9fb2c4'; ctx.font = Math.max(9, 10 * camera.z) + 'px ui-sans-serif, system-ui';
        ctx.fillText(p.stateCount + ' states · ' + p.transitionCount + ' transitions · ' + p.branchCount +
          ' branches · ' + p.loopCount + ' cycles', a.x + 13, a.y + Math.max(28, 38 * camera.z)); ctx.restore();
      }
      ctx.restore(); drawn.procedures++;
      if (!detailLevel) {
        if (w > 95 && h > 60) {
          ctx.save(); ctx.globalAlpha = faded ? .13 : .65; ctx.strokeStyle = '#6bb7d5'; ctx.lineWidth = 2;
          var cy = a.y + h * .72, left = a.x + Math.min(26, w * .12), right = a.x + w - Math.min(26, w * .12);
          ctx.beginPath(); ctx.moveTo(left, cy); ctx.lineTo(right, cy); ctx.stroke();
          if (p.branchCount) { ctx.strokeStyle = '#d5ad62'; ctx.beginPath(); ctx.moveTo(left + (right-left)*.35, cy);
            ctx.lineTo(left + (right-left)*.54, cy - Math.min(18, h*.2)); ctx.lineTo(right, cy); ctx.stroke(); }
          if (p.loopCount) { ctx.strokeStyle = '#e3b341'; ctx.beginPath(); ctx.arc(left + (right-left)*.7, cy, Math.min(12,h*.14), .2, 5.7); ctx.stroke(); }
          ctx.restore();
        }
        return;
      }
      (edgesByProc.get(p.id) || []).forEach(function (e) {
        var from = nodes.get(e.from), to = nodes.get(e.to); if (!from || !to) return;
        var cycle = !!e.loopBack;
        var ffi = e.callsite && calls.get(e.callsite) && calls.get(e.callsite).nativeCall;
        if (line(from, to, e.action === 'unwind' || e.kind === 'unwind' ? colors.unwind :
          e.kind === 'continuation' ? colors.continuation :
          cycle ? '#e3b341' : colors.normal, !isActive(e.id, activeEdges),
          e.kind === 'continuation' || e.kind === 'unwind' || e.action === 'unwind', cycle,
          e.kind === 'continuation' ? (e.action === 'unwind' ? 'unwind' : 'normal') +
            (ffi ? ' continuation after FFI call' : ' continuation at this callsite') : e.label, true)) drawn.transitions++;
      });
      (p.nodeIds || []).forEach(function (id) { var n = nodes.get(id); if (n) drawState(n, !isActive(id, activeNodes)); });
      (callsByProc.get(p.id) || []).forEach(function (c) {
        var from = nodes.get(c.from); if (!from) return;
        var direct = new Set(c.targets || []), dispatchTargets = new Set(c.dispatchTargets || []);
        var targets = callTargets(c), outside = [], missing = [];
        targets.forEach(function (target) {
          var to = procedureById.get(target);
          if (!to) { missing.push(target); return; }
          if (procedureFilter && !procedureFilter.has(target)) { outside.push(target); return; }
          var dispatch = dispatchTargets.has(target), callback = !direct.has(target) && !dispatch;
          if (line(from, { x: to.x + 16, y: to.y + 22 }, dispatch ? '#d5ad62' : callback ? '#c49dff' : '#77d5b3',
            !callEdgeActive(c.id, target, activeCalls, activeTargets),
            dispatch || callback, false, (dispatch ? 'possible dispatch ' : callback ? 'callback ' : 'call ') +
              target.split('::').pop(), true)) drawn.calls++;
        });
        if (outside.length) {
          var point = xy(from); ctx.save(); ctx.fillStyle = '#d5ad62'; ctx.font = '10px ui-sans-serif, system-ui';
          ctx.fillText('◇ outside scope: ' + outside[0].split('::').pop() +
            (outside.length > 1 ? ' (+' + (outside.length - 1) + ')' : ''), point.x + 14, point.y + 29);
          ctx.restore();
        }
        if (c.nativeCall) {
          var nativePoint = xy(from), native = c.nativeCall;
          ctx.save(); ctx.fillStyle = '#f0883e'; ctx.font = '10px ui-sans-serif, system-ui';
          ctx.fillText('◇ FFI ' + (native.symbol || 'symbol unknown') +
            (native.abi ? ' · ABI ' + native.abi : '') + ' · native MIR unavailable',
            nativePoint.x + 14, nativePoint.y + (outside.length ? 42 : 29)); ctx.restore();
        } else if (c.unknown || c.possibleUnknown || (c.unavailableTargets || []).length || missing.length) {
          var point = xy(from); ctx.save(); ctx.fillStyle = '#e3b341'; ctx.font = '10px ui-sans-serif, system-ui';
          ctx.fillText('◇ body/target unknown', point.x + 14, point.y + (outside.length ? 42 : 29)); ctx.restore();
        }
      });
    }
    function drawOverview() {
      var margin = 16, memberPage = !!overviewGroup, pageSize = 30;
      var top = memberPage ? 70 : 42;
      var groups = memberPage ? overviewGroup.members.slice(overviewPage * pageSize, (overviewPage + 1) * pageSize).map(function (id) {
        var p = procedureById.get(id);
        return { key: 'member|' + id, title: id, section: p.section, count: 1, members: [id],
          states: p.stateCount, transitions: p.transitionCount, branches: p.branchCount,
          loops: p.loopCount, representative: id };
      }) : overviewGroups;
      if (!groups.length) {
        overviewTiles = [];
        ctx.fillStyle = '#b9cadb'; ctx.font = '12px ui-sans-serif, system-ui';
        ctx.fillText(procedureFilter ? 'No procedures in current scope' : 'No procedures in model', 16, 23);
        renderCounts.textContent = '0 procedure regions on screen' + scopeSummary();
        return;
      }
      var cols = Math.max(1, Math.ceil(Math.sqrt(groups.length * width / Math.max(1, height - top))));
      var rows = Math.ceil(groups.length / cols);
      var cardW = (width - margin * (cols + 1)) / cols;
      var cardH = (height - top - margin * (rows + 1)) / rows;
      overviewTiles = [];
      ctx.fillStyle = '#b9cadb'; ctx.font = '12px ui-sans-serif, system-ui';
      ctx.fillText(memberPage ? overviewGroup.title + ' · procedure page ' + (overviewPage + 1) +
        ' of ' + Math.ceil(overviewGroup.count / pageSize) :
        (procedureFilter ? 'Scoped MIR model' : 'Complete MIR model') +
        ' · grouped statechart tiles · click a group, then any procedure', 16, 23);
      if (memberPage) {
        function nav(label, x, action) {
          var y = 32, w = 112, h = 26;
          overviewTiles.push({ kind: 'nav', action: action, title: label, x: x, y: y, width: w, height: h });
          ctx.fillStyle = '#18334b'; radiusBox(x, y, w, h, 5); ctx.fill();
          ctx.strokeStyle = '#6391b7'; ctx.stroke(); ctx.fillStyle = '#e0ebf5';
          ctx.font = '11px ui-sans-serif, system-ui'; ctx.fillText(label, x + 8, y + 17);
        }
        nav('← All groups', 16, 'back');
        if (overviewPage) nav('← Previous', 136, 'previous');
        if ((overviewPage + 1) * pageSize < overviewGroup.count) nav('Next →', 256, 'next');
      }
      groups.forEach(function (g, i) {
        var x = margin + (i % cols) * (cardW + margin), y = top + margin + Math.floor(i / cols) * (cardH + margin);
        overviewTiles.push({ kind: memberPage ? 'member' : 'group', group: g, id: memberPage ? g.representative : null,
          x: x, y: y, width: cardW, height: cardH });
        var participating = activeProcedureIds ? g.members.filter(function (id) { return activeProcedureIds.has(id); }).length : g.count;
        ctx.save(); ctx.globalAlpha = participating ? 1 : .27;
        radiusBox(x, y, cardW, cardH, 9);
        ctx.fillStyle = g.section === 'application entry flow' ? '#16283c' : '#1b2531'; ctx.fill();
        ctx.strokeStyle = g.key.startsWith('0|') ? '#79cbb4' : '#567b9d'; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath(); ctx.rect(x + 9, y + 6, cardW - 18, cardH - 12); ctx.clip();
        ctx.fillStyle = '#e0ebf5'; ctx.font = 'bold 12px ui-sans-serif, system-ui';
        ctx.fillText(g.title, x + 11, y + 20);
        ctx.fillStyle = '#9fb7ca'; ctx.font = '11px ui-sans-serif, system-ui';
        ctx.fillText(g.count.toLocaleString() + ' procedures · ' + g.states.toLocaleString() + ' states', x + 11, y + 38);
        ctx.fillText(g.branches.toLocaleString() + ' branches · ' + g.loops.toLocaleString() + ' cycles', x + 11, y + 54);
        if (activeProcedureIds) { ctx.fillStyle = '#b7d1e6';
          ctx.fillText(participating.toLocaleString() + ' of ' + g.count.toLocaleString() + ' on pinned routes', x + 11, y + 69); }
        var cy = y + Math.max(69, cardH - 26), left = x + 20, right = x + cardW - 20;
        ctx.strokeStyle = '#6fb6d3'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(left, cy); ctx.lineTo(right, cy); ctx.stroke();
        ctx.fillStyle = '#69d6aa'; ctx.beginPath(); ctx.arc(left, cy, 4, 0, Math.PI * 2); ctx.fill();
        radiusBox(left + 16, cy - 8, Math.max(22, cardW * .27), 16, 5); ctx.fillStyle = '#284258'; ctx.fill();
        ctx.strokeStyle = '#7badc9'; ctx.stroke();
        if (g.branches) { ctx.strokeStyle = '#d5ad62'; ctx.beginPath(); ctx.moveTo(left + cardW * .4, cy);
          ctx.lineTo(left + cardW * .55, cy - 12); ctx.lineTo(right, cy); ctx.stroke(); }
        if (g.loops) { ctx.strokeStyle = '#e3b341'; ctx.beginPath();
          ctx.arc(left + cardW * .73, cy, 10, .25, 5.8); ctx.stroke(); }
        ctx.fillStyle = '#64d2a2'; ctx.beginPath(); ctx.arc(right, cy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); drawn.procedures += g.count;
      });
      renderCounts.textContent = drawn.procedures.toLocaleString() + ' of ' + model.counts.procedures.toLocaleString() +
        (memberPage ? ' procedure regions on this page of ' + overviewGroup.count.toLocaleString() +
          ' in ' + overviewGroup.title : ' procedure regions represented in ' + groups.length + ' composite tiles') + ' · ' +
        model.counts.mirBlocks.toLocaleString() + ' MIR blocks / ' +
        model.counts.mirSuccessors.toLocaleString() + ' successors in complete model' + scopeSummary();
    }
    function draw() {
      resetCanvas(); if (!model || !visible) return;
      if (overviewMode) { drawOverview(); drawMinimapViewport(); return; }
      var detailLevel = camera.z >= .42;
      visibleProcedures.forEach(function (p) { if (inView(p)) drawProcedure(p, detailLevel); });
      if (overviewGroup) {
        ctx.save(); radiusBox(12, 12, 142, 27, 5); ctx.fillStyle = '#18334b'; ctx.fill();
        ctx.strokeStyle = '#6391b7'; ctx.stroke(); ctx.fillStyle = '#e0ebf5';
        ctx.font = '11px ui-sans-serif, system-ui'; ctx.fillText('← Procedure group', 20, 30); ctx.restore();
      }
      if (camera.z < .42) {
        ctx.save(); ctx.fillStyle = '#9fb2c4'; ctx.font = '12px ui-sans-serif, system-ui';
        ctx.fillText('Composite procedures · zoom to inspect recorded states and guarded transitions', 14, 22); ctx.restore();
      }
      renderCounts.textContent = drawn.procedures.toLocaleString() + ' of ' + model.counts.procedures.toLocaleString() +
        ' procedure regions on screen · ' + drawn.states.toLocaleString() + ' states · ' +
        drawn.transitions.toLocaleString() + ' transitions drawn · ' + model.counts.mirBlocks.toLocaleString() +
        ' MIR blocks / ' + model.counts.mirSuccessors.toLocaleString() + ' successors in complete model' + scopeSummary();
      drawMinimapViewport();
    }
    function fitEntries() {
      if (!model) return;
      overviewMode = false;
      overviewGroup = null; overviewPage = 0;
      detail.style.display = 'none';
      if (!visibleProcedures.length) { overviewMode = true; focusedProcedure = null; draw(); return; }
      var roots = model.roots && model.roots.application || [];
      var first = visibleProcedures.find(function (p) { return roots.indexOf(p.id) >= 0; }) || visibleProcedures[0];
      focusedProcedure = first.id;
      camera.z = Math.min(1, Math.max(.65, (height - 50) / Math.min(first.height, 650)));
      camera.x = 38 - first.x * camera.z; camera.y = 38 - first.y * camera.z; draw();
    }
    function fitAll() {
      if (!model) return;
      overviewMode = true;
      overviewGroup = null; overviewPage = 0;
      detail.style.display = 'none';
      focusedProcedure = null;
      draw();
    }
    function focus(id, retainGroup) {
      var p = visibleProcedures.find(function (entry) { return entry.id === id; }); if (!p) return;
      overviewMode = false;
      if (!retainGroup) { overviewGroup = null; overviewPage = 0; }
      focusedProcedure = p.id;
      camera.z = Math.max(.65, Math.min(1, (height - 40) / Math.min(p.height, 850)));
      camera.x = 35 - p.x * camera.z; camera.y = 35 - p.y * camera.z; draw();
    }
    function renderPins() {
      pinsBox.replaceChildren(); if (!pins.length) pinsBox.textContent = 'No pins · showing every recorded branch.';
      pins.forEach(function (id) { var b = doc.createElement('button'); b.textContent = id + ' ×' +
        (procedureFilter && !procedureFilter.has(id) ? ' · outside scope' : '');
        b.onclick = function () { togglePin(id); }; pinsBox.appendChild(b); });
    }
    function baseStatus() {
      return model ? 'All recorded normal, branch, loop, and unwind transitions. ' +
        model.coverage.unavailableCallees + ' unavailable callees · ' + model.coverage.unresolvedCalls +
        ' unresolved calls · ' + model.coverage.opaqueBlocks + ' opaque blocks · ' +
        model.coverage.missingMirStubs + ' missing MIR stubs · ' +
        (model.roots.disconnected || []).length + ' disconnected or unknown entry roots.' :
        'Indexing compiler MIR states…';
    }
    function statusText() {
      var text = baseStatus();
      if (pins.length && !analysis) text = 'Analyzing all recorded routes for ' + pins.length + ' AND pins…';
      if (pins.length && analysis) text = (analysis.status === 'exact' ? 'Exact captured-CFG fixed point' :
        analysis.status === 'impossible' ? 'No captured route contains all pins' :
        'Indeterminate: captured routes cannot resolve all pins') + ' · ' + pins.length + ' AND pins' +
        (analysis.partialCoverage ? ' · partial body coverage' : '') +
        ((analysis.diagnostics || []).length ? ' · ' + analysis.diagnostics.join('; ') : '');
      return text + scopeSummary();
    }
    function togglePin(id) {
      if (!model || !procedures.some(function (p) { return p.id === id; })) return;
      var at = pins.indexOf(id); if (at < 0) pins.push(id); else pins.splice(at, 1);
      analysis = null; activeNodes = activeEdges = activeCalls = activeTargets = activeProcedureIds = null;
      renderPins(); status.textContent = statusText(); draw(); onPins(pins.slice());
    }
    function renderSearch() {
      results.replaceChildren(); if (!model) { results.textContent = 'Indexing compiler MIR…'; return; }
      if (!visibleProcedures.length) { results.textContent = 'No procedures in current scope.'; return; }
      var q = search.value.trim().toLowerCase(); if (!q) { results.textContent = 'Search is optional. Click a region or state to pin it.'; return; }
      var total = 0;
      visibleProcedures.forEach(function (p) {
        if ((p.id + ' ' + (p.source_file || '')).toLowerCase().indexOf(q) < 0) return;
        total++; if (total > 30) return;
        var row = doc.createElement('div'); row.className = 'result';
        var name = doc.createElement('div'); name.textContent = p.id; row.appendChild(name);
        var meta = doc.createElement('div'); meta.textContent = (p.source_file || 'Source unknown') +
          ' · ' + p.branchCount + ' branches · ' + p.loopCount + ' cycles'; row.appendChild(meta);
        var jump = doc.createElement('button'); jump.textContent = 'Focus'; jump.onclick = function () { focus(p.id); showDetail(p); };
        var pin = doc.createElement('button'); pin.textContent = pins.indexOf(p.id) < 0 ? 'AND pin' : 'Unpin';
        pin.onclick = function () { togglePin(p.id); renderSearch(); }; row.appendChild(jump); row.appendChild(pin); results.appendChild(row);
      });
      if (!total) results.textContent = 'No matching procedure.';
      else if (total > 30) { var more = doc.createElement('div'); more.textContent = 'Showing 30 of ' + total + '; refine search.'; results.appendChild(more); }
    }
    function showDetail(item) {
      if (!item) { detail.style.display = 'none'; return; }
      var p = item.nodeIds ? item : procedures.find(function (entry) { return entry.id === item.procedure; });
      if (!p || procedureFilter && !procedureFilter.has(p.id)) return;
      detail.replaceChildren(); detail.style.display = 'block';
      var title = doc.createElement('h3'); title.textContent = item.nodeIds ? 'Procedure region' : item.block == null ? 'Execution port' : 'MIR operation state'; detail.appendChild(title);
      function lineText(value) { var el = doc.createElement('div'); el.textContent = value; detail.appendChild(el); }
      lineText(p.id); if (item.block != null) lineText(item.block + ' · ' + item.kind + ' · ' + item.label);
      lineText('Source: ' + (item.source_file || p.source_file || 'unknown') +
        (item.source_location || p.source_location ? ':' + (item.source_location || p.source_location) : ''));
      if (item.source_snippet) lineText(item.source_snippet);
      lineText(p.stateCount + ' states, ' + p.transitionCount + ' recorded transitions, ' + p.loopCount + ' cycles');
      if (item.block != null) {
        var call = (callsByProc.get(p.id) || []).find(function (c) { return c.from === item.id; });
        if (call && call.nativeCall) {
          var native = call.nativeCall;
          lineText('FFI callsite · symbol ' + (native.symbol || 'unknown') +
            (native.abi ? ' · ABI ' + native.abi : '') +
            (native.libraries && native.libraries.length ? ' · linked libraries ' + native.libraries.join(', ') : '') +
            (call.calleeArtifact ? ' · artifact ' + call.calleeArtifact : '') +
            (call.calleeCrate ? ' · crate ' + call.calleeCrate : '') +
            (call.nativeTargetIds && call.nativeTargetIds.length ? ' · proven native target in artifact' :
              ' · native target unresolved') +
            '. Native MIR unavailable; ' + (call.normal || []).length + ' normal and ' +
            (call.unwind || []).length + ' unwind continuations remain at this Rust callsite.');
        }
        if (call && !call.nativeCall) lineText('Callsite ' + call.id + ' → ' + (call.targets || []).join(', ') +
          ((call.possibleTargets || []).length ? ' · possible bound callback targets: ' + call.possibleTargets.join(', ') : '') +
          ((call.dispatchTargets || []).length ? ' · possible trait implementations: ' + call.dispatchTargets.join(', ') : '') +
          ((call.unavailableTargets || []).length ? ' · body unavailable: ' + call.unavailableTargets.join(', ') : '') +
          (call.possibleDispatch ? ' · possible trait dispatch, concrete runtime choice unknown' : '') +
          (call.unknown || call.possibleUnknown ? ' · target uncertain' : '') +
          '. Continuations return to this callsite only.');
        if (call && procedureFilter) {
          var outside = callTargets(call).filter(function (id) { return procedureById.has(id) && !procedureFilter.has(id); });
          if (outside.length) lineText('Targets outside current scope: ' + outside.join(', '));
        }
      }
      var pin = doc.createElement('button'); pin.textContent = pins.indexOf(p.id) >= 0 ? 'Remove AND pin' : 'AND pin this procedure';
      pin.onclick = function () { togglePin(p.id); showDetail(item); }; detail.appendChild(pin);
      if (onTrace) { var trace = doc.createElement('button'); trace.textContent = 'View bounded trace waterfall';
        trace.onclick = function () { onTrace(p.id); }; detail.appendChild(trace); }
      var close = doc.createElement('button'); close.textContent = 'Close'; close.onclick = function () { detail.style.display = 'none'; }; detail.appendChild(close);
    }
    function hit(screenX, screenY) {
      if (overviewMode) return overviewTiles.find(function (tile) {
        return screenX >= tile.x && screenX <= tile.x + tile.width &&
          screenY >= tile.y && screenY <= tile.y + tile.height;
      }) || null;
      if (overviewGroup && screenX >= 12 && screenX <= 154 && screenY >= 12 && screenY <= 39)
        return { kind: 'backMembers' };
      var x = (screenX - camera.x) / camera.z, y = (screenY - camera.y) / camera.z;
      for (var i = visibleProcedures.length - 1; i >= 0; i--) {
        var p = visibleProcedures[i]; if (x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) continue;
        if (camera.z >= .42) for (var j = 0; j < p.nodeIds.length; j++) {
          var n = nodes.get(p.nodeIds[j]); if (n && Math.abs(x - n.x) <= 72 && Math.abs(y - n.y) <= 22) return n;
        }
        return p;
      }
      return null;
    }
    canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY }; changed = false; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); });
    canvas.addEventListener('pointermove', function (e) {
      if (drag) { var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) changed = true;
        camera.x += dx; camera.y += dy; drag.x = e.clientX; drag.y = e.clientY; draw(); }
      else { var r = canvas.getBoundingClientRect(); hover = hit(e.clientX - r.left, e.clientY - r.top);
        canvas.title = hover ? (hover.kind === 'backMembers' ? 'Back to procedure group' : hover.kind === 'nav' ? hover.title :
          hover.group ? hover.group.title + (hover.kind === 'group' ? ' · click to browse procedures' : ' · click to inspect states') :
          hover.nodeIds ? hover.id : hover.procedure + ' · ' + hover.label) : ''; }
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!drag) return; drag = null; canvas.classList.remove('dragging');
      if (changed) return;
      var r = canvas.getBoundingClientRect(), item = hit(e.clientX - r.left, e.clientY - r.top);
      if (item && item.kind === 'nav') {
        if (item.action === 'back') { overviewGroup = null; overviewPage = 0; }
        else if (item.action === 'previous') overviewPage--;
        else if (item.action === 'next') overviewPage++;
        draw(); return;
      }
      if (item && item.kind === 'group') {
        overviewGroup = item.group; overviewPage = 0; draw(); return;
      }
      if (item && item.kind === 'member') { focus(item.id, true); showDetail(procedureById.get(item.id)); return; }
      if (item && item.kind === 'backMembers') { overviewMode = true; detail.style.display = 'none'; draw(); return; }
      if (item) { showDetail(item); togglePin(item.nodeIds ? item.id : item.procedure); }
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault(); var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (overviewMode) { if (e.deltaY < 0) {
        var tile = hit(x, y);
        if (tile && tile.kind === 'group') { overviewGroup = tile.group; overviewPage = 0; draw(); }
        else if (tile && tile.kind === 'member') focus(tile.id, true);
      } return; }
      var next = Math.max(.015, Math.min(2.5, camera.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      camera.x = x - (x - camera.x) * next / camera.z;
      camera.y = y - (y - camera.y) * next / camera.z; camera.z = next; draw();
    }, { passive: false });
    search.addEventListener('input', renderSearch);
    doc.getElementById('state-reset').onclick = function () { pins = []; analysis = null; activeNodes = activeEdges = activeCalls = activeTargets = activeProcedureIds = null;
      search.value = ''; detail.style.display = 'none'; status.textContent = statusText();
      renderPins(); renderSearch(); fitEntries(); onPins([]); };
    doc.getElementById('state-fit-entries').onclick = fitEntries;
    doc.getElementById('state-fit-all').onclick = fitAll;
    if (onTrace) doc.getElementById('state-waterfall').onclick = function () { onTrace(focusedProcedure); };
    function setData(next) {
      dataGeneration++;
      model = next; procedures = model.procedures || []; procedureById = new Map(procedures.map(function (p) { return [p.id, p]; }));
      nodes = new Map(model.nodes.map(function (n) { return [n.id, n]; }));
      edges = new Map(model.edges.map(function (e) { return [e.id, e]; }));
      calls = new Map(model.calls.map(function (c) { return [c.id, c]; }));
      edgesByProc = new Map(); callsByProc = new Map();
      model.edges.forEach(function (e) { if (!edgesByProc.has(e.procedure)) edgesByProc.set(e.procedure, []); edgesByProc.get(e.procedure).push(e); });
      model.calls.forEach(function (c) { if (!callsByProc.has(c.procedure)) callsByProc.set(c.procedure, []); callsByProc.get(c.procedure).push(c); });
      rebuildScope(); drawMinimapBase();
      pins = pins.filter(function (id) { return procedureById.has(id); });
      analysis = null; activeNodes = activeEdges = activeCalls = activeTargets = activeProcedureIds = null;
      counts.textContent = model.counts.procedures.toLocaleString() + ' procedures · ' + model.counts.mirBlocks.toLocaleString() +
        ' MIR blocks · ' + model.counts.mirSuccessors.toLocaleString() + ' recorded successors · ' +
        (model.roots.application || []).length + ' application entries';
      status.textContent = statusText();
      renderPins(); renderSearch(); resize(); fitEntries(); onPins(pins.slice());
    }
    function setProcedureFilter(ids) {
      procedureFilter = ids == null ? null : new Set(ids);
      rebuildScope(); drawMinimapBase();
      if (!model) return;
      focusedProcedure = null; detail.style.display = 'none';
      renderPins(); renderSearch(); status.textContent = statusText();
      if (overviewMode) draw(); else fitEntries();
    }
    function setAnalysis(result) {
      analysis = result; activeNodes = new Set(result.activeNodeIds || []);
      activeEdges = new Set(result.activeEdgeIds || []); activeCalls = new Set(result.activeCallIds || []);
      activeTargets = new Set(result.activeCallTargets || []);
      activeProcedureIds = new Set(); activeNodes.forEach(function (id) { var n = nodes.get(id); if (n) activeProcedureIds.add(n.procedure); });
      status.textContent = statusText();
      draw();
    }
    function resize() { if (!visible) return; width = Math.max(1, canvas.clientWidth); height = Math.max(1, canvas.clientHeight); draw(); }
    function activate(active) { visible = active; minimap.hidden = !active; if (active) resize(); }
    function stats() { return model ? { counts: model.counts, roots: model.roots, coverage: model.coverage,
      drawn: drawn, dataGeneration: dataGeneration, pins: pins.slice(), status: analysis && analysis.status,
      scope: { active: !!procedureFilter, procedures: visibleProcedures.length,
        outsideTargets: boundaryCounts.outsideTargets, unknownCallsites: boundaryCounts.unknownCallsites,
        outsidePins: procedureFilter ? pins.filter(function (id) { return !procedureFilter.has(id); }).length : 0 },
      overviewMode: overviewMode, overviewView: overviewMode ? (overviewGroup ? 'members' : 'groups') : 'detail',
      overviewGroups: overviewGroups.length, overviewGroupCount: overviewGroup && overviewGroup.count,
      overviewPage: overviewPage,
      overviewTiles: overviewMode ? overviewTiles.map(function (t) { return {
        kind: t.kind, title: t.title || t.group.title, id: t.id || null,
        representative: t.group && t.group.representative, count: t.group && t.group.count,
        participating: t.group && (activeProcedureIds ? t.group.members.filter(function (id) {
          return activeProcedureIds.has(id);
        }).length : t.group.count),
        x: t.x, y: t.y, width: t.width, height: t.height }; }) : [],
      active: analysis && { nodes: activeNodes.size, edges: activeEdges.size, calls: activeCalls.size,
        targets: activeTargets.size }, diagnostics: analysis && analysis.diagnostics, camera: camera,
      focusedProcedure: focusedProcedure,
      focusedCounts: focusedProcedure && procedureById.has(focusedProcedure) ?
        { states: procedureById.get(focusedProcedure).stateCount,
          transitions: procedureById.get(focusedProcedure).transitionCount,
          branches: procedureById.get(focusedProcedure).branchCount,
          cycles: procedureById.get(focusedProcedure).loopCount } : null,
      applicationProcedures: model.layout.applicationProcedures,
      disconnectedProcedures: model.layout.disconnectedProcedures,
      branchStates: model.layout.branchStates, loopTransitions: model.layout.loopTransitions } : null; }
    renderPins(); renderSearch();
    return { setData: setData, setAnalysis: setAnalysis, setProcedureFilter: setProcedureFilter,
      activate: activate, resize: resize,
      pin: togglePin, focus: focus, fitEntries: fitEntries, fitAll: fitAll, stats: stats,
      hasProcedure: function (id) { return procedureById.has(id); },
      get pins() { return pins.slice(); } };
  }
  return { callEdgeActive: callEdgeActive, layout: layout, groupOverview: groupOverview, selfLoopGeometry: selfLoopGeometry,
    minimapGeometry: minimapGeometry, mount: mount };
});
