/* Authored regression controls; execution is owned by the independent validator. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const Engine=require('../src/comment-search.js'),Evidence=require('../src/analysis-evidence.js'),Analysis=require('../src/analysis-api.js'),F=require('../tests/fixtures/comment-search/fixture-graphs.cjs');
const scope='local:portable-fixture',make=(g=F.graph(),options={})=>Engine.create({capture:{contentSha256:Evidence.digest(g)},nodes:g.nodes,...options});
const index=(extra={})=>({op:'indexComments',repositoryScope:scope,...extra});
const find=(i,extra={})=>({op:'searchComments',repositoryScope:scope,index:i,query:'tampering with saved information',...extra});
async function seeded(engine=make()){const first=await engine.query(index({model:F.model}));const vectors=first.data.pending.map((p,i)=>({key:p.key,vector:i===2?[1,0,0]:[0,1,0]}));return (await engine.query(index({model:F.model,previous:first.data.index,vectors,vectorProvenance:{model:F.model,kind:'synthetic engine math only'}}))).data.index;}
test('fixed text-only groundtruth source lines are exact slices; six paraphrases contain no opaque symbol names',()=>{
 assert.equal(F.input.documents.length,8);for(const d of F.input.documents.slice(4))assert(F.source.includes(d.text),d.id);
 assert.equal(F.input.queries.filter(q=>q.expectedDocIds.length).length,6);assert.equal(F.input.queries.filter(q=>!q.expectedDocIds.length).length,2);
 for(const q of F.input.queries)for(const d of F.input.documents)assert(!q.text.includes(d.symbol));
});
test('lexical missing-model status, original details and legacy absence are explicit',async()=>{
 const e=make(),built=await e.query(index()),value=await e.query(find(built.data.index,{query:'digest'}));assert.equal(value.data.mode,'lexical-only');assert.equal(value.data.semanticStatus,'missing-embedding-configuration');assert(value.data.results.some(r=>r.record.occurrenceId==='occ:portable:03'));
 assert.equal(Engine.capability().version,'portable-comments-v2');assert.equal(Engine.capability().indexVersion,'portable-comments-v1');assert.equal(Engine.capability().lexicalQueryPolicy,'english-function-words-v1');assert.equal(value.version,'portable-comments-v2');assert.equal(value.replay.version,value.version);assert.equal(built.data.index.version,'portable-comments-v1');
 const details=await e.query({op:'commentDetails',nodeId:'item:portable:p03'});assert.equal(details.data.records.length,1);assert.equal(details.data.records[0].record.occurrenceId,'occ:portable:03');
 const old=F.graph();old.nodes=old.nodes.filter(n=>n.attributes.kind!=='comment_corpus');const legacy=await make(old).query(index());assert.equal(legacy.data.index.coverage.status,'missing-comment-metadata');assert.equal(legacy.data.index.chunks.length,0);
});
test('synthetic cosine/RRF controls do not pretend to measure model relevance',async()=>{
 const e=make(),i=await seeded(e),q=find(i,{query:'unrelated synthetic control',queryVector:[1,0,0],queryProvenance:{model:F.model,kind:'synthetic engine control'}}),v=await e.query(q);
 assert.equal(v.data.mode,'hybrid-lexical-embedding');assert.equal(v.data.results[0].record.occurrenceId,'occ:portable:03');assert.equal(v.data.results[0].embedding.rank,1);assert.equal(v.data.results[0].lexical,null);assert.equal(v.data.results[0].graphNodeId,'item:portable:p03');
 assert.deepEqual(await e.query({op:'replay',replay:v.replay}),{...v,replayed:true});assert.equal(v.semantics.securityOrAuthorizationProven,false);
});
test('English function words cannot create lexical fusion votes; content tokens and cosine ties survive independent scopes',async()=>{
 for(const [repositoryScope,term] of [['local:ranking-alpha','needle'],['local:ranking-beta','spark']]){
  const texts=['// Budgeted buffer allocation reserves capacity.','// An an an placeholder can be present.','// An placeholder may be pending.','// Be an placeholder in the queue.','// ID ip x ÉCLAIR cache_key-canary cache_key.','// '+term+' '+term+' '+term.toUpperCase()+'.','// '+term+'.','// No not never without.'];
  const g=F.change(F.graph(),c=>{c.scopeSha256=F.sha(repositoryScope);c.records.forEach((r,i)=>r.text=texts[i]);}),e=make(g),first=await e.query(index({repositoryScope,model:F.model}));
  const vectors=first.data.pending.map(p=>({key:p.key,vector:p.occurrenceId==='occ:portable:01'?[1,0,0]:p.occurrenceId==='occ:portable:03'?[-1,0,0]:[0,1,0]})),built=await e.query(index({repositoryScope,model:F.model,previous:first.data.index,vectors,vectorProvenance:{model:F.model,kind:'independent synthetic ranking controls'}}));
  const search=extra=>e.query(find(built.data.index,{repositoryScope,limit:8,...extra}));
  const semantic=await search({query:'How can an enormous answer be withheld?',queryVector:[1,0,0],queryProvenance:{model:F.model,kind:'synthetic cosine only'}});
  assert.equal(semantic.data.results[0].record.occurrenceId,'occ:portable:01');assert.equal(semantic.data.results[0].embedding.score,1);assert.equal(semantic.data.results[0].rrf,1/61);
  assert(semantic.data.results.every(r=>r.lexical===null),'function-word overlap adds no lexical vote');assert.equal(semantic.data.results.length,8,'zero and negative cosine remain honest nearest vectors');
  const zero=semantic.data.results.filter(r=>r.embedding.score===0);assert.equal(zero.length,6);assert.deepEqual(zero.map(r=>r.chunk.key),zero.map(r=>r.chunk.key).sort((a,b)=>a.localeCompare(b)));
  assert.equal(semantic.data.results.at(-1).embedding.score,-1);assert.equal(semantic.data.results.at(-1).record.occurrenceId,'occ:portable:03');
  for(const query of ['How can an answer be withheld?','an be the how can','unmatchedultravioletquasar'])assert.equal((await search({query})).data.results.length,0);
  const repeated=await search({query:term+' '+term});assert.deepEqual(repeated.data.results.map(r=>r.record.occurrenceId),['occ:portable:06','occ:portable:07']);assert.equal(repeated.data.results[0].lexical.score,1+Math.log(3));assert.equal(repeated.data.results[1].lexical.score,1);
  const hybrid=await search({query:term,queryVector:[1,0,0],queryProvenance:{model:F.model,kind:'synthetic fusion only'}});for(const id of ['occ:portable:06','occ:portable:07']){const hit=hybrid.data.results.find(r=>r.record.occurrenceId===id);assert(hit.lexical&&hit.embedding);assert.equal(hit.rrf,1/(60+hit.lexical.rank)+1/(60+hit.embedding.rank));}
  const tied=await search({query:'an placeholder'});assert.equal(tied.data.results.length,3);assert(tied.data.results.every(r=>r.lexical.score===1));assert.deepEqual(tied.data.results.map(r=>r.chunk.key),tied.data.results.map(r=>r.chunk.key).sort((a,b)=>a.localeCompare(b)));
  for(const query of ['id','IP','x','éclair','cache_key','canary']){const value=await search({query});assert.equal(value.data.results.length,1,query);assert.equal(value.data.results[0].record.occurrenceId,'occ:portable:05',query);}
  for(const query of ['no','not','never','without'])assert.equal((await search({query})).data.results[0].record.occurrenceId,'occ:portable:08','negation remains content evidence');
 }
});
test('incremental unchanged/content-only/delete/rename/model and repository-scope isolation',async()=>{
 const first=await seeded(),same=await make().query(index({model:F.model,previous:first}));assert.equal(same.data.incremental.reusedVectors,8);
 const edited=F.change(F.graph(),c=>{c.records[0].text+=' changed';c.artifactSha256=F.sha('new-doc-export');}),doc=await make(edited).query(index({model:F.model,previous:first}));assert.equal(doc.data.incremental.reusedVectors,7);assert.equal(doc.data.pending.length,1);
 const deleted=F.change(F.graph(),c=>c.records.splice(0,1)),drop=await make(deleted).query(index({model:F.model,previous:first}));assert.equal(drop.data.index.chunks.length,7);assert.equal(drop.data.incremental.reusedVectors,7);
 const renamed=F.change(F.graph(),c=>{c.records[0].id+='renamed';c.records[0].occurrenceId+='renamed';}),rename=await make(renamed).query(index({model:F.model,previous:first}));assert.equal(rename.data.incremental.reusedVectors,7);
 const model=await make().query(index({model:{...F.model,revision:'v2'},previous:first}));assert.equal(model.data.incremental.reusedVectors,0);
 await assert.rejects(make().query(index({repositoryScope:'other',model:F.model,previous:first})),{code:'COMMENT_INDEX_MISMATCH'});
 await assert.rejects(make(edited).query(find(first)),{code:'COMMENT_SNAPSHOT_MISMATCH'});
});
test('caller mutation never changes admitted corpus, indexes or in-flight request ownership',async()=>{
 const g=F.graph(),e=make(g);F.change(g,c=>c.records[0].text='mutated');const q=index(),pending=e.query(q);q.repositoryScope='changed';const built=await pending;assert(built.data.index.chunks[0].text.includes('Retries'));
 const saved=F.clone(built.data.index),search=find(saved,{query:'Retries'}),running=e.query(search);saved.chunks[0].text='mutated';search.query='different';const result=await running;assert.equal(result.request.query,'Retries');assert.equal(result.data.results[0].record.occurrenceId,'occ:portable:01');
});
test('replay raw integrity and complete normalized fields checked before default repair',async()=>{
 const e=make(),built=await e.query(index()),value=await e.query(find(built.data.index,{query:'digest'}));
 for(const edit of [r=>delete r.request.timeoutMs,r=>delete r.request.budgets,r=>delete r.request.limit,r=>delete r.request.kinds,r=>delete r.request.queryVector,r=>delete r.request.queryProvenance,r=>r.request.limit=null,r=>r.request.kinds=null,r=>r.request.queryVector=false,r=>r.version='portable-comments-v1',r=>r.captureSha256='0'.repeat(64)])for(const rehash of [false,true]){
  const replay=F.clone(value.replay);edit(replay);if(rehash)replay.requestHash=Evidence.digest(replay.request,true);const before=F.clone(replay);await assert.rejects(e.query({op:'replay',replay}),{code:'INVALID_REPLAY'});assert.deepEqual(replay,before);
 }
 const changed=F.clone(value.replay);changed.request.query='credential';await assert.rejects(e.query({op:'replay',replay:changed}),{code:'INVALID_REPLAY'});
 // A caller-recomputed integrity hash describes a new valid request, not an
 // authenticated copy of the old question. Source/capture pins still apply.
 changed.requestHash=Evidence.digest(changed.request,true);const before=F.clone(changed),fresh=await e.query(changed.request);
 assert.notEqual(changed.requestHash,value.replay.requestHash);assert.deepEqual(fresh.replay,changed);assert.equal(fresh.data.results[0].record.occurrenceId,'occ:portable:06');
 assert.deepEqual(await e.query({op:'replay',replay:changed}),{...fresh,replayed:true});assert.deepEqual(changed,before);
});
test('complete fresh/replay payloads share the lowest successful deterministic work boundary',async()=>{
 const e=make(),built=await e.query(index()),q=find(built.data.index,{query:'digest',timeoutMs:5000});let low=1,high=2000000,best;
 while(high-low>1){const mid=Math.floor((low+high)/2);try{best=await e.query({...q,budgets:{maxWork:mid}});high=mid;}catch(error){assert.equal(error.code,'COMMENT_BUDGET');low=mid;}}
 for(const maxWork of [high,high+1]){const value=await e.query({...q,budgets:{maxWork}});assert.deepEqual(await e.query({op:'replay',replay:value.replay}),{...value,replayed:true});}
 await assert.rejects(e.query({...q,budgets:{maxWork:high-1}}),{code:'COMMENT_BUDGET'});
});
test('index integrity cannot invent or omit source chunk bindings even after caller rehash',async()=>{
 const e=make(),built=await e.query(index());for(const edit of [i=>i.chunks.pop(),i=>i.chunks[0].text+='x',i=>i.chunks[0].occurrenceId='wrong']){const i=F.clone(built.data.index);edit(i);delete i.sha256;i.sha256=Evidence.digest(i,true);await assert.rejects(e.query(find(i)),error=>['COMMENT_INTEGRITY','COMMENT_SNAPSHOT_MISMATCH'].includes(error.code));}
});
test('Unicode chunks preserve surrogate pairs, exact text and SHA256 pins; large scoped capture is never read after admission',async()=>{
 const g=F.change(F.graph(),c=>c.records[0].text='x'.repeat(1023)+'🦀'+'é'.repeat(1100)),e=make(g),built=await e.query(index()),chunks=built.data.index.chunks.filter(c=>c.occurrenceId==='occ:portable:01');assert.equal(chunks.map(c=>c.text).join(''),F.corpus(g).records[0].text);for(const c of chunks)assert.equal(c.textSha256,F.sha(c.text));
 Object.defineProperty(g,'nodes',{get(){throw new Error('query must not revisit admitted graph');}});assert((await e.query(find(built.data.index,{query:'digest'}))).data.results.length>0);
});
test('bounded vectors/escaped JSON, missing provider and cooperative cancellation have no partial result',async()=>{
 const e=make();await assert.rejects(e.query({op:'embedComments',repositoryScope:scope,texts:[{id:'q',text:'example'}]}),{code:'COMMENT_PROVIDER_UNAVAILABLE'});
 await assert.rejects(e.query(index({model:{...F.model,dimension:100000}})),{code:'INVALID_COMMENT_MODEL'});
 await assert.rejects(e.query(index({budgets:{maxOutputBytes:100},vectorProvenance:{note:'\u0000'.repeat(100)}})),{code:'COMMENT_BUDGET'});
 let cancelled=false;const running=e.query(index({model:F.model}),{cancelled:()=>cancelled});setTimeout(()=>{cancelled=true;},0);await assert.rejects(running,{code:'CANCELLED'});
 const i=await seeded(e);await assert.rejects(e.query(find(i,{queryVector:[NaN,0,0],queryProvenance:{model:F.model}})));
});
test('provider URL is trusted config only, loopback by default; explicit action bounded and replay does not fetch',async t=>{
 for(const url of ['file:///tmp/model','http://user:pass@localhost/','https://external.invalid/','http://localhost/?secret=x'])assert.throws(()=>Engine.providerConfig({url,model:F.model}));
 let calls=0;const server=http.createServer((req,res)=>{calls++;let text='';req.on('data',b=>text+=b);req.on('end',()=>{const body=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:body.model,vectors:body.inputs.map(x=>({id:x.id,vector:[1,0,0]}))}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const e=make();e.configureProvider({url:'http://127.0.0.1:'+server.address().port+'/',model:F.model});const built=await e.query(index({model:F.model}));assert.equal(calls,0);
 const embedded=await e.query({op:'embedComments',repositoryScope:scope,texts:built.data.pending.map(p=>({id:p.key,text:p.text}))});assert.equal(calls,1);
 const populated=await e.query(index({model:F.model,previous:built.data.index,vectors:embedded.data.entries.map(v=>({key:v.id,vector:v.vector})),vectorProvenance:embedded.data.provenance}));await e.query({op:'replay',replay:populated.replay});assert.equal(calls,1);assert.equal(embedded.replay,undefined);
});
test('API and bounded CLI use the same index/search contracts and keep old ingress limits',async()=>{
 const g=F.graph(),api=Analysis.create(g),first=await api.query(index());assert.equal(first.error,undefined);const query=find(first.data.index,{query:'digest'}),value=await api.query(query);assert.deepEqual(value,await make(g,{capture:api.graph}).query(query));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bg-comments-cli-'));try{const graph=path.join(dir,'graph.json'),request=path.join(dir,'request.json');fs.writeFileSync(graph,JSON.stringify(g));fs.writeFileSync(request,JSON.stringify(query));const result=cp.spawnSync(process.execPath,[path.join(__dirname,'query-analysis.cjs'),'--graph',graph,'--comment-request-file',request],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);assert.equal(out.data.results[0].record.occurrenceId,'occ:portable:03');}finally{fs.rmSync(dir,{recursive:true});}
});

test('pinned measured model vectors retain fixed source/input/provenance and retrieve the six predeclared paraphrases',async()=>{
 const folder=path.join(__dirname,'../tests/fixtures/comment-search'),raw=fs.readFileSync(path.join(folder,'model-vectors.json')),measured=JSON.parse(raw),provenance=JSON.parse(fs.readFileSync(path.join(folder,'model-provenance.json'),'utf8'));
 assert.equal(F.sha(raw),'38c07152430f0923b609baf07f04a0657a2b412ca47e44cb3e7fcf4a00cbb653');assert.equal(measured.measured,true);assert.deepEqual(measured.input,F.input);assert.equal(provenance.sourceSha256,F.sha(F.source));assert.equal(provenance.inputSha256,F.sha(fs.readFileSync(path.join(folder,'model-input.json'))));
 const e=make(),initial=await e.query(index({model:measured.model})),byId=new Map(measured.documents.map(d=>[d.id,d])),vectorProvenance={model:measured.model,kind:'pinned-local-onnx-measurement',fixtureSha256:F.sha(raw),provenanceSha256:F.sha(fs.readFileSync(path.join(folder,'model-provenance.json')))};
 const vectors=initial.data.pending.map(p=>{const d=byId.get(p.occurrenceId);assert(d,p.occurrenceId);assert.equal(p.textSha256,d.textSha256);return {key:p.key,vector:d.vector};}),populated=await e.query(index({model:measured.model,previous:initial.data.index,vectors,vectorProvenance}));
 for(const declared of F.input.queries){const measuredQuery=measured.queries.find(q=>q.id===declared.id);assert.equal(measuredQuery.textSha256,F.sha(declared.text));const value=await e.query(find(populated.data.index,{query:declared.text,queryVector:measuredQuery.vector,queryProvenance:vectorProvenance,limit:8}));assert.equal(value.data.mode,'hybrid-lexical-embedding');
  const top=value.data.results.slice(0,3).map(r=>r.record.occurrenceId);for(const id of declared.expectedDocIds)assert(top.includes(id),declared.id+' expected '+id+' in top 3; got '+top.join(','));
  if(!declared.expectedDocIds.length)assert(value.data.relevance.includes('Unrelated queries may still have nearest vectors'));
  assert.deepEqual(await e.query({op:'replay',replay:value.replay}),{...value,replayed:true});
 }
});
test('collapsed graph IDs never navigate a different package, target, source or original path',async()=>{
 for(const mutate of [n=>n.attributes.package_id='other-package',n=>n.attributes.target_name='other-target',n=>n.attributes.target_kind='["bin"]',n=>n.attributes.path='portable::different',n=>n.source_file='elsewhere.rs']){
  const g=F.graph();mutate(g.nodes.find(n=>n.id==='item:portable:p03'));const value=await make(g).query({op:'commentDetails',occurrenceId:'occ:portable:03'});assert.equal(value.data.records[0].graphNodeId,null);assert.equal(value.data.records[0].record.occurrenceId,'occ:portable:03');assert.equal(value.data.records[0].fileNodeId,'file:portable:source');
 }
});

// Root validation must bind these to actual fresh capture outputs. Absence is a
// visible skip in ordinary unit runs, never evidence for real capture acceptance.
const capturePath=process.env.BUILD_GRAPH_COMMENT_CAPTURE,beforePath=process.env.BUILD_GRAPH_COMMENT_BEFORE,afterPath=process.env.BUILD_GRAPH_COMMENT_AFTER;
const Capture=require('../tests/fixtures/comment-search/capture-contract.cjs');
const contextAfterPath=process.env.BUILD_GRAPH_COMMENT_CONTEXT_AFTER;
test('actual Cargo-only default-feature change invalidates effective docs at unchanged physical source identity',{skip:!contextAfterPath},async()=>{
 assert(beforePath,'the original baseline capture is required');const before=Capture.captured(beforePath),after=Capture.captured(contextAfterPath),corpora=g=>g.nodes.filter(n=>n.attributes.kind==='comment_corpus').map(n=>JSON.parse(n.attributes.comment_corpus)),left=corpora(before.graph),right=corpora(after.graph);
 assert.equal(left.length,2);assert.equal(right.length,2);
 for(const old of left){
  const current=right.find(c=>c.scopeSha256===old.scopeSha256);assert(current,'same physical package/target/source scope');assert.deepEqual(current.scope,old.scope);assert.deepEqual(current.sourcePins,old.sourcePins,'all Rust source bytes remain identical across the Cargo-only capture');assert.equal(current.sourceSnapshotSha256,old.sourceSnapshotSha256);
  assert.equal(old.exportStatus,'successful-rustdoc-observation');assert.equal(current.exportStatus,'successful-rustdoc-observation');assert.equal(current.build.selectedContext.status,'observed-selected-context');assert.equal(old.build.selectedContext.status,'observed-selected-context');assert.notEqual(current.build.selectedContext.sha256,old.build.selectedContext.sha256,'configuration has its independent freshness pin');
 }
 const old=left.find(c=>c.scope.target.kind.includes('bin')),current=right.find(c=>c.scopeSha256===old.scopeSha256),docs=c=>c.records.filter(r=>r.kind==='effective-doc');
 const prior=docs(old).find(r=>r.text==='Default configuration documentation.');assert(prior);assert(!docs(old).some(r=>r.text==='Blue configuration documentation.'));const changed=docs(current).find(r=>r.text==='Blue configuration documentation.');assert(changed);assert.equal(changed.occurrenceId,prior.occurrenceId);assert(!docs(current).some(r=>r.text==='Default configuration documentation.'));
 const firstApi=Analysis.create(before.graph,{rawText:before.rawText}),secondApi=Analysis.create(after.graph,{rawText:after.rawText}),first=await Capture.seeded(q=>firstApi.query(q)),next=await secondApi.query(index({model:Capture.measured.model,previous:first.index}));assert.equal(next.error,undefined);assert.equal(next.data.incremental.reusedVectors,8,'all measured source documents are unchanged');
 const selected=await secondApi.query({op:'commentDetails',occurrenceId:changed.occurrenceId});assert.equal(selected.error,undefined);assert(selected.data.records.some(r=>r.record.text===changed.text));assert(!selected.data.records.some(r=>r.record.text===prior.text));
 const stale=await secondApi.query(find(first.index));assert.equal(stale.error.code,'COMMENT_SNAPSHOT_MISMATCH');
});
test('actual compiled capture binds measured text vectors to exact compiler/source occurrences',{skip:!capturePath},async()=>{
 const {graph,rawText}=Capture.captured(capturePath),api=Analysis.create(graph,{rawText}),query=q=>api.query(q),built=await Capture.seeded(query);
 await Capture.ownershipControls(query,graph);
 for(const row of built.rows.values()){Capture.exactLinks(row,graph);assert(row.graphNodeId||row.fileNodeId,'fresh fixture occurrence has exact graph-or-file navigation');}
 for(const q of built.model.input.queries){const value=Capture.relevance(await query(Capture.search(built.index,q)),q);for(const hit of value.data.results)Capture.exactLinks(hit,graph);assert.deepEqual(await query({op:'replay',replay:value.replay}),{...value,replayed:true});}
});
test('actual before/after doc edit reuses unchanged vectors at the SAME physical package/target/source identity',{skip:!beforePath&&!afterPath},async()=>{
 assert(beforePath&&afterPath,'both paired capture paths are required');const before=Capture.captured(beforePath),after=Capture.captured(afterPath),firstApi=Analysis.create(before.graph,{rawText:before.rawText}),secondApi=Analysis.create(after.graph,{rawText:after.rawText}),first=await Capture.seeded(q=>firstApi.query(q));
 const next=await Capture.changed(q=>secondApi.query(q),first);for(const row of next.rows.values())Capture.exactLinks(row,after.graph);
 const stale=await secondApi.query(find(first.index));assert.equal(stale.error.code,'COMMENT_SNAPSHOT_MISMATCH');
 const saved=await secondApi.query({op:'loadCommentIndex',repositoryScope:scope,index:next.index});assert.equal(saved.error,undefined);assert.deepEqual(await secondApi.query({op:'replay',replay:saved.replay}),{...saved,replayed:true});
});
