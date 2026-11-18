/* Shared capture identity, replay and conservative execution evidence. Browser + CommonJS. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./value-flow.js') : root.ValueFlow, typeof module === 'object' && module.exports ? require('./execution-model.js') : root.ExecutionModel, common ? require('./guard-obligations.js') : root.GuardObligations, common ? require('./failure-obligations.js') : root.FailureObligations, common ? require('./resource-risks.js') : root.ResourceRisks, common ? require('./call-paths.js') : { normalize: function (q) { return root.CallPaths.normalize(q); } }, common ? require('./advisory-exposure.js') : { normalize: function (q) { return root.AdvisoryExposure.normalize(q); } }, common ? require('./program-queries.js') : root.ProgramQueries);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AnalysisEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ValueFlow, Model, Guards, Failures, Resources, CallPaths, Advisories, Programs) {
  'use strict';
  var VERSION = 1, DEFAULT_MS = 2000, MAX_MS = 5000, MAX_ITEMS = 100;
  var VERSIONS = { evidence: VERSION, model: 1, analysis: 'structural-and-v1', digest: 'canonical-json-v1',
    callPaths: 'captured-call-paths-v2', advisoryExposure: 'local-osv-exposure-v2', entryEffects: 1, buildExecution: 'cargo-build-execution-v1', effectSummaries: 'rust-standard-effects-v1', orderedExecution: 'structural-ordered-v1', valueFlow: 'mir-values-v1', guardObligations: 'guard-obligations-v1', failureObligations: 'failure-obligations-v1', resourceRisks: 'resource-risks-v1' };
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function unique(xs) { return Array.from(new Set(xs)).sort(); }
  function list(xs) { return { total: xs.length, items: xs.slice(0, MAX_ITEMS), truncated: xs.length > MAX_ITEMS }; }
  function source(n) { return { source_file: n && n.source_file || null, source_location: n && n.source_location || null }; }

  // Incremental SHA-256 keeps browser hashing bounded even for external captures.
  function hasher() {
    if (typeof module === 'object' && module.exports) return require('node:crypto').createHash('sha256');
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var block = new Uint8Array(64), used = 0, bytes = 0, w = new Int32Array(64), encoder = new TextEncoder();
    function rotate(x, n) { return x >>> n | x << (32 - n); }
    function compress() {
      var i;
      for (i = 0; i < 16; i++) w[i] = block[i*4]<<24 | block[i*4+1]<<16 | block[i*4+2]<<8 | block[i*4+3];
      for (i = 16; i < 64; i++) {
        var x = w[i-15], y = w[i-2];
        w[i] = (w[i-16] + (rotate(x,7)^rotate(x,18)^x>>>3) + w[i-7] + (rotate(y,17)^rotate(y,19)^y>>>10)) | 0;
      }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
      for (i = 0; i < 64; i++) {
        var t = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + (e&f ^ ~e&g) + k[i] + w[i]) | 0;
        var u = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + (a&b ^ a&c ^ b&c)) | 0;
        j=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0;
      }
      [a,b,c,d,e,f,g,j].forEach(function (v, n) { h[n] = (h[n]+v)|0; });
    }
    function add(v) { block[used++] = v; if (used === 64) { compress(); used = 0; } }
    return { update: function (text) {
      for (var offset = 0; offset < text.length;) {
        var end = Math.min(offset + 16384, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
        var data = encoder.encode(text.slice(offset, end)); bytes += data.length;
        for (var i = 0; i < data.length; i++) add(data[i]);
        offset = end;
      }
      return this;
    }, digest: function () {
      add(128); while (used !== 56) add(0);
      var high = Math.floor(bytes / 0x20000000), low = bytes * 8;
      for (var i = 3; i >= 0; i--) add(high >>> (i*8) & 255);
      for (var j = 3; j >= 0; j--) add(low >>> (j*8) & 255);
      return h.map(function (v) { return (v>>>0).toString(16).padStart(8, '0'); }).join('');
    } };
  }
  // Stream JSON tokens: never construct a second canonical graph or graph-sized string.
  function digest(value, sorted) {
    var hash = hasher(), ancestors = new Set();
    function visit(v) {
      if (!v || typeof v !== 'object') { hash.update(JSON.stringify(v) || 'null'); return; }
      if (ancestors.has(v)) fail('INVALID_GRAPH', 'capture must not contain cycles');
      ancestors.add(v);
      var array = Array.isArray(v), keys = array ? null : Object.keys(v).filter(function (key) { return v[key] !== undefined; });
      if (keys && sorted) keys.sort();
      hash.update(array ? '[' : '{');
      for (var i = 0; i < (array ? v.length : keys.length); i++) {
        var item = array ? v[i] : keys[i];
        if (i) hash.update(',');
        if (!array) hash.update(JSON.stringify(item) + ':');
        visit(array ? item : v[item]);
      }
      hash.update(array ? ']' : '}'); ancestors.delete(v);
    }
    visit(value); return hash.digest('hex');
  }
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { fail('INVALID_REQUEST', 'request must be JSON serializable'); }
  }
  function strings(value, name, max, required) {
    if (!Array.isArray(value) || required && !value.length || value.length > max ||
        !value.every(function (x) { return typeof x === 'string' && x.length; }))
      fail('INVALID_' + name.toUpperCase(), name + ' requires ' + (required ? '1' : '0') + '..' + max + ' nonempty IDs');
    return unique(value);
  }
  function normalize(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST', 'request must be an object');
    var q = clone(request);
    if (typeof q.op !== 'string' || !q.op) fail('INVALID_REQUEST', 'op must be a nonempty string');
    if (q.op === 'callPaths') q = CallPaths.normalize(q);
    if (q.op === 'advisoryExposure') q = Advisories.normalize(q);
    if (q.op === 'valueFlow') q = ValueFlow.normalize(q);
    if (q.op === 'guardObligations') q = Guards.normalize(q);
    if (q.op === 'failureObligations') q = Failures.normalize(q);
    if (q.op === 'resourceRisks') q = Resources.normalize(q);
    if (q.op === 'reachability') {
      q.pins = strings(q.pins, 'pins', 16, true);
      if (q.roots != null) q.roots = strings(typeof q.roots === 'string' ? [q.roots] : q.roots, 'roots', 100, true);
      q.timeoutMs = q.timeoutMs == null ? DEFAULT_MS : q.timeoutMs;
      if (!Number.isSafeInteger(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > MAX_MS)
        fail('INVALID_TIMEOUT', 'timeoutMs must be an integer 1..' + MAX_MS);
    }
    if (q.op === 'orderedPath') {
      if ((q.function != null) === (q.entryId != null)) fail('INVALID_REQUEST', 'orderedPath requires exactly one function or entryId');
      ['function', 'entryId'].forEach(function (key) {
        if (q[key] != null && (typeof q[key] !== 'string' || !q[key] || q[key].length > 16384))
          fail('INVALID_REQUEST', key + ' must be a bounded exact ID');
      });
      function selection(s) {
        if (!s || typeof s !== 'object' || Array.isArray(s) || !['procedure', 'node', 'call'].includes(s.kind) ||
            typeof s.id !== 'string' || !s.id || s.id.length > 16384 || Object.keys(s).some(function (k) { return k !== 'kind' && k !== 'id'; }))
          fail('INVALID_SELECTION', 'selection requires exact {kind: procedure|node|call, id}');
        return { kind: s.kind, id: s.id };
      }
      if (q.waypoints == null) q.waypoints = [];
      if (!Array.isArray(q.waypoints) || q.waypoints.length > 16) fail('INVALID_SELECTION', 'waypoints accepts at most 16 ordered events');
      q.waypoints = q.waypoints.map(selection); // Preserve order AND repetitions.
      if (q.target != null) q.target = selection(q.target);
      if (!q.waypoints.length && !q.target || q.waypoints.length + (q.target ? 1 : 0) > 16)
        fail('INVALID_SELECTION', 'orderedPath requires 1..16 waypoints including target');
      if (q.exclusions == null) q.exclusions = [];
      if (!Array.isArray(q.exclusions) || q.exclusions.length > 100) fail('INVALID_SELECTION', 'exclusions accepts at most 100 events');
      q.exclusions = unique(q.exclusions.map(function (s) { return JSON.stringify(selection(s)); })).map(function (s) { return JSON.parse(s); });
      q.timeoutMs = q.timeoutMs == null ? DEFAULT_MS : q.timeoutMs;
      if (!Number.isSafeInteger(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > MAX_MS) fail('INVALID_TIMEOUT', 'timeoutMs must be an integer 1..' + MAX_MS);
      var ceilings = { maxWork: 2000000, maxStates: 50000, maxEvidence: 1000 };
      if (q.budgets != null && (typeof q.budgets !== 'object' || Array.isArray(q.budgets))) fail('INVALID_BUDGET', 'budgets must be an object');
      q.budgets = Object.assign({ maxWork: 2000000, maxStates: 50000, maxEvidence: 200 }, q.budgets || {});
      Object.keys(q.budgets).forEach(function (key) {
        if (!ceilings[key] || !Number.isSafeInteger(q.budgets[key]) || q.budgets[key] < 1 || q.budgets[key] > ceilings[key])
          fail('INVALID_BUDGET', key + ' must be an integer 1..' + (ceilings[key] || 0));
      });
    }
    if (['entrypoints', 'effects', 'effectPaths', 'buildInventory'].includes(q.op)) {
      ['entryId', 'effectId', 'category', 'kind', 'function'].forEach(function (key) {
        if (q[key] != null && (typeof q[key] !== 'string' || !q[key] || q[key].length > 16384))
          fail('INVALID_REQUEST', key + ' must be a nonempty bounded string');
      });
      if (q.phase != null && !['build', 'application', 'dev-test', 'unknown'].includes(q.phase)) fail('INVALID_PHASE', 'phase must be build, application, dev-test or unknown');
      if (q.includePossible != null && typeof q.includePossible !== 'boolean') fail('INVALID_REQUEST', 'includePossible must be boolean');
    }
    if (q.scope != null) {
      if (!q.scope || typeof q.scope !== 'object' || Array.isArray(q.scope)) fail('INVALID_SCOPE', 'scope must be an object');
      q.scope.packageIds = strings(q.scope.packageIds, 'scope', 100, false);
      q.scope.dependencies = q.scope.dependencies || 'none';
      if (!['none', 'direct', 'transitive'].includes(q.scope.dependencies)) fail('INVALID_SCOPE', 'invalid dependency scope');
    }
    if (q.page != null) {
      var names = ['nodes','edges','calls','callTargets','packages','dependencies','functions','incoming','outgoing','entries','effects','witnesses','inventory','units','relationships','findings','unmatched','diagnostics','unknowns'];
      function checkPage(p, nested) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) fail('INVALID_PAGE', 'page must be an object');
        Object.keys(p).forEach(function (key) {
          if (key === 'offset') { if (!Number.isSafeInteger(p[key]) || p[key] < 0) fail('INVALID_PAGE', 'offset must be >= 0'); }
          else if (key === 'limit') { if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > 100) fail('INVALID_PAGE', 'limit must be 1..100'); }
          else if (!nested && names.includes(key)) checkPage(p[key], true);
          else fail('INVALID_PAGE', 'unknown page field ' + key);
        });
      }
      checkPage(q.page, false);
    }
    return q;
  }
  function validateGraph(graph) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail('INVALID_GRAPH', 'graph requires nodes and edges arrays');
    var ids = new Set();
    graph.nodes.forEach(function (n) {
      if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id) || n.attributes != null &&
          (typeof n.attributes !== 'object' || Array.isArray(n.attributes))) fail('INVALID_GRAPH', 'malformed or duplicate graph node');
      ids.add(n.id);
      var a = n.attributes || {}, flow;
      if (a.kind === 'flow_function') {
        try { flow = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; } catch (_) { return; }
        if (flow && Array.isArray(flow.blocks) && flow.blocks.some(function (b) { return !b || typeof b !== 'object'; }))
          fail('INVALID_GRAPH', 'malformed flow block');
      }
    });
    graph.edges.forEach(function (e) {
      if (!e || typeof e.source !== 'string' || typeof e.target !== 'string' || typeof e.relation !== 'string')
        fail('INVALID_GRAPH', 'malformed graph edge');
    });
  }
  function create(graph, options) {
    options = options || {}; validateGraph(graph);
    var model = options.model || Model.build(graph);
    var valueIndex, guardIndex, failureIndex, resourceIndex;
    function values() { return valueIndex || (valueIndex = ValueFlow.build(graph, model)); }
    function guards() { return guardIndex || (guardIndex = Guards.build(values(), model)); }
    function failures() { return failureIndex || (failureIndex = Failures.build(guards(), model)); }
    function resources() { return resourceIndex || (resourceIndex = Resources.build(failures())); }
    if (!options.deferIndexes) resources();
    var identity = { sha256: options.sha256 || (options.rawText != null ? hasher().update(options.rawText).digest('hex') : digest(graph, false)),
      contentSha256: digest(graph, true), digestFormat: VERSIONS.digest,
      source: options.source || null, nodes: graph.nodes.length, edges: graph.edges.length };
    var rawByProcedure = new Map(), rawById = new Map(), rawPaths = new Map();
    var nodesByProcedure = new Map(), edgesByNode = new Map(), callsByNode = new Map(), callsById = new Map();
    var procById = new Map(model.procedures.map(function (p) { return [p.id, p]; }));
    var provenanceValues = { sourceRevision: [], sourceDigests: [], target: [], features: [], toolchain: [] }, malformedRecords = [];
    var invalidProvenance = [], programBuildRecords = [];
    function collect(a, location) {
      [['source_revision','sourceRevision'],['source_digest','sourceDigests'],['target_triple','target'],
        ['features','features'],['toolchain','toolchain'],['rustc_version','toolchain']].forEach(function (pair) {
        var value = a[pair[0]];
        if (value == null || value === '') return;
        if (typeof value !== 'string' && !(pair[0] === 'features' && Array.isArray(value) && value.every(function (v) { return typeof v === 'string'; })) ||
            pair[0] === 'source_digest' && !/^[0-9a-f]{16}$/i.test(value)) {
          invalidProvenance.push({ evidencePath: location + '/' + pair[0], classification: 'unknown' }); return;
        }
        provenanceValues[pair[1]].push({ value: Array.isArray(value) ? list(value) : value, evidencePath: location + '/' + pair[0] });
      });
    }
    if (graph.provenance != null && (typeof graph.provenance !== 'object' || Array.isArray(graph.provenance)))
      invalidProvenance.push({ evidencePath: '/provenance', classification: 'unknown' });
    else collect(graph.provenance || {}, '/provenance');
    graph.nodes.forEach(function (n, i) {
      rawById.set(n.id, n); rawPaths.set(n.id, '/nodes/' + i);
      var a = n.attributes || {}; collect(a, '/nodes/' + i + '/attributes');
      if(a.capture_provenance_v1!=null)programBuildRecords.push({rawNodeId:n.id,evidencePath:'/nodes/'+i+'/attributes/capture_provenance_v1',status:typeof a.capture_provenance_v1==='string'?'captured':'invalid',record:typeof a.capture_provenance_v1==='string'?a.capture_provenance_v1:null});
      if (a.kind === 'flow_function') {
        var flow;
        try { flow = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; } catch (_) { /* Model retains unavailable diagnostics. */ }
        var key = flow && typeof flow.function === 'string' ? flow.function : a.path;
        if (typeof key === 'string' && !rawByProcedure.has(key)) rawByProcedure.set(key, n);
        if (flow && Array.isArray(flow.blocks)) flow.blocks.forEach(function (b, ordinal) {
          function stringArray(xs) { return Array.isArray(xs) && xs.every(function (v) { return typeof v === 'string'; }); }
          var invalid = b.kind != null && !['goto','branch','call','tail_call','return','opaque','assert','yield','unwind','abort','unreachable','drop'].includes(b.kind);
          ['callee','callee_id','callee_package_id','callee_crate','callee_artifact','callee_abi'].forEach(function (field) {
            if (b[field] != null && typeof b[field] !== 'string') invalid = true;
          });
          ['callee_targets','native_target_ids'].forEach(function (field) { if (b[field] != null && !stringArray(b[field])) invalid = true; });
          if (b.callback_parameter != null && (!Number.isInteger(b.callback_parameter) || b.callback_parameter < 0)) invalid = true;
          if (b.callback_unknown != null && typeof b.callback_unknown !== 'boolean') invalid = true;
          if (b.native_call != null && (typeof b.native_call !== 'object' || Array.isArray(b.native_call))) invalid = true;
          if (b.callback_args != null && (!Array.isArray(b.callback_args) || b.callback_args.some(function (arg) {
            return !arg || !Number.isInteger(arg.index) || arg.index < 0 || arg.targets != null && !stringArray(arg.targets) ||
              arg.parameter != null && (!Number.isInteger(arg.parameter) || arg.parameter < 0) || arg.unknown != null && typeof arg.unknown !== 'boolean';
          }))) invalid = true;
          if (Array.isArray(b.successors) && b.successors.some(function (s) { return s &&
            (s.kind != null && !['normal','unwind'].includes(s.kind) || s.action != null && !['continue','terminate','unreachable'].includes(s.action)); })) invalid = true;
          if (invalid) malformedRecords.push({ procedure: key, nodeId: key + '#' + b.id,
            classification: 'unknown', evidencePath: '/nodes/' + i + '/attributes/flow#blocks/' + ordinal,
            message: 'Malformed or unsupported execution record; discarded fields may hide execution.' });
        });
      }
    });
    model.nodes.forEach(function (n) { if (!nodesByProcedure.has(n.procedure)) nodesByProcedure.set(n.procedure, []); nodesByProcedure.get(n.procedure).push(n); });
    model.edges.forEach(function (e) { if (!edgesByNode.has(e.from)) edgesByNode.set(e.from, []); edgesByNode.get(e.from).push(e); });
    model.calls.forEach(function (c) {
      callsByNode.set(c.from, c); callsById.set(c.id, c);
    });
    var modelNodeById = new Map(model.nodes.map(function (n) { return [n.id, n]; }));
    var errorRecords = (model.coverage.errors || []).map(function (message) {
      var match = /(?:for |from |at )(.+)$/.exec(message), node = match && modelNodeById.get(match[1]);
      return { message: message, procedure: node && node.procedure || null };
    });
    var provenance = {};
    Object.keys(provenanceValues).forEach(function (key) {
      var values = provenanceValues[key];
      provenance[key] = { status: values.length ? 'captured' : 'unknown', ...list(values) };
    });
    provenance.sourceDigests.algorithm = 'fnv1a-64';
    provenance.invalidRecords = list(invalidProvenance);
    function describe(procedure, rawId) {
      var raw = rawByProcedure.get(procedure) || rawById.get(rawId), a = raw && raw.attributes || {};
      function text(key) { return typeof a[key] === 'string' && a[key] || null; }
      function capturedList(key) {
        var value = a[key]; if (value == null || value === '') return { status: 'unknown', ...list([]) };
        try { if (typeof value === 'string') value = JSON.parse(value); } catch (_) { value = null; }
        return Array.isArray(value) && value.every(function (v) { return typeof v === 'string'; }) ?
          { status: 'captured', ...list(value) } : { status: 'invalid', ...list([]) };
      }
      var compilerId = (procById.get(procedure) || {}).function_id;
      var values = { packageId: text('package_id'), buildUnitId: text('unit_key'),
        functionId: text('function_id') || (typeof compilerId === 'string' ? compilerId : null),
        sourceDigest: /^[0-9a-f]{16}$/i.test(text('source_digest') || '') ? text('source_digest') : null };
      return { rawNodeId: raw && raw.id || null, procedureId: procedure || null, ...values,
        unknownFields: Object.keys(values).filter(function (key) { return values[key] == null; }),
        source: source(raw), evidencePath: raw ? rawPaths.get(raw.id) : null,
        sourceDigestAlgorithm: 'fnv1a-64', targetName: text('target_name'), targetSourcePath: text('target_src_path'),
        targetKind: capturedList('target_kind'), artifact: text('native_artifact'), targetArtifacts: capturedList('target_artifacts') };
    }
    function prepare(request) {
      var replayed = request && request.op === 'replay';
      if (replayed) {
        if (!request.replay) fail('INVALID_REPLAY', 'replay descriptor is missing');
        var replay = clone(request.replay);
        if (!replay || replay.version !== VERSION || !replay.capture || !replay.request)
          fail('INVALID_REPLAY', 'replay requires the serialized replay descriptor');
        if (replay.capture.contentSha256 !== identity.contentSha256 || replay.capture.digestFormat !== identity.digestFormat)
          fail('CAPTURE_MISMATCH', 'replay capture digest does not match the loaded graph');
        if (digest(replay.versions, true) !== digest(VERSIONS, true)) fail('VERSION_MISMATCH', 'replay analysis versions do not match');
        request = replay.request;
      }
      var q = normalize(request);
      if (q.op === 'replay') fail('INVALID_REPLAY', 'nested replay is not supported');
      return { request: q, replayed: replayed };
    }
    function envelope(prepared) {
      return { graph: { ...identity }, provenance: clone(provenance), captureDiagnostics: list(malformedRecords), versions: { ...VERSIONS }, request: clone(prepared.request),
        replayed: prepared.replayed, replay: { version: VERSION,
          capture: { contentSha256: identity.contentSha256, digestFormat: identity.digestFormat },
          versions: { ...VERSIONS }, request: clone(prepared.request) },
        assumptions: ['Captured structural execution only; branch feasibility is unsolved.',
          prepared.request.op === 'callPaths' || prepared.request.op === 'advisoryExposure' ? 'Directed captured call connectivity only; possible global bindings are overapproximations. No non-exposure or invocation-exact claim.' :
          prepared.request.op === 'valueFlow' ? 'Configured value-model influence only; neither runtime exploitability nor vulnerability absence is proven.' :
          prepared.request.op === 'orderedPath' ? 'Ordered structural event prefixes only; no data-flow or vulnerability absence claim.' :
            'Pins are unordered; no data-flow or vulnerability absence claim.',
          'Missing capture provenance remains unknown; paths do not establish ownership or revision.'],
        classifications: ['compiler-confirmed', 'modeled', 'possible', 'observed', 'unknown'] };
    }
    async function coverageFor(q, contextualCallbacks, control) {
      var roots = q.roots || unique((model.roots.application || []).concat(model.roots.disconnected || []));
      var seen = new Set(), reachableNodes = new Set(), reachableCalls = new Set(), queue = roots.slice();
      var gaps = [], nodeQueue = [], missingTargets = new Set(), missing = q.pins.filter(function (p) { return !procById.has(p); });
      function boundedCoverage() { return { partial: true, roots: list(roots), reachableProcedures: seen.size,
        reachableCalls: reachableCalls.size, gaps: list(gaps.concat([{ kind: 'coverage-budget', classification: 'unknown',
          message: 'Coverage traversal was interrupted; unvisited capture remains unknown.' }])), completionIncomplete: true,
        global: { partial: !!model.coverage.partial, nativePartial: !!model.coverage.nativePartial },
        interpretation: 'Incomplete query-reachable coverage; no definitive negative is available.' }; }
      missing.forEach(function (p) { gaps.push({ kind: 'missing-pin-body', procedure: p, classification: 'unknown', identity: describe(p) }); });
      for (var i = 0; i < queue.length; i++) {
        if (control && !control()) return boundedCoverage();
        var id = queue[i]; if (seen.has(id) || !procById.has(id)) continue;
        seen.add(id); nodeQueue = [procById.get(id).entry];
        for (var j = 0; j < nodeQueue.length; j++) {
          if (control && j % 256 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
          if (control && !control()) return boundedCoverage();
          var nodeId = nodeQueue[j]; if (reachableNodes.has(nodeId)) continue;
          reachableNodes.add(nodeId);
          var call = callsByNode.get(nodeId);
          if (call) {
            reachableCalls.add(call.id);
            (call.unavailableTargets || []).forEach(function (p) { missingTargets.add(p); });
            var possible = call.possibleTargets || call.targets;
            for (var pi = 0; pi < possible.length; pi++) {
              if (control && !control()) return boundedCoverage();
              if (!seen.has(possible[pi])) queue.push(possible[pi]);
            }
            var boundByAnalyzer = contextualCallbacks && call.callbackParameter !== null && !call.unknown && !call.nativeCall && !call.possibleDispatch;
            if (!boundByAnalyzer && (call.unknown || call.possibleUnknown || call.nativeCall || call.possibleDispatch || call.callbackParameter !== null))
              gaps.push({ kind: call.nativeCall ? 'native-boundary' : call.possibleDispatch || call.callbackParameter !== null ? 'dispatch' : 'missing-call-target',
                procedure: id, callsite: call.id, nodeId: call.from, classification: 'unknown',
                unavailableTargets: list(call.unavailableTargets || []), identity: describe(id) });
          }
          var successors = edgesByNode.get(nodeId) || [];
          for (var ei = 0; ei < successors.length; ei++) {
            if (control && !control()) return boundedCoverage();
            if (!reachableNodes.has(successors[ei].to)) nodeQueue.push(successors[ei].to);
          }
        }
        var procedureNodes = nodesByProcedure.get(id) || [];
        for (var ni = 0; ni < procedureNodes.length; ni++) {
          if (control && !control()) return boundedCoverage();
          var n = procedureNodes[ni];
          if (reachableNodes.has(n.id) && ['opaque', 'yield', 'drop'].includes(n.kind))
            gaps.push({ kind: n.kind, procedure: id, nodeId: n.id, classification: 'unknown', identity: describe(id) });
        }
      }
      if (control && !control()) return boundedCoverage();
      // Model errors have source block IDs; retain unattributed errors conservatively.
      var allErrors = model.coverage.errors || [], relevantErrors = [], disconnectedErrors = [];
      for (var ri = 0; ri < errorRecords.length; ri++) {
        if (control && !control()) return boundedCoverage();
        var record = errorRecords[ri];
        (record.procedure && !seen.has(record.procedure) ? disconnectedErrors : relevantErrors).push(record.message);
      }
      relevantErrors.forEach(function (message) { gaps.push({ kind: 'malformed-model', classification: 'unknown', message: message }); });
      var relevantMalformed = [];
      for (var mi = 0; mi < malformedRecords.length; mi++) {
        if (control && !control()) return boundedCoverage();
        if (reachableNodes.has(malformedRecords[mi].nodeId)) relevantMalformed.push(malformedRecords[mi]);
      }
      relevantMalformed.forEach(function (record) { gaps.push({ kind: 'malformed-record', ...record }); });
      var globalUnavailable = model.coverage.unavailable || [];
      // Inferred roots omit bodies the model could not import. Any such body may
      // be an entry that connects the pins; only explicit roots can isolate it.
      var relevantUnavailable = [];
      for (var ui = 0; ui < globalUnavailable.length; ui++) {
        if (control && !control()) return boundedCoverage();
        var unavailable = globalUnavailable[ui];
        if (!q.roots || seen.has(unavailable.function) || missing.includes(unavailable.function) || missingTargets.has(unavailable.function))
          relevantUnavailable.push(unavailable);
      }
      relevantUnavailable.forEach(function (u) { gaps.push({ kind: 'unavailable-body', classification: 'unknown', ...u }); });
      var disconnectedUnknownCalls = 0;
      for (var ci = 0; ci < model.calls.length; ci++) {
        if (control && ci % 512 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
        if (control && !control()) return boundedCoverage();
        var c = model.calls[ci];
        if (!reachableCalls.has(c.id) && (c.unknown || c.possibleUnknown || c.nativeCall || c.possibleDispatch || c.callbackParameter !== null)) disconnectedUnknownCalls++;
      }
      return { partial: gaps.length > 0, roots: list(roots), reachableProcedures: seen.size,
        reachableCalls: reachableCalls.size, gaps: list(gaps),
        disconnected: { unknownCalls: disconnectedUnknownCalls,
          unavailableBodies: globalUnavailable.length - relevantUnavailable.length, modelErrors: list(disconnectedErrors),
          malformedRecords: malformedRecords.length - relevantMalformed.length,
          interpretation: 'Disconnected through recorded calls only; reachable unknown effects may connect unrecorded regions.' },
        global: { partial: !!model.coverage.partial || malformedRecords.length > 0, diagnostics: list(allErrors), unavailableBodies: list(globalUnavailable),
          malformedRecords: list(malformedRecords),
          nativePartial: !!model.coverage.nativePartial },
        interpretation: q.roots ? 'Coverage follows structural entry reachability from the explicit roots, including possible dispatch.' :
          'All inferred roots are possible entries; unknown effects in any entry can hide additional routes.' };
    }
    async function analyze(prepared, runtime) {
      runtime = runtime || {}; var q = prepared.request;
      if (q.op !== 'reachability') fail('INVALID_REQUEST', 'analyze requires reachability');
      (q.roots || []).forEach(function (p) { if (!procById.has(p)) fail('UNKNOWN_PROCEDURE', 'unknown root procedure ' + p); });
      var now = runtime.now || Date.now, start = now(), queryCoverage = await coverageFor(q), timedOut = false, wasCancelled = false;
      function cancelled() {
        wasCancelled = wasCancelled || !!(runtime.cancelled && runtime.cancelled());
        timedOut = timedOut || now() - start >= q.timeoutMs;
        return wasCancelled || timedOut;
      }
      // Global native/partial flags must not contaminate an unrelated explicit-root query.
      // Actual visited opaque effects still come from the existing model algorithm.
      var view = { ...model, coverage: { ...model.coverage, partial: false, nativePartial: false } };
      var result = await Model.analyze(view, q.pins, { roots: q.roots, cancelled: cancelled });
      cancelled();
      var budget = result.diagnostics.some(function (d) { return /budget reached/i.test(d); });
      var incomplete = result.status === 'cancelled' || budget || timedOut || wasCancelled;
      if (timedOut || wasCancelled) result.status = 'cancelled';
      if (!incomplete && queryCoverage.partial && result.status !== 'indeterminate') result.status = 'indeterminate';
      result.partialCoverage = !!result.partialCoverage || queryCoverage.partial || incomplete;
      if (queryCoverage.partial) result.diagnostics.push('Query-reachable capture gaps prevent a definitive structural conclusion.');
      if (timedOut) result.diagnostics.push('Analysis time budget reached (' + q.timeoutMs + ' ms).');
      result.queryCoverage = queryCoverage;
      result.completion = { complete: !incomplete, cancelled: wasCancelled, timedOut: timedOut,
        budgetExceeded: budget, timeoutMs: q.timeoutMs };
      result.finding = { classification: result.status === 'exact' ? 'modeled' : result.status === 'impossible' ? 'modeled' : 'unknown',
        definitiveNegative: result.status === 'impossible' && !result.partialCoverage && !incomplete,
        domain: 'captured structural model only' };
      var pagination = {}, counts = { nodes: result.activeNodeIds.length, edges: result.activeEdgeIds.length,
        calls: result.activeCallIds.length, callTargets: result.activeCallTargets.length };
      Object.keys(counts).forEach(function (key) {
        var p = q.page && (q.page[key] || q.page) || {}, offset = p.offset || 0, limit = p.limit || 50;
        pagination[key] = { total: counts[key], offset: offset, limit: limit,
          omitted: Math.min(offset, counts[key]) + Math.max(0, counts[key] - offset - limit),
          nextOffset: offset + limit < counts[key] ? offset + limit : null };
      });
      result.queryCoverage.pagination = pagination;
      result.completion.evidenceComplete = Object.keys(pagination).every(function (key) { return pagination[key].omitted === 0; });
      result.evidenceLinks = { nodes: list(result.activeNodeIds.slice().sort().slice(0, MAX_ITEMS).map(function (id) {
        var n = modelNodeById.get(id);
        return { id: id, blockId: n && n.block || null, classification: n && n.block ? 'compiler-confirmed' : 'modeled',
          source: source(n), identity: describe(n && n.procedure) };
      })), calls: list(result.activeCallIds.slice().sort().slice(0, MAX_ITEMS).map(function (id) {
        var c = callsById.get(id);
        return { id: id, classification: c && c.resolution === 'idMatched' ? 'compiler-confirmed' : c && c.possibleDispatch ? 'possible' : c && c.unknown ? 'unknown' : 'modeled',
          identity: describe(c && c.procedure), callsite: c && c.from || null,
          source: source(c && modelNodeById.get(c.from)), targets: list(c && c.targets || []),
          normalContinuationIds: list(c && c.normal || []), unwindContinuationIds: list(c && c.unwind || []) };
      })) };
      result.evidenceLinks.nodes.total = counts.nodes; result.evidenceLinks.nodes.truncated = counts.nodes > MAX_ITEMS;
      result.evidenceLinks.calls.total = counts.calls; result.evidenceLinks.calls.truncated = counts.calls > MAX_ITEMS;
      return Object.assign(result, envelope(prepared));
    }
    var selectionProcedures = new Map();
    function addSelection(key, id) {
      if (typeof key !== 'string' || !key) return;
      if (!selectionProcedures.has(key)) selectionProcedures.set(key, new Set());
      selectionProcedures.get(key).add(id);
    }
    model.procedures.forEach(function (p) {
      var raw = rawByProcedure.get(p.id);
      [p.id, p.symbol_id, p.function_id, p.display_path, raw && raw.id].forEach(function (key) { addSelection(key, p.id); });
    });
    graph.edges.forEach(function (e) {
      if (e.relation !== 'has_flow') return;
      (selectionProcedures.get(e.target) || []).forEach(function (id) { addSelection(e.source, id); });
    });
    async function analyzeOrdered(prepared, runtime) {
      runtime = runtime || {}; var q = prepared.request, unknownSelections = [];
      if (q.op !== 'orderedPath') fail('INVALID_REQUEST', 'analyzeOrdered requires orderedPath');
      var now = runtime.now || Date.now, started = now(), coverageWork = 0, timedOut = false, wasCancelled = false, coverageBudget = false;
      function control() {
        timedOut = timedOut || now() - started >= q.timeoutMs;
        wasCancelled = wasCancelled || !!(runtime.cancelled && runtime.cancelled());
        coverageBudget = coverageBudget || ++coverageWork >= q.budgets.maxWork;
        return !timedOut && !wasCancelled && !coverageBudget;
      }
      function resolve(s, role) {
        var candidates = s.kind === 'procedure' ? Array.from(selectionProcedures.get(s.id) || []) :
          (s.kind === 'node' ? modelNodeById.has(s.id) : callsById.has(s.id)) ? [s.id] : [];
        if (candidates.length !== 1) {
          unknownSelections.push({ role: role, selection: s, status: candidates.length ? 'ambiguous' : 'unavailable',
            candidates: list(candidates), classification: 'unknown' }); return null;
        }
        return { kind: s.kind, id: candidates[0] };
      }
      var rootId = q.function;
      if (q.entryId != null) {
        var entry = (runtime.entries || []).find(function (e) { return e.id === q.entryId; });
        rootId = entry && entry.nodeId;
        if (!entry) unknownSelections.push({ role: 'root', selection: { kind: 'entry', id: q.entryId }, status: 'unavailable', classification: 'unknown' });
      }
      var rootSelection = rootId ? resolve({ kind: 'procedure', id: rootId }, 'root') : null;
      var selected = q.waypoints.concat(q.target ? [q.target] : []).map(function (s, i) { return resolve(s, 'waypoint:' + i); });
      var excluded = q.exclusions.map(function (s) { return resolve(s, 'exclusion'); });
      var rootIdResolved = rootSelection && rootSelection.id;
      var queryCoverage = await coverageFor({ roots: rootIdResolved ? [rootIdResolved] : [],
        pins: selected.filter(Boolean).filter(function (s) { return s.kind === 'procedure'; }).map(function (s) { return s.id; }) }, true, control);
      queryCoverage.callbackBindings = 'Ordered procedure summaries check exact per-invocation bindings; unresolved bindings remain indeterminate.';
      var result;
      if (unknownSelections.length || queryCoverage.completionIncomplete) result = {
        status: timedOut || wasCancelled ? 'cancelled' : 'indeterminate', partialCoverage: true, witness: null,
        diagnostics: [queryCoverage.completionIncomplete ? 'Ordered query coverage budget/cancellation reached; no negative conclusion.' :
          'Unavailable or ambiguous selections have no invented executable identity.'],
        completion: { complete: !queryCoverage.completionIncomplete, cancelled: wasCancelled, timedOut: timedOut,
          budgetExceeded: coverageBudget, evidenceComplete: !queryCoverage.completionIncomplete,
          work: coverageWork, states: 0, limits: q.budgets, timeoutMs: q.timeoutMs } };
      else result = await Model.analyzeOrdered(model, { root: rootIdResolved, waypoints: selected, exclusions: excluded,
        budgets: Object.assign({}, q.budgets, { maxWork: q.budgets.maxWork - coverageWork }),
        timeoutMs: Math.max(1, q.timeoutMs - (now() - started)) }, runtime);
      if (!queryCoverage.completionIncomplete && !unknownSelections.length) result.completion.work += coverageWork;
      result.completion.limits = q.budgets; result.completion.timeoutMs = q.timeoutMs;
      queryCoverage.selections = list(unknownSelections);
      queryCoverage.partial = queryCoverage.partial || unknownSelections.length > 0;
      if (queryCoverage.partial) {
        result.partialCoverage = true;
        if (result.status === 'exact' || result.status === 'impossible') result.status = 'indeterminate';
        result.diagnostics.push('Query-reachable capture gaps prevent a definitive structural conclusion.');
      }
      function enrich(step) {
        var p = step.procedure, owner = step.sourceProcedure || p, raw = rawByProcedure.get(owner);
        var attrs = raw && raw.attributes || {}, s = step.source || source(raw);
        var absolute = s.source_file && s.source_file.startsWith('/') ? s.source_file : null;
        if (!absolute && typeof attrs.source_absolute === 'string' && attrs.source_absolute.startsWith('/') &&
            raw && s.source_file === raw.source_file) absolute = attrs.source_absolute;
        if (!absolute && typeof attrs.target_src_path === 'string' && attrs.target_src_path.startsWith('/') && s.source_file &&
            (attrs.target_src_path === s.source_file || attrs.target_src_path.endsWith('/' + s.source_file))) absolute = attrs.target_src_path;
        return Object.assign({}, step, { sourceProcedure: owner, sourceIdentity: describe(owner),
          source: Object.assign({}, s, { absolute_file: absolute }), identity: describe(p),
          views: { flow: { procedure: p, nodeId: step.nodeId || null },
            flamegraph: { root: rootIdResolved, focus: p, witnessProofId: result.witness && result.witness.rootProofId },
            sequence: { root: rootIdResolved, focus: p, witnessProofId: result.witness && result.witness.rootProofId } } });
      }
      if (result.witness) {
        result.witness.steps = result.witness.steps.map(enrich);
        result.witness.summaries = result.witness.summaries.map(enrich);
      }
      return Object.assign(result, envelope(prepared), { schemaVersion: 1, operation: 'orderedPath',
        semantics: { basis: 'STRUCTURAL reachability in captured MIR', branchFeasibilitySolved: false,
          vulnerabilityAbsenceProven: false, eventOrder: ['procedure entry (root counts)', 'node arrival', 'callsite execution before callee entry'],
          repeatedWaypoints: 'one waypoint per distinct matching event; repetitions require another visit',
          exclusions: 'prefix through and including the final waypoint; exclusions take precedence over a match',
          existingViews: 'flow highlights this witness in the full CFG; flamegraph/sequence project these exact proof steps' },
        resolved: { root: rootSelection, waypoints: selected, exclusions: excluded }, queryCoverage: queryCoverage,
        finding: { classification: result.status === 'exact' || result.status === 'impossible' ? 'modeled' : 'unknown',
          definitiveNegative: result.status === 'impossible' && !result.partialCoverage && result.completion.complete,
          domain: 'captured structural model only' } });
    }
    async function analyzeValues(prepared, runtime) {
      if (prepared.request.op !== 'valueFlow') fail('INVALID_REQUEST', 'analyzeValues requires valueFlow');
      var result = await ValueFlow.analyze(values(), prepared.request, runtime);
      result.witnesses.items.forEach(function (row) { row.steps = row.steps.map(function (step) {
        var entry = valueIndex.procedures.get(step.sourceProcedure), raw = entry && entry.raw;
        var a = raw && raw.attributes || {}, span = step.source || source(raw), absolute = null;
        if (typeof span.source_file === 'string' && span.source_file.startsWith('/')) absolute = span.source_file;
        if (!absolute && raw && span.source_file === raw.source_file && typeof a.source_absolute === 'string' && a.source_absolute.startsWith('/')) absolute = a.source_absolute;
        if (!absolute && typeof a.target_src_path === 'string' && a.target_src_path.startsWith('/') && span.source_file &&
            (a.target_src_path === span.source_file || a.target_src_path.endsWith('/' + span.source_file))) absolute = a.target_src_path;
        // Snapshot identity from the accepted imported body, never a mutable first path claim.
        var owner = entry && entry.procedure || {}, identity = { rawNodeId: raw && raw.id || null,
          procedureId: owner.id || null, functionId: owner.function_id || null, packageId: owner.package_id || null,
          buildUnitId: typeof a.unit_key === 'string' ? a.unit_key : null,
          sourceDigest: /^[0-9a-f]{16}$/i.test(a.source_digest || '') ? a.source_digest : null, sourceDigestAlgorithm: 'fnv1a-64' };
        identity.unknownFields = Object.keys(identity).filter(function (k) { return identity[k] == null; });
        return Object.assign({}, step, { source: Object.assign({}, span, { absolute_file: absolute }),
          sourceIdentity: identity, identity: identity,
          evidencePath: raw && rawPaths.get(raw.id) + '/attributes/flow#value_facts',
          views: { flow: { procedure: step.procedure, nodeId: step.nodeId } } });
      }); });
      return Object.assign(result, envelope(prepared), { assumptions: [
        'Value propagation within the supported captured MIR and explicit configured summaries.',
        'CFG joins overapproximate feasible branches; implicit control dependencies are excluded.',
        'Unknown effects and missing facts prevent an absence conclusion; candidate influence is not exploitability.' ] });
    }
    async function analyzeGuards(prepared, runtime) {
      if (prepared.request.op !== 'guardObligations') fail('INVALID_REQUEST', 'analyzeGuards requires guardObligations');
      var result = await Guards.analyze(guards(), prepared.request, runtime);
      result.witnesses.items.forEach(function (row) { row.steps = row.steps.map(function (step) {
        var entry = valueIndex.procedures.get(step.sourceProcedure), raw = entry && entry.raw;
        var a = raw && raw.attributes || {}, span = step.source || source(raw), absolute = null;
        if (typeof span.source_file === 'string' && span.source_file.startsWith('/')) absolute = span.source_file;
        if (!absolute && raw && span.source_file === raw.source_file && typeof a.source_absolute === 'string' && a.source_absolute.startsWith('/')) absolute = a.source_absolute;
        if (!absolute && typeof a.target_src_path === 'string' && a.target_src_path.startsWith('/') && span.source_file &&
            (a.target_src_path === span.source_file || a.target_src_path.endsWith('/' + span.source_file))) absolute = a.target_src_path;
        var owner = entry && entry.procedure || {}, identity = { rawNodeId: raw && raw.id || null,
          procedureId: owner.id || null, functionId: owner.function_id || null, packageId: owner.package_id || null,
          buildUnitId: typeof a.unit_key === 'string' ? a.unit_key : null,
          sourceDigest: /^[0-9a-f]{16}$/i.test(a.source_digest || '') ? a.source_digest : null, sourceDigestAlgorithm: 'fnv1a-64' };
        identity.unknownFields = Object.keys(identity).filter(function (k) { return identity[k] == null; });
        return Object.assign({}, step, { source: Object.assign({}, span, { absolute_file: absolute }), sourceIdentity: identity,
          identity: identity, evidencePath: raw && rawPaths.get(raw.id) + '/attributes/flow#' + (['branch','guard-outcome'].includes(step.kind) ? 'guard_facts' : 'value_facts'),
          views: { flow: { procedure: step.procedure, nodeId: step.nodeId } } });
      }); });
      var assumptions = result.assumptions;
      return Object.assign(result, envelope(prepared), { assumptions: assumptions });
    }
    // Both observers reserve generated owner/source metadata through their core.
    async function enrichBoundedStep(step, retain) {
        var entry = valueIndex.procedures.get(step.sourceProcedure), raw = entry && entry.raw;
        var a = raw && raw.attributes || {}, owner = entry && entry.procedure || {};
        // Preflight variable-size metadata before inspecting paths or retaining
        // derived copies. The core owns work/bytes/time/cancellation throughout.
        var metadata = await retain({ span: step.source || source(raw),
          sourceAbsolute: typeof a.source_absolute === 'string' ? a.source_absolute : null,
          targetSource: typeof a.target_src_path === 'string' ? a.target_src_path : null,
          identity: { rawNodeId: raw && raw.id || null, procedureId: owner.id || null,
            functionId: owner.function_id || null, packageId: owner.package_id || null,
            buildUnitId: typeof a.unit_key === 'string' ? a.unit_key : null,
            sourceDigest: typeof a.source_digest === 'string' && a.source_digest.length === 16 && /^[0-9a-f]{16}$/i.test(a.source_digest) ? a.source_digest : null,
            sourceDigestAlgorithm: 'fnv1a-64' } });
        var span = metadata.span, absolute = null, identity = metadata.identity;
        if (typeof span.source_file === 'string' && span.source_file.startsWith('/')) absolute = span.source_file;
        if (!absolute && raw && span.source_file === raw.source_file && metadata.sourceAbsolute && metadata.sourceAbsolute.startsWith('/')) absolute = metadata.sourceAbsolute;
        if (!absolute && metadata.targetSource && metadata.targetSource.startsWith('/') && span.source_file &&
            (metadata.targetSource === span.source_file || metadata.targetSource.endsWith('/' + span.source_file))) absolute = metadata.targetSource;
        identity.unknownFields = Object.keys(identity).filter(function (k) { return identity[k] == null; });
        return Object.assign({}, step, { source: Object.assign({}, span, { absolute_file: absolute }), sourceIdentity: identity,
          identity: identity, evidencePath: raw && rawPaths.get(raw.id) + '/attributes/flow#' + (step.kind === 'edge' ? 'blocks' : 'value_facts'),
          views: { flow: { procedure: step.procedure, nodeId: step.nodeId } } });
    }
    async function analyzeResources(prepared, runtime) {
      if (prepared.request.op !== 'resourceRisks') fail('INVALID_REQUEST', 'analyzeResources requires resourceRisks');
      var result = await Resources.analyze(resources(), prepared.request, runtime, enrichBoundedStep);
      return Object.assign(result, envelope(prepared), { assumptions: result.assumptions });
    }
    async function analyzeFailures(prepared, runtime) {
      if (prepared.request.op !== 'failureObligations') fail('INVALID_REQUEST', 'analyzeFailures requires failureObligations');
      var result = await Failures.analyze(failures(), prepared.request, runtime, enrichBoundedStep);

      var assumptions = result.assumptions;
      return Object.assign(result, envelope(prepared), { assumptions: assumptions });
    }
    var programs = null;
    function programEngine() {
      if (!Programs) fail('UNSUPPORTED_PROGRAM_QUERY', 'Program query module is not loaded');
      if (!programs) programs = Programs.create({ values: values(), guards: guards(), capture: identity, versions: VERSIONS, rawPaths: rawPaths, buildContext: {status:programBuildRecords.length?'captured':'unavailable',records:programBuildRecords,missing:programBuildRecords.length?[]:['capture_provenance_v1 build/tree context was not captured'],provenance:provenance}, digest: function (v) { return digest(v, true); } });
      return programs;
    }
    return { graph: { ...identity }, model: model, provenance: provenance, prepare: prepare, envelope: envelope,
      queryProgram: function (request, runtime) { return programEngine().query(request, runtime); },
      programCapability: function () { return programEngine().capability(); },
      describe: describe, analyze: analyze, analyzeOrdered: analyzeOrdered, analyzeValues: analyzeValues, analyzeGuards: analyzeGuards, analyzeFailures: analyzeFailures, analyzeResources: analyzeResources,
      get valueCapability() { return values().capability; },
      get guardCapability() { return guards().capability; },
      get failureCapability() { return clone(failures().capability); },
      get resourceCapability() { return clone(resources().capability); } };
  }
  return { VERSION: VERSION, VERSIONS: VERSIONS, DEFAULT_MS: DEFAULT_MS, MAX_MS: MAX_MS,
    hasher: hasher, validateGraph: validateGraph, normalize: normalize, digest: function (v) { return digest(v, true); }, create: create };
});
