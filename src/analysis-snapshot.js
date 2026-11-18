/* Portable, bounded side exports. All semantic evidence comes from existing public engines. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./analysis-evidence.js') : root.AnalysisEvidence,
    common ? require('./execution-flow.js') : root.ExecutionFlow, common ? require('./execution-model.js') : root.ExecutionModel,
    common ? require('./call-graph.js') : root.CallGraph, common ? require('./entry-effects.js') : root.EntryEffects,
    common ? require('./call-paths.js') : root.CallPaths, common ? require('./advisory-exposure.js') : root.AdvisoryExposure,
    common ? require('./supply-chain.js') : root.SupplyChain);
  if (common) module.exports = api;
  root.AnalysisSnapshot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Evidence, Flow, Model, CallGraph, Effects, Paths, Advisories, Supply) {
  'use strict';
  var VERSION = 'revision-side-v1';
  var LIMITS = { maxWork: 2000000, maxRetainedBytes: 33554432, maxOutputBytes: 8388608 };
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  // JSON strings can expand to six ASCII bytes per UTF-16 code unit. Count
  // escaped UTF-8 wire bytes separately from retained UTF-16 allocation below.
  function stringBytes(value, limit) {
    var size = 2;
    if (limit != null && value.length + 2 > limit) fail('REVISION_BUDGET','Revision input/output byte limit reached');
    for (var i = 0; i < value.length; i++) {
      var c = value.charCodeAt(i);
      if (c === 34 || c === 92 || [8,9,10,12,13].includes(c)) size += 2;
      else if (c < 32) size += 6;
      else if (c < 128) size++;
      else if (c < 2048) size += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i+1 < value.length && value.charCodeAt(i+1) >= 0xDC00 && value.charCodeAt(i+1) <= 0xDFFF) { size += 4; i++; }
      else size += c >= 0xD800 && c <= 0xDFFF ? 6 : 3;
      if (limit != null && size > limit) fail('REVISION_BUDGET', 'Revision input/output byte limit reached');
    }
    return size;
  }
  function scalarBytes(v, limit) { return typeof v === 'string' ? stringBytes(v,limit) : v === null ? 4 : typeof v === 'number' ? String(v).length : typeof v === 'boolean' ? (v ? 4 : 5) : 2; }
  // Dispatch has an atomic ownership boundary. Admit before the bounded native
  // JSON clone; later cooperative work never reads mutable caller request objects.
  function dispatchCopy(value, limit) {
    var bytes=0,work=0,ancestors=new Set();
    function visit(v,depth){if(depth>40||++work>250000)fail('REVISION_BUDGET','Revision dispatch structure limit reached');
      bytes+=scalarBytes(v,limit-bytes);if(bytes>limit)fail('REVISION_BUDGET','Revision input/output byte limit reached');
      if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
      if(!v||typeof v!=='object'||ancestors.has(v))fail('INVALID_REQUEST','request must be JSON serializable');ancestors.add(v);
      var keys=Object.keys(v);if(keys.length>100000)fail('REVISION_BUDGET','Revision dispatch key limit reached');
      for(var k of keys){if(k==='__proto__'||k==='constructor'||k==='prototype')fail('INVALID_REVISION','Unsafe JSON key');if(v[k]===undefined&&!Array.isArray(v))continue;bytes+=1+(Array.isArray(v)?0:stringBytes(k,limit-bytes)+1);if(bytes>limit)fail('REVISION_BUDGET','Revision input/output byte limit reached');visit(v[k]===undefined?null:v[k],depth+1);}
      ancestors.delete(v);
    }
    visit(value,0);return JSON.parse(JSON.stringify(value));
  }
  // Registration owns a full immutable capture once. It is separate from the
  // small per-query budgets; neither callers nor transport/model aliases receive
  // this raw/index state. Scoped queries reuse it without full rehash/rebuild.
  var captures = new WeakMap();
  function captureRequest(request) {
    exactKeys(request,['op','raw','maxCaptureBytes'],'capture registration');
    var limit=request.maxCaptureBytes==null?536870912:request.maxCaptureBytes;
    if (!Number.isSafeInteger(limit)||limit<1||limit>1073741824) fail('INVALID_BUDGET','Capture admission requires 1..1073741824 bytes');
    var raw=request.raw;
    if (typeof raw!=='string') fail('INVALID_REVISION','Capture registration requires raw JSON text');
    if (raw.length>limit) fail('REVISION_BUDGET','Capture text exceeds admission bytes');
    var size=0;
    for (var i=0;i<raw.length;i++) {
      var c=raw.charCodeAt(i);
      if(c<128)size++;else if(c<2048)size+=2;
      else if(c>=0xD800&&c<=0xDBFF&&i+1<raw.length&&raw.charCodeAt(i+1)>=0xDC00&&raw.charCodeAt(i+1)<=0xDFFF){size+=4;i++;}else size+=3;
      if(size>limit)fail('REVISION_BUDGET','Capture text exceeds admission bytes');
    }
    return {op:'registerRevisionCapture',raw:raw,maxCaptureBytes:limit};
  }
  function captureHash(token) {
    var context=captures.get(token);
    if(!context)fail('CAPTURE_UNAVAILABLE','Capture admission token is unavailable');
    return context.core.graph.contentSha256;
  }
  function admitCapture(raw, options) {
    options = options || {};
    var ceiling = options.maxCaptureBytes == null ? 536870912 : options.maxCaptureBytes;
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 1073741824) fail('INVALID_BUDGET','Capture admission requires 1..1073741824 bytes');
    var used = 0, values = 0, ancestors = new Set();
    function own(v, depth) {
      if (++values > 16000000 || depth > 40) fail('REVISION_BUDGET','Capture admission structure limit reached');
      used += scalarBytes(v,ceiling-used);
      if (used > ceiling) fail('REVISION_BUDGET','Capture admission byte limit reached');
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
      if (!v || typeof v !== 'object' || ancestors.has(v)) fail('INVALID_GRAPH','Capture must be JSON');
      ancestors.add(v); var out = Array.isArray(v) ? [] : {}, keys = Object.keys(v);
      if (keys.length > 1000000) fail('REVISION_BUDGET','Capture admission collection limit reached');
      for (var key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('INVALID_GRAPH','Unsafe capture key');
        if (v[key] === undefined && !Array.isArray(v)) continue;
        used += 1 + (Array.isArray(v) ? 0 : stringBytes(key,ceiling-used)+1);
        out[key] = own(v[key] === undefined ? null : v[key],depth+1);
      }
      ancestors.delete(v); return Object.freeze(out);
    }
    if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length > 200000 || !Array.isArray(raw.edges) || raw.edges.length > 1000000) fail('REVISION_BUDGET','Capture admission node/edge limit reached');
    var graph = own(raw,0); Evidence.validateGraph(graph);
    var model = Model.build(graph), core = Evidence.create(graph,{ model:model, sha256:options.sha256==null?undefined:own(options.sha256,0), source:options.source==null?null:own(options.source,0) });
    var flow = Flow.catalog(graph); Flow.applyModelTargets(flow,model);
    var calls = CallGraph.build(graph,flow), catalog = Supply.build(graph);
    var effects = Effects.build(graph,{flow:flow,model:model,callGraph:calls,catalog:catalog});
    var paths = Paths.create(graph,{model:model,callGraph:calls});
    var advisories = Advisories.create(graph,{paths:paths,entries:effects.entries,buildExecution:effects.buildExecution,entryCoverage:effects.coverage,digest:Evidence.digest});
    var token = Object.freeze({});
    captures.set(token,{raw:graph,model:model,core:core,flow:flow,calls:calls,catalog:catalog,effects:effects,paths:paths,advisories:advisories,rawById:new Map(graph.nodes.map(function(n){return [n.id,n];}))});
    return token;
  }
  function session(options, runtime) {
    options = options || {}; runtime = runtime || {};
    var limits = Object.assign({}, LIMITS, options.budgets || {}), work = 0, bytes = 0;
    Object.keys(limits).forEach(function (k) { if (!LIMITS[k] || !Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > LIMITS[k]) fail('INVALID_BUDGET', k + ' exceeds revision limits'); });
    var timeout = options.timeoutMs == null ? 5000 : options.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) fail('INVALID_TIMEOUT', 'timeoutMs requires 1..5000');
    var now = runtime.now || Date.now, start = now(), lastYield = 0;
    function check() {
      if (runtime.cancelled && runtime.cancelled()) fail('CANCELLED', 'Revision work cancelled; no complete comparison');
      if (now() - start >= timeout) fail('TIMEOUT', 'Revision time budget reached; no complete comparison');
    }
    async function tick(size) {
      check(); work++; bytes += size || 0;
      if (work > limits.maxWork || bytes > limits.maxRetainedBytes) fail('REVISION_BUDGET', 'Revision work/retained-byte budget reached; evidence is incomplete');
      if (work - lastYield >= 128) { lastYield = work; await new Promise(function (resolve) { setTimeout(resolve, 0); }); check(); }
    }
    async function copy(value, maxBytes) {
      var used = 0, ancestors = new Set();
      async function walk(v, depth) {
        if (depth > 40) fail('INVALID_REVISION', 'Revision JSON depth exceeds 40');
        var size = typeof v === 'string' ? v.length * 2 + 4 : 16;
        used += scalarBytes(v,maxBytes ? maxBytes-used : null); if (maxBytes && used > maxBytes) fail('REVISION_BUDGET', 'Revision input/output byte limit reached');
        await tick(size);
        if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)) return v;
        if (!v || typeof v !== 'object' || ancestors.has(v)) fail('INVALID_REQUEST', 'request must be JSON serializable');
        if (Array.isArray(v) && v.length > 100000) fail('REVISION_BUDGET', 'Revision array limit reached');
        ancestors.add(v); var out = Array.isArray(v) ? [] : {}, keys = Object.keys(v);
        if (keys.length > 100000) fail('REVISION_BUDGET', 'Revision object limit reached');
        for (var key of keys) {
          if(v[key]===undefined&&!Array.isArray(v))continue;
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('INVALID_REVISION', 'Unsafe JSON key');
          used += 1 + (Array.isArray(v) ? 0 : stringBytes(key,maxBytes ? maxBytes-used : null) + 1); if (maxBytes && used > maxBytes) fail('REVISION_BUDGET', 'Revision input/output byte limit reached');
          await tick(key.length * 2 + 6); out[key] = await walk(v[key]===undefined?null:v[key], depth + 1);
        }
        ancestors.delete(v); return out;
      }
      return await walk(value, 0);
    }
    async function hash(v) {
      var h = Evidence.hasher();
      async function quote(str) {
        h.update('"');
        for(var offset=0;offset<str.length;){await tick();var end=Math.min(offset+2048,str.length);if(end<str.length&&/[\uD800-\uDBFF]/.test(str[end-1]))end--;
          h.update(JSON.stringify(str.slice(offset,end)).slice(1,-1));offset=end;
        }
        h.update('"');
      }
      async function visit(x) {
        await tick();
        if(typeof x==='string'){await quote(x);return;}
        if (!x || typeof x !== 'object') { h.update(JSON.stringify(x)||'null'); return; }
        var array = Array.isArray(x), keys = array ? null : Object.keys(x).filter(function(k){return x[k]!==undefined;}).sort(); h.update(array ? '[' : '{');
        for (var i = 0; i < (array ? x.length : keys.length); i++) {
          if (i) h.update(','); if (!array) {await quote(keys[i]);h.update(':');}
          await visit(array ? x[i] : x[keys[i]]);
        }
        h.update(array ? ']' : '}');
      }
      await visit(v); return h.digest('hex');
    }
    return { charge: async function (amount) { if(Number.isSafeInteger(amount)&&amount>0){work+=amount;await tick();} }, tick: tick, copy: copy, hash: hash, check: check, limits: limits, resolveCapture: runtime.resolveCapture,
      pause: async function () { await new Promise(function (resolve) { setTimeout(resolve, 0); }); check(); },
      runtime: { cancelled: function () { check(); return false; } },
      stats: function () { return { work: work, retainedBytes: bytes, limits: limits, timeoutMs: timeout }; } };
  }
  function exactKeys(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (k) { return !keys.includes(k); })) fail('INVALID_REVISION', name + ' has unsupported fields');
  }
  function declaration(value) {
    value = value || {}; exactKeys(value, ['revision', 'configuration'], 'declaration');
    if (value.revision != null) {
      exactKeys(value.revision, ['value', 'provenance'], 'declared revision');
      if (typeof value.revision.value !== 'string' || !value.revision.value || typeof value.revision.provenance !== 'string' || !value.revision.provenance) fail('INVALID_REVISION', 'Declared revision needs value and provenance');
    }
    if (value.configuration != null) {
      exactKeys(value.configuration, ['target', 'features', 'toolchain', 'provenance'], 'declared configuration');
      if (!['target', 'toolchain', 'provenance'].every(function (k) { return typeof value.configuration[k] === 'string' && value.configuration[k]; }) ||
          !Array.isArray(value.configuration.features) || !value.configuration.features.every(function (v) { return typeof v === 'string'; })) fail('INVALID_REVISION', 'Declared configuration needs target/features/toolchain/provenance');
    }
    return value;
  }
  // Absence is usable only within a completed, unpaged, explicitly supported result.
  async function complete(result, s) {
    if (!result || result.error || result.partialCoverage === true || ['indeterminate','cancelled','unknown'].includes(result.status)) return false;
    if (result.completion && (result.completion.complete === false || result.completion.evidenceComplete === false || result.completion.budgetExceeded || result.completion.timedOut || result.completion.cancelled)) return false;
    var valid = true;
    async function visit(v) {
      await s.tick(); if (!v || typeof v !== 'object') return;
      if (v.truncated === true || v.offset > 0 || v.partial === true || v.catalogIncomplete === true || v.bodyStatus === 'unavailable') valid = false;
      for (var key of Object.keys(v)) await visit(v[key]);
    }
    // Request/replay are inputs, not coverage. Unknown model fields aren't silently completed.
    for (var k of ['queryCoverage','coverage','entryEffectCoverage','buildExecutionCoverage','entries','effects','witnesses','findings','inventory','units','relationships']) if (result[k]) await visit(result[k]);
    return valid;
  }
  async function build(input, s) {
    exactKeys(input, ['graph','capture','declaration','queries','selection'], 'side input');
    if (!!input.graph === !!input.capture) fail('INVALID_REVISION', 'Side needs exactly one bundled graph or capture reference');
    var token = input.capture && s.resolveCapture && await s.resolveCapture(input.capture.contentSha256), context = token && captures.get(token), graph = input.graph || context && context.raw;
    if (!graph) fail('CAPTURE_UNAVAILABLE', 'Referenced capture is unavailable; saved findings are not evidence');
    if (!Array.isArray(graph.nodes) || graph.nodes.length > 200000 || !Array.isArray(graph.edges) || graph.edges.length > 1000000) fail('REVISION_BUDGET', 'Capture exceeds finite 200000-node / 1000000-edge admission ceilings');
    if (input.capture) { exactKeys(input.capture, ['contentSha256'], 'capture reference'); if (context.core.graph.contentSha256 !== input.capture.contentSha256) fail('CAPTURE_MISMATCH', 'Referenced capture content changed'); }
    var selection = input.selection || {}; exactKeys(selection, ['function','scope','phase'], 'selection');
    declaration(input.declaration); var queries = input.queries || [];
    if (!Array.isArray(queries) || queries.length > 32) fail('INVALID_REVISION', 'Side accepts at most 32 explicit queries');
    var keys = new Set();
    for (var item of queries) {
      exactKeys(item, ['key','request'], 'side query');
      if (typeof item.key !== 'string' || !item.key || item.key.startsWith('$') || keys.has(item.key)) fail('INVALID_REVISION', 'Query keys must be unique, nonempty and not reserved');
      keys.add(item.key);
      if (!item.request || !['effectPaths','callPaths','advisoryExposure','guardObligations','failureObligations','resourceRisks'].includes(item.request.op)) fail('INVALID_REVISION', 'Unsupported side query operation');
    }
    // Existing engine constructors are synchronous. Their bounded input is admitted
    // before construction; yield/check between each existing public build phase.
    await s.tick(); if (!context) Evidence.validateGraph(graph);
    await s.pause(); var model = context && context.model || Model.build(graph); await s.pause();
    var core = context && context.core || Evidence.create(graph, { model: model }); await s.pause();
    var flow = context && context.flow || Flow.catalog(graph); if (!context) Flow.applyModelTargets(flow, model); await s.pause();
    var calls = context && context.calls || CallGraph.build(graph, flow); await s.pause();
    var catalog = context && context.catalog || Supply.build(graph), effects = context && context.effects || Effects.build(graph, { flow: flow, model: model, callGraph: calls, catalog: catalog }); await s.pause();
    var paths = context && context.paths || Paths.create(graph, { model: model, callGraph: calls }); await s.pause();
    var advisories = context && context.advisories || Advisories.create(graph, { paths: paths, entries: effects.entries, buildExecution: effects.buildExecution, entryCoverage: effects.coverage, digest: Evidence.digest });
    var operations = [];
    async function run(key, request) {
      await s.tick(); var prepared = core.prepare(request), op = prepared.request.op, result;
      if (['entrypoints','effects','effectPaths','buildInventory'].includes(op)) result = effects.query(request, core, { packageIds: prepared.request.scope ? catalog.scope(prepared.request.scope).packageIds : null });
      else if (op === 'callPaths') result = await paths.query(request, core, s.runtime);
      else if (op === 'advisoryExposure') result = await advisories.query(request, core, s.runtime);
      else result = await core[{guardObligations:'analyzeGuards',failureObligations:'analyzeFailures',resourceRisks:'analyzeResources'}[op]](prepared, s.runtime);
      if(result.completion)await s.charge(result.completion.work||0);
      result = await s.copy(result, 2097152);
      operations.push({ key: key, operation: op, requestHash: await s.hash(result.request), modelHash: await s.hash(result.request.model || result.request.snapshot || null), complete: await complete(result, s), result: result });
    }
    await run('$entries', Object.assign({ op: 'entrypoints', page: { limit: 100 } }, selection));
    await run('$effects', Object.assign({ op: 'effects', page: { limit: 100 } }, selection));
    await run('$build', Object.assign({ op: 'buildInventory', page: { limit: 100 } }, selection));
    // Existing effect routes supply callers, exact source witnesses and coverage.
    var entryRows = operations[0].result.entries.items;
    for (var i = 0; i < Math.min(32, entryRows.length); i++) await run('$route:' + entryRows[i].id, Object.assign({}, selection, { op: 'effectPaths', entryId: entryRows[i].id, page: { limit: 100 } }, { function: undefined }));
    for (var q of queries) await run(q.key, q.request);
    var identityCoverageIncomplete=false;
    var definitions = [], rawById = context ? context.rawById : new Map(), claims = new Map(), selectedPackages = selection.scope ? catalog.scope(selection.scope).packageIds : null;
    if (!context) for (var rawNode of graph.nodes) { await s.tick(); rawById.set(rawNode.id, rawNode); }
    for (var n of graph.nodes) {
      await s.tick(); var a = n.attributes || {}; if (a.kind !== 'flow_function' || selectedPackages && !selectedPackages.includes(a.package_id)) continue;
      if(typeof a.flow==='string'&&a.flow.length*2>1048576){identityCoverageIncomplete=true;continue;}
      await s.tick(typeof a.flow==='string'?a.flow.length*2:0);
      var body; try { body = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; } catch (_) { continue; }
      if (!body || typeof body.function !== 'string') continue;
      if (!claims.has(body.function)) claims.set(body.function, []); claims.get(body.function).push({raw:n,body:body});
    }
    for (var p of model.procedures) {
      await s.tick(); if (selection.function && ![p.id,p.symbol_id,p.function_id].includes(selection.function) || selectedPackages && !selectedPackages.includes(p.package_id)) continue;
      if (definitions.length >= 2000) break;
      var matches = (claims.get(p.id) || []).filter(function (c) { var a = c.raw.attributes;
        return (a.symbol_id || null) === p.symbol_id && (c.body.function_id || null) === p.function_id && (a.package_id || null) === p.package_id && (a.capture_scope || null) === p.capture_scope;
      });
      var raw = matches.length === 1 ? matches[0].raw : null, attrs = raw && raw.attributes || {}, symbol = rawById.get(p.symbol_id), sa = symbol && symbol.attributes || {};
      var identity = core.describe(null, raw && raw.id); identity.procedureId = p.id;
      identity.functionId = raw ? p.function_id || attrs.function_id || null : null;
      var scope = { packageId: p.package_id || null, buildUnitId: attrs.unit_key || null, captureScope: p.capture_scope || null,
        targetName: attrs.target_name || null, targetKind: attrs.target_kind || null, targetTriple: attrs.target_triple || null };
      // Do not use projection ID, name, source line, digest or body similarity as a cross-revision key.
      var original = attrs.original_symbol_id || sa.original_symbol_id || null;
      var matchKey = raw && identity.functionId && original && Object.values(scope).every(Boolean) ? await s.hash({ functionId: identity.functionId, originalSymbolId: original, scope: scope }) : null;
      definitions.push({ procedure: p.id, nodeId: symbol ? symbol.id : raw && raw.id || null, identity: identity, scope: scope, originalSymbolId: original,
        matchKey: matchKey, source: { source_file: raw && raw.source_file || null, source_location: raw && raw.source_location || null,
          absolute_file: attrs.source_absolute || null }, displayPath: p.display_path || p.id });
    }
    var captureContexts = [];
    for(var captureNode of graph.nodes){await s.tick();var ca=captureNode.attributes||{};
      if(ca.kind!=='crate'||ca.capture_provenance_v1==null||selectedPackages&&!selectedPackages.includes(ca.package_id))continue;
      if(captureContexts.length>=2000)fail('REVISION_BUDGET','Capture-context record limit reached');
      var contextRecord;try{contextRecord=JSON.parse(ca.capture_provenance_v1);}catch(_){contextRecord=null;}
      var valid=contextRecord&&contextRecord.schemaVersion===1&&contextRecord.producer==='build-graph-cli-local-context-v1'&&contextRecord.basis==='observed-local-process'&&contextRecord.scope&&contextRecord.scope.packageId===ca.package_id&&contextRecord.git&&contextRecord.git.before&&contextRecord.git.after&&contextRecord.build&&contextRecord.build.completeInputs===false;
      if(valid)for(var state of [contextRecord.git.before,contextRecord.git.after])if(state.treeOid!=null&&(!['sha1','sha256'].includes(state.objectFormat)||typeof state.treeOid!=='string'||!(state.objectFormat==='sha256'?/^[a-f0-9]{64}$/:/^[a-f0-9]{40}$/).test(state.treeOid)))valid=false;
      captureContexts.push(valid?{packageId:ca.package_id,basis:'captured-local-context',record:contextRecord,buildFingerprint:await s.hash(contextRecord.build),buildFingerprintAlgorithm:'sha256/canonical-json-v1',completeCompilerInputs:false}:{packageId:ca.package_id,basis:'invalid-or-unavailable',record:null,buildFingerprint:null});
    }
    var envelope = core.envelope(core.prepare({ op: 'capabilities' }));
    var evidence = { graph: core.graph, provenance: envelope.provenance, versions: envelope.versions,
      analysisVersionHash: await s.hash(envelope.versions), declaration: input.declaration || {}, captureContexts: captureContexts, definitions: definitions, operations: operations,
      packages: [], dependencies: [], packageCoverage: catalog.coverage, identityCoverageIncomplete:identityCoverageIncomplete, definitionsTruncated: !selection.function && definitions.length >= 2000,
      captureCoverage: model.coverage, routeInventoryComplete: entryRows.length <= 32 && operations[0].complete };
    for (var pack of catalog.packages) { await s.tick(); if (!selectedPackages || selectedPackages.includes(pack.id)) { if (evidence.packages.length >= 2000) { evidence.packagesTruncated = true; break; } evidence.packages.push(pack); } }
    for (var dep of catalog.dependencies) { await s.tick(); if (!selectedPackages || selectedPackages.includes(dep.source) || selectedPackages.includes(dep.target)) { if (evidence.dependencies.length >= 5000) { evidence.dependenciesTruncated = true; break; } evidence.dependencies.push(dep); } }
    var snapshot = { schemaVersion: 1, version: VERSION, input: input, inputHash: await s.hash(input), evidence: evidence, evidenceHash: await s.hash(evidence) };
    snapshot.contentHash = await s.hash({ version: VERSION, inputHash: snapshot.inputHash, evidenceHash: snapshot.evidenceHash });
    return snapshot;
  }
  async function exportSide(input, options, runtime, shared) {
    var s = shared || session(options, runtime), admitted = await s.copy(dispatchCopy(input,4194304), 4194304), result = await build(admitted, s);
    return await s.copy(result, s.limits.maxOutputBytes);
  }
  async function importSide(snapshot, s) {
    exactKeys(snapshot, ['schemaVersion','version','input','inputHash','evidence','evidenceHash','contentHash'], 'side snapshot');
    if (snapshot.schemaVersion !== 1 || snapshot.version !== VERSION) fail('VERSION_MISMATCH', 'Unsupported revision snapshot version');
    if (await s.hash(snapshot.input) !== snapshot.inputHash || await s.hash(snapshot.evidence) !== snapshot.evidenceHash ||
        await s.hash({ version: VERSION, inputHash: snapshot.inputHash, evidenceHash: snapshot.evidenceHash }) !== snapshot.contentHash) fail('SNAPSHOT_MISMATCH', 'Revision snapshot content binding failed');
    // Digest is integrity, never producer authenticity. Recompute the public engines.
    var fresh = await build(snapshot.input, s);
    if (fresh.evidenceHash !== snapshot.evidenceHash) fail('VERSION_MISMATCH', 'Saved evidence differs from current public engines; export again');
    return fresh;
  }
  return { VERSION: VERSION, LIMITS: LIMITS, dispatchCopy: dispatchCopy, admitCapture: admitCapture, captureRequest:captureRequest, captureHash:captureHash, session: session, exportSide: exportSide, importSide: importSide, complete: complete, fail: fail };
});
