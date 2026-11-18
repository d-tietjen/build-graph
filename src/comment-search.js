/* One portable comment index. Reconstructed from the public EDEN-3206 design;
 * historical unverified source is not a dependency or runtime qualification. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./analysis-evidence.js') : root.AnalysisEvidence,
    common ? require('./analysis-snapshot.js') : root.AnalysisSnapshot);
  if (common) module.exports = api;
  root.CommentSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Evidence, Snapshot) {
  'use strict';
  var VERSION = 'portable-comments-v2', INDEX_VERSION = 'portable-comments-v1', CHUNKER = 'comment-text-utf16-1024-v1';
  var INPUT = 8388608, LIMITS = { maxWork: 2000000, maxRetainedBytes: 33554432, maxOutputBytes: 16777216 };
  var OPS = ['indexComments','loadCommentIndex','searchComments','commentDetails','embedComments'];
  // Grammar-only overlap must not manufacture a second RRF vote. This fixed
  // English query policy never changes exact chunk text or embedding inputs.
  var LEXICAL_FUNCTION_WORDS = new Set(('a an the i me my myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves this that these those am is are was were be been being do does did doing have has had having can could may might must shall should will would and or but if then than as at by for from in into of on onto out over to up upon with who whom whose what which when where why how').split(' '));
  function fail(code,message) { var e=new Error(message);e.code=code;throw e; }
  function object(v) { return !!v && typeof v==='object' && !Array.isArray(v); }
  function text(v,max) { return typeof v==='string' && v.length>0 && v.length<=(max||16384); }
  function hash(v) { return typeof v==='string' && /^[a-f0-9]{64}$/.test(v); }
  function exact(v,keys,label) { if(!object(v)||Object.keys(v).some(function(k){return !keys.includes(k);}))fail('INVALID_COMMENTS',label+' has unsupported fields or shape'); }
  function copy(v,limit) { try{return Snapshot.dispatchCopy(v,limit||INPUT);}catch(e){if(e.code==='REVISION_BUDGET')fail('COMMENT_BUDGET','Comment JSON admission byte/value/depth limit reached');throw e;} }
  function limits(request) {
    var raw=request&&request.op==='replay'&&request.replay?request.replay.request:request;
    if(raw&&raw.budgets!=null&&!object(raw.budgets))fail('INVALID_BUDGET','budgets must be an object');
    var l=Object.assign({},LIMITS,raw&&raw.budgets||{});
    Object.keys(l).forEach(function(k){if(!LIMITS[k]||!Number.isSafeInteger(l[k])||l[k]<1||l[k]>LIMITS[k])fail('INVALID_BUDGET','Unsupported comment budget '+k);});return l;
  }
  function admitRequest(q) { var l=limits(q);return copy(q,Math.min(INPUT,l.maxRetainedBytes,l.maxOutputBytes)); }
  function descriptor(m) {
    if(m==null)return null;
    exact(m,['id','revision','artifactSha256','dimension','normalization','pooling','tokenizerSha256'],'model');
    if(!text(m.id)||!text(m.revision)||!hash(m.artifactSha256)||!Number.isSafeInteger(m.dimension)||m.dimension<1||m.dimension>1536||
      !['l2','none'].includes(m.normalization)||!text(m.pooling)||!hash(m.tokenizerSha256))fail('INVALID_COMMENT_MODEL','Pin model ID/revision/artifact/tokenizer hashes, pooling, normalization and dimension 1..1536');
    return m;
  }
  function vector(v,m) {
    if(!m||!Array.isArray(v)||v.length!==m.dimension)fail('INVALID_COMMENT_VECTOR','Vector dimension differs from pinned model');
    var square=0;
    for(var x of v){if(typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1e6)fail('INVALID_COMMENT_VECTOR','Vector components must be finite and bounded');square+=x*x;}
    if(!(square>0)||!Number.isFinite(square)||m.normalization==='l2'&&Math.abs(square-1)>0.01)fail('INVALID_COMMENT_VECTOR','Vector norm is invalid for pinned normalization');
    return v;
  }
  function normalize(q) {
    exact(q,['op','repositoryScope','model','previous','vectors','vectorProvenance','index','query','queryVector','queryProvenance','limit','kinds','nodeId','occurrenceId','texts','timeoutMs','budgets'],'request');
    if(!OPS.includes(q.op))fail('INVALID_REQUEST','Unknown comment operation');
    var out=Object.assign({},q);out.budgets=limits(q);out.timeoutMs=q.timeoutMs==null?2000:q.timeoutMs;
    if(!Number.isSafeInteger(out.timeoutMs)||out.timeoutMs<1||out.timeoutMs>5000)fail('INVALID_TIMEOUT','timeoutMs requires 1..5000');
    if(q.op!=='commentDetails'&&!text(q.repositoryScope,512))fail('INVALID_COMMENT_SCOPE','Explicit local repositoryScope is required');
    if(q.op==='indexComments'){out.model=descriptor(q.model);out.vectors=q.vectors||[];out.vectorProvenance=q.vectorProvenance||null;}
    if(q.op==='searchComments'){
      if(!text(q.query,2048))fail('INVALID_COMMENTS','query requires 1..2048 characters');out.limit=q.limit==null?20:q.limit;
      if(!Number.isSafeInteger(out.limit)||out.limit<1||out.limit>100)fail('INVALID_COMMENTS','limit requires 1..100');
      out.kinds=q.kinds==null?[]:q.kinds;
      if(!Array.isArray(out.kinds)||out.kinds.length>8||!out.kinds.every(function(k){return ['effective-doc','line','block','outer-line-doc','inner-line-doc','outer-block-doc','inner-block-doc'].includes(k);}))fail('INVALID_COMMENTS','Unsupported comment kinds');
      out.queryVector=q.queryVector||null;out.queryProvenance=q.queryProvenance||null;
    }
    if(q.op==='commentDetails'&&!text(q.nodeId)&&!text(q.occurrenceId))fail('INVALID_COMMENTS','Details require exact nodeId or occurrenceId');
    return out;
  }
  function freeze(v) { if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v; }
  function capability() { return {version:VERSION,indexVersion:INDEX_VERSION,lexicalQueryPolicy:'english-function-words-v1',chunker:CHUNKER,operations:OPS.slice(),inputBytes:INPUT,limits:copy(LIMITS),
    maxRecords:10000,maxChunks:5000,chunkUtf16:1024,embeddingText:'exact text-only substrings; no inferred summaries or merged signatures',
    provider:'trusted host configuration plus explicit embedComments action; never imported from corpus/index/replay',
    providerProtocol:'POST {model:<pinned descriptor>,inputs:[{id,text}]}; response {model:<same descriptor>,vectors:[{id,vector}]}',
    maxEmbeddingBatch:16,maxEmbeddingTexts:256,providerResponseBytes:1048576,providerTimeoutMs:5000,
    automaticModelCalls:false,replayProviderCalls:false,graphExpansion:'separate neighbors operation',commentsAreExecutionOrSecurityProof:false,
    provenance:'caller-owned imported vectors; hash integrity is not provider authenticity',
    captureAdmission:'one optional bounded corpus copy at capture construction; no graph clone/hash/reindex per query'}; }

  // Only host/UI configuration can enter this function. No saved payload is
  // allowed to choose a URL. Redirects, credentials and ambient cookies are off.
  function providerConfig(config) {
    exact(config,['url','allowExternal','model'],'provider configuration');descriptor(config.model);
    if(typeof URL!=='function')fail('COMMENT_PROVIDER_UNAVAILABLE','URL validation is unavailable in this host');
    if(typeof config.url!=='string')fail('INVALID_COMMENT_PROVIDER','Provider URL must be a string');
    var url;try{url=new URL(config.url);}catch(_){fail('INVALID_COMMENT_PROVIDER','Provider URL is invalid');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)fail('INVALID_COMMENT_PROVIDER','Use an HTTP(S) URL without userinfo, query or fragment');
    var local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(!local&&config.allowExternal!==true)fail('INVALID_COMMENT_PROVIDER','External endpoints require explicit trusted allowExternal:true configuration');
    if(config.allowExternal!=null&&typeof config.allowExternal!=='boolean')fail('INVALID_COMMENT_PROVIDER','allowExternal must be boolean');
    return freeze(copy({url:url.href,allowExternal:config.allowExternal===true,model:config.model}));
  }
  function create(context) {
    var capture=freeze(copy(context.capture,65536)), corpora=[], recordCount=0, corpusBytes=0, admissionDiagnostics=[];
    if(!hash(capture.contentSha256))fail('INVALID_COMMENTS','Captured graph content hash is required');
    // The already loaded graph is inspected once. Only optional carriers and
    // exact target IDs are retained; a 365MB legacy graph is not copied.
    var links=new Map(), incoming=[],potential=new Set();
    for(var n of context.nodes||[]){if(n.attributes&&n.attributes.kind==='comment_corpus'&&n.attributes.comment_corpus!=null)incoming.push(n.attributes.comment_corpus);}
    for(var raw of incoming){
      if(typeof raw!=='string'||raw.length>INPUT||corpusBytes+raw.length*2>16777216){admissionDiagnostics.push('Optional comment corpus exceeds capture admission bound');continue;}
      corpusBytes+=raw.length*2;var c;
      try{c=copy(JSON.parse(raw),INPUT);}catch(_){admissionDiagnostics.push('Malformed or oversized optional comment corpus');continue;}
      if(!object(c)||!object(c.scope)||!object(c.coverage)||!Array.isArray(c.sourcePins)||!text(c.exportStatus)||c.schemaVersion!==1||!text(c.extractor)||!hash(c.scopeSha256)||!hash(c.artifactSha256)||!hash(c.sourceSnapshotSha256)||!hash(c.buildSha256)||!Array.isArray(c.records)||c.records.length+recordCount>10000){admissionDiagnostics.push('Unsupported optional comment corpus identity/record bound');continue;}
      recordCount+=c.records.length;for(var r of c.records){if(r&&text(r.graphNodeId))potential.add(r.graphNodeId);if(r&&text(r.fileNodeId))potential.add(r.fileNodeId);}corpora.push(freeze(c));
    }
    if(potential.size)for(var n of context.nodes||[])if(potential.has(n.id)){if(!links.has(n.id))links.set(n.id,n);else links.set(n.id,null);}
    corpora.sort(function(a,b){return a.scopeSha256.localeCompare(b.scopeSha256);});
    var provider=null;
    function configureProvider(config) { provider=config==null?null:providerConfig(config);return provider?{configured:true,external:provider.allowExternal,model:copy(provider.model)}:{configured:false}; }
    function session(q,runtime) {
      runtime=runtime||{};var start=(runtime.now||Date.now)(), work=0,retained=0,next=256,channel=null,resume=null,first=true;
      function check(){if(runtime.cancelled&&runtime.cancelled())fail('CANCELLED','Comment operation cancelled');if((runtime.now||Date.now)()-start>=q.timeoutMs)fail('TIMEOUT','Comment operation time budget reached');}
      async function spend(n){work+=n==null?1:n;check();if(work>q.budgets.maxWork)fail('COMMENT_BUDGET','Comment work budget reached');if(work>=next){next=work+256;
        if(first){first=false;await new Promise(function(r){setTimeout(r,0);});}
        else if(typeof setImmediate==='function')await new Promise(function(r){setImmediate(r);});
        else if(typeof MessageChannel==='function'){if(!channel){channel=new MessageChannel();channel.port1.onmessage=function(){var r=resume;resume=null;r();};}await new Promise(function(r){resume=r;channel.port2.postMessage(null);});}
        else await new Promise(function(r){setTimeout(r,0);});check();}}
      async function wire(v,ceiling,reserve,h){var bytes=0;async function token(t){var size=0;for(var i=0;i<t.length;i++){var c=t.charCodeAt(i);size+=c<128?1:c<2048?2:c>=0xD800&&c<=0xDBFF&&i+1<t.length&&t.charCodeAt(i+1)>=0xDC00&&t.charCodeAt(i+1)<=0xDFFF?(i++,4):3;if((i&255)===0)await spend();}bytes+=size;if(bytes>ceiling)fail('COMMENT_BUDGET','Comment wire byte limit reached');if(h)h.update(t);}
        async function visit(x){await spend();if(x===null||typeof x!=='object'){if(typeof x==='string'){await token('"');for(var i=0;i<x.length;){var end=Math.min(i+1024,x.length);if(end<x.length&&/[\uD800-\uDBFF]/.test(x[end-1]))end--;await token(JSON.stringify(x.slice(i,end)).slice(1,-1));i=end;}await token('"');}else await token(JSON.stringify(x));return;}
          var array=Array.isArray(x),keys=array?null:Object.keys(x).sort();await token(array?'[':'{');for(var j=0;j<(array?x.length:keys.length);j++){if(j)await token(',');if(!array){await token(JSON.stringify(keys[j]));await token(':');}await visit(array?x[j]:x[keys[j]]);}await token(array?']':'}');}
        await visit(v);if(reserve){retained+=bytes;if(retained>q.budgets.maxRetainedBytes)fail('COMMENT_BUDGET','Comment retained wire reservation reached');}return bytes;}
      async function digest(v){var h=Evidence.hasher();await wire(v,q.budgets.maxRetainedBytes,false,h);return h.digest('hex');}
      async function textHash(t){var h=Evidence.hasher();for(var i=0;i<t.length;){var end=Math.min(i+1024,t.length);if(end<t.length&&/[\uD800-\uDBFF]/.test(t[end-1]))end--;await spend(Math.ceil((end-i)/128));h.update(t.slice(i,end));i=end;}return h.digest('hex');}
      async function retain(v){await wire(v,q.budgets.maxRetainedBytes,true);return v;}
      return {spend:spend,check:check,wire:wire,digest:digest,textHash:textHash,retain:retain,close:function(){if(channel){channel.port1.onmessage=null;channel.port1.close();channel.port2.close();}}};
    }
    // Capture-owned admission is atomic and bounded by the optional corpus
    // limits above. All original records, base chunks and hashes are computed
    // once; query budgets never clone or hash the full captured graph.
    function exactLink(r,c,file){
      var id=file?r.fileNodeId:r.graphNodeId,n=id&&links.get(id),a=n&&n.attributes||{},scope=c.scope||{},target=scope.target||{},d=r.declaration;
      if(!n||a.package_id!==scope.packageId||!text(r.file)||n.source_file!==r.file)return null;
      if(file)return a.kind==='file'?id:null;
      var kinds;try{kinds=JSON.parse(a.target_kind);}catch(_){return null;}
      if(!d||a.path!==d.path||a.kind!==d.kind||a.target_name!==target.name||a.target_src_path!==target.source||JSON.stringify(kinds)!==JSON.stringify(target.kind)||
        d.begin&&n.source_location!==d.begin[0]||r.sourceAbsolute&&a.source_absolute&&r.sourceAbsolute!==a.source_absolute)return null;
      return id;
    }
    var rows=[],pins=[],diagnostics=admissionDiagnostics.slice(),seenRecords=new Set(),baseChunks=new Map(),baseCount=0;
    for(var c of corpora){pins.push({scopeSha256:c.scopeSha256,artifactSha256:c.artifactSha256,sourceSnapshotSha256:c.sourceSnapshotSha256,buildSha256:c.buildSha256,corpusSha256:Evidence.digest(c,true)});
      for(var r of c.records){
        if(!object(r)||!text(r.id)||r.occurrenceId!=null&&!text(r.occurrenceId)||r.graphNodeId!=null&&!text(r.graphNodeId)||r.fileNodeId!=null&&!text(r.fileNodeId)||typeof r.text!=='string'||r.text.length>65536||!['effective-doc','line','block','outer-line-doc','inner-line-doc','outer-block-doc','inner-block-doc'].includes(r.kind)||typeof r.ownership!=='string'){diagnostics.push('Malformed comment record omitted');continue;}
        var key=Evidence.digest([c.scopeSha256,r.id],true);if(seenRecords.has(key)){diagnostics.push('Duplicate original comment record omitted');continue;}seenRecords.add(key);
        var row={key:key,record:r,scope:c.scope,scopeSha256:c.scopeSha256,extractor:c.extractor,artifactSha256:c.artifactSha256,buildSha256:c.buildSha256,sourceSnapshotSha256:c.sourceSnapshotSha256,
          graphNodeId:exactLink(r,c,false),fileNodeId:exactLink(r,c,true),graphBinding:'conjunctive exact ID/package/target/path/kind/source; collapsed or missing links remain unavailable'};
        var pieces=[];
        for(var start=0;start<r.text.length;){var end=Math.min(start+1024,r.text.length);if(end<r.text.length&&/[\uD800-\uDBFF]/.test(r.text[end-1]))end--;var t=r.text.slice(start,end),h=Evidence.hasher();h.update(t);pieces.push({text:t,textSha256:h.digest('hex'),startUtf16:start,endUtf16:end});start=end;}
        baseCount+=pieces.length;baseChunks.set(key,freeze(pieces));rows.push(freeze(row));
      }
    }
    var catalog=freeze({rows:rows,pins:pins,diagnostics:diagnostics,coverage:corpora.map(function(c){return {scope:c.scope,exportStatus:c.exportStatus,sourcePins:c.sourcePins,coverage:c.coverage};})});
    async function records(s){await s.spend();return catalog;}
    async function validateIndex(index,q,s,allowOld) {
      exact(index,['schemaVersion','version','chunker','captureSha256','repositoryScope','model','corpusPins','chunks','coverage','vectorProvenance','sha256'],'index');
      if(!Object.prototype.hasOwnProperty.call(index,'model')||!Array.isArray(index.corpusPins)||!object(index.coverage)||!object(index.vectorProvenance)||index.schemaVersion!==1||index.version!==INDEX_VERSION||index.chunker!==CHUNKER||!hash(index.sha256)||!hash(index.captureSha256)||index.repositoryScope!==q.repositoryScope)fail('COMMENT_INDEX_MISMATCH','Index version/repository scope differs');
      descriptor(index.model);if(!Array.isArray(index.chunks)||index.chunks.length>5000)fail('INVALID_COMMENTS','Index chunks exceed 5000');
      var payload=Object.assign({},index);delete payload.sha256;if(await s.digest(payload)!==index.sha256)fail('COMMENT_INTEGRITY','Index payload hash differs');
      if(!allowOld&&index.captureSha256!==capture.contentSha256)fail('COMMENT_SNAPSHOT_MISMATCH','Comment index belongs to another graph snapshot; rebuild against current capture');
      var seen=new Set();
      for(var c of index.chunks){await s.spend();exact(c,['key','recordKey','occurrenceId','kind','text','textSha256','startUtf16','endUtf16','extractor','scopeSha256','vector'],'chunk');
        if(!hash(c.key)||!hash(c.recordKey)||!hash(c.textSha256)||!text(c.text,1024)||!text(c.occurrenceId)||!text(c.extractor)||!hash(c.scopeSha256)||seen.has(c.key))fail('INVALID_COMMENTS','Invalid/duplicate index chunk');seen.add(c.key);
        if(await s.textHash(c.text)!==c.textSha256||!Number.isSafeInteger(c.startUtf16)||!Number.isSafeInteger(c.endUtf16)||c.startUtf16<0||c.endUtf16-c.startUtf16!==c.text.length)fail('COMMENT_INTEGRITY','Chunk text/geometry hash differs');
        if(await chunkKey(c,index.repositoryScope,index.model,s)!==c.key)fail('COMMENT_INTEGRITY','Chunk configuration key differs');if(c.vector!=null)vector(c.vector,index.model);
      }
      return index;
    }
    async function chunkKey(c,scope,model,s) {return await s.digest({repositoryScope:scope,scopeSha256:c.scopeSha256,occurrenceId:c.occurrenceId,recordKey:c.recordKey,kind:c.kind,startUtf16:c.startUtf16,textSha256:c.textSha256,extractor:c.extractor,chunker:CHUNKER,model:model});}
    async function build(q,s) {
      var data=await records(s),chunks=[],pending=[],reused=0,added=0,prior=new Map(),provided=new Map();
      if(q.previous){await validateIndex(q.previous,q,s,true);for(var c of q.previous.chunks){await s.spend();if(c.vector)prior.set(c.key,c.vector);}}
      if(!Array.isArray(q.vectors)||q.vectors.length>5000)fail('INVALID_COMMENT_VECTOR','vectors requires at most 5000 keyed entries');
      if(q.vectors.length&&(!object(q.vectorProvenance)||!object(q.vectorProvenance.model)||await s.digest(q.vectorProvenance.model)!==await s.digest(q.model)))fail('INVALID_COMMENT_VECTOR','Imported vectors require caller-owned provenance');
      for(var v of q.vectors){await s.spend();exact(v,['key','vector'],'vector');if(!hash(v.key)||provided.has(v.key))fail('INVALID_COMMENT_VECTOR','Invalid/duplicate vector key');provided.set(v.key,vector(v.vector,q.model));}
      var used=new Set();
      for(var row of data.rows){var r=row.record;
        for(var piece of baseChunks.get(row.key)){await s.spend();if(chunks.length>=5000)fail('COMMENT_BUDGET','Comment index exceeds 5000 chunks; select a smaller capture');
          var c={recordKey:row.key,occurrenceId:r.occurrenceId||r.id,kind:r.kind,text:piece.text,textSha256:piece.textSha256,startUtf16:piece.startUtf16,endUtf16:piece.endUtf16,extractor:row.extractor,scopeSha256:row.scopeSha256,vector:null};
          c.key=await chunkKey(c,q.repositoryScope,q.model,s);
          if(provided.has(c.key)){c.vector=provided.get(c.key);used.add(c.key);added++;}else if(q.model&&prior.has(c.key)){c.vector=prior.get(c.key);reused++;}
          if(q.model&&!c.vector){var need={key:c.key,text:c.text,textSha256:c.textSha256,occurrenceId:c.occurrenceId};await s.retain(need);pending.push(need);}
          await s.retain(c);chunks.push(c);
        }
      }
      for(var key of provided.keys())if(!used.has(key))fail('INVALID_COMMENT_VECTOR','Vector key does not belong to current exact corpus/model/repository scope');
      var provenanceSources=reused&&q.previous&&Array.isArray(q.previous.vectorProvenance.sources)?q.previous.vectorProvenance.sources.slice():[];
      if(added&&q.vectorProvenance){var incomingHash=await s.digest(q.vectorProvenance),exists=false;for(var source of provenanceSources){await s.spend();if(await s.digest(source)===incomingHash)exists=true;}if(!exists)provenanceSources.push(q.vectorProvenance);}
      if(provenanceSources.length>64)fail('COMMENT_BUDGET','Vector provenance exceeds 64 source batches; start a bounded fresh index');
      var index={schemaVersion:1,version:INDEX_VERSION,chunker:CHUNKER,captureSha256:capture.contentSha256,repositoryScope:q.repositoryScope,model:q.model,corpusPins:data.pins,chunks:chunks,
        coverage:{status:corpora.length?'observed-partial':'missing-comment-metadata',records:data.rows.length,corpora:data.coverage,diagnostics:data.diagnostics,
          semantic:q.model?(pending.length?'missing-vectors':'embedding-ready'):'missing-embedding-configuration',intentOnly:true},
        vectorProvenance:{sources:provenanceSources,authenticity:'caller-owned; not independently attested'}};
      index.sha256=await s.digest(index);return {index:index,pending:pending,incremental:{reusedVectors:reused,providedVectors:added,missingVectors:pending.length,oldChunks:q.previous?q.previous.chunks.length:0,currentChunks:chunks.length}};
    }
    async function bound(index,q,s) {
      await validateIndex(index,q,s,false);var data=await records(s);
      if(await s.digest(index.corpusPins)!==await s.digest(data.pins))fail('COMMENT_SNAPSHOT_MISMATCH','Index corpus provenance differs from current capture');
      var byKey=new Map(data.rows.map(function(r){return [r.key,r];}));
      if(index.chunks.length!==baseCount)fail('COMMENT_SNAPSHOT_MISMATCH','Index omits or adds current source chunks');
      var geometry=new Set();
      // Check exact current record/chunk bindings, not only caller recomputable hashes.
      for(var c of index.chunks){await s.spend();var row=byKey.get(c.recordKey),r=row&&row.record;
        var location=c.recordKey+':'+c.startUtf16;if(geometry.has(location))fail('COMMENT_SNAPSHOT_MISMATCH','Duplicate source chunk geometry');geometry.add(location);
        var piece=(baseChunks.get(c.recordKey)||[]).find(function(p){return p.startUtf16===c.startUtf16&&p.endUtf16===c.endUtf16;});
        if(!r||!piece||piece.text!==c.text||c.scopeSha256!==row.scopeSha256||c.extractor!==row.extractor||c.kind!==r.kind||c.occurrenceId!==(r.occurrenceId||r.id))fail('COMMENT_SNAPSHOT_MISMATCH','Chunk has no exact current source occurrence');
      }
      return {data:data,byKey:byKey};
    }
    function words(t) {return t.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[];}
    async function search(q,s) {
      var attached=await bound(q.index,q,s),queryWords=Array.from(new Set(words(q.query).filter(function(w){return !LEXICAL_FUNCTION_WORDS.has(w);}))),lexical=[],semantic=[];
      if(q.queryVector!=null){vector(q.queryVector,q.index.model);if(!object(q.queryProvenance)||!object(q.queryProvenance.model)||await s.digest(q.queryProvenance.model)!==await s.digest(q.index.model))fail('INVALID_COMMENT_VECTOR','Query vector requires provenance for the exact pinned model');}
      for(var c of q.index.chunks){await s.spend();if(q.kinds.length&&!q.kinds.includes(c.kind))continue;
        var counts=new Map();for(var w of words(c.text)){await s.spend();counts.set(w,(counts.get(w)||0)+1);}
        var score=0;for(var w of queryWords){await s.spend();if(counts.has(w))score+=1+Math.log(counts.get(w));}if(score>0)lexical.push({chunk:c,score:score});
        if(q.queryVector&&c.vector){var dot=0,a=0,b=0;for(var i=0;i<c.vector.length;i++){await s.spend();dot+=q.queryVector[i]*c.vector[i];a+=q.queryVector[i]*q.queryVector[i];b+=c.vector[i]*c.vector[i];}
          var similarity=dot/Math.sqrt(a*b);if(Number.isFinite(similarity))semantic.push({chunk:c,score:similarity});}
      }
      function order(a,b){return b.score-a.score||a.chunk.key.localeCompare(b.chunk.key);}await s.spend(Math.ceil((lexical.length+semantic.length)*Math.log2(q.index.chunks.length+1)*2));lexical.sort(order);semantic.sort(order);s.check();
      var fused=new Map();
      for(var pair of [[lexical,'lexical'],[semantic,'embedding']])for(var i=0;i<pair[0].length;i++){await s.spend();var candidate=pair[0][i],value=fused.get(candidate.chunk.key)||{chunk:candidate.chunk,rrf:0,lexical:null,embedding:null};value.rrf+=1/(60+i+1);value[pair[1]]={rank:i+1,score:candidate.score};fused.set(candidate.chunk.key,value);}
      await s.spend(Math.ceil(fused.size*Math.log2(fused.size+1)*2));var ranked=Array.from(fused.values()).sort(function(a,b){return b.rrf-a.rrf||a.chunk.key.localeCompare(b.chunk.key);}),results=[];
      for(var hit of ranked.slice(0,q.limit)){await s.spend();var row=attached.byKey.get(hit.chunk.recordKey);results.push({rank:results.length+1,rrf:hit.rrf,lexical:hit.lexical,embedding:hit.embedding,chunk:hit.chunk,
        matchedText:hit.chunk.text,record:row.record,scope:row.scope,graphNodeId:row.graphNodeId,fileNodeId:row.fileNodeId,graphBinding:row.graphBinding,
        provenance:{artifactSha256:row.artifactSha256,sourceSnapshotSha256:row.sourceSnapshotSha256,buildSha256:row.buildSha256,extractor:row.extractor}});}
      return {results:results,total:ranked.length,truncated:ranked.length>q.limit,indexSha256:q.index.sha256,model:q.index.model,
        mode:q.queryVector&&semantic.length?'hybrid-lexical-embedding':'lexical-only',coverage:q.index.coverage,
        semanticStatus:!q.index.model?'missing-embedding-configuration':!q.queryVector?'missing-query-vector':semantic.length<q.index.chunks.length?'partial-vector-coverage':'embedding-evaluated',
        relevance:'RRF of text evidence only; cosine rank is not a probability or a relevance/authorization proof. Unrelated queries may still have nearest vectors.'};
    }
    async function embed(q,s,runtime) {
      if(!provider)fail('COMMENT_PROVIDER_UNAVAILABLE','Configure a trusted local embedding endpoint before the explicit embedding action');
      if(!Array.isArray(q.texts)||!q.texts.length||q.texts.length>256)fail('INVALID_COMMENTS','Embedding action accepts 1..256 exact texts');
      var configured=provider, fetcher=context.fetch|| (typeof fetch==='function'?fetch:null), entries=[],ids=new Set();
      if(!fetcher||typeof AbortController!=='function')fail('COMMENT_PROVIDER_UNAVAILABLE','This host lacks fetch/AbortController; import offline vectors');
      for(var t of q.texts){await s.spend();exact(t,['id','text'],'embedding input');if(!text(t.id,128)||!text(t.text,2048)||ids.has(t.id))fail('INVALID_COMMENTS','Embedding IDs must be unique and texts bounded');ids.add(t.id);}
      for(var at=0;at<q.texts.length;at+=16){s.check();var batch=q.texts.slice(at,at+16),controller=new AbortController(),started=Date.now(),timer=setInterval(function(){try{s.check();if(Date.now()-started>=5000)controller.abort();}catch(_){controller.abort();}},10);
        try{
          var response=await fetcher(configured.url,{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:configured.model,inputs:batch}),signal:controller.signal});
          s.check();if(!response.ok)fail('COMMENT_PROVIDER_ERROR','Embedding endpoint returned HTTP '+response.status);
          if(!response.body||!response.body.getReader)fail('COMMENT_PROVIDER_ERROR','Embedding endpoint must provide a bounded readable response');
          var reader=response.body.getReader(),chunks=[],bytes=0;
          while(true){s.check();var part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1048576){await reader.cancel();fail('COMMENT_PROVIDER_ERROR','Embedding response exceeds 1 MiB');}chunks.push(part.value);await s.spend(Math.ceil(part.value.byteLength/128));}
          var all=new Uint8Array(bytes),offset=0;for(var part of chunks){all.set(part,offset);offset+=part.byteLength;}
          var result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch(_){fail('COMMENT_PROVIDER_ERROR','Embedding response is not UTF-8 JSON');}
          exact(result,['model','vectors'],'embedding response');if(await s.digest(result.model)!==await s.digest(configured.model)||!Array.isArray(result.vectors)||result.vectors.length!==batch.length)fail('COMMENT_PROVIDER_ERROR','Endpoint model or response count differs');
          var expected=new Set(batch.map(function(t){return t.id;}));
          for(var v of result.vectors){await s.spend();exact(v,['id','vector'],'embedding response vector');if(!expected.delete(v.id))fail('COMMENT_PROVIDER_ERROR','Endpoint returned duplicate/unknown IDs');vector(v.vector,configured.model);entries.push({id:v.id,vector:v.vector,textSha256:await s.textHash(batch.find(function(t){return t.id===v.id;}).text)});}
        } catch(e){s.check();if(e.name==='AbortError')fail('COMMENT_PROVIDER_ERROR','Embedding endpoint timed out or was cancelled');throw e;} finally {clearInterval(timer);controller.abort();}
      }
      return {model:copy(configured.model),entries:entries,provenance:{kind:'explicit-http-response',model:copy(configured.model),endpointClass:['localhost','127.0.0.1','[::1]'].includes(new URL(configured.url).hostname)?'loopback':'explicit-external',configurationSha256:await s.digest(configured),textPins:entries.map(function(v){return {id:v.id,textSha256:v.textSha256};}),authenticity:'configured endpoint response; not independent model attestation'}};
    }
    async function query(request,runtime) {
      var owned=admitRequest(request),saved=owned.op==='replay'?owned.replay:null;
      if(saved){exact(owned,['op','replay'],'replay envelope');exact(saved,['schemaVersion','version','operation','captureSha256','requestHash','request'],'replay');
        if(saved.schemaVersion!==1||saved.version!==VERSION||saved.captureSha256!==capture.contentSha256||!hash(saved.requestHash)||saved.operation==='embedComments'||!object(saved.request)||saved.operation!==saved.request.op)fail('INVALID_REPLAY','Comment replay identity differs');}
      var raw=saved?saved.request:owned,q;try{q=normalize(raw);}catch(e){if(saved)fail('INVALID_REPLAY','Saved comment request is invalid: '+e.message);throw e;}
      var s=session(q,runtime),replayed=!!saved;
      try{
        // Integrity covers raw saved bytes/fields BEFORE normalized/default repair.
        var requestHash=await s.digest(saved?raw:q);
        if(saved&&(requestHash!==saved.requestHash||JSON.stringify(raw)!==JSON.stringify(q)))fail('INVALID_REPLAY','Comment replay integrity or complete normalized request differs');
        await s.retain(q);var data;
        if(q.op==='indexComments')data=await build(q,s);
        else if(q.op==='loadCommentIndex'){await bound(q.index,q,s);data={index:q.index,coverage:q.index.coverage};}
        else if(q.op==='searchComments')data=await search(q,s);
        else if(q.op==='commentDetails'){var all=await records(s),matches=[];for(var row of all.rows){await s.spend();if((!q.nodeId||row.graphNodeId===q.nodeId||row.fileNodeId===q.nodeId)&&(!q.occurrenceId||row.record.occurrenceId===q.occurrenceId))matches.push(row);}data={records:matches.slice(0,100),total:matches.length,truncated:matches.length>100,coverage:all.coverage,diagnostics:all.diagnostics};}
        else data=await embed(q,s,runtime);
        var response={schemaVersion:1,operation:q.op,version:VERSION,capture:capture,request:q,data:data,
          semantics:{basis:'author-written comment intent',executionProven:false,securityOrAuthorizationProven:false,graphExpansion:'separate'},completion:{complete:true}};
        if(q.op!=='embedComments')response.replay={schemaVersion:1,version:VERSION,operation:q.op,captureSha256:capture.contentSha256,requestHash:requestHash,request:q};
        response.replayed=true;await s.wire(response,q.budgets.maxOutputBytes,true);if(response.replay)await s.wire({op:'replay',replay:response.replay},INPUT,false);
        s.check();if(!replayed)delete response.replayed;var result=copy(response,q.budgets.maxOutputBytes);s.check();return result;
      } finally{s.close();}
    }
    return {query:query,configureProvider:configureProvider};
  }
  return {VERSION:VERSION,CHUNKER:CHUNKER,operations:OPS,capability:capability,create:create,admitRequest:admitRequest,providerConfig:providerConfig};
});
