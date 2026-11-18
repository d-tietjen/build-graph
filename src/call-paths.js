/* Complete finite connecting call subgraphs. Browser + CommonJS; no walk enumeration. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./supply-chain.js') : root.SupplyChain);
  if (common) module.exports = api;
  root.CallPaths = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SupplyChain) {
  'use strict';
  var VERSION = 'captured-call-paths-v2';
  var CEILINGS = { maxWork: 2000000, maxNodes: 50000, maxEdges: 200000, maxEvidenceBytes: 8388608 };
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function normalize(q) {
    ['from', 'to'].forEach(function (key) {
      if (typeof q[key] !== 'string' || !q[key] || q[key].length > 16384)
        fail('INVALID_ENDPOINT', key + ' requires an exact bounded captured function ID');
    });
    if (q.includePossible == null) q.includePossible = true;
    if (typeof q.includePossible !== 'boolean') fail('INVALID_REQUEST', 'includePossible must be boolean');
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!Number.isSafeInteger(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000) fail('INVALID_TIMEOUT', 'timeoutMs requires 1..5000');
    if (q.budgets != null && (!q.budgets || typeof q.budgets !== 'object' || Array.isArray(q.budgets))) fail('INVALID_BUDGET', 'budgets must be an object');
    q.budgets = Object.assign({}, CEILINGS, q.budgets || {});
    Object.keys(q.budgets).forEach(function (key) {
      if (!CEILINGS[key] || !Number.isSafeInteger(q.budgets[key]) || q.budgets[key] < 1 || q.budgets[key] > CEILINGS[key])
        fail('INVALID_BUDGET', key + ' exceeds supported call graph budget');
    });
    return q;
  }
  function page(rows, q, name) {
    var p = q.page && (q.page[name] || q.page) || {}, offset = p.offset || 0, limit = p.limit == null ? 50 : p.limit;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail('INVALID_PAGE', 'page requires offset >= 0 and limit 1..100');
    var items = rows.slice(offset, offset + limit);
    return { total: rows.length, offset: offset, limit: limit, items: items,
      nextOffset: offset + items.length < rows.length ? offset + items.length : null,
      truncated: offset > 0 || offset + items.length < rows.length };
  }
  function source(n) { var path = n && n.attributes && n.attributes.source_absolute || n && n.source_file;
    return { source_file: n && n.source_file || null, source_location: n && n.source_location || null,
      absolute_file: typeof path === 'string' && path[0] === '/' ? path : null }; }
  function create(raw, inputs) {
    // Keep a private snapshot. Results, capabilities and the caller's graph cannot mutate it.
    var graph = clone(inputs.callGraph), model = { procedures: clone(inputs.model.procedures), calls: clone(inputs.model.calls), coverage: clone(inputs.model.coverage || {}) }, catalog = SupplyChain.build(clone(raw));
    var nodes = graph.nodes, edges = graph.edges, byId = new Map(), pathClaims = new Map(), procedures = new Map();
    var rawClaims = new Map(), rawById = new Map(raw.nodes.map(function (n) { return [n.id, n]; }));
    raw.nodes.forEach(function (n) {
      var a = n.attributes || {}, body;
      if (a.kind !== 'flow_function') return;
      try { body = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; } catch (_) { return; }
      if (!body || typeof body.function !== 'string') return;
      if (!rawClaims.has(body.function)) rawClaims.set(body.function, []);
      rawClaims.get(body.function).push({ node: n, body: body });
    });
    // Index accepted Model blocks once, retaining only bounded per-procedure gap facts.
    // A symbol/procedure identity does not imply that its MIR body is available.
    var modelNodes = new Map(inputs.model.nodes.map(function (n) { return [n.id, n]; })), bodyFacts = new Map();
    model.procedures.forEach(function (p) {
      procedures.set(p.id, p);
      var blocks = p.nodeIds.map(function (id) { return modelNodes.get(id); }).filter(function (n) { return n && n.procedure === p.id && n.block !== null; });
      var missingMir = blocks.length === 1 && blocks[0].kind === 'opaque' && /pre-optimization MIR unavailable/.test(blocks[0].label);
      bodyFacts.set(p.id, { missingMir: missingMir, gaps: blocks.filter(function (n) { return n.kind === 'opaque' || n.kind === 'yield'; }).map(function (n) {
        return { nodeId: n.id, blockId: n.block, kind: n.kind,
          reason: missingMir ? 'missing-mir' : n.kind === 'yield' ? 'yield-boundary' : 'opaque-block', source: source(n) };
      }) });
    });
    nodes.forEach(function (n) {
      var owner = catalog.ownership(n), paths = Array.from(new Set(n.flowPaths || [])), p = paths.length === 1 && procedures.get(paths[0]);
      var claims = p && (rawClaims.get(p.id) || []).filter(function (c) {
        var a = c.node.attributes;
        return a.path === p.id && (a.symbol_id || null) === p.symbol_id &&
          (c.body.function_id || null) === p.function_id && (a.package_id || null) === p.package_id &&
          (a.crate || null) === p.crate && (a.capture_scope || null) === p.capture_scope &&
          (a.display_path || p.id) === p.display_path &&
          (c.node.source_file || null) === p.source_file && (c.node.source_location || null) === p.source_location &&
          (!a.function_id || a.function_id === p.function_id);
      });
      var declaration = rawById.get(n.id), da = declaration && declaration.attributes || {};
      var linked = p && claims.length === 1 && claims[0].node.id === p.rawFlowNodeId && (!n.package_id || n.package_id === p.package_id) &&
        (['function', 'method'].includes(da.kind) ? p.symbol_id === n.id && (!da.package_id || da.package_id === p.package_id) : claims[0].node.id === n.id);
      var bodyFact = linked && bodyFacts.get(p.id);
      var nativeUnknown = n.language === 'native' && (n.kind === 'boundary' || n.native_boundary_kind);
      var row = { id: n.id, path: n.path, displayPath: n.display_path || n.path,
        packageId: !nativeUnknown && owner.status === 'exact' && owner.packageIds.length === 1 ? owner.packageIds[0] : null,
        ownership: clone(nativeUnknown ? { status: 'unknown', packageIds: [] } : owner),
        source: source(linked ? claims[0].node : declaration || n), language: n.language || 'rust', kind: n.kind,
        bodyStatus: linked ? bodyFact.missingMir ? 'unavailable' : 'captured' : n.body_status === 'native_disassembly' ? 'native_disassembly' : 'unavailable',
        bodyAvailability: linked ? bodyFact.missingMir ? 'missing-mir' : 'available' : 'unavailable',
        procedureId: linked ? p.id : null, functionId: linked ? p.function_id || null : null,
        buildUnitId: linked ? claims[0].node.attributes.unit_key || null : null,
        unknownCalls: n.unknownCalls || 0 };
      byId.set(n.id, row);
      if (!pathClaims.has(n.path)) pathClaims.set(n.path, []);
      pathClaims.get(n.path).push(n.id);
    });
    // A recursion projection can originate from a callback/indirect invocation;
    // retain that uncertainty even though its display kind says recursion.
    var possibleSites = new Set();
    model.calls.forEach(function (c) {
      if (c.possibleDispatch || c.callbackParameter != null)
        possibleSites.add(c.id);
    });
    var callsByProcedure = new Map();
    model.calls.forEach(function (call) {
      if (!callsByProcedure.has(call.procedure)) callsByProcedure.set(call.procedure, []);
      callsByProcedure.get(call.procedure).push(call);
    });
    var frozenCoverage = clone(model.coverage || {});
    function exact(id) {
      if (byId.has(id)) return byId.get(id);
      if (pathClaims.has(id)) fail(pathClaims.get(id).length > 1 ? 'AMBIGUOUS_ENDPOINT' : 'EXACT_ID_REQUIRED', 'Use an exact functions[].id; paths and labels are not endpoint identities');
      fail('UNKNOWN_ENDPOINT', 'Unknown captured function ID: ' + id);
    }
    async function run(request, control) {
      var q = normalize(clone(request)), from = exact(q.from), to = exact(q.to), start = Date.now(), work = 0, evidenceBytes = 0, stopped = null;
      var forward = new Set(), backward = new Set(), out = new Map(), incoming = new Map(), accepted = [], selected = null;
      var visible = q.scope ? new Set(catalog.scope(q.scope).packageIds) : null;
      var excludedPossible = 0, excludedNonCalls = 0, excludedBySource = new Map();
      control = control || {};
      function retain(value) {
        var bytes = JSON.stringify(value).length * 2;
        if (bytes > q.budgets.maxEvidenceBytes - evidenceBytes) { stopped = 'evidence-byte-budget'; throw stopped; }
        evidenceBytes += bytes;
      }
      async function checkpoint() {
        work++;
        if (control.cancelled && control.cancelled()) stopped = 'cancelled';
        else if (work > q.budgets.maxWork) stopped = 'work-budget';
        else if (Date.now() - start >= q.timeoutMs) stopped = 'timeout';
        if (stopped) throw stopped;
        if (work % 512 === 0) { await new Promise(function (resolve) { setTimeout(resolve, 0); });
          if (control.cancelled && control.cancelled()) { stopped = 'cancelled'; throw stopped; } }
      }
      async function reach(seed, adjacency, seen, reverse) {
        var queue = [seed]; seen.add(seed);
        for (var head = 0; head < queue.length; head++) {
          await checkpoint();
          for (var e of adjacency.get(queue[head]) || []) {
            await checkpoint();
            var next = reverse ? e.source : e.target;
            if (!seen.has(next)) {
              if (seen.size >= q.budgets.maxNodes) { stopped = 'node-budget'; throw stopped; }
              seen.add(next); queue.push(next);
            }
          }
        }
      }
      var resultNodes = [], resultEdges = [], relevantUnknown = [];
      try {
        if (nodes.length > q.budgets.maxNodes) { stopped = 'node-budget'; throw stopped; }
        for (var e of edges) {
          await checkpoint();
          if (!['call', 'recursion', 'indirect', 'callback', 'native_call', 'boundary'].includes(e.kind)) { excludedNonCalls++; continue; }
          if (!byId.has(e.source) || !byId.has(e.target)) continue;
          var sites = [], possible = false, known = false;
          for (var fact of e.callsites || []) {
            await checkpoint();
            var uncertain = ['indirect', 'callback'].includes(e.kind) || possibleSites.has(fact.id);
            if (uncertain) possible = true; else known = true;
            if (q.includePossible || !uncertain) sites.push(fact);
            else excludedBySource.set(e.source, (excludedBySource.get(e.source) || 0) + 1);
          }
          if (!(e.callsites || []).length) {
            possible = ['indirect', 'callback'].includes(e.kind); known = !possible;
            if (possible && !q.includePossible) excludedBySource.set(e.source, (excludedBySource.get(e.source) || 0) + 1);
          }
          if (!q.includePossible && !known) continue;
          if (accepted.length >= q.budgets.maxEdges) { stopped = 'edge-budget'; throw stopped; }
          var row = { id: 'call-edge:' + accepted.length, source: e.source, target: e.target, kind: e.kind,
            classification: q.includePossible && possible ? known ? 'mixed' : 'possible' : e.kind === 'native_call' ? 'observed' : 'modeled',
            invocationExact: false, sourceEvidence: source(e), callsites: [],
            nativeCall: e.native_call || null, boundaryKind: e.boundaryKind || null };
          for (var site of sites) { await checkpoint(); row.callsites.push(Object.assign(clone(site), { classification: possibleSites.has(site.id) || ['indirect', 'callback'].includes(e.kind) ? 'possible' : 'modeled', invocationExact: false })); }
          retain(row); accepted.push(row);
          if (!out.has(e.source)) out.set(e.source, []); out.get(e.source).push(row);
          if (!incoming.has(e.target)) incoming.set(e.target, []); incoming.get(e.target).push(row);
        }
        await reach(from.id, out, forward, false);
        await reach(to.id, incoming, backward, true);
        selected = new Set();
        for (var id of forward) { await checkpoint(); if (backward.has(id)) selected.add(id); }
        for (var node of nodes) {
          await checkpoint();
          if (selected.has(node.id)) { var nodeRow = Object.assign({}, byId.get(node.id), { outsideScope: !!visible && !visible.has(byId.get(node.id).packageId) });
            retain(nodeRow); resultNodes.push(clone(nodeRow)); }
        }
        for (var edge of accepted) { await checkpoint(); if (selected.has(edge.source) && selected.has(edge.target)) resultEdges.push(edge); }
        for (var frontierId of forward) {
          await checkpoint(); var n = byId.get(frontierId);
          excludedPossible += excludedBySource.get(frontierId) || 0;
          var gaps = [], bodyGaps = [], possibleCalls = 0;
          for (var reachableEdge of out.get(frontierId) || []) { await checkpoint(); if (reachableEdge.classification === 'possible' || reachableEdge.classification === 'mixed') possibleCalls++; }
          for (var call of n && callsByProcedure.get(n.procedureId) || []) {
            await checkpoint();
            if (call.unknown || call.possibleUnknown || call.nativeCall || call.possibleDispatch || call.callbackParameter != null || call.legacyUnverified || call.idMismatch) {
              var gap = { callsiteId: call.id, unknown: !!call.unknown, possibleUnknown: !!call.possibleUnknown,
                callbackParameter: call.callbackParameter, native: !!call.nativeCall, legacyUnverified: !!call.legacyUnverified, idMismatch: !!call.idMismatch };
              retain(gap); gaps.push(gap);
            }
          }
          for (var bodyGap of n && bodyFacts.get(n.procedureId) && bodyFacts.get(n.procedureId).gaps || []) {
            await checkpoint(); retain(bodyGap); bodyGaps.push(clone(bodyGap));
          }
          if (n && (n.bodyStatus !== 'captured' || n.unknownCalls || n.ownership.status !== 'exact' || gaps.length || bodyGaps.length || possibleCalls)) {
            var unknown = { id: frontierId, bodyStatus: n.bodyStatus, bodyAvailability: n.bodyAvailability, unknownCalls: n.unknownCalls, ownership: n.ownership.status, possibleCalls: possibleCalls, callsites: gaps, bodyGaps: bodyGaps };
            retain(unknown); relevantUnknown.push(unknown);
          }
        }
        var membership = { schemaVersion: 1, complete: true, nodeIds: [], edges: [] };
        for (var member of resultNodes) { await checkpoint(); retain(member.id); membership.nodeIds.push(member.id); }
        for (var link of resultEdges) { await checkpoint(); var tuple = [link.source, link.target, link.kind]; retain(tuple); membership.edges.push(tuple); }
      } catch (error) { if (!stopped) throw error; }
      var complete = !stopped, route = complete && forward.has(to.id);
      // A budget/cancel result never masquerades as the full connecting graph.
      if (!complete) { resultNodes = []; resultEdges = []; relevantUnknown = []; membership = { schemaVersion: 1, complete: false, nodeIds: [], edges: [] }; }
      var partial = relevantUnknown.length > 0 || !!excludedPossible || resultEdges.some(function (e) { return e.classification === 'possible' || e.classification === 'mixed'; });
      var nodePage = page(resultNodes, q, 'nodes'), edgePage = page(resultEdges, q, 'edges');
      return { status: !complete ? 'indeterminate' : route ? 'captured-route' : 'no-captured-route',
        endpoints: { from: clone(from), to: clone(to), zeroLength: from.id === to.id },
        nodes: nodePage, edges: edgePage, membership: membership,
        completion: { complete: complete, reason: stopped, work: work, evidenceBytes: evidenceBytes,
          evidenceComplete: complete && !nodePage.truncated && !edgePage.truncated,
          graphComplete: complete, representation: 'finite connecting subgraph; cycles retained symbolically' },
        queryCoverage: { partial: partial || !complete, unknownFrontier: page(relevantUnknown, q, 'unknowns'),
          capturedCoverage: clone(frozenCoverage), includedPossible: q.includePossible,
          possibleEdgeCount: resultEdges.filter(function (e) { return e.classification === 'possible' || e.classification === 'mixed'; }).length,
          excludedPossible: excludedPossible, excludedNonCalls: excludedNonCalls,
          scopeRole: 'presentation only; traversal includes all captured packages',
          hiddenIntermediaries: resultNodes.filter(function (n) { return n.outsideScope && n.id !== from.id && n.id !== to.id; }).length,
          missingBodiesProveNonExposure: false },
        semantics: { basis: 'directed captured call graph reachability', orderedExecutionProven: false,
          branchFeasibilitySolved: false, invocationExact: false, globalImpossibilityProven: false,
          possiblePolicy: 'Global callback and dispatch bindings are possible overapproximations, not invocation-specific proof.',
          sameEndpoint: 'Zero-length route plus all captured cycles returning to the endpoint.' },
        examples: { items: [], bounded: true, label: 'No walk enumeration; use orderedPath for a selected structural execution witness.' },
        finding: route ? 'Captured call connectivity; execution and exploitability are unproven.' :
          'No complete captured route established; missing capture or possible bindings can hide calls.' };
    }
    async function query(request, evidence, control) {
      var prepared = evidence.prepare(request);
      if (prepared.request.op !== 'callPaths') fail('INVALID_REQUEST', 'Expected callPaths');
      return Object.assign(await run(prepared.request, control), evidence.envelope(prepared), { schemaVersion: 1, operation: 'callPaths' });
    }
    return { query: query, run: run, functions: function () { return clone(Array.from(byId.values())); } };
  }
  return { VERSION: VERSION, normalize: normalize, page: page, create: create };
});
