'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js'),Evidence=require('../src/analysis-evidence.js'),F=require('../tests/fixtures/test-candidates/fixture-graphs.cjs');
const {harness,descendants,normalized}=require('./test-viewer-effects.cjs');
const panel=h=>h.elements.get('test-candidates-content');
const disclosure=h=>{const details=descendants(panel(h)).find(e=>e.tagName==='details'&&e.children.some(c=>c.textContent==='Candidate evidence and replay'));const pre=details&&details.children.find(e=>e.tagName==='pre');return pre&&JSON.parse(pre.textContent);};
const button=(h,text)=>{const b=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent===text);assert(b,text);return b;};
const click=b=>b.listeners.click();
async function completed(h,q,predicate=v=>v.operation==='testCandidates'){
 const request=q.op==='replay'?q.replay.request:q,deadline=performance.now()+(request.timeoutMs??5000)+1000;
 for(;;){const texts=descendants(panel(h)).map(e=>e.textContent).concat(h.elements.get('flow-status').textContent),error=texts.find(t=>/^(Candidate query error:|Flow (catalog|worker) error:)/.test(t));assert.equal(error,undefined,error);
  const value=disclosure(h);if(value&&predicate(value))return value;assert(performance.now()<deadline,'candidate completed within timeout plus transport margin');await new Promise(r=>setTimeout(r,5));}
}
async function eventually(predicate,message){const deadline=performance.now()+6000;while(!predicate()){assert(performance.now()<deadline,message);await new Promise(r=>setTimeout(r,5));}}
async function launch(worker,raw=F.graph(),options={}){
 const h=await harness(worker,raw,{allowEmptyEntries:true,...options}),flows=[],focus=[],messages=[];let catalogs=0,instance;
 Object.assign(h.context.STATE_UI,{hasProcedure(){return true;},focus(id){focus.push(id);},activate(){},setAnalysis(v){flows.push(normalized(v));},setData(){catalogs++;}});
 if(worker){const post=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(v){instance=this;messages.push(normalized(v));return post.call(this,v);};}
 return {h,flows,focus,messages,get worker(){return instance;},get catalogs(){return catalogs;}};
}
for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 test(mode+': real form preserves complete API code/manifest and replay with no execution',async()=>{
  const events=await launch(worker),{h}=events;try{
   const q=F.request(),input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Test candidate request');input.value=JSON.stringify(q);input.listeners.input();click(button(h,'Generate test candidate'));
   const expected=await Analysis.create(F.graph(),{rawText:h.raw}).query(q);assert.equal(expected.error,undefined);assert.deepEqual(await completed(h,q),expected);assert.equal(expected.artifact.manifest.state,'generated-unrun');assert.equal(expected.artifact.manifest.executionObserved,false);
   click(button(h,'Replay test candidate'));assert.deepEqual(await completed(h,q,v=>v.replayed),{...expected,replayed:true});assert.deepEqual(events.flows,[]);assert.deepEqual(events.focus,[]);
   click(button(h,'Export candidate artifact'));if(worker){const link=descendants(panel(h)).find(e=>e.tagName==='a'&&e.download==='test-candidate.json');assert(link);assert.match(link.href,/^blob:/);}else assert(descendants(panel(h)).some(e=>e.textContent.includes('Download is unavailable')));
  }finally{h.dispose();}
 });
 test(mode+': distinct graph endpoint and procedure retain full form/API/replay equality',async()=>{
  const raw=F.graph(true),{h}=await launch(worker,raw);try{
   const q=F.distinctRequest(false,raw),input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Test candidate request');input.value=JSON.stringify(q);input.listeners.input();click(button(h,'Generate test candidate'));
   const expected=await Analysis.create(raw,{rawText:h.raw}).query(q);assert.equal(expected.error,undefined);assert.notEqual(expected.artifact.manifest.evidence.query.result.endpoints.from.id,q.target);assert.deepEqual(await completed(h,q),expected);
   click(button(h,'Replay test candidate'));assert.deepEqual(await completed(h,q,v=>v.replayed),{...expected,replayed:true});
  }finally{h.dispose();}
 });
 for(const variant of F.sourceVariants())test(mode+': distinct-ID '+variant.name+' preserves API evidence and replay',async()=>{
  const {raw}=variant,{h}=await launch(worker,raw);try{
   const q=F.distinctRequest(false,raw),expected=await Analysis.create(raw,{rawText:h.raw}).query(q);assert.equal(expected.error,undefined);
   const input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Test candidate request');input.value=JSON.stringify(q);input.listeners.input();click(button(h,'Generate test candidate'));
   const value=await completed(h,q),m=value.artifact.manifest,e=m.evidence.query.result.endpoints.from;assert.deepEqual(value,expected);assert.notEqual(e.id,e.procedureId);assert.equal(e.procedureId,q.target);
   assert.deepEqual(m.target.captured.source,{source_file:variant.file,source_location:3,absolute_file:variant.capturedAbsolute});assert.deepEqual(e.source,{source_file:variant.file,source_location:3,absolute_file:variant.endpointAbsolute});assert.equal(m.target.capturedSourceCorrespondence,'unknown');
   click(button(h,'Replay test candidate'));assert.deepEqual(await completed(h,q,v=>v.replayed),{...expected,replayed:true});
  }finally{h.dispose();}
 });
 test(mode+': malformed or conflicting absolute source enrichment rejects through the actual transport',async()=>{
  for(const enrichment of ['relative.rs',true,{},'/different/fixture.rs']){
   const raw=F.sourceVariants()[0].raw;for(const n of raw.nodes.slice(1))n.attributes.source_absolute=enrichment;
   const {h}=await launch(worker,raw);try{const q=F.distinctRequest(false,raw),expected=await Analysis.create(raw,{rawText:h.raw}).query(q);assert.equal(expected.error.code,'INVALID_CANDIDATE');await assert.rejects(h.ui.runCandidateQuery(q),{code:expected.error.code,message:expected.error.message});assert.equal(disclosure(h),undefined);}finally{h.dispose();}
  }
 });
 test(mode+': bounded fuzz and unsupported shapes disclose full evidence through actual transports',async()=>{
  const {h}=await launch(worker);try{
   const q=F.request();delete q.cases;q.fuzz={domains:[[0,7,255]],maxCases:3,provenance:'Explicit finite domain'};
   const expected=await Analysis.create(F.graph(),{rawText:h.raw}).query(q),value=await h.ui.runCandidateQuery(q);assert.deepEqual(normalized(value),expected);assert.deepEqual(disclosure(h),expected);
   q.callable.parameters=['&[u8]'];const unsupported=await h.ui.runCandidateQuery(q);assert.equal(unsupported.artifact.manifest.support.status,'unsupported');assert.equal(unsupported.artifact.code,'');assert.deepEqual(disclosure(h),normalized(unsupported));
  }finally{h.dispose();}
 });
 test(mode+': request ownership, errors and invalid JSON never retain stale artifacts',async()=>{
  const {h}=await launch(worker);try{
   const q=F.request(),copy=F.clone(q),pending=h.ui.queryCandidates(q);q.cases[0].inputs[0]=99;const value=await pending;assert.deepEqual(normalized(value),await Analysis.create(F.graph(),{rawText:h.raw}).query(copy));
   const replay=F.clone(value.replay),again=h.ui.queryCandidates({op:'replay',replay});replay.request.callable.path='mutated';assert.deepEqual(normalized(await again),{...normalized(value),replayed:true});
   const bad=F.request();bad.callable.sourcePath='../outside.rs';const expected=await Analysis.create(F.graph()).query(bad);await assert.rejects(h.ui.runCandidateQuery(bad),{code:expected.error.code,message:expected.error.message});assert.equal(disclosure(h),undefined);
   const cycle={op:'testCandidates'};cycle.input=cycle;await assert.rejects(h.ui.queryCandidates(cycle),{code:'INVALID_REQUEST'});
   const input=descendants(panel(h)).find(e=>e.tagName==='textarea');input.value='{';click(button(h,'Generate test candidate'));assert.equal(disclosure(h),undefined);assert(descendants(panel(h)).some(e=>e.textContent.startsWith('Candidate query error:')));
  }finally{h.dispose();}
 });
 test(mode+': cancellation, stale replies, catalog replacement and worker failures complete pending promises',async()=>{
  const events=await launch(worker),{h}=events;try{
   const q=F.request(),pending=h.ui.runCandidateQuery(q);pending.catch(()=>{});h.ui.cancelCandidates();await assert.rejects(pending,/cancelled/);assert.equal(disclosure(h),undefined);
   const value=await h.ui.runCandidateQuery(q);if(worker){const message=events.messages.filter(m=>m.type==='candidate_query').at(-1);events.worker.onmessage({data:{type:'candidate_result',requestId:message.requestId-1,catalogToken:message.catalogToken,result:{stale:true}}});events.worker.onmessage({data:{type:'candidate_error',requestId:message.requestId,catalogToken:message.catalogToken-1,message:'stale'}});assert.deepEqual(disclosure(h),normalized(value));}
   const catalog=events.catalogs,newRaw=F.graph();newRaw.label='replacement';h.ui.refresh(JSON.stringify(newRaw));await eventually(()=>events.catalogs>catalog,'replacement catalog completed');assert.equal(disclosure(h),undefined);
   const replay={op:'replay',replay:value.replay};await assert.rejects(h.ui.runCandidateQuery(replay),{code:'CAPTURE_UNAVAILABLE'});
   if(worker){const inFlight=h.ui.runCandidateQuery(q);inFlight.catch(()=>{});events.worker.onerror();await assert.rejects(inFlight,/cancelled/);assert.equal(disclosure(h),undefined);}
  }finally{h.dispose();}
 });
 test(mode+': candidate cancel/input edits preserve existing map, independent flow, revision evidence and pins',async()=>{
  const events=await launch(worker),{h}=events;try{
   h.context.STATE_UI.pins=['keep'];const exported=await h.ui.runRevisionQuery({op:'exportRevision',input:{queries:[]}}),prior=descendants(h.elements.get('revision-comparison-content')).filter(e=>e.tagName==='pre').map(e=>e.textContent);
   const owner=h.context.claimEntryEffectHighlight({},22);h.context.applyEntryEffectHighlight({activeNodeIds:['existing-owner'],activeEdgePairs:[]},owner);const map=h.context.ENTRY_EFFECT_ACTIVE;
   const value=await h.ui.runCandidateQuery(F.request());assert.equal(value.operation,'testCandidates');h.ui.cancelCandidates();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,map);assert.deepEqual(h.context.STATE_UI.pins,['keep']);assert.deepEqual(events.flows,[]);assert.deepEqual(events.focus,[]);
   assert.deepEqual(descendants(h.elements.get('revision-comparison-content')).filter(e=>e.tagName==='pre').map(e=>e.textContent),prior);assert.equal(exported.operation,'exportRevision');
  }finally{h.dispose();}
 });
 test(mode+': baseline admitted through revisions can generate its own source-pinned candidate',async()=>{
  const {h}=await launch(worker);try{
   const before=F.graph();before.label='before';const registered=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:JSON.stringify(before)}),q=F.request(true);q.input.capture=registered.capture;
   const value=await h.ui.runCandidateQuery(q),expected=await Analysis.create(F.graph(),{rawText:h.raw,revisionCaptures:[before]}).query(q);assert.deepEqual(normalized(value),expected);assert.equal(value.artifact.manifest.target.declaration.sourceSha256,F.sourceHash(true));
  }finally{h.dispose();}
 });
 test(mode+': current capture references preserve complete revision artifacts and replay accounting',async()=>{
  const R=require('../tests/fixtures/revision-comparison/fixture-graphs.cjs'),item=R.semantic('guard'),raw=item.after.graph,{h}=await launch(worker,raw);try{
   const api=Analysis.create(raw,{rawText:h.raw}),registration={op:'registerRevisionCapture',raw:JSON.stringify(item.before.graph)},registered=await h.ui.queryRevisions(registration);assert.deepEqual(normalized(registered),await api.query(registration));
   delete item.before.graph;item.before.capture=normalized(registered.capture);delete item.after.graph;item.after.capture={contentSha256:Evidence.digest(raw)};
   const before=await h.ui.queryRevisions({op:'exportRevision',input:item.before}),after=await h.ui.queryRevisions({op:'exportRevision',input:item.after});let implicit;
   for(const omitCurrent of [true,false]){
    const q=F.request();q.target='root';q.queryKey='guard';q.input=F.clone(after.snapshot.input);if(omitCurrent)delete q.input.capture;
    q.revision={before:F.clone(before.snapshot),after:F.clone(after.snapshot),side:'after',key:'guard',mappings:item.mappings};
    const original=F.clone(q),pending=h.ui.runCandidateQuery(q);assert.deepEqual(q,original);q.input.declaration.revision.value='mutated transport caller';q.revision.after.input.declaration.revision.value='mutated transport snapshot';q.cases[0].inputs[0]=99;
    const value=normalized(await pending),expected=await api.query(original);assert.equal(expected.error,undefined);assert.deepEqual(value,expected);assert.deepEqual(disclosure(h),expected);if(omitCurrent)implicit=value;else assert.deepEqual(value,implicit);
    assert.equal(value.replay.requestHash,Evidence.digest(value.replay.request));const nested=value.artifact.manifest.evidence.revision.comparison.replay;assert.equal(nested.requestHash,Evidence.digest(nested.request));
    const replay=F.clone(value.replay),again=h.ui.queryCandidates({op:'replay',replay});replay.request.input.declaration.revision.value='mutated transport replay';
    const replayed=normalized(await again);assert.deepEqual(replayed,{...value,replayed:true});assert.deepEqual(replayed.artifact.manifest,value.artifact.manifest);assert.deepEqual(replayed.artifact.manifest.evidence.revision.comparison.replay.request,nested.request);assert.deepEqual(replayed.artifact.manifest.evidence.revision.comparison.replay.request.budgets,nested.request.budgets);
    for(const edit of [r=>delete r.request.input.capture,r=>r.request.input.capture=F.clone(before.snapshot.input.capture)]){const bad=F.clone(value.replay);edit(bad);await assert.rejects(h.ui.queryCandidates({op:'replay',replay:bad}),{code:'INVALID_REPLAY'});}
   }
  }finally{h.dispose();}
 });
}
if(process.env.TEST_CANDIDATE_CAPTURE||process.env.TEST_CANDIDATE_HTML||process.env.TEST_CANDIDATE_BASELINE_CAPTURE||process.env.TEST_CANDIDATE_BASELINE_HTML)test('fresh paired emitted HTML uses all 19 exact current modules and actual inline graph in worker/fallback',async()=>{
 for(const key of ['TEST_CANDIDATE_CAPTURE','TEST_CANDIDATE_HTML','TEST_CANDIDATE_BASELINE_CAPTURE','TEST_CANDIDATE_BASELINE_HTML'])assert(process.env[key],key);
 for(const baseline of [true,false])for(const worker of [false,true]){
  const raw=JSON.parse(fs.readFileSync(process.env[baseline?'TEST_CANDIDATE_BASELINE_CAPTURE':'TEST_CANDIDATE_CAPTURE'],'utf8')),html=fs.readFileSync(process.env[baseline?'TEST_CANDIDATE_BASELINE_HTML':'TEST_CANDIDATE_HTML'],'utf8'),{h}=await launch(worker,raw,{html});
  try{const q=F.captureRequest(raw,baseline),expected=await Analysis.create(raw,{rawText:h.raw}).query(q),value=await h.ui.runCandidateQuery(q);assert.equal(expected.error,undefined);assert.deepEqual(normalized(value),expected);assert.notEqual(value.artifact.manifest.evidence.query.result.endpoints.from.id,q.target);assert.equal(value.artifact.manifest.evidence.query.result.endpoints.from.procedureId,q.target);assert.equal(value.artifact.manifest.state,'generated-unrun');assert.deepEqual(normalized(await h.ui.queryCandidates({op:'replay',replay:value.replay})),{...expected,replayed:true});}finally{h.dispose();}
 }
});
