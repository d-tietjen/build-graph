/* Optional local measurements. No profiler, workload execution, or network access. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./analysis-evidence.js') : root.AnalysisEvidence,
    common ? require('./analysis-snapshot.js') : root.AnalysisSnapshot);
  if (common) module.exports = api;
  root.PerformanceMeasurements = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Evidence, Snapshot) {
  'use strict';
  var VERSION = 'local-performance-v1', INPUT_BYTES = 8388608, SOURCE_BYTES = 4194304;
  var LIMITS = { maxWork: 2000000, maxOutputBytes: 33554432, maxRetainedBytes: 67108864 };
  var OPS = ['importMeasurements', 'loadMeasurements', 'compareMeasurements'];
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function copy(v, bytes) { try{return Snapshot.dispatchCopy(v,bytes||INPUT_BYTES);}catch(error){if(error.code==='REVISION_BUDGET')fail('MEASUREMENT_BUDGET','Measurement JSON admission byte/value/depth limit reached');if(error.code==='INVALID_REVISION')fail('INVALID_MEASUREMENTS','Unsafe measurement JSON key');throw error;} }
  function text(v) { return typeof v === 'string' && v.length > 0 && v.length <= 16384; }
  function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function hash(v) { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v); }
  function exactKeys(v, keys, label) {
    if (!object(v)) fail('INVALID_MEASUREMENTS', label + ' must be an object');
    Object.keys(v).forEach(function (key) { if (!keys.includes(key)) fail('INVALID_MEASUREMENTS', label + ': unsupported field ' + key); });
  }
  function finite(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
  function nonempty(v) { return v != null && (typeof v === 'string' ? !!v : object(v) ? Object.keys(v).length > 0 : false); }
  function requestLimits(request) {
    var incoming = request && request.op === 'replay' && request.replay ? request.replay.request : request;
    if (incoming && incoming.budgets != null && !object(incoming.budgets)) fail('INVALID_BUDGET', 'budgets must be an object');
    var limits = Object.assign({}, LIMITS, incoming && incoming.budgets || {});
    Object.keys(limits).forEach(function (key) { if (!LIMITS[key] || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > LIMITS[key]) fail('INVALID_BUDGET', 'Unsupported measurement budget ' + key); });
    return limits;
  }
  // Shared by core and browser ingress: admit the entire envelope before the
  // native ownership clone or any transport post. No caller reads cross a yield.
  function admitRequest(request) {
    var limits = requestLimits(request);
    return copy(request, Math.min(INPUT_BYTES, limits.maxRetainedBytes, limits.maxOutputBytes));
  }
  function timeout(request) {
    var value = request && request.timeoutMs;
    value = value == null ? 2000 : value;
    if (!Number.isSafeInteger(value) || value < 1 || value > 5000) fail('INVALID_TIMEOUT', 'timeoutMs requires 1..5000');
    return value;
  }
  function capability() { return { version: VERSION, operations: OPS.slice(), localOnly: true,
    formats: ['generic-benchmark-v1', 'criterion-json-v1 (Criterion 0.5.1 WallTime)', 'folded-stacks-v1'],
    inputBytes: INPUT_BYTES, sourceBytes: SOURCE_BYTES, maxSources: 64, maxRecords: 20000, maxFrames: 100000,
    maxStackDepth: 128, dispatchValues:250000, dispatchDepth:40, limits: copy(LIMITS), atomicAdmission: 'bounded caller JSON ownership, source JSON parsing and final ownership clone; cancellation before/after; existing function identity extraction is an atomic capture-owned boundary',
    cooperativeWork: 'wire bytes/keys, source/payload hashing, inner candidate joins, record/frame matching, aggregation and comparison',
    retainedAccounting: 'conservative cumulative serialized UTF-8 reservations before retained appends/clones, including repeated mappings and final response/replay occurrences; JS object overhead is additional',
    samplesAreInvocations: false, samplesAreElapsedTrace: false, missingSamplesProveUnused: false }; }
  function estimate(v, label) {
    exactKeys(v, ['value', 'confidenceInterval', 'standardError'], label);
    if (!finite(v.value)) fail('INVALID_MEASUREMENTS', label + '.value requires a finite nonnegative number');
    if (v.standardError != null && !finite(v.standardError)) fail('INVALID_MEASUREMENTS', label + '.standardError is invalid');
    var ci = v.confidenceInterval;
    if (ci != null) {
      exactKeys(ci, ['level', 'lower', 'upper'], label + '.confidenceInterval');
      if (!Number.isFinite(ci.level) || !(ci.level > 0 && ci.level < 1) || !finite(ci.lower) || !finite(ci.upper) || ci.lower > v.value || ci.upper < v.value)
        fail('INVALID_MEASUREMENTS', label + ' requires lower <= value <= upper and confidence level in (0,1)');
    }
    return v;
  }
  function selector(v) {
    exactKeys(v, ['nodeId', 'procedureId', 'functionId', 'buildUnitId'], 'target');
    if (!(v.nodeId || v.procedureId || v.functionId) || Object.values(v).some(function (x) { return !text(x); })) fail('INVALID_MEASUREMENTS', 'target requires exact nonempty node, procedure or function IDs');
    if (v.functionId && !v.buildUnitId) fail('INVALID_MEASUREMENTS', 'functionId requires buildUnitId');
    return v;
  }
  function normalize(request, current) {
    exactKeys(request, ['op', 'input', 'snapshot', 'before', 'after', 'subjectMappings', 'timeoutMs', 'budgets'], 'request');
    var q = Object.assign({}, request); // Never repair the saved request used for integrity.
    if (!OPS.includes(q.op)) fail('INVALID_REQUEST', 'Unknown measurement operation');
    q.timeoutMs = timeout(q);
    q.budgets = requestLimits(q);
    if (q.op === 'importMeasurements') {
      if (!object(q.input)) fail('INVALID_MEASUREMENTS', 'input is required');
      q.input = Object.assign({}, q.input);
      if (q.input.capture == null) q.input.capture = { contentSha256: current.contentSha256 };
    }
    return q;
  }
  function create(inputs) {
    // Engines already own the capture. Measurements retain only small exact identities,
    // lazily on first use, never a raw capture clone or a new graph admission limit.
    var current = copy(inputs.capture), rows = null, byNode, byProcedure, byFunction, directed;
    async function indexes(spend, reserve, keyFor) {
      if (rows) return;
      await spend(); var admitted = inputs.functions(), nextRows = [], nextNode = new Map(), nextProcedure = new Map(), nextFunction = new Map(), nextDirected = new Map();
      function add(map, key, r) { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(r); }
      for (var row of admitted) { await spend(); var r = {id:row.id,procedureId:row.procedureId||null,functionId:row.functionId||null,buildUnitId:row.buildUnitId||null,packageId:row.packageId||null,displayPath:row.displayPath||row.path||row.id};
        await reserve(r,true);nextRows.push(r);add(nextNode,r.id,r);add(nextProcedure,r.procedureId,r);add(nextFunction,r.functionId&&r.buildUnitId?await keyFor([r.functionId,r.buildUnitId]):null,r); }
      var uncertainSites=new Set();for(var c of inputs.calls||[]){await spend();if(c.possibleDispatch||c.callbackParameter!=null||c.unknown)uncertainSites.add(c.id);}
      // Multiple projection edges, candidate bindings and non-call references cannot
      // establish one exact directed call. Never infer a call from stack adjacency.
      for (var e of inputs.edges) { await spend();
        var key = await keyFor([e.source,e.target]);
        if (!nextDirected.has(key)) nextDirected.set(key, []);
        var uncertain=false;for(var site of e.callsites||[]){await spend();if(uncertainSites.has(site.id))uncertain=true;}
        var claim={kind:e.kind,referenceKind:e.referenceKind||null,uncertain:uncertain};await reserve(claim,true);nextDirected.get(key).push(claim);
      }
      // Publish only a complete private admission. Cancelled admissions retain none.
      byNode=nextNode;byProcedure=nextProcedure;byFunction=nextFunction;directed=nextDirected;rows=nextRows;
    }
    async function query(request, control) {
      control = control || {};
      // Bound the atomic caller-ownership clone by the caller's effective limits,
      // including replay. Never yield while reading caller-mutable objects.
      if (control.cancelled && control.cancelled()) fail('CANCELLED', 'Measurement operation cancelled');
      request = admitRequest(request);
      if (control.cancelled && control.cancelled()) fail('CANCELLED', 'Measurement operation cancelled');
      var replayed = request && request.op === 'replay', saved = replayed && request.replay;
      if (replayed) {
        if (!saved || saved.version !== VERSION || saved.schemaVersion !== 1 || !OPS.includes(saved.operation) || !hash(saved.requestHash) || !saved.request || saved.request.op !== saved.operation || saved.captureSha256 !== current.contentSha256)
          fail('INVALID_REPLAY', 'Measurement replay version, request hash or current capture pin differs');
        request = saved.request;
        if (request.op === 'importMeasurements' && (!object(request.input) || !object(request.input.capture) || !hash(request.input.capture.contentSha256)))
          fail('INVALID_REPLAY', 'Measurement replay requires its saved input capture pin');
      }
      // Separate accounting controls let the charged integrity walk inspect the
      // exact owned saved JSON before normalization adds or repairs any fields.
      var limits = requestLimits(request), timeoutMs = timeout(request);
      var started = Date.now(), work = 0, retained = 0, derived = 0, nextYield = 256, records = 0, frames = 0;
      function check() {
        if (control.cancelled && control.cancelled()) fail('CANCELLED', 'Measurement operation cancelled');
        if (Date.now() - started >= timeoutMs) fail('MEASUREMENT_TIMEOUT', 'Measurement timeout; no partial snapshot saved');
        if (work > limits.maxWork) fail('MEASUREMENT_BUDGET', 'Measurement work budget reached; no partial snapshot saved');
      }
      var taskChannel = null, taskResume = null, firstTask = true;
      // A real task turn lets timers and worker messages cancel promptly without
      // imposing a timer's minimum delay on every 256 units of useful work.
      function yieldTask() {
        // Keep the initial timer turn so an already queued cancellation timer
        // runs before a short hash finishes; later turns avoid the delay floor.
        if (firstTask) { firstTask = false; return new Promise(function (r) { setTimeout(r,0); }); }
        if (typeof setImmediate === 'function') return new Promise(function (r) { setImmediate(r); });
        if (typeof MessageChannel === 'function') {
          if (!taskChannel) { taskChannel = new MessageChannel(); taskChannel.port1.onmessage = function () { var resume = taskResume; taskResume = null; resume(); }; }
          return new Promise(function (r) { taskResume = r; taskChannel.port2.postMessage(null); });
        }
        return new Promise(function (r) { setTimeout(r,0); });
      }
      async function spend(n) { work += n == null ? 1 : n; check(); if (work >= nextYield) { nextYield = work + 256; await yieldTask(); check(); } }
      // Walk wire tokens without a JSON-sized string or clone. Repeated references
      // are charged on every occurrence. Reservation completes before publication
      // to a retained collection or the final ownership clone. The cumulative
      // reservation is conservative; it does not estimate JS heap/object overhead.
      async function wire(value, ceiling, reserve, hasher, transient) {
        var bytes = 0, values = 0;
        function token(value) {
          var size = 0;
          for (var i = 0; i < value.length; i++) { var c = value.charCodeAt(i);
            if (c < 128) size++; else if (c < 2048) size += 2;
            else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < value.length && value.charCodeAt(i+1) >= 0xDC00 && value.charCodeAt(i+1) <= 0xDFFF) { size += 4; i++; } else size += 3;
          }
          bytes += size;
          if (bytes > ceiling || reserve && (retained + size > limits.maxRetainedBytes || !transient && derived + size > limits.maxOutputBytes)) fail('MEASUREMENT_BUDGET','Measurement wire/retained byte budget reached; no partial snapshot saved');
          if (reserve) { retained += size; if(!transient)derived += size; }
          if (hasher) hasher.update(value);
        }
        async function quote(value) {
          token('"');
          for (var i = 0; i < value.length;) { var end = Math.min(i + 128, value.length);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end-1])) end--;
            await spend(); token(JSON.stringify(value.slice(i,end)).slice(1,-1)); i = end;
          }
          token('"');
        }
        async function visit(value, depth) {
          await spend();if(depth>40||++values>250000)fail('MEASUREMENT_BUDGET','Measurement JSON value/depth limit reached');
          if (typeof value === 'string') { await quote(value); return; }
          if (value === null || typeof value !== 'object') { token(JSON.stringify(value) || 'null'); return; }
          var array = Array.isArray(value); token(array ? '[' : '{'); var first = true;
          // Object.keys is bounded at atomic admission (or by generated limits).
          // Charge each key and child, including empty/undefined fields.
          var keys=Object.keys(value);if(keys.length>100000)fail('MEASUREMENT_BUDGET','Measurement collection limit reached');
          if(hasher&&!array){var sortWork=0;for(var key of keys){await spend();sortWork+=Math.max(1,Math.ceil(key.length/128));}
            await spend(sortWork*Math.max(1,Math.ceil(Math.log2(keys.length+1))));keys.sort();}
          for (var key of keys) { await spend(); if(key==='__proto__'||key==='constructor'||key==='prototype')fail('INVALID_MEASUREMENTS','Unsafe measurement JSON key');if (value[key] === undefined && !array) continue;
            if (!first) token(','); first = false;
            if (!array) { await quote(key); token(':'); }
            await visit(value[key] === undefined ? null : value[key],depth+1);
          }
          token(array ? ']' : '}');
        }
        await visit(value,0); check(); return bytes;
      }
      async function reserve(value, transient) { await wire(value, limits.maxRetainedBytes, true, null, transient); return value; }
      async function append(array, value) { await reserve(value); array.push(value); }
      async function digest(value) { var h = Evidence.hasher(); await wire(value, limits.maxRetainedBytes, false, h); return h.digest('hex'); }
      async function keyFor(value) { await wire(value,INPUT_BYTES,false);return JSON.stringify(value); }
      // One charged canonical request walk on both paths. Replay hashes the exact
      // saved JSON before any repair; fresh requests hash their normalized form.
      try {
      var q = replayed ? request : normalize(request, current), requestHash = await digest(q);
      if (replayed) {
        if (requestHash !== saved.requestHash) fail('INVALID_REPLAY', 'Measurement replay saved request hash differs');
        q = normalize(request, current);
        // These controls and the required import pin are the only defaults that
        // normalization can add. Reject repairs without another full hash walk.
        if (request.timeoutMs !== q.timeoutMs || !object(request.budgets) || Object.keys(LIMITS).some(function (key) { return request.budgets[key] !== q.budgets[key]; }))
          fail('INVALID_REPLAY', 'Measurement replay request is not normalized');
      }
      await reserve(q);
      async function resolve(target, mapped, captureMatches) {
        if (!captureMatches) return { status: 'capture-mismatch', target: target || null };
        if (!target) return { status: 'unmatched', reason: 'No exact identity or explicit mapping; labels are not ownership evidence' };
        selector(target);
        var bucket = target.nodeId ? byNode.get(target.nodeId) || [] : target.procedureId ? byProcedure.get(target.procedureId) || [] : byFunction.get(await keyFor([target.functionId,target.buildUnitId])) || [];
        var candidates = [];
        for (var r of bucket) { await spend();
          if ((!target.nodeId || r.id === target.nodeId) && (!target.procedureId || r.procedureId === target.procedureId) && (!target.functionId || r.functionId === target.functionId) && (!target.buildUnitId || r.buildUnitId === target.buildUnitId)) await append(candidates,r.id);
        }
        return candidates.length === 1 ? { status: mapped ? 'declared' : 'exact-id', node: byNode.get(candidates[0])[0],
          basis: mapped ? 'caller-declared mapping; not compiler-confirmed measurement ownership' : 'caller supplied exact captured IDs; measurement provenance remains imported' } :
          { status: candidates.length ? 'ambiguous' : 'unmatched', target: target, candidates: candidates };
      }
      async function textHash(value) {
        var h = Evidence.hasher();
        for (var i = 0; i < value.length;) { var end = Math.min(i + 16384,value.length); if (end < value.length && /[\uD800-\uDBFF]/.test(value[end-1])) end--;
          await spend(Math.ceil((end-i)/128)); h.update(value.slice(i,end)); i = end; }
        return h.digest('hex');
      }
      async function parsed(value, label) {
        if (typeof value !== 'string') fail('INVALID_MEASUREMENTS', label + ' requires original JSON text');
        await wire({text:value},SOURCE_BYTES,false); check();
        var out; try { out = JSON.parse(value); } catch (_) { fail('INVALID_MEASUREMENTS', label + ': malformed JSON'); }
        check(); await wire(out,SOURCE_BYTES,true,null,true); return out;
      }
      function record() { if (++records > 20000) fail('MEASUREMENT_BUDGET', 'At most 20000 benchmark/stack records are supported'); }
      async function sourcePins(sources) {
        var pins = [];
        for (var s of sources) { await spend(); if (!text(s.id) || typeof s.text !== 'string') fail('INVALID_MEASUREMENTS', 'Each source requires id and original text');
          await wire({text:s.text},SOURCE_BYTES,false); await append(pins,{id:s.id,sha256:await textHash(s.text)}); }
        return pins;
      }
      async function validateSnapshot(snapshot) {
        exactKeys(snapshot, ['schemaVersion','version','input','sourcePins','sha256'], 'snapshot');
        if (snapshot.schemaVersion !== 1 || snapshot.version !== VERSION || !hash(snapshot.sha256)) fail('INVALID_MEASUREMENTS', 'Unsupported measurement snapshot version');
        await spend();
        if (await digest({schemaVersion:1,version:VERSION,input:snapshot.input,sourcePins:snapshot.sourcePins}) !== snapshot.sha256) fail('MEASUREMENT_INTEGRITY', 'Snapshot payload hash differs');
        if (!snapshot.input || !Array.isArray(snapshot.input.sources)) fail('INVALID_MEASUREMENTS','Snapshot input sources are required');
        if (!Array.isArray(snapshot.sourcePins)) fail('MEASUREMENT_INTEGRITY', 'Original source pins are required');
        var plainPins=[]; for(var pin of snapshot.sourcePins){await spend();await append(plainPins,{id:pin.id,sha256:pin.sha256});}
        if (await digest(await sourcePins(snapshot.input.sources)) !== await digest(plainPins)) fail('MEASUREMENT_INTEGRITY', 'Original source text hash differs');
        check(); return snapshot.input;
      }
      async function importInput(input) {
        exactKeys(input, ['schemaVersion','capture','provenance','sources','mappings'], 'input');
        if (input.schemaVersion !== 1 || !object(input.capture) || !hash(input.capture.contentSha256)) fail('INVALID_MEASUREMENTS', 'input requires schemaVersion 1 and capture.contentSha256');
        if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 64) fail('INVALID_MEASUREMENTS','Provide 1..64 local sources');
        if (input.provenance != null && !object(input.provenance)) fail('INVALID_MEASUREMENTS','provenance must be an object');
        var matches = input.capture.contentSha256 === current.contentSha256, diagnostics = [], benchmarks = [], profiles = [], ids = new Set();
        var mappings = input.mappings || [], mappingIndex = new Map(), usedMappings = new Set();
        if (!Array.isArray(mappings) || mappings.length > 20000) fail('INVALID_MEASUREMENTS','mappings requires <=20000 records');
        for (var m of mappings) { await spend(); exactKeys(m,['sourceId','recordId','target','provenance'],'mapping');
          if (!text(m.sourceId) || !text(m.recordId) || !text(m.provenance)) fail('INVALID_MEASUREMENTS','mapping requires sourceId, exact recordId/frame text and provenance');
          selector(m.target); await wire(m,q.budgets.maxRetainedBytes,false); var mk=await keyFor([m.sourceId,m.recordId]); if(!mappingIndex.has(mk))mappingIndex.set(mk,[]);mappingIndex.get(mk).push(m); }
        if(matches&&mappings.length)await indexes(spend,reserve,keyFor);
        async function binding(s,id,target) {
          var declared=mappingIndex.get(await keyFor([s.id,id]))||[];
          for(var m of declared){await spend();usedMappings.add(m);}
          if(declared.length>1 || declared.length && target && await digest(declared[0].target)!==await digest(target)) return {status:'ambiguous',reason:'Conflicting explicit mappings/record identity',mappings:declared};
          var result=await resolve(declared.length?declared[0].target:target,!!declared.length,matches);
          if(declared.length)result.mapping=declared[0];return result;
        }
        async function bench(s,b) {
          await spend();record();exactKeys(b,['id','name','subject','method','input','unit','statistic','estimate','target','throughput','metadata'],'benchmark');
          if(!text(b.id)||!text(b.name)||!text(b.unit)||!['mean','median','slope','median_abs_dev','std_dev'].includes(b.statistic))fail('INVALID_MEASUREMENTS','benchmark needs id/name/unit and a supported statistic');
          if(b.subject!=null&&!text(b.subject))fail('INVALID_MEASUREMENTS','subject is an explicit stable continuity ID');
          if(b.throughput!=null){exactKeys(b.throughput,['perIteration','unit','format'],'throughput');if(!finite(b.throughput.perIteration)||!text(b.throughput.unit)||b.throughput.format!=null&&!text(b.throughput.format))fail('INVALID_MEASUREMENTS','throughput requires finite nonnegative perIteration and explicit unit');}
          if(b.target){selector(b.target);if(matches)await indexes(spend,reserve,keyFor);}
          estimate(b.estimate,'benchmark '+b.id);
          var row=Object.assign({sourceId:s.id},b,{binding:await binding(s,b.id,b.target)});await append(benchmarks,row);
        }
        var pins=await sourcePins(input.sources);
        for(var s of input.sources){await spend();exactKeys(s,['id','format','text','name','provenance','unit','weightKind','frameIdentities'],'source');
          if(ids.has(s.id))fail('INVALID_MEASUREMENTS','Duplicate source ID '+s.id);ids.add(s.id);
          if(s.format==='generic-benchmark-v1'){
            var generic=await parsed(s.text,s.id);exactKeys(generic,['schemaVersion','benchmarks'],'generic benchmark JSON');
            if(generic.schemaVersion!==1||!Array.isArray(generic.benchmarks))fail('INVALID_MEASUREMENTS','generic-benchmark-v1 requires schemaVersion 1 and benchmarks');
            for(var b of generic.benchmarks)await bench(s,b);
          }else if(s.format==='criterion-json-v1'){
            var bundle=await parsed(s.text,s.id);exactKeys(bundle,['criterionVersion','measurement','estimatesText','benchmarkText','subject'],'Criterion bundle');
            if(bundle.criterionVersion!=='0.5.1'||bundle.measurement!=='WallTime')fail('UNSUPPORTED_MEASUREMENTS','Only declared Criterion 0.5.1 WallTime estimates.json + benchmark.json are supported; custom units are not inferred');
            var es=await parsed(bundle.estimatesText,'estimates.json'),meta=await parsed(bundle.benchmarkText,'benchmark.json');
            exactKeys(es,['mean','median','median_abs_dev','slope','std_dev'],'Criterion estimates.json');
            exactKeys(meta,['group_id','function_id','value_str','throughput','full_id','directory_name','title'],'Criterion benchmark.json');
            if(!text(meta.group_id)||!text(meta.full_id)||!text(meta.directory_name)||!text(meta.title)||![meta.function_id,meta.value_str].every(function(x){return x===null||typeof x==='string';}))fail('INVALID_MEASUREMENTS','Criterion benchmark.json requires its complete 0.5.1 BenchmarkId fields');
            var throughput=null;
            if(meta.throughput!=null){exactKeys(meta.throughput,['Bytes','BytesDecimal','Elements'],'Criterion throughput');var tk=Object.keys(meta.throughput);if(tk.length!==1||!Number.isSafeInteger(meta.throughput[tk[0]])||meta.throughput[tk[0]]<0)fail('INVALID_MEASUREMENTS','Criterion throughput needs a nonnegative safe integer');throughput={perIteration:meta.throughput[tk[0]],unit:tk[0]==='Elements'?'elements':'bytes',format:tk[0]};}
            for(var statistic of ['mean','median','median_abs_dev','slope','std_dev']){
              await spend();var e=es[statistic];if(statistic==='slope'&&e===null)continue;
              exactKeys(e,['confidence_interval','point_estimate','standard_error'],'Criterion '+statistic);
              exactKeys(e.confidence_interval,['confidence_level','lower_bound','upper_bound'],'Criterion confidence_interval');
              await bench(s,{id:meta.full_id+':'+statistic,name:meta.full_id,subject:bundle.subject,method:{tool:'criterion',version:'0.5.1',measurement:'WallTime'},input:meta.value_str,unit:'ns/iteration',statistic:statistic,
                estimate:{value:e.point_estimate,standardError:e.standard_error,confidenceInterval:{level:e.confidence_interval.confidence_level,lower:e.confidence_interval.lower_bound,upper:e.confidence_interval.upper_bound}},throughput:throughput,metadata:meta});
            }
            pins.find(function(p){return p.id===s.id;}).files={estimatesSha256:await textHash(bundle.estimatesText),benchmarkSha256:await textHash(bundle.benchmarkText)};
          }else if(s.format==='folded-stacks-v1'){
            if(!text(s.unit)||!['samples','sampled-weight'].includes(s.weightKind)||s.weightKind==='samples'&&s.unit!=='samples')fail('INVALID_MEASUREMENTS','Folded source requires unit and weightKind samples (unit samples) or sampled-weight');
            var identities=s.frameIdentities||{};if(!object(identities))fail('INVALID_MEASUREMENTS','frameIdentities must be an object keyed by exact raw frame text');
            var profile={sourceId:s.id,unit:s.unit,weightKind:s.weightKind,total:0,stacks:[],nodes:[],edges:[],flame:[],inlining:'unknown unless frame metadata explicitly declares inline context'}, nodeWeights=new Map(),edgeWeights=new Map(),trie={children:new Map(),inclusive:0},lineNo=0;
            for(var line of s.text.split(/\r?\n/)){await spend();lineNo++;if(!line.trim()||line[0]==='#')continue;record();
              var match=/^(.+)\s+(\d+(?:\.\d+)?)$/.exec(line);if(!match)fail('INVALID_MEASUREMENTS','Folded line '+lineNo+' requires semicolon-separated frames followed by a positive weight');
              var weight=Number(match[2]),stack=match[1].split(';');
              if(!Number.isFinite(weight)||weight<=0||s.weightKind==='samples'&&!Number.isSafeInteger(weight)||stack.length>128||stack.some(function(f){return !text(f);}))fail('INVALID_MEASUREMENTS','Invalid weight/frame/depth at folded line '+lineNo);
              profile.total+=weight;if(!Number.isFinite(profile.total)||s.weightKind==='samples'&&!Number.isSafeInteger(profile.total))fail('MEASUREMENT_BUDGET','Folded total exceeds numeric precision');
              var resolved=[],seen=new Set(),pairSeen=new Set(),branch=trie;trie.inclusive+=weight;
              for(var i=0;i<stack.length;i++){await spend();if(++frames>100000)fail('MEASUREMENT_BUDGET','At most 100000 stack frames are supported');var f=stack[i],identity=Object.prototype.hasOwnProperty.call(identities,f)?identities[f]:null;
                if(identity){exactKeys(identity,['target','inlined','provenance'],'frame identity');selector(identity.target);if(!text(identity.provenance)||identity.inlined!=null&&typeof identity.inlined!=='boolean')fail('INVALID_MEASUREMENTS','Frame identity needs provenance and optional boolean inlined');if(matches)await indexes(spend,reserve,keyFor);}
                var bound=await binding(s,f,identity&&identity.target),r={frame:f,binding:bound,inlined:identity&&identity.inlined!=null?identity.inlined:null};await append(resolved,r);
                if(!branch.children.has(f)){await reserve(r,true);branch.children.set(f,{frame:f,binding:bound,inlined:r.inlined,children:new Map(),inclusive:0,exclusive:0});}branch=branch.children.get(f);branch.inclusive+=weight;if(i===stack.length-1)branch.exclusive+=weight;
                if(bound.node){var nid=bound.node.id,nw=nodeWeights.get(nid)||{node:bound.node,inclusive:0,exclusive:0,occurrenceWeight:0};nw.occurrenceWeight+=weight;if(!Number.isFinite(nw.occurrenceWeight)||s.weightKind==='samples'&&!Number.isSafeInteger(nw.occurrenceWeight))fail('MEASUREMENT_BUDGET','Recursive occurrence weights exceed numeric precision');if(!seen.has(nid)){nw.inclusive+=weight;seen.add(nid);}if(i===stack.length-1)nw.exclusive+=weight;if(!nodeWeights.has(nid))await reserve(nw);nodeWeights.set(nid,nw);}
                if(i>0){var a=resolved[i-1],key=a.binding.node&&bound.node?await keyFor([a.binding.node.id,bound.node.id]):null,claims=key&&directed&&directed.get(key),supported=key&&claims&&claims.length===1&&['call','recursion','native_call','boundary'].includes(claims[0].kind)&&!claims[0].referenceKind&&!claims[0].uncertain&&a.inlined===false&&r.inlined===false;
                  if(supported&&!pairSeen.has(key)){pairSeen.add(key);var ew=edgeWeights.get(key)||{source:a.binding.node.id,target:bound.node.id,sampledAdjacencyWeight:0};ew.sampledAdjacencyWeight+=weight;if(!edgeWeights.has(key))await reserve(ew);edgeWeights.set(key,ew);}
                  else if(!supported)await append(diagnostics,{sourceId:s.id,line:lineNo,from:a.frame,to:f,status:'sampled-adjacency-unattached',reason:'Mapping, inline/physical-frame evidence or one exact captured directed call is unavailable; no call timing/count inferred'});
                }
              }
              await reserve({line:lineNo,weight:weight});profile.stacks.push({line:lineNo,frames:resolved,weight:weight});
            }
            if(!profile.stacks.length)fail('INVALID_MEASUREMENTS','Folded source has no positive stack records');
            // Iterative layout retains recursion, alphabetic population order and context.
            var pending=[{node:trie,x:0,depth:-1,parent:null}],serial=0;
            while(pending.length){await spend();var item=pending.pop(),cursor=item.x,children=[],sortUnits=0;
              for(var child of item.node.children.values()){var units=Math.max(1,Math.ceil(child.frame.length/128));await spend(units);sortUnits+=units;children.push(child);}
              await spend(sortUnits*Math.max(1,Math.ceil(Math.log2(children.length+1))));children.sort(function(a,b){return a.frame<b.frame?-1:a.frame>b.frame?1:0;});
              if(item.depth>=0){var fid=serial++;await append(profile.flame,{id:fid,parent:item.parent,frame:item.node.frame,binding:item.node.binding,inlined:item.node.inlined,depth:item.depth,x:item.x,weight:item.node.inclusive,exclusive:item.node.exclusive});item.parent=fid;}
              var next=[];for(var child of children){await spend();next.push({node:child,x:cursor,depth:item.depth+1,parent:item.parent});cursor+=child.inclusive;}for(var j=next.length-1;j>=0;j--){await spend();pending.push(next[j]);}
            }
            profile.nodes=Array.from(nodeWeights.values());profile.edges=Array.from(edgeWeights.values());profiles.push(profile);
          }else fail('UNSUPPORTED_MEASUREMENTS','Unsupported source format '+s.format);
        }
        var duplicateBench=new Set();for(var b of benchmarks){await spend();var key=await keyFor([b.sourceId,b.id]);if(duplicateBench.has(key))fail('INVALID_MEASUREMENTS','Duplicate benchmark ID '+b.id);duplicateBench.add(key);}
        for(var m of mappings){await spend();if(!usedMappings.has(m))await append(diagnostics,{status:ids.has(m.sourceId)?'unmatched-mapping-record':'unmatched-mapping-source',mapping:m});}
        var payload={schemaVersion:1,version:VERSION,input:input,sourcePins:pins};
        await reserve(payload);var snapshot=Object.assign({},payload,{sha256:await digest(payload)});check();
        // Admit the complete reload envelope before calling this a saved snapshot.
        await wire({op:'loadMeasurements',snapshot:snapshot,timeoutMs:q.timeoutMs,budgets:q.budgets},INPUT_BYTES,false);
        return {snapshot:snapshot,benchmarks:benchmarks,profiles:profiles,diagnostics:diagnostics,
          coverage:{captureMatches:matches,mappedBenchmarks:benchmarks.filter(function(b){return !!b.binding.node;}).length,benchmarkCount:benchmarks.length,
            unknownProvenanceFields:['build','tree','workload','configuration','toolchain','machine','environment','recordedAt'].filter(function(key){return !nonempty((input.provenance||{})[key]);}),
            missingSamplesProveUnused:false,unmatchedAndInliningRemainUnknown:true},
          provenance:{imported:input.provenance||{},capture:input.capture,currentCapture:current,ownership:'imported IDs/mappings, not compiler-confirmed performance attribution'}};
      }
      async function loaded(snapshot){var imported=await importInput(await validateSnapshot(snapshot));if(imported.snapshot.sha256!==snapshot.sha256)fail('MEASUREMENT_INTEGRITY','Snapshot source file pins differ from their original text');return imported;}
      await spend();var data;
      if(q.op==='importMeasurements')data=await importInput(q.input);
      else if(q.op==='loadMeasurements')data=await loaded(q.snapshot);
      else {
        var before=await loaded(q.before),after=await loaded(q.after);
        var comparisons=[],unmatched=[],continuity=q.subjectMappings||[];
        if(!Array.isArray(continuity)||continuity.length>20000)fail('INVALID_MEASUREMENTS','subjectMappings requires <=20000 explicit records');
        var continuityIndex=new Map(),beforeIndex=new Map(),afterIndex=new Map(),inverseSubjects=new Map();
        for(var link of continuity){await spend();exactKeys(link,['before','after','provenance'],'subject mapping');if(!text(link.before)||!text(link.after)||!text(link.provenance))fail('INVALID_MEASUREMENTS','subject mapping requires before/after stable subject IDs and provenance');await wire(link,q.budgets.maxRetainedBytes,false);if(!continuityIndex.has(link.before))continuityIndex.set(link.before,[]);continuityIndex.get(link.before).push(link);}
        for(var b of before.benchmarks){await spend();if(!text(b.subject))continue;var key=await keyFor([b.subject,b.statistic]);if(!beforeIndex.has(key))beforeIndex.set(key,[]);beforeIndex.get(key).push(b);
          var links=continuityIndex.get(b.subject)||[],targets=links.length?links:[{after:b.subject}];
          for(var link of targets){await spend();if(!inverseSubjects.has(link.after))inverseSubjects.set(link.after,new Set());inverseSubjects.get(link.after).add(b.subject);}
        }
        for(var a of after.benchmarks){await spend();if(!text(a.subject))continue;var key=await keyFor([a.subject,a.statistic]);if(!afterIndex.has(key))afterIndex.set(key,[]);afterIndex.get(key).push(a);}
        for(var b of before.benchmarks){await spend();var links=continuityIndex.get(b.subject)||[],subjects=[];if(links.length){for(var link of links){await spend();await append(subjects,link.after);}}else await append(subjects,b.subject);
          var candidates=[],candidateIds=[];
          for(var subject of subjects){await spend();if(text(subject))for(var a of afterIndex.get(await keyFor([subject,b.statistic]))||[]){await spend();await append(candidateIds,{sourceId:a.sourceId,id:a.id});candidates.push(a);}}
          if(candidates.length!==1||links.length>1||(beforeIndex.get(await keyFor([b.subject,b.statistic]))||[]).length!==1||(inverseSubjects.get(subjects[0])||new Set()).size!==1){
            await append(unmatched,{before:{sourceId:b.sourceId,id:b.id},candidates:candidateIds,status:candidates.length?'ambiguous':'unmatched',reason:'Unique observations and one-to-one declared subject continuity are required on both sides'});continue;}
          var a=candidates[0],reasons=[],changes=[],bp=before.provenance.imported,ap=after.provenance.imported;
          for(var key of ['workload','configuration','machine','environment']){await spend();if(!nonempty(bp[key])||!nonempty(ap[key]))reasons.push('Unknown '+key);else if(await digest(bp[key])!==await digest(ap[key]))reasons.push('Different '+key);}
          if(!nonempty(b.method)||!nonempty(a.method))reasons.push('Unknown measurement method');else if(await digest(b.method)!==await digest(a.method))reasons.push('Different measurement method');
          if(b.input===undefined||a.input===undefined)reasons.push('Unknown benchmark input');else if(await digest(b.input)!==await digest(a.input))reasons.push('Different benchmark input');
          if(b.unit!==a.unit)reasons.push('Different units');
          for(var key of ['build','tree','toolchain','recordedAt'])if(await digest(bp[key]===undefined?null:bp[key])!==await digest(ap[key]===undefined?null:ap[key]))changes.push({field:key,before:bp[key]===undefined?null:bp[key],after:ap[key]===undefined?null:ap[key]});
          if(before.snapshot.input.capture.contentSha256!==after.snapshot.input.capture.contentSha256)changes.push({field:'capture',before:before.snapshot.input.capture,after:after.snapshot.input.capture});
          var result={subject:{before:b.subject,after:a.subject,continuity:links.length?'declared-mapping':'same-declared-subject',provenance:links.length?links[0].provenance:null},before:b,after:a,compatible:!reasons.length,reasons:reasons,provenanceChanges:changes,
            uncertainty:'Raw intervals retain their own confidence levels. Overlap is not a significance test; no p-value or joint confidence is inferred.'};
          if(!reasons.length&&b.estimate.value>0){var ratio=a.estimate.value/b.estimate.value;if(Number.isFinite(ratio))result.ratio=ratio;else result.ratioUnavailable='Ratio exceeds finite numeric range';var bc=b.estimate.confidenceInterval,ac=a.estimate.confidenceInterval;if(bc&&ac&&bc.lower>0){var lower=ac.lower/bc.upper,upper=ac.upper/bc.lower;if(Number.isFinite(lower)&&Number.isFinite(upper))result.derivedEndpointRange={lower:lower,upper:upper,label:'derived endpoint ratio range; no joint confidence level'};}}
          await append(comparisons,result);
        }
        data={before:before.snapshot,after:after.snapshot,comparisons:comparisons,unmatched:unmatched};
      }
      var response={schemaVersion:1,operation:q.op,version:VERSION,capture:current,request:q,
        replay:{schemaVersion:1,version:VERSION,operation:q.op,captureSha256:current.contentSha256,requestHash:requestHash,request:q},
        semantics:{basis:'imported local benchmark statistics and sampled stacks',samplesAreInvocations:false,samplesAreElapsedTrace:false,chronologyKnown:false,missingSamplesProveUnused:false,
          inclusive:'each function counted once per sampled stack; recursive contexts retained separately',exclusive:'leaf weight only',edge:'sampled adjacent physical-frame co-occurrence on an existing exact directed call; latency/frequency/errors unavailable'},
        completion:{complete:true},data:data};
      // Reserve the replay marker on fresh responses too, so the saved budget
      // covers the same complete response on an unchanged replay.
      response.replayed=true;
      // Account for escaping, keys, replay and complete original file text together.
      // These are wire/retained-value bounds, not a claim about V8 object overhead.
      check();await wire({op:'replay',replay:response.replay},INPUT_BYTES,false);
      await wire(response,q.budgets.maxOutputBytes,true,null,true);check();
      if(!replayed)delete response.replayed;
      var owned=copy(response,q.budgets.maxOutputBytes);check();return owned;
      } finally {
        if (taskChannel) { taskChannel.port1.onmessage = null; taskChannel.port1.close(); taskChannel.port2.close(); }
      }
    }
    return {query:query};
  }
  return {VERSION:VERSION,operations:OPS,capability:capability,admitRequest:admitRequest,create:create};
});
