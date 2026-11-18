'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Analysis=require('../src/analysis-api.js'),F=require('../tests/fixtures/performance-measurements/fixture-graphs.cjs');
const {harness,descendants,normalized}=require('./test-viewer-effects.cjs');
const panel=h=>h.elements.get('measurements-content');
const disclosure=h=>{const pre=descendants(panel(h)).find(e=>e.tagName==='pre');return pre&&JSON.parse(pre.textContent);};
const field=(h,label)=>{const e=descendants(panel(h)).find(e=>e.attributes['aria-label']===label);assert(e,label);return e;};
const button=(h,label)=>{const e=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent===label);assert(e,label);return e;};
async function until(predicate,message){const deadline=performance.now()+6000;while(!predicate()){assert(performance.now()<deadline,message);await new Promise(r=>setTimeout(r,5));}}
async function lowestWork(api,request){
 let best=await api.query({...F.clone(request),timeoutMs:5000});assert.equal(best.error,undefined);
 const limits=best.request.budgets,at=maxWork=>({...F.clone(request),timeoutMs:5000,budgets:{...limits,maxWork}});let lower=1,upper=limits.maxWork;
 assert.equal((await api.query(at(lower))).error.code,'MEASUREMENT_BUDGET');
 while(upper-lower>1){const middle=Math.floor((lower+upper)/2),value=await api.query(at(middle));if(value.error){assert.equal(value.error.code,'MEASUREMENT_BUDGET');lower=middle;}else{upper=middle;best=value;}}
 assert.equal(best.request.budgets.maxWork,upper);return {value:best,at,boundary:upper};
}
async function launch(worker,raw=F.graph(),options={}){const h=await harness(worker,raw,{allowEmptyEntries:true,...options}),selected=[],messages=[];let instance;
 h.context.showFunctionDetail=id=>{selected.push(id);h.context.MEASUREMENT_PICK(id);};
 if(worker){const post=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(v){instance=this;messages.push(normalized(v));return post.call(this,v);};}
 return {h,selected,messages,get worker(){return instance;}};
}
for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 test(mode+': actual form/API/full JSON replay and per-source measured flame/heat equality',async()=>{
  const {h,selected}=await launch(worker);try{
   const raw=F.graph(),q=F.request(raw),expected=await Analysis.create(raw,{rawText:h.raw}).query(q),input=field(h,'Local measurement request');input.value=JSON.stringify(q);input.listeners.input();button(h,'Load measurements').listeners.click();await until(()=>!!disclosure(h),'measurement form completed');assert.deepEqual(disclosure(h),expected);
   const heat=h.context.MEASUREMENT_HEAT;assert(heat.nodes.has('item:fixture::work'));assert(!heat.nodes.has('item:other::work'));assert(heat.edges.has(JSON.stringify(['item:fixture::root','item:fixture::work'])));
   const frame=descendants(panel(h)).find(e=>e.tagName==='button'&&e.title&&e.title.startsWith('work · inclusive'));assert(frame);frame.listeners.click();assert.equal(selected.at(-1),'item:fixture::work');
   const dataset=field(h,'Measured dataset');dataset.value='benchmark:0';dataset.listeners.change();assert.equal(h.context.MEASUREMENT_HEAT.edges.size,0);assert.equal(h.context.MEASUREMENT_HEAT.nodes.size,1);assert(descendants(panel(h)).some(e=>e.textContent.includes('Statistic belongs to this benchmark subject')));
   button(h,'Replay measurements').listeners.click();await until(()=>disclosure(h)&&disclosure(h).replayed,'measurement replay completed');assert.deepEqual(disclosure(h),{...expected,replayed:true});
   button(h,'Save measurement snapshot').listeners.click();if(worker)assert(descendants(panel(h)).some(e=>e.download==='measurement-snapshot.json'&&e.href.startsWith('blob:')));else assert(descendants(panel(h)).some(e=>e.textContent.includes('Download unavailable')));
  }finally{h.dispose();}
 });
 test(mode+': snapshot reload, capture mismatch and compatible baseline comparison use actual transport',async()=>{
  const {h}=await launch(worker);try{
   const raw=F.graph(),api=Analysis.create(raw,{rawText:h.raw}),first=await h.ui.runMeasurementQuery(F.request(raw)),saved=normalized(first.data.snapshot),loaded=await h.ui.runMeasurementQuery({op:'loadMeasurements',snapshot:saved});assert.deepEqual(normalized(loaded),await api.query({op:'loadMeasurements',snapshot:saved}));assert.deepEqual(normalized(loaded.data),normalized(first.data));
   field(h,'Measurement baseline snapshot').value=JSON.stringify(saved);field(h,'Measurement baseline snapshot').listeners.input();button(h,'Compare measurement baseline').listeners.click();await until(()=>disclosure(h)&&disclosure(h).operation==='compareMeasurements','comparison completed');assert.equal(disclosure(h).data.comparisons[0].compatible,true);assert.equal(h.context.MEASUREMENT_HEAT,null);
   const q=F.request(raw);q.input.capture.contentSha256='0'.repeat(64);const mismatch=await h.ui.runMeasurementQuery(q);assert.equal(mismatch.data.coverage.captureMatches,false);assert.equal(h.context.MEASUREMENT_HEAT,null);assert(descendants(panel(h)).some(e=>e.textContent.startsWith('Capture mismatch:')));
  }finally{h.dispose();}
 });
 test(mode+': caller mutations, invalid models and malformed form input cannot preserve stale heat or snapshots',async()=>{
  const {h}=await launch(worker);try{
   const q=F.request();q.budgets={maxWork:2000000};const original=F.clone(q),pending=h.ui.runMeasurementQuery(q);q.input.sources[0].text='mutated';q.budgets.maxWork=1;assert.deepEqual(normalized(await pending),await Analysis.create(F.graph(),{rawText:h.raw}).query(original));
   const replay=F.clone(disclosure(h).replay),again=h.ui.queryMeasurements({op:'replay',replay});replay.request.input.sources[1].text='mutated';replay.request.budgets.maxWork=1;assert.equal((await again).replayed,true);
   const invalid=F.request();invalid.input.sources[0].text='{';await assert.rejects(h.ui.runMeasurementQuery(invalid),{code:'INVALID_MEASUREMENTS'});assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
   await h.ui.runMeasurementQuery(original);field(h,'Local measurement request').value='{';button(h,'Load measurements').listeners.click();assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);assert(descendants(panel(h)).some(e=>e.textContent.startsWith('Measurement error:')));
  }finally{h.dispose();}
 });
 test(mode+': exact replay integrity and complete import/load/compare payloads cross the actual transport',async()=>{
  const {h}=await launch(worker);try{
   const api=Analysis.create(F.graph(),{rawText:h.raw}),explicit=F.request(),implicit=F.clone(explicit);delete implicit.input.capture;
   const first=await h.ui.runMeasurementQuery(explicit);assert.deepEqual(normalized(await h.ui.runMeasurementQuery(implicit)),normalized(first));assert.equal(implicit.input.capture,undefined);
   const load={op:'loadMeasurements',snapshot:normalized(first.data.snapshot)},compare={op:'compareMeasurements',before:load.snapshot,after:load.snapshot};
   for(const q of [explicit,implicit,load,compare]){
    const value=await h.ui.runMeasurementQuery(q);assert.deepEqual(normalized(value),await api.query(q));
    assert.deepEqual(normalized(await h.ui.runMeasurementQuery({op:'replay',replay:value.replay})),{...normalized(value),replayed:true});
    const input=r=>r.request.op==='importMeasurements'?r.request.input:r.request.op==='loadMeasurements'?r.request.snapshot.input:r.request.before.input;
    const repairs=[
     ['deleted timeout',r=>{delete r.request.timeoutMs;}],['null timeout',r=>{r.request.timeoutMs=null;}],
     ['deleted budgets',r=>{delete r.request.budgets;}],['null budgets',r=>{r.request.budgets=null;}],
     ...Object.keys(value.request.budgets).map(key=>['deleted default '+key,r=>{delete r.request.budgets[key];}])
    ];
    const corruptions=[
     ['deleted capture',r=>{delete input(r).capture;}],['null capture',r=>{input(r).capture=null;}],...repairs,
     ...repairs.map(([label,edit])=>['rehashed '+label,r=>{edit(r);r.requestHash=h.context.AnalysisEvidence.digest(r.request,true);}]),
     ['changed capture',r=>{input(r).capture.contentSha256='a'.repeat(64);}],['foreign current capture',r=>{r.captureSha256='b'.repeat(64);}],
     ['changed source',r=>{input(r).sources[0].text+=' ';}],['changed hash',r=>{r.requestHash='0'.repeat(64);}],['changed version',r=>{r.version='different';}]
    ];
    for(const [label,edit] of corruptions){
     await h.ui.runMeasurementQuery(explicit);assert(h.context.MEASUREMENT_HEAT);
     const replay=F.clone(normalized(value.replay));edit(replay);const unchanged=F.clone(replay),request={op:'replay',replay};
     const invalid=await api.query(request);assert.equal(invalid.error.code,'INVALID_REPLAY',label);assert.equal(invalid.data,undefined);assert.equal(invalid.replay,undefined);
     await assert.rejects(h.ui.runMeasurementQuery(request),{code:'INVALID_REPLAY'},label);assert.deepEqual(replay,unchanged);assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
    }
   }
  }finally{h.dispose();}
 });
 test(mode+': lowest and adjacent successful work budgets preserve full replay through the actual transport',async()=>{
  const raw=F.graph(),{h}=await launch(worker,raw);try{
   const api=Analysis.create(raw,{rawText:h.raw}),explicit={op:'importMeasurements',input:{schemaVersion:1,capture:F.request(raw).input.capture,sources:[{id:'empty',format:'generic-benchmark-v1',text:'{"schemaVersion":1,"benchmarks":[]}\n'}]}},implicit=F.clone(explicit);delete implicit.input.capture;
   const first=await api.query(explicit);assert.equal(first.error,undefined);const snapshot=first.data.snapshot;
   let explicitValue;
   for(const q of [explicit,implicit,{op:'loadMeasurements',snapshot},{op:'compareMeasurements',before:snapshot,after:snapshot}]){
    const bound=await lowestWork(api,q);if(q===explicit)explicitValue=bound.value;else if(q===implicit)assert.deepEqual(bound.value,explicitValue);
    for(const maxWork of [bound.boundary,bound.boundary+1]){
     const expected=maxWork===bound.boundary?bound.value:await api.query(bound.at(maxWork)),value=await h.ui.runMeasurementQuery(bound.at(maxWork));assert.equal(expected.error,undefined);assert.deepEqual(normalized(value),expected);assert.deepEqual(disclosure(h),expected);
     const replay=F.clone(expected.replay);assert.deepEqual(normalized(await h.ui.runMeasurementQuery({op:'replay',replay})),{...expected,replayed:true});assert.deepEqual(disclosure(h),{...expected,replayed:true});assert.deepEqual(replay,expected.replay);
    }
    const replay=F.clone(bound.value.replay);replay.request.budgets.maxWork=bound.boundary-1;replay.requestHash=h.context.AnalysisEvidence.digest(replay.request,true);
    for(const request of [bound.at(bound.boundary-1),{op:'replay',replay}]){
     const invalid=await api.query(request);assert.equal(invalid.error.code,'MEASUREMENT_BUDGET');assert.equal(invalid.data,undefined);assert.equal(invalid.replay,undefined);
     await assert.rejects(h.ui.runMeasurementQuery(request),{code:invalid.error.code});assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
    }
   }
  }finally{h.dispose();}
 });
 test(mode+': effective ingress ceilings reject oversized request/replay before ownership clone and worker post',async()=>{
  const events=await launch(worker),{h}=events,original=h.context.AnalysisSnapshot.dispatchCopy;try{
   const api=Analysis.create(F.graph(),{rawText:h.raw});
   for(const key of ['maxRetainedBytes','maxOutputBytes'])for(const replayed of [false,true]){
    const warm=await h.ui.runMeasurementQuery(F.request());assert(h.context.MEASUREMENT_HEAT);
    const request=F.clone(normalized(warm.request));request.input.provenance.note='x'.repeat(131072);request.budgets[key]=65536;
    const replay={...normalized(warm.replay),request,requestHash:h.context.AnalysisEvidence.digest(request)},q=replayed?{op:'replay',replay}:request;
    assert(JSON.stringify(q).length>65536&&JSON.stringify(q).length<8388608);
    const expected=await api.query(q);assert.equal(expected.error.code,'MEASUREMENT_BUDGET');assert.equal(expected.data,undefined);assert.equal(expected.replay,undefined);
    const attempts=[],posted=events.messages.filter(m=>m.type==='measurement_query').length;
    h.context.AnalysisSnapshot.dispatchCopy=function(value,limit){const attempt={value,limit,completed:false};attempts.push(attempt);const owned=original(value,limit);attempt.completed=true;return owned;};
    try{await assert.rejects(h.ui.runMeasurementQuery(q),{code:expected.error.code,message:expected.error.message});}
    finally{h.context.AnalysisSnapshot.dispatchCopy=original;}
    assert.equal(attempts.length,1);assert.equal(attempts[0].value,q);assert.equal(attempts[0].limit,65536);assert.equal(attempts[0].completed,false,'reject before native JSON ownership cloning');
    assert.equal(events.messages.filter(m=>m.type==='measurement_query').length,posted,'no oversized measurement query may be posted');assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
   }
  }finally{h.context.AnalysisSnapshot.dispatchCopy=original;h.dispose();}
 });
 test(mode+': cancel, input edit, catalog replacement and worker failure fence pending generations',async()=>{
  const events=await launch(worker),{h}=events;try{
   const q=F.request(),pending=h.ui.runMeasurementQuery(q);pending.catch(()=>{});h.ui.cancelMeasurements();await assert.rejects(pending,/cancelled/);assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
   const value=await h.ui.runMeasurementQuery(q);if(worker){const m=events.messages.filter(x=>x.type==='measurement_query').at(-1);events.worker.onmessage({data:{type:'measurement_result',requestId:m.requestId-1,catalogToken:m.catalogToken,result:{stale:true}}});events.worker.onmessage({data:{type:'measurement_error',requestId:m.requestId,catalogToken:m.catalogToken-1,message:'stale'}});assert.deepEqual(disclosure(h),normalized(value));}
   field(h,'Local measurement request').listeners.input();assert.equal(h.context.MEASUREMENT_HEAT,null);assert.equal(disclosure(h),undefined);
   await h.ui.runMeasurementQuery(q);const different=F.graph();different.label='new capture';let catalogs=0;h.context.STATE_UI.setData=()=>{catalogs++;};h.ui.refresh(JSON.stringify(different));await until(()=>catalogs>0,'replacement catalog completed');assert.equal(h.context.MEASUREMENT_HEAT,null);assert.equal(disclosure(h),undefined);
   const mismatch=await h.ui.runMeasurementQuery({op:'loadMeasurements',snapshot:value.data.snapshot});assert.equal(mismatch.data.coverage.captureMatches,false);
   if(worker){const inflight=h.ui.runMeasurementQuery(F.request(different));inflight.catch(()=>{});events.worker.onerror();await assert.rejects(inflight,/cancelled/);assert.equal(h.context.MEASUREMENT_HEAT,null);assert.equal(disclosure(h),undefined);}
  }finally{h.dispose();}
 });
 test(mode+': measurement operations preserve independent panels, map ownership, shared pins and flow analysis',async()=>{
  const {h}=await launch(worker),flows=[];try{
   h.context.STATE_UI.pins=['keep-pin'];h.context.STATE_UI.setAnalysis=v=>flows.push(v);const owner=h.context.claimEntryEffectHighlight({},17);h.context.applyEntryEffectHighlight({activeNodeIds:['other-owner'],activeEdgePairs:['other\towner']},owner);const map=h.context.ENTRY_EFFECT_ACTIVE;
   const revision=await h.ui.runRevisionQuery({op:'exportRevision',input:{queries:[]}}),before=descendants(h.elements.get('revision-comparison-content')).filter(e=>e.tagName==='pre').map(e=>e.textContent);
   await h.ui.runMeasurementQuery(F.request());h.ui.cancelMeasurements();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,map);assert.deepEqual(h.context.STATE_UI.pins,['keep-pin']);assert.deepEqual(flows,[]);assert.deepEqual(descendants(h.elements.get('revision-comparison-content')).filter(e=>e.tagName==='pre').map(e=>e.textContent),before);assert.equal(revision.operation,'exportRevision');
  }finally{h.dispose();}
 });
 test(mode+': local file read generations cannot overwrite a later input',async()=>{
  const {h}=await launch(worker);try{const file=field(h,'Import measurement request or snapshot');let resolve;file.files=[{size:20,text:()=>new Promise(r=>{resolve=r;})}];file.listeners.change();field(h,'Local measurement request').value='later input';field(h,'Local measurement request').listeners.input();resolve('{}');await Promise.resolve();await Promise.resolve();assert.equal(field(h,'Local measurement request').value,'later input');assert.equal(disclosure(h),undefined);}finally{h.dispose();}
 });
}
test('actual node/edge color hooks preserve kind colors, directed calls and independent ownership',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../src/viewer.html'),'utf8'),colors=html.slice(html.indexOf('function architectureNodeColor(n) {'),html.indexOf('function esc(s) {'));
 const begin=html.indexOf('function measurementEdgeColor(link) {'),end=html.indexOf('function setupMeasurementsUI(',begin),context={MEASUREMENT_HEAT:{nodes:new Map([['function','#hot']]),edges:new Map([[JSON.stringify(['from','to']),'#edge']])},ENTRY_EFFECT_ACTIVE:null,KIND_COLORS:{function:'#base'},DEFAULT_COLOR:'#default',architectureLinkDirected:l=>l.directed,linkSourceId:l=>l.source,linkTargetId:l=>l.target};
 vm.runInNewContext(colors+html.slice(begin,end),context);assert.equal(context.architectureNodeColor({id:'function',kind:'function'}),'#hot');assert.equal(context.architectureNodeColor({id:'package',kind:'package',workspaceMember:true}),'#58a6ff');assert.equal(context.measurementEdgeColor({source:'from',target:'to',directed:true,cat:'call'}),'#edge');assert.equal(context.measurementEdgeColor({source:'from',target:'to',directed:false,cat:'call'}),null);assert.equal(context.measurementEdgeColor({source:'from',target:'to',directed:true,cat:'reference'}),null);context.ENTRY_EFFECT_ACTIVE={nodes:new Set(['other'])};assert.equal(context.architectureNodeColor({id:'function',kind:'function'}),'#30363d');
});
if(['PERFORMANCE_CAPTURE','PERFORMANCE_HTML','PERFORMANCE_BASELINE_CAPTURE','PERFORMANCE_BASELINE_HTML'].some(k=>process.env[k]))test('two fresh emitted HTML files contain all 20 exact current modules and retain complete API equality',async()=>{
 for(const key of ['PERFORMANCE_CAPTURE','PERFORMANCE_HTML','PERFORMANCE_BASELINE_CAPTURE','PERFORMANCE_BASELINE_HTML'])assert(process.env[key],key);
 for(const before of [false,true])for(const worker of [false,true]){const raw=JSON.parse(fs.readFileSync(process.env[before?'PERFORMANCE_BASELINE_CAPTURE':'PERFORMANCE_CAPTURE'],'utf8')),html=fs.readFileSync(process.env[before?'PERFORMANCE_BASELINE_HTML':'PERFORMANCE_HTML'],'utf8'),{h}=await launch(worker,raw,{html});try{const q=await F.captureRequest(raw),api=Analysis.create(raw,{rawText:h.raw}),value=await h.ui.runMeasurementQuery(q);assert.deepEqual(normalized(value),await api.query(q));assert.equal(value.data.benchmarks[0].binding.status,'exact-id');assert.notEqual(value.data.benchmarks[0].binding.node.id,value.data.benchmarks[0].binding.node.procedureId);assert.deepEqual(normalized(value.data.benchmarks[0].target),q.input.sources[1].frameIdentities['physical-frame'].target);assert.equal(value.data.profiles[0].nodes.length,1);assert.deepEqual(normalized(await h.ui.queryMeasurements({op:'replay',replay:value.replay})),{...normalized(value),replayed:true});}finally{h.dispose();}}
});

for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 test(mode+': bilateral observation continuity and incompatible controls retain full API/replay equality',async()=>{
  const {h}=await launch(worker);try{const api=Analysis.create(F.graph(),{rawText:h.raw});
   for(const scenario of F.comparisonCases()){
    const before=(await h.ui.queryMeasurements(scenario.before)).data.snapshot,after=(await h.ui.queryMeasurements(scenario.after)).data.snapshot;
    for(const reverse of [false,true]){const q={op:'compareMeasurements',before:reverse?after:before,after:reverse?before:after};if(scenario.subjectMappings)q.subjectMappings=scenario.subjectMappings.map(m=>reverse?{before:m.after,after:m.before,provenance:m.provenance}:m);
     const v=await h.ui.runMeasurementQuery(q);assert.deepEqual(normalized(v),await api.query(q),scenario.name);
     if(scenario.compatible||reverse&&scenario.reverseCompatible){assert.equal(v.data.comparisons.length,1);assert.equal(v.data.comparisons[0].compatible,true);}
     else if(scenario.incompatible){assert.equal(v.data.comparisons.length,1);assert.equal(v.data.comparisons[0].compatible,false);assert.equal(v.data.comparisons[0].ratio,undefined);}
     else{assert.equal(v.data.comparisons.length,0);assert.equal(v.data.unmatched.length,q.before.input.sources.length);assert(v.data.unmatched.every(r=>r.status==='ambiguous'));}
     assert.deepEqual(normalized(await h.ui.queryMeasurements({op:'replay',replay:v.replay})),{...normalized(v),replayed:true});assert.equal(h.context.MEASUREMENT_HEAT,null);
    }
   }
  }finally{h.dispose();}
 });
 test(mode+': tiny budgets stop repeated metadata and clear prior heat without publishing a partial snapshot',async()=>{
  const {h}=await launch(worker);try{for(const budgets of [{maxRetainedBytes:65536},{maxOutputBytes:65536}]){await h.ui.runMeasurementQuery(F.request());assert(h.context.MEASUREMENT_HEAT);const q=F.repeatedMappingRequest();q.budgets=budgets;await assert.rejects(h.ui.runMeasurementQuery(q),{code:'MEASUREMENT_BUDGET'});assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);}}finally{h.dispose();}
 });
 test(mode+': timer cancels genuinely running engine work and no late result can replace a later import',async()=>{
  const events=await launch(worker),{h}=events;let executionContext,originalHasher;try{
   await h.ui.runMeasurementQuery(F.request());executionContext=worker?events.worker.context:h.context;originalHasher=executionContext.AnalysisEvidence.hasher;
   let started=false,timerRan=false,armed=true;executionContext.AnalysisEvidence.hasher=function(){if(armed){armed=false;started=true;setTimeout(()=>{timerRan=true;h.ui.cancelMeasurements();},0);}return originalHasher();};
   const q=F.request();q.input.sources=[q.input.sources[1]];q.input.sources[0].text=Array(6000).fill('entry;work;work 1').join('\n');
   const pending=h.ui.runMeasurementQuery(q);await assert.rejects(pending,/cancelled/);assert.equal(started,true,'engine hashing started before timer cancellation');assert.equal(timerRan,true);assert.equal(disclosure(h),undefined);assert.equal(h.context.MEASUREMENT_HEAT,null);
   executionContext.AnalysisEvidence.hasher=originalHasher;const later=await h.ui.runMeasurementQuery(F.request());await new Promise(r=>setTimeout(r,30));assert.deepEqual(disclosure(h),normalized(later));assert.equal(later.data.profiles[0].total,12);assert(h.context.MEASUREMENT_HEAT.nodes.has('item:fixture::work'));
  }finally{if(executionContext&&originalHasher)executionContext.AnalysisEvidence.hasher=originalHasher;h.dispose();}
 });
}

for(const worker of [false,true])test((worker?'worker':'fallback')+': real Java profile retains encoded frame boundaries through actual transport and replay',async()=>{
 const {h}=await launch(worker);try{const q=F.request();q.input.sources=[F.realProfile()];const v=await h.ui.runMeasurementQuery(q),p=v.data.profiles[0];assert.deepEqual(normalized(v),await Analysis.create(F.graph(),{rawText:h.raw}).query(q));assert.equal(p.stacks.find(s=>s.frames[0].frame==='java').frames.length,46);assert.equal(p.nodes.length,0);assert.equal(p.edges.length,0);const expected=new Map();for(const frames of F.realRawStacks()){const key=JSON.stringify(frames);expected.set(key,(expected.get(key)||0)+1);}assert.deepEqual(new Map(p.stacks.map(s=>[JSON.stringify(Array.from(s.frames,f=>F.decodeFoldedFrame(f.frame))),s.weight])),expected);assert.deepEqual(normalized(await h.ui.queryMeasurements({op:'replay',replay:v.replay})),{...normalized(v),replayed:true});}finally{h.dispose();}
});
