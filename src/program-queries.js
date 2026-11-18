/* Read-only typed program plans. Shared by CommonJS, the viewer worker and fallback. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./value-flow.js') : root.ValueFlow, common ? require('./guard-obligations.js') : root.GuardObligations);
  if (common) module.exports = api;
  root.ProgramQueries = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Values, Guards) {
  'use strict';
  var VERSION = 'program-queries-v1', FACT_VERSION = 'program-facts-v1';
  var LIMITS = { maxWork: 2000000, maxRows: 10000, maxStates: 50000, maxEvidence: 1000, maxRetainedBytes: 16777216, maxOutputBytes: 1048576 };
  var DEFAULTS = { maxWork: 2000000, maxRows: 2000, maxStates: 10000, maxEvidence: 200, maxRetainedBytes: 4194304, maxOutputBytes: 524288 };
  var INPUT_BYTES = 65536, REPLAY_BYTES = LIMITS.maxOutputBytes + 32;
  var KINDS = ['function','block','exit','callsite','statement','parameter','argument','place','condition','boundary','valueStep','guardStep'];
  var RELATIONS = ['contains','calls','control','argument','parameter','reads','writes','atCall','valueEvidence','guardEvidence'];
  var OPS = ['select','filter','traverse','join','project','analyze','slice'];
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function text(x) { return typeof x === 'string' && x.length > 0 && x.length <= 16384; }
  function keys(x, allowed, label) { if (!object(x) || Object.keys(x).some(function (k) { return !allowed.includes(k); })) fail('INVALID_PROGRAM_PLAN', (label || 'object') + ' contains unsupported fields'); }
  function id(kind, owner, key) { return 'pq1:' + JSON.stringify([kind, owner, key == null ? null : key]); }
  function path(value) {
    if (!text(value) || value.split('.').length > 8 || !value.split('.').every(function (p) { return /^[A-Za-z][A-Za-z0-9_]*$/.test(p) && !['constructor','prototype','__proto__'].includes(p); }))
      fail('INVALID_PROGRAM_PLAN', 'field paths must be bounded plain property names');
    return value;
  }
  function field(row, name) { for (var key of name.split('.')) { if (!row || !Object.prototype.hasOwnProperty.call(row, key)) return null; row = row[key]; } return row === undefined ? null : row; }
  // Measure escaped UTF-8 JSON before allocation/stringification. Reject non-JSON
  // objects and accessors; a caller never lends mutable request storage to a job.
  function copyJSON(value, limit, tick, copy, internal) {
    var bytes = 0, memory = 0, ancestors = new Set();
    function add(n) { bytes += n; if (tick) tick(n); if (bytes > limit) fail('PROGRAM_BYTES', 'Escaped JSON exceeds the byte budget (' + limit + '); reduce fields, rows or model size'); }
    function string(s) {
      memory += 24 + s.length * 2; add(2);
      for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i);
        if (c === 34 || c === 92 || [8,9,10,12,13].includes(c)) add(2);
        else if (c < 32) add(6);
        else if (c < 128) add(1);
        else if (c < 2048) add(2);
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
        else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
      }
    }
    function visit(v, depth) {
      memory += 64; if (depth > 64) fail('INVALID_PROGRAM_PLAN', 'JSON nesting exceeds 64 levels');
      if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) { add(String(v).length); return v; }
      if (typeof v === 'string') { string(v); return v; }
      if (!v || typeof v !== 'object' || ancestors.has(v) || Object.getOwnPropertySymbols(v).length) fail('INVALID_PROGRAM_PLAN', 'Plan requires finite, acyclic plain JSON values');
      var array = Array.isArray(v);if(array&&v.length>100000)fail('INVALID_PROGRAM_PLAN','JSON arrays exceed the bounded structure limit');var names = Object.keys(v), out = copy ? (array ? [] : {}) : null;
      if (internal && !array) names = names.filter(function (k) { var d = Object.getOwnPropertyDescriptor(v,k); return d.get || d.set || d.value !== undefined; });
      if (!array && Object.prototype.toString.call(v) !== '[object Object]') fail('INVALID_PROGRAM_PLAN', 'Plan requires plain JSON objects');
      if (array && names.length !== v.length) fail('INVALID_PROGRAM_PLAN', 'Sparse or decorated JSON arrays are unsupported');
      add(2); ancestors.add(v);
      for (var i = 0; i < names.length; i++) {
        var k = names[i], descriptor = Object.getOwnPropertyDescriptor(v, k);
        if (!descriptor || descriptor.get || descriptor.set || ['__proto__','constructor','prototype'].includes(k)) fail('INVALID_PROGRAM_PLAN', 'Accessors and prototype fields are unsupported');
        if (i) add(1); if (!array) { string(k); add(1); }
        var item = visit(descriptor.value, depth + 1); if (copy) out[k] = item;
      }
      ancestors.delete(v); return out;
    }
    return { value: visit(value, 0), bytes: bytes, memory: memory };
  }
  function ownValue(v, key) { var d = object(v) && Object.getOwnPropertyDescriptor(v,key); return d && !d.get && !d.set ? d.value : undefined; }
  function programReplay(input) {
    var r = ownValue(input,'replay'), p = ownValue(r,'plan');
    return ownValue(input,'op') === 'replay' && Object.keys(input).length === 2 &&
      object(r) && Object.keys(r).length === 6 && ['version','capture','versions','plan','normalizedPlanSha256','resultSha256'].every(function(k){return Object.prototype.hasOwnProperty.call(r,k);}) &&
      ownValue(p,'op') === 'programQuery';
  }
  // A successful wire response already bounds its saved receipt. The extra 32
  // bytes cover {op:"replay",replay:...}; the inner original plan always keeps
  // the fresh declaration cap, independently of capture/receipt overhead.
  function admitRequest(input) { return copyJSON(input, programReplay(input) ? REPLAY_BYTES : INPUT_BYTES, null, true).value; }
  function normalize(input) {
    var q = copyJSON(input, INPUT_BYTES, null, true).value;
    keys(q, ['op','version','steps','return','budgets','timeoutMs'], 'programQuery');
    if (q.op !== 'programQuery' || q.version !== 1 || !Array.isArray(q.steps) || !q.steps.length || q.steps.length > 32) fail('INVALID_PROGRAM_PLAN', 'programQuery version:1 requires 1..32 steps');
    if(q.budgets!=null&&!object(q.budgets))fail('INVALID_PROGRAM_PLAN','budgets must be an object');
    q.budgets = Object.assign({}, DEFAULTS, q.budgets || {});
    keys(q.budgets, Object.keys(LIMITS), 'budgets');
    Object.keys(q.budgets).forEach(function (k) { if (!Number.isSafeInteger(q.budgets[k]) || q.budgets[k] < 1 || q.budgets[k] > LIMITS[k]) fail('INVALID_PROGRAM_PLAN', k + ' must be an integer 1..' + LIMITS[k]); });
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!Number.isSafeInteger(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000) fail('INVALID_PROGRAM_PLAN', 'timeoutMs must be 1..5000');
    var names = new Set();
    function ref(name) { if (!names.has(name)) fail('INVALID_PROGRAM_PLAN', 'Unknown or forward named result ' + String(name)); }
    function where(predicates) {
      if (!Array.isArray(predicates) || predicates.length > 16) fail('INVALID_PROGRAM_PLAN', 'where accepts at most 16 predicates');
      predicates.forEach(function (p) { keys(p, ['field','test','value'], 'predicate'); path(p.field);
        if (!['eq','ne','in','exists','contains'].includes(p.test)) fail('INVALID_PROGRAM_PLAN', 'Unsupported predicate ' + p.test);
        if (p.test === 'exists' ? typeof p.value !== 'boolean' : p.test === 'in' ? !Array.isArray(p.value) || p.value.length > 100 || p.value.some(function (v) { return v !== null && !['string','number','boolean'].includes(typeof v); }) : p.value !== null && !['string','number','boolean'].includes(typeof p.value)) fail('INVALID_PROGRAM_PLAN', 'Predicate values must be typed scalars (in: <=100 scalars; exists: boolean)');
        if (p.test === 'contains' && typeof p.value !== 'string') fail('INVALID_PROGRAM_PLAN', 'contains requires a literal string');
      });
    }
    q.steps.forEach(function (s) {
      if (!object(s) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s.name || '') || names.has(s.name) || !OPS.includes(s.op)) fail('INVALID_PROGRAM_PLAN', 'Each step requires a unique plain name and supported op');
      var allowed = { select: ['kind','procedures','ids','where'], filter: ['from','where'], traverse: ['from','relations','direction','depth'], join: ['left','right','on','how'], project: ['from','fields'], analyze: ['query'], slice: ['from','relations','direction','depth'] };
      keys(s, ['name','op'].concat(allowed[s.op]), s.name);
      if (s.from != null) ref(s.from);
      if (s.op === 'select') {
        if (!KINDS.includes(s.kind) || ['valueStep','guardStep'].includes(s.kind)) fail('INVALID_PROGRAM_PLAN', 'select requires an available captured fact kind; use analyze for witness facts');
        ['procedures','ids'].forEach(function (key) { if (s[key] != null && (!Array.isArray(s[key]) || s[key].length > 100 || !s[key].every(text))) fail('INVALID_PROGRAM_PLAN', key + ' requires <=100 exact IDs'); });
      }
      if (s.op === 'filter' || s.where != null) { if (s.where == null) s.where = []; where(s.where); }
      if (s.op === 'traverse' || s.op === 'slice') {
        if (!text(s.from) || !Array.isArray(s.relations) || !s.relations.length || s.relations.length > RELATIONS.length || !s.relations.every(function (r) { return RELATIONS.includes(r); })) fail('INVALID_PROGRAM_PLAN', 'Traversal requires a named input and supported relations');
        s.relations = Array.from(new Set(s.relations)).sort(); s.direction = s.direction || 'forward'; s.depth = s.depth == null ? 8 : s.depth;
        if (!['forward','backward','usage'].includes(s.direction) || !Number.isSafeInteger(s.depth) || s.depth < 0 || s.depth > 64) fail('INVALID_PROGRAM_PLAN', 'direction must be forward/backward/usage and depth 0..64');
        if (s.direction === 'usage' && s.relations.some(function (r) { return !['reads','writes','atCall','valueEvidence','guardEvidence'].includes(r); })) fail('INVALID_PROGRAM_PLAN', 'usage supports reads/writes/atCall and analyzer evidence relations');
      }
      if (s.op === 'join') { ref(s.left); ref(s.right); keys(s.on, ['left','right'], 'join.on'); path(s.on.left); path(s.on.right); s.how = s.how || 'inner'; if (!['inner','left'].includes(s.how)) fail('INVALID_PROGRAM_PLAN', 'join.how must be inner or left'); }
      if (s.op === 'project') { if (!text(s.from) || !object(s.fields) || !Object.keys(s.fields).length || Object.keys(s.fields).length > 32) fail('INVALID_PROGRAM_PLAN', 'project requires 1..32 named field paths'); Object.keys(s.fields).forEach(function (k) { path(k); if (k==='refs')fail('INVALID_PROGRAM_PLAN','Projection preserves refs; choose another output name'); if (k.includes('.')) fail('INVALID_PROGRAM_PLAN', 'projection output names must be plain fields'); path(s.fields[k]); }); }
      if (s.op === 'filter' && !text(s.from)) fail('INVALID_PROGRAM_PLAN', 'filter requires from');
      if (s.op === 'analyze') { if (!object(s.query) || !['valueFlow','guardObligations'].includes(s.query.op) || s.query.budgets != null || s.query.timeoutMs != null || s.query.scope != null || s.query.page != null) fail('INVALID_PROGRAM_PLAN', 'analyze requires a valueFlow/guardObligations query; limits belong to the whole plan'); s.query = (s.query.op === 'valueFlow' ? Values : Guards).normalize(s.query); delete s.query.budgets; delete s.query.timeoutMs; }
      names.add(s.name);
    });
    if (!Array.isArray(q.return) || !q.return.length || q.return.length > 32 || new Set(q.return).size !== q.return.length) fail('INVALID_PROGRAM_PLAN', 'return requires unique named results');
    q.return.forEach(ref);
    return q;
  }
  function schema() { return { version: VERSION, factVersion: FACT_VERSION, operations: OPS.slice(), factKinds: KINDS.slice(), relations: RELATIONS.slice(),
    fact: { id: 'pq1: JSON tuple [kind, exact procedure ID, local key]', refs: 'fact ID[]', kind: 'factKinds enum', procedureId: 'exact captured procedure ID', identity: '{rawNodeId,procedureId,functionId,packageId,buildUnitId,sourceDigest,unknownFields}', source: '{source_file,source_location,absolute_file}', evidencePath: 'original capture JSON pointer; # enters parsed flow JSON', classification: 'compiler-confirmed|modeled|possible|unknown' },
    plan: { required: ['op:programQuery','version:1','steps','return'], steps: { select: '{name,op,kind,procedures?:string[],ids?:factID[],where?:predicate[]}', filter: '{name,op,from,where}', traverse: '{name,op,from,relations,direction?:forward|backward|usage,depth?:0..64}', join: '{name,op,left,right,on:{left:fieldPath,right:fieldPath},how?:inner|left}', project: '{name,op,from,fields:{outputName:fieldPath}}', analyze: '{name,op,query:valueFlow|guardObligations query without per-step budgets}', slice: 'traverse shape; emits structured evidence and boundaries' }, predicate: '{field,test:eq|ne|in|exists|contains,value:scalar|scalar[]}' },
    replay: { required: ['version:1','capture','versions','plan','normalizedPlanSha256','resultSha256'], plan: 'original admitted declaration under inputBytes, with the same shape validation as a fresh plan', normalizedPlanSha256: 'SHA-256 of the complete normalized plan and models, verified before query work' },
    unavailable: ['runtime values','general heap aliases','implicit control taint','path feasibility','exhaustiveness','policy inference','arbitrary evaluation'], limits: Object.assign({}, LIMITS), defaults: Object.assign({}, DEFAULTS), inputBytes: INPUT_BYTES, replayInputBytes: REPLAY_BYTES,
    dependence: 'reads/writes are captured syntax only; valueEvidence and guardEvidence are existing analyzers\' bounded context-specific witnesses, never a new propagation engine' }; }
  function create(context) {
    var values = context.values, guards = context.guards, owners = values.procedures, cache = new Map(), cacheBytes = 0;
    var capture = { contentSha256: context.capture.contentSha256, digestFormat: context.capture.digestFormat, buildContext: context.buildContext };
    var reverseCalls = null;
    var versions = Object.assign({}, context.versions, { programQueries: VERSION, programFacts: FACT_VERSION });
    function ownerIdentity(e) { var p = e.procedure, a = e.raw && e.raw.attributes || {}, out = { rawNodeId: e.raw && e.raw.id || null, procedureId: p.id, functionId: p.function_id || null, symbolId: p.symbol_id || null, packageId: p.package_id || null, buildUnitId: a.unit_key || null, sourceDigest: a.source_digest && /^[0-9a-f]{16}$/i.test(a.source_digest) ? a.source_digest : null };
      out.unknownFields = Object.keys(out).filter(function (k) { return out[k] == null; }); return out; }
    function row(e, kind, key, record, suffix, extra) {
      var raw = e.raw, a = raw && raw.attributes || {}, file = record && record.source_file || raw && raw.source_file || null;
      if(!text(e.procedure.id)||[file,a.source_absolute,a.target_src_path].some(function(v){return typeof v==='string'&&v.length>16384;}))fail('PROGRAM_BYTES','Owner identity or source path exceeds 16384 characters; inspect the original capture pointer');
      var absolute = typeof file === 'string' && file.startsWith('/') ? file : raw && file === raw.source_file && typeof a.source_absolute === 'string' && a.source_absolute.startsWith('/') ? a.source_absolute : typeof a.target_src_path === 'string' && a.target_src_path.startsWith('/') && file && (a.target_src_path === file || a.target_src_path.endsWith('/' + file)) ? a.target_src_path : null;
      var factId = id(kind, e.procedure.id, key);
      return Object.assign({ id: factId, refs: [factId], kind: kind, procedureId: e.procedure.id, classification: 'compiler-confirmed', identity: ownerIdentity(e), source: { source_file: file, source_location: record && record.source_location || raw && raw.source_location || null, absolute_file: absolute }, evidencePath: raw ? context.rawPaths.get(raw.id) + '/attributes/flow#' + suffix : null }, extra || {});
    }
    function evict(){while(cacheBytes+(reverseCalls?reverseCalls.bytes:0)>LIMITS.maxRetainedBytes&&cache.size){var oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).bytes;cache.delete(oldest);}}
    async function query(input, runtime) {
      var q, replay, work = 0, retained = 0, rows = 0, states = 0, evidenceUsed = 0, yielded = 0, active = 'preflight', now = runtime && runtime.now || Date.now, start = now(), deadline;
      var cancelled = false, timedOut = false, budgetKey = null, channel = null, firstYield = true, reverseUsed = false;
      var tables = new Map(), analysisNames = new Map(), overlay = new Map(), overlayOut = new Map(), overlayIn = new Map(), usedOwners = new Map();
      function tick(n) { work += n == null ? 1 : n; cancelled = cancelled || !!(runtime && runtime.cancelled && runtime.cancelled()); timedOut = timedOut || deadline != null && now() >= deadline; if (cancelled || timedOut) fail('PROGRAM_CANCELLED', cancelled ? 'Program query cancelled; no partial results published' : 'Whole-plan deadline reached; no partial results published'); if (q && work > q.budgets.maxWork) { budgetKey = 'maxWork'; fail('PROGRAM_BUDGET', 'Cumulative maxWork exhausted at ' + active); } }
      async function cooperate() { tick(); if (work - yielded >= 4096) { await new Promise(function (r) { if (firstYield) { firstYield=false;setTimeout(r,0); } else if (typeof setImmediate === 'function') setImmediate(r); else if (typeof MessageChannel !== 'undefined') { if(!channel)channel=new MessageChannel();channel.port1.onmessage=r;channel.port2.postMessage(0); } else setTimeout(r,0); }); yielded = work; tick(0); } }
      function hold(v) { var measured = copyJSON(v, q.budgets.maxRetainedBytes - retained, tick, false, true); if(measured.memory>q.budgets.maxRetainedBytes-retained)fail('PROGRAM_BYTES','Retained-memory budget exhausted at '+active+'; narrow the selection or projection');retained += measured.memory; return v; }
      function addRow(out, v) { tick(); if (++rows > q.budgets.maxRows) { budgetKey = 'maxRows'; fail('PROGRAM_BUDGET', 'Cumulative maxRows exhausted at ' + active + '; return fewer facts or narrow procedure IDs'); } out.push(hold(v)); }
      function link(store, relation) { if (!store.has(relation.from)) store.set(relation.from, []); store.get(relation.from).push(relation); }
      function relation(out, from, to, kind, extra) { var r = Object.assign({ id: id('relation', from, [kind,to,extra && extra.outcome]), from: from, to: to, kind: kind, classification: 'compiler-confirmed' }, extra || {}); out.push(hold(r)); return r; }
      async function materialize(procedure) {
        tick(); if (usedOwners.has(procedure)) return usedOwners.get(procedure);
        if (cache.has(procedure)) { var cached=cache.get(procedure);tick(cached.work);retained+=cached.bytes;if(retained>q.budgets.maxRetainedBytes)fail('PROGRAM_BYTES','Cached owner exceeds remaining retained-memory budget');usedOwners.set(procedure,cached);return cached; }
        var ownerWork=work,ownerBytes=retained;
        var e = owners.get(procedure), all = new Map(), relations = [], out = new Map(), incoming = new Map();
        if (!e) fail('STALE_PROGRAM_REFERENCE', 'Unknown exact procedure ID ' + procedure + '; select functions from this capture');
        function put(kind, key, record, suffix, extra) { var v = row(e, kind, key, record, suffix, extra); if (!all.has(v.id)) all.set(v.id, hold(v)); return v.id; }
        var f = put('function', null, e.raw, '', { displayPath: e.procedure.display_path || procedure, bodyStatus: e.status, unavailableKinds: e.status === 'captured' ? [] : ['statement','argument','parameter','place'], reason: e.reason || null });
        function contains(child) { relation(relations, f, child, 'contains'); }
        function place(p, suffix) {
          if (!p) return null;
          var unsupported = p.projection.some(function (part) { return part.kind === 'unsupported'; });
          var key = [p.local,unsupported ? ['unsupported-occurrence',suffix] : p.projection.map(function (part) { return part.kind === 'field' ? ['field',part.index] : [part.kind]; })];
          var local = e.locals.get(p.local), v = put('place', key, local, suffix, { local: p.local, projection: p.projection, type: p.type || local && local.type || null, classification: unsupported ? 'unknown' : 'compiler-confirmed', reason: unsupported ? 'unsupported-place-projection' : null }); return v;
        }
        function usage(from, p, kind, suffix) { if(p){var target=place(p,suffix);relation(relations,from,target,kind,{classification:all.get(target).classification,evidencePath:context.rawPaths.get(e.raw.id)+'/attributes/flow#'+suffix});} }
        function reads(from, operand, suffix) { if (operand && operand.place) usage(from,operand.place,'reads',suffix+'/place'); }
        var guardEntry=guards.procedures.get(procedure),guardOrdinals=new Map();if(guardEntry&&guardEntry.status==='captured'){var ordinal=0;for(var guardBlock of guardEntry.branches.keys()){tick();guardOrdinals.set(guardBlock,ordinal++);hold(guardBlock);}}
        if (e.flow && e.raw && e.reason !== 'missing or ambiguous imported value-body ownership') {
          var knownBlocks=new Set();for(var block of e.flow.blocks){tick();knownBlocks.add(block.id);hold(block.id);}
          for (var bi = 0; bi < e.flow.blocks.length; bi++) {
            await cooperate(); var b = e.flow.blocks[bi], bp = 'blocks/' + bi, bid = put('block', b.id, b, bp, { nodeId: procedure + '#' + b.id, blockId: b.id, blockKind: b.kind }); contains(bid);
            var g = guards.procedures.get(procedure), condition = g && g.status === 'captured' && g.branches.get(b.id), cid = null;
            if (condition) { cid = put('condition', b.id, condition, 'guard_facts/branches/' + guardOrdinals.get(b.id), { nodeId: procedure + '#' + b.id, conditionKind: condition.kind, outcomes: condition.targets || [], discriminant: condition.discriminant || null }); contains(cid); if (condition.kind === 'boolean') reads(cid, condition.discriminant, 'guard_facts/branches/'+guardOrdinals.get(b.id)+'/discriminant'); }
            var hasSuccessors=Array.isArray(b.successors),successors=hasSuccessors?b.successors:[null];
            for (var ei=0;ei<successors.length;ei++) {
              await cooperate();var successor=successors[ei],ep=bp+'/successors'+(hasSuccessors?'/'+ei:''),edgeKind=successor&&successor.kind==='unwind'?'unwind':'normal',action=successor&&successor.action||null,targetId=null;
              if(object(successor)&&typeof successor.target==='string'&&knownBlocks.has(successor.target)) targetId=id('block',procedure,successor.target);
              else if(object(successor)&&successor.target==null&&['continue','terminate','unreachable'].includes(action)) targetId=put('exit',[b.id,ei],b,ep,{exitKind:action==='continue'?(edgeKind==='unwind'?'unwind':'return'):action,action:action,edgeKind:edgeKind,successorIndex:ei,classification:'modeled'});
              else targetId=put('boundary',['control',b.id,ei],b,ep,{reason:'invalid-control-successor',successor:successor,classification:'unknown'});
              relation(relations,bid,targetId,'control',{id:id('relation',bid,['control',ei]),edgeKind:edgeKind,action:action,successorIndex:hasSuccessors?ei:null,successor:successor,conditionId:cid,outcome:condition&&condition.kind==='boolean'&&object(successor)?(condition.targets.find(function(t){return t.target===successor.target;})||{}).value??null:null,evidencePath:context.rawPaths.get(e.raw.id)+'/attributes/flow#'+ep,classification:all.has(targetId)&&all.get(targetId).classification==='unknown'?'unknown':'modeled'});
            }
            var call = values.calls.get(procedure + '#' + b.id + '@call');
            if (call) {
              var callId = put('callsite', call.id, b, bp, { callsiteId: call.id, nodeId: call.from, resolution: call.resolution || null, possibleDispatch: !!call.possibleDispatch, unknown: !!call.unknown, targetIds: (call.possibleTargets || call.targets || []).slice() }); contains(callId); relation(relations, bid, callId, 'contains');
              for (var target of call.possibleTargets || call.targets || []) relation(relations, callId, id('function', target, null), 'calls', { classification: call.resolution === 'idMatched' && !call.possibleDispatch ? 'compiler-confirmed' : 'possible', recursion: target === procedure, callsiteId: call.id });
              var missing = (call.unavailableTargets || []).slice(); if (call.unknown || call.possibleUnknown || call.nativeCall || call.callbackParameter != null) missing.push(call.nativeCall ? 'native-boundary' : call.callbackParameter != null ? 'callback-binding-context-required' : 'unresolved-dispatch');
              for (var mi = 0; mi < missing.length; mi++) { var boundary = put('boundary', [call.id,mi], b, bp, { callsiteId: call.id, reason: missing[mi], classification: 'unknown' }); relation(relations, callId, boundary, 'calls', { classification: 'unknown' }); }
            }
          }
        }
        if (e.status === 'captured') {
          for (var pi = 0; pi < e.facts.parameter_locals.length; pi++) { await cooperate(); var localId = e.facts.parameter_locals[pi], param = put('parameter', pi, e.locals.get(localId), 'value_facts/parameter_locals/' + pi, { index: pi, local: localId }); contains(param); relation(relations, f, param, 'parameter'); relation(relations, param, place({ local: localId, projection: [] }, 'value_facts/locals'), 'parameter'); }
          for (var vi = 0; vi < e.facts.blocks.length; vi++) {
            var vb = e.facts.blocks[vi], vp = 'value_facts/blocks/' + vi, blockId = id('block',procedure,vb.id);
            for (var si = 0; si < vb.statements.length; si++) { await cooperate(); var s = vb.statements[si], sp = vp + '/statements/' + si, statement = put('statement', s.id, s, sp, { factId: s.id, nodeId: procedure + '#' + vb.id, statementKind: s.kind, valueKind: s.value && s.value.kind || null }); contains(statement); relation(relations, blockId, statement, 'contains'); usage(statement,s.destination,'writes',sp+'/destination'); if (s.value) { usage(statement,s.value.place,'reads',sp+'/value/place'); for (var oi = 0; oi < (s.value.operands || []).length; oi++) reads(statement, s.value.operands[oi], sp + '/value/operands/' + oi); } }
            if (vb.call) {
              var callsite = procedure + '#' + vb.id + '@call', callFact = id('callsite',procedure,callsite);
              for (var ai = 0; ai < vb.call.arguments.length; ai++) { await cooperate(); var argument = put('argument', [callsite,ai], vb.call, vp + '/call/arguments/' + ai, { callsiteId: callsite, index: ai, nodeId: procedure + '#' + vb.id, operandKind: vb.call.arguments[ai].kind }); relation(relations, callFact, argument, 'argument'); contains(argument); reads(argument, vb.call.arguments[ai], vp + '/call/arguments/' + ai); }
              usage(callFact,vb.call.destination,'writes',vp+'/call/destination');
            }
          }
        }
        if (e.status !== 'captured' || !guards.procedures.get(procedure) || guards.procedures.get(procedure).status !== 'captured') { var unavailable = put('boundary', 'capability', e.raw, '', { reason: e.reason || (guards.procedures.get(procedure) || {}).reason || 'guard facts unavailable', unavailableKinds: e.status !== 'captured' ? ['value','guard'] : ['guard'], classification: 'unknown' }); contains(unavailable); }
        for (var rel of relations) { link(out, rel); if (!incoming.has(rel.to)) incoming.set(rel.to, []); incoming.get(rel.to).push(rel); }
        // Atomic capture-owned publication: interrupted owners never enter cache.
        tick(); var owned = { rows: all, out: out, incoming: incoming, work:work-ownerWork, bytes:retained-ownerBytes }; if(cache.has(procedure))cacheBytes-=cache.get(procedure).bytes;cache.set(procedure,owned);cacheBytes+=owned.bytes;usedOwners.set(procedure,owned);evict();return owned;
      }
      async function resolve(factId) {
        tick(); if (overlay.has(factId)) return overlay.get(factId);
        var tuple; try { if (!factId.startsWith('pq1:')) throw 0; tuple = JSON.parse(factId.slice(4)); } catch (_) { fail('STALE_PROGRAM_REFERENCE', 'Expected a typed pq1 fact ID from this capture'); }
        if (!Array.isArray(tuple) || tuple.length !== 3 || !owners.has(tuple[1])) fail('STALE_PROGRAM_REFERENCE', 'Fact owner is unavailable in this capture: ' + factId);
        var own = await materialize(tuple[1]), found = own.rows.get(factId); if (!found) fail('STALE_PROGRAM_REFERENCE', 'Fact no longer exists or its kind is unavailable: ' + factId); return found;
      }
      function refs(v) { return Array.isArray(v.refs) ? v.refs : v.id ? [v.id] : []; }
      async function adjacent(v, requested, direction) {
        var out = [], own = owners.has(v.procedureId) ? await materialize(v.procedureId) : null;
        if (own) out = out.concat(direction === 'backward' || direction === 'usage' ? own.incoming.get(v.id) || [] : own.out.get(v.id) || []);
        out = out.concat((direction === 'backward' || direction === 'usage' ? overlayIn : overlayOut).get(v.id) || []);
        if ((direction === 'backward' || direction === 'usage') && v.kind === 'function' && requested.includes('calls')) {
          if(!reverseUsed){if(reverseCalls){tick(reverseCalls.work);retained+=reverseCalls.bytes;if(retained>q.budgets.maxRetainedBytes)fail('PROGRAM_BYTES','Reverse call index exceeds retained-memory budget');}else{var reverseWork=work,reverseBytes=retained,reverse=new Map();for(var call of values.calls.values()){await cooperate();for(var target of call.possibleTargets || call.targets || []){tick();if(!reverse.has(target))reverse.set(target,[]);reverse.get(target).push(hold({procedure:call.procedure,id:call.id}));}}reverseCalls={index:reverse,work:work-reverseWork,bytes:retained-reverseBytes};evict();}reverseUsed=true;}
          for(var callRef of reverseCalls.index.get(v.procedureId)||[]){await cooperate();var caller=await materialize(callRef.procedure);for(var r of caller.out.get(id('callsite',callRef.procedure,callRef.id))||[])if(r.to===v.id)out.push(r);}
        }
        return out.filter(function (r) { tick(); return requested.includes(r.kind); });
      }
      function matches(v, predicates) { return (predicates || []).every(function (p) { tick(); var x = field(v,p.field); if (p.test === 'exists') return (x !== null) === p.value; if (p.test === 'eq') return x === p.value; if (p.test === 'ne') return x !== p.value; if (p.test === 'in') return p.value.includes(x); return typeof x === 'string' && x.includes(p.value); }); }
      async function walk(step) {
        var seeds=[],distance=new Map(),queue=[],result=[],candidates=new Map(),frontiers=[],boundaries=[],cycles=[],conditions=[],conditionIds=new Set();
        for(var seedRow of tables.get(step.from).rows)for(var seed of refs(seedRow))if(!distance.has(seed)){distance.set(seed,0);seeds.push(seed);queue.push(seed);}
        // Minimum-distance expansion includes descendants of a later shorter route.
        for(var qi=0;qi<queue.length;qi++){
          await cooperate();var factId=queue[qi],v=await resolve(factId),depth=distance.get(factId);addRow(result,v);
          if(v.kind==='boundary'||v.classification==='unknown')addRow(boundaries,v);
          if(v.kind==='condition'||v.kind==='guardStep'&&['branch','guard-outcome','guard-result'].includes(v.stepKind)){conditionIds.add(v.id);addRow(conditions,v);}
          for(var r of await adjacent(v,step.relations,step.direction)){
            await cooperate();var target=step.direction==='forward'?r.to:r.from;candidates.set(r.id,hold({relation:r,from:factId,to:target}));
            if(depth<step.depth&&!distance.has(target)){distance.set(target,depth+1);queue.push(target);hold(target);}
          }
        }
        var graphEdges=[],adj=new Map();
        for(var candidate of candidates.values()){
          await cooperate();var r=candidate.relation;
          if(!distance.has(candidate.to)){addRow(frontiers,{factId:candidate.from,relationId:r.id,nextId:candidate.to,reason:'depth-limit'});continue;}
          graphEdges.push(r);if(!adj.has(candidate.from))adj.set(candidate.from,[]);adj.get(candidate.from).push(candidate);
          if(r.conditionId&&!conditionIds.has(r.conditionId)){conditionIds.add(r.conditionId);addRow(conditions,await resolve(r.conditionId));}
        }
        // Iterative gray/black DFS over the bounded induced graph: convergence is
        // not a cycle, and JavaScript stack depth does not follow capture depth.
        var color=new Map();
        for(var root of queue){if(color.has(root))continue;var stack=[{id:root,index:0}];color.set(root,1);
          while(stack.length){await cooperate();var frame=stack[stack.length-1],edges=adj.get(frame.id)||[];
            if(frame.index>=edges.length){color.set(frame.id,2);stack.pop();continue;}
            var edge=edges[frame.index++];if(color.get(edge.to)===1)addRow(cycles,{from:edge.from,to:edge.to,relationId:edge.relation.id,kind:edge.relation.kind==='calls'?'recursion':'cycle',classification:edge.relation.classification});
            else if(!color.has(edge.to)){color.set(edge.to,1);stack.push({id:edge.to,index:0});}
          }
        }
        var analyses={};for(var analysisName of analysisNames.get(step.from)||[]){analyses[analysisName]=tables.get(analysisName).analysis;for(var gap of analyses[analysisName].queryCoverage.gaps||[])addRow(boundaries,{kind:'analysis-boundary',analysisName:analysisName,classification:'unknown',reason:gap.kind,procedureId:gap.procedure||null,detail:gap.detail||null});}
        return {rows:result,slice:{direction:step.direction,seeds:seeds,relations:graphEdges,conditions:conditions,cycles:cycles,unmatched:boundaries,frontiers:frontiers,truncated:frontiers.length>0||Object.values(analyses).some(function(a){return !a.completion.evidenceComplete;}),analysisCoverage:analyses,partialCoverage:boundaries.length>0||Object.values(analyses).some(function(a){return a.queryCoverage.partial;}),semantics:'Captured typed evidence; reads/writes are syntax, witness edges retain analyzer contexts; feasibility and exhaustiveness unproven'}};
      }
      try {
        var admitted = admitRequest(input);
        if (admitted.op === 'replay') {
          keys(admitted,['op','replay'],'replay'); replay = admitted.replay; keys(replay,['version','capture','versions','plan','normalizedPlanSha256','resultSha256'],'replay descriptor');
          if (!/^[0-9a-f]{64}$/.test(replay.resultSha256||'')) fail('INVALID_PROGRAM_REPLAY','Replay requires the saved result SHA-256');
          if (!/^[0-9a-f]{64}$/.test(replay.normalizedPlanSha256||'')) fail('INVALID_PROGRAM_REPLAY','Replay requires the saved normalized plan SHA-256');
          if (replay.version !== 1 || !replay.capture || context.digest(replay.capture) !== context.digest(capture)) fail('CAPTURE_MISMATCH', 'Program replay capture differs; load the original capture or create a new plan');
          if (context.digest(replay.versions) !== context.digest(versions)) fail('VERSION_MISMATCH', 'Program replay versions differ; use matching schema/model versions');
          admitted = replay.plan;
        }
        q = normalize(admitted); var normalizedPlanSha256 = context.digest(q);
        if(replay&&normalizedPlanSha256!==replay.normalizedPlanSha256)fail('INVALID_PROGRAM_REPLAY','Replay normalized plan differs from the saved SHA-256');
        deadline = start + q.timeoutMs; tick(); hold(q);
        // Validate exact owner/model references before publishing or analyzing.
        for (var check of q.steps) {
          for (var owner of check.procedures || []) if (!owners.has(owner)) fail('STALE_PROGRAM_REFERENCE', 'Unknown procedure ' + owner + '; select functions from this capture');
          for (var exact of check.ids || []) await resolve(exact);
          if (check.op === 'analyze') {
            if (!owners.has(check.query.function)) fail('STALE_PROGRAM_REFERENCE', 'Unknown analyzer root ' + check.query.function);
            var endpoints = check.query.op === 'valueFlow' ? check.query.model.sources.concat(check.query.model.sinks).map(function (r) { return r.at; }).concat(check.query.model.summaries.map(function (r) { return {call:r.call}; })) : check.query.model.rules.flatMap(function (r) { return [r.operation].concat(r.requires.map(function (g) { return g.at; })); }).concat(check.query.model.summaries.map(function (r) { return {call:r.call}; }));
            for (var endpoint of endpoints) { tick(); if (endpoint.call ? !values.calls.has(endpoint.call) : !owners.has(endpoint.procedure)) fail('STALE_PROGRAM_REFERENCE', 'Unknown exact analyzer endpoint ' + (endpoint.call || endpoint.procedure)); }
          }
        }
        for (var step of q.steps) {
          active = step.name; await cooperate(); var table = { rows: [] };
          if (step.op === 'select') {
            var ownerIds = step.procedures || owners.keys();
            if (step.ids) { for (var exactId of step.ids) { var selected = await resolve(exactId); if (selected.kind !== step.kind || step.procedures && !step.procedures.includes(selected.procedureId)) fail('STALE_PROGRAM_REFERENCE','Fact kind/owner does not match select ' + step.name); if (matches(selected,step.where)) addRow(table.rows,selected); } }
            else for (var ownerId of ownerIds) { await cooperate();
              if (step.kind === 'function') { var e = owners.get(ownerId), functionFact = row(e,'function',null,e.raw,'',{displayPath:e.procedure.display_path || ownerId,bodyStatus:e.status,unavailableKinds:e.status === 'captured' ? [] : ['statement','argument','parameter','place'],reason:e.reason || null}); if (matches(functionFact,step.where)) addRow(table.rows,functionFact); }
              else { var facts = await materialize(ownerId); for (var fact of facts.rows.values()) { await cooperate(); if (fact.kind === step.kind && matches(fact,step.where)) addRow(table.rows,fact); } }
            }
          } else if (step.op === 'filter') { for (var item of tables.get(step.from).rows) { await cooperate(); if (matches(item,step.where)) addRow(table.rows,item); } }
          else if (step.op === 'traverse' || step.op === 'slice') table = await walk(step);
          else if (step.op === 'project') { for (var item of tables.get(step.from).rows) { await cooperate(); var projected = { refs: refs(item).slice() }; for (var key of Object.keys(step.fields)) projected[key] = field(item,step.fields[key]); addRow(table.rows,projected); } }
          else if (step.op === 'join') {
            // Bounded hash join: null/absent keys never accidentally match.
            var buckets = new Map();
            for (var right of tables.get(step.right).rows) { await cooperate(); var rk = field(right,step.on.right); if (rk !== null && ['string','number','boolean'].includes(typeof rk)) { var bk = typeof rk + ':' + rk; if (!buckets.has(bk)) buckets.set(bk,[]); buckets.get(bk).push(right); hold(bk); } }
            for (var left of tables.get(step.left).rows) { await cooperate(); var lk = field(left,step.on.left), matched = lk === null ? [] : buckets.get(typeof lk + ':' + lk) || []; if (!matched.length && step.how === 'left') matched = [null]; for (var rightRow of matched) { await cooperate(); addRow(table.rows,{left:left,right:rightRow,refs:Array.from(new Set(refs(left).concat(rightRow ? refs(rightRow) : [])))}); } }
          } else if (step.op === 'analyze') {
            if(states>=q.budgets.maxStates||evidenceUsed>=q.budgets.maxEvidence){budgetKey=states>=q.budgets.maxStates?'maxStates':'maxEvidence';fail('PROGRAM_BUDGET','Cumulative analyzer '+budgetKey+' exhausted before '+step.name);}
            var request = Object.assign({},step.query,{ timeoutMs: Math.max(1,Math.min(5000,deadline - now())), budgets: {maxWork:Math.max(1,q.budgets.maxWork-work),maxStates:Math.max(1,q.budgets.maxStates-states),maxEvidence:Math.min(q.budgets.maxEvidence-evidenceUsed,Math.max(1,q.budgets.maxRows-rows))} });
            var analysis = await (step.query.op === 'valueFlow' ? Values.analyze(values,request,{now:now,cancelled:function(){cancelled=cancelled||!!(runtime&&runtime.cancelled&&runtime.cancelled());timedOut=timedOut||now()>=deadline;return cancelled||timedOut;}}) : Guards.analyze(guards,request,{now:now,cancelled:function(){cancelled=cancelled||!!(runtime&&runtime.cancelled&&runtime.cancelled());timedOut=timedOut||now()>=deadline;return cancelled||timedOut;}}));
            // Record the pinned parent timeout, not a wall-clock-dependent remaining slice.
            analysis.completion.timeoutMs=q.timeoutMs;
            work += analysis.completion.work; states += analysis.completion.states;evidenceUsed+=analysis.witnesses.items.reduce(function(n,w){return n+w.steps.length;},0); tick(); if (states > q.budgets.maxStates || analysis.completion.budgetExceeded) { budgetKey = states > q.budgets.maxStates ? 'maxStates' : 'maxWork'; fail('PROGRAM_BUDGET','Shared analyzer budget exhausted at ' + step.name); }
            if (analysis.completion.cancelled || analysis.completion.timedOut) fail('PROGRAM_CANCELLED','Shared analyzer cancelled at whole-plan deadline');
            table.analysis = hold({operation:analysis.operation,status:analysis.status,finding:analysis.finding,semantics:analysis.semantics,completion:analysis.completion,queryCoverage:analysis.queryCoverage,witnesses:{total:analysis.witnesses.total,truncated:analysis.witnesses.truncated},rules:analysis.rules || null,model:step.query.model});
            for (var wi = 0; wi < analysis.witnesses.items.length; wi++) {
              var witness = analysis.witnesses.items[wi], previous = null;
              for (var ti = 0; ti < witness.steps.length; ti++) { await cooperate(); var s = witness.steps[ti], sourceOwner = owners.get(s.sourceProcedure || s.procedure); if (!sourceOwner) fail('AMBIGUOUS_PROGRAM_OWNER','Analyzer witness has no unique captured source owner');
                var kind = analysis.operation === 'valueFlow' ? 'valueStep' : 'guardStep';
                var v = row(sourceOwner,kind,[step.name,wi,ti],s.source,(kind === 'guardStep' && ['branch','guard-outcome'].includes(s.kind) ? 'guard_facts' : 'value_facts'),{stepKind:s.kind,callsiteId:s.callsiteId || null,nodeId:s.nodeId || null,contextId:s.contextId || null,analysisName:step.name,witnessIndex:wi,sourceId:witness.sourceId || null,sinkId:witness.sinkId || null,classification:s.classification || (witness.classification === 'possible' ? 'possible' : witness.classification === 'unknown' ? 'unknown' : 'modeled'),detail:s,witness:{classification:witness.classification || null,requirements:witness.requirements || null,truncated:!!witness.truncated}});
                overlay.set(v.id,v); addRow(table.rows,v);
                function overlayRelation(from,to,relationKind) { var r = relation([],from,to,relationKind,{classification:v.classification,contextId:v.contextId,analysisName:step.name,witnessIndex:wi}); link(overlayOut,r); if (!overlayIn.has(to)) overlayIn.set(to,[]); overlayIn.get(to).push(r); }
                if (previous) overlayRelation(previous,v.id,kind === 'valueStep' ? 'valueEvidence' : 'guardEvidence');
                if (v.callsiteId && values.calls.has(v.callsiteId)) overlayRelation(v.id,id('callsite',values.calls.get(v.callsiteId).procedure,v.callsiteId),'atCall'); previous = v.id;
              }
            }
          }
          var dependencies=step.op==='analyze'?[step.name]:step.op==='join'?Array.from(new Set((analysisNames.get(step.left)||[]).concat(analysisNames.get(step.right)||[]))):step.from?analysisNames.get(step.from)||[]:[];analysisNames.set(step.name,dependencies);tables.set(step.name,table);
        }
        active = 'output'; var results = {}; for (var name of q.return) results[name] = tables.get(name);
        var payload = {schemaVersion:1,operation:'programQuery',capture:capture,versions:versions,plan:q,results:results,assumptions:['Read-only captured evidence for human defensive review; no exploitation or autonomous workflow.','Structural calls/control and syntactic reads/writes do not prove value dependence, feasibility or exhaustiveness.','Only valueEvidence/guardEvidence reuse the declared public analyzers; possible bindings and missing bodies remain explicit.']};
        // Output ownership, escaping, replay and hashing are inside the same budget.
        hold(payload);var owned = copyJSON(payload,q.budgets.maxOutputBytes,tick,true,true).value, hash = context.digest(owned); tick();
        if (replay && replay.resultSha256 != null && replay.resultSha256 !== hash) fail('RESULT_MISMATCH','Replayed evidence differs from the saved result hash');
        owned.resultSha256 = hash; owned.replay = {version:1,capture:capture,versions:versions,plan:admitted,normalizedPlanSha256:normalizedPlanSha256,resultSha256:hash};
        owned.completion = {complete:true,cancelled:false,timedOut:false,work:q.budgets.maxWork,states:states,evidence:evidenceUsed,retainedBytes:q.budgets.maxRetainedBytes,rows:rows};
        // Include replay and diagnostics in the escaped wire budget as well.
        hold(owned);var wire = copyJSON(owned,q.budgets.maxOutputBytes,tick,true,true).value;
        wire.completion.work = work;wire.completion.retainedBytes=retained; return wire;
      } catch (error) {
        return {schemaVersion:1,operation:'programQuery',capture:{contentSha256:capture.contentSha256,digestFormat:capture.digestFormat},error:{code:error.code || 'INVALID_PROGRAM_PLAN',message:String(error.message || error).slice(0,1000),step:active,budget:budgetKey},results:{},completion:{complete:false,cancelled:cancelled,timedOut:timedOut,work:work,states:states,evidence:evidenceUsed,retainedBytes:retained,rows:rows}};
      } finally { if(channel){channel.port1.close();channel.port2.close();} }
    }
    return {query:query,capability:function(){return {version:VERSION,factVersion:FACT_VERSION,readOnly:true,lazyProcedureFacts:true,persistentIndexBytes:LIMITS.maxRetainedBytes,arbitraryEvaluation:false,operations:OPS.slice(),factKinds:KINDS.slice(),relations:RELATIONS.slice(),valueFlow:values.capability,guardObligations:guards.capability,unavailable:schema().unavailable,limits:Object.assign({},LIMITS)};}};
  }
  return {VERSION:VERSION,FACT_VERSION:FACT_VERSION,normalize:normalize,admitRequest:admitRequest,isReplayRequest:programReplay,schema:schema,create:create,factId:id};
});
