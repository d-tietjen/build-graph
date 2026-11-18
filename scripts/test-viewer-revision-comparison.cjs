/* Actual emitted worker/fallback and shared existing effects harness; source-review gated. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js'),Snapshot=require('../src/analysis-snapshot.js'),Evidence=require('../src/analysis-evidence.js');
const F=require('../tests/fixtures/revision-comparison/fixture-graphs.cjs'),Model=require('../src/execution-model.js');
const {harness,descendants,normalized}=require('./test-viewer-effects.cjs');
const panel=h=>h.elements.get('revision-comparison-content');
const disclosure=h=>{const pre=descendants(panel(h)).find(e=>e.tagName==='pre');return pre&&JSON.parse(pre.textContent);};
const button=(h,text)=>{const b=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent===text);assert(b,text);return b;};
const click=b=>b.listeners.click();
async function completed(h,request,predicate=()=>true){const deadline=performance.now()+(request.timeoutMs??5000)+1000;for(;;){const error=descendants(panel(h)).map(e=>e.textContent).find(t=>/^(?:Revision (?:query|import) error:|Flow (?:worker|catalog) error:)/.test(t));assert.equal(error,undefined,error);const value=disclosure(h);if(value&&predicate(value))return value;assert(performance.now()<deadline,'real completed revision response within request timeout + 1000 ms bounded transport margin');await new Promise(r=>setTimeout(r,5));}}
async function eventually(predicate,label){const end=performance.now()+6000;while(!predicate()){assert(performance.now()<end,label);await new Promise(r=>setTimeout(r,5));}}
async function launch(worker,raw,options={}){const h=await harness(worker,raw,{allowEmptyEntries:true,...options}),focus=[],results=[],messages=[];let catalog=0,instance,publicModel;let accepted=new Set(Model.build(raw).procedures.map(p=>p.id));
 Object.assign(h.context.STATE_UI,{hasProcedure(id){return accepted.has(id);},focus(id){focus.push(id);},activate(){},setAnalysis(v){results.push(v);},setData(model){publicModel=model;accepted=new Set(model.procedures.map(p=>p.id));catalog++;}});
 if(worker){const original=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(v){instance=this;messages.push(normalized(v));return original.call(this,v);};}
 return{h,focus,results,messages,get worker(){return instance;},get catalog(){return catalog;},get accepted(){return accepted;},get publicModel(){return publicModel;}};
}
async function snapshots(item){return{op:'compareRevisions',before:await Snapshot.exportSide(item.before,{},{now:()=>0}),after:await Snapshot.exportSide(item.after,{},{now:()=>0}),mappings:item.mappings||[]};}
for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 test(mode+': form and complete source-linked semantic payload equal API, immutable replay and first configuration/model disclosure',async()=>{
  const item=F.semantic('guard'),request=await snapshots(item),events=await launch(worker,item.after.graph),{h}=events;try{
   const input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Revision comparison request');input.value=JSON.stringify(request);input.listeners.input();click(button(h,'Run revision query'));
   const value=await completed(h,request),expected=await Analysis.create(item.after.graph,{rawText:h.raw}).query(request);assert.equal(expected.error,undefined);assert.deepEqual(value,expected);
   assert(descendants(panel(h)).some(e=>e.textContent.startsWith('Configuration/model first')));assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/fixture/root.rs')));
   click(button(h,'Replay revision query'));assert.deepEqual(await completed(h,request,v=>v.replayed),{...expected,replayed:true});
   const copy=normalized(request),pending=h.ui.queryRevisions(request);request.before.input.declaration.revision.value='mutated after dispatch';assert.deepEqual(normalized(await pending),expected);assert.deepEqual(copy,expected.replay.request);
  }finally{h.dispose();}
 });
 test(mode+': baseline IDs cannot highlight candidate; selected after witness uses exact own paths and independent leases',async()=>{
  const item=F.semantic('guard'),request=await snapshots(item),events=await launch(worker,item.after.graph),{h}=events;try{
   h.context.STATE_UI.pins=['keep'];const value=await h.ui.runRevisionQuery(request),before=button(h,'Open before execution flow');click(before);assert.equal(events.results.length,0);assert.equal(events.focus.length,0);
   click(button(h,'Open after execution flow'));const selected=value.changes.find(c=>c.key==='guard').after.witnesses.items[0];assert.deepEqual(normalized(events.results.at(-1).activeNodeIds),normalized(selected.steps.map(s=>s.nodeId).filter(Boolean)));assert.deepEqual(normalized(events.results.at(-1).activeCallIds),normalized(selected.steps.map(s=>s.callsiteId).filter(Boolean)));assert.deepEqual(h.context.STATE_UI.pins,['keep']);
   const ownMap=h.context.ENTRY_EFFECT_ACTIVE,ownFlow=events.results.at(-1);h.ui.cancelResources();h.ui.cancelFailures();h.ui.cancelValues();h.ui.cancelGuards();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,ownMap);assert.equal(events.results.at(-1),ownFlow);
   const lease=h.context.claimEntryEffectHighlight({},99);h.context.applyEntryEffectHighlight({activeNodeIds:['newer'],activeEdgePairs:[]},lease);const newMap=h.context.ENTRY_EFFECT_ACTIVE;const count=events.results.length;h.ui.analyzeState(['root']);await eventually(()=>events.results.length>count,'newer independent actor');const newFlow=events.results.at(-1);h.ui.cancelRevisions();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,newMap);assert.equal(events.results.at(-1),newFlow);assert.deepEqual(h.context.STATE_UI.pins,['keep']);
   const other=F.semantic('guard');other.after.graph.label='other capture';const foreign=await snapshots(other);await h.ui.runRevisionQuery(foreign);const oldFocus=events.focus.length;click(button(h,'Open after execution flow'));assert.equal(events.focus.length,oldFocus,'foreign candidate content hash never navigates current capture');
  }finally{h.dispose();}
 });
 test(mode+': imported baseline reference, current reference export and replay are reproducible without graph copies',async()=>{
  const before=F.basic(),after=F.basic(true),events=await launch(worker,after),{h}=events;try{
   const registered=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:JSON.stringify(before)});assert.equal(registered.capture.contentSha256,Evidence.digest(before));
   const first=await h.ui.queryRevisions({op:'exportRevision',input:{capture:registered.capture,declaration:{},queries:[]}}),second=await h.ui.queryRevisions({op:'exportRevision',input:{declaration:{},queries:[]}});assert(!first.snapshot.input.graph&&!second.snapshot.input.graph);
   const request={op:'compareRevisions',before:first.snapshot,after:second.snapshot},value=await h.ui.runRevisionQuery(request),expected=await Analysis.create(after,{rawText:h.raw,revisionCaptures:[before]}).query(request);assert.deepEqual(normalized(value),expected);
   click(button(h,'Replay revision query'));assert.deepEqual(await completed(h,request,v=>v.replayed),{...expected,replayed:true});
  }finally{h.dispose();}
 });
 test(mode+': active cancellation, stale replies, catalog replacement, malformed JSON and real worker failure',async()=>{
  const item=F.semantic('guard'),request=await snapshots(item),events=await launch(worker,item.after.graph),{h}=events;try{
   const pending=h.ui.runRevisionQuery(request);pending.catch(()=>{});h.ui.cancelRevisions();await assert.rejects(pending,/cancelled/);assert.equal(disclosure(h),undefined);
   const value=await h.ui.runRevisionQuery(request),current=disclosure(h);
   if(worker){const last=events.messages.filter(m=>m.type==='revision_query').at(-1);events.worker.onmessage({data:{type:'revision_result',requestId:last.requestId-1,catalogToken:last.catalogToken,result:{status:'stale'}}});events.worker.onmessage({data:{type:'revision_error',requestId:last.requestId,catalogToken:last.catalogToken-1,message:'stale'}});assert.deepEqual(disclosure(h),current);}
   const count=events.catalog;h.ui.refresh(JSON.stringify(item.after.graph));await eventually(()=>events.catalog>count,'fresh catalog');assert.equal(disclosure(h),undefined);
   assert.deepEqual(normalized(await h.ui.runRevisionQuery({op:'replay',replay:value.replay})),{...normalized(value),replayed:true});
   const bad=normalized(request);bad.after.contentHash='changed';const expected=await Analysis.create(item.after.graph).query(bad);await assert.rejects(h.ui.runRevisionQuery(bad),{code:expected.error.code,message:expected.error.message});assert.equal(disclosure(h),undefined);
   const input=descendants(panel(h)).find(e=>e.tagName==='textarea');input.value='{';click(button(h,'Run revision query'));assert(descendants(panel(h)).some(e=>e.textContent.startsWith('Revision query error:')));
   const cyclic={op:'compareRevisions'};cyclic.before=cyclic;await assert.rejects(h.ui.queryRevisions(cyclic),{code:'INVALID_REQUEST'});
   if(worker){const pending=h.ui.runRevisionQuery(request);pending.catch(()=>{});await eventually(()=>events.messages.filter(m=>m.type==='revision_query').length>2,'actual dispatch');events.worker.onerror();await assert.rejects(pending,/cancelled/);const prior=events.catalog;h.ui.refresh(JSON.stringify(item.after.graph));await eventually(()=>events.catalog>prior,'recovered catalog');assert.equal((await h.ui.runRevisionQuery(request)).operation,'compareRevisions');}
  }finally{h.dispose();}
 });
 test(mode+': symbol evidence navigates one accepted distinct procedure and keeps baseline disabled',async()=>{
  const before=F.separateProcedures(F.basic()),after=F.separateProcedures(F.basic(true)),request=await snapshots({before:F.declared(before,'before'),after:F.declared(after,'after')}),events=await launch(worker,after),{h}=events;try{
   await h.ui.runRevisionQuery(request);assert(!events.accepted.has('app::new_entry'));assert(events.accepted.has('procedure:app::new_entry'));
   const inspect=descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Inspect after function');assert(inspect.length);for(const b of inspect)click(b);assert(events.focus.length);assert(events.focus.every(id=>events.accepted.has(id)&&id.startsWith('procedure:')));
   const count=events.focus.length;for(const b of descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Inspect before function'))click(b);assert.equal(events.focus.length,count);
  }finally{h.dispose();}
 });
 test(mode+': unrelated same-key endpoints and commit-only semantic output match API through actual transport',async()=>{
  const raw=F.basic(true),q=(id)=>F.declared(raw,'same',[{key:'route',request:{op:'callPaths',from:id,to:id}}]),request=await snapshots({before:q('app::entry'),after:q('app::new_entry')}),events=await launch(worker,raw),{h}=events;try{
   const value=await h.ui.runRevisionQuery(request),expected=await Analysis.create(raw,{rawText:h.raw}).query(request);assert.deepEqual(normalized(value),expected);assert.equal(value.changes.find(c=>c.key==='route').questionEquivalent,false);
   const attach=(raw,commit)=>{const carrier=raw.nodes.find(n=>n.attributes.kind==='crate'),state={status:'clean-tracked-context',objectFormat:'sha1',treeOid:'a'.repeat(40),commitOid:commit};carrier.attributes.capture_provenance_v1=JSON.stringify({schemaVersion:1,producer:'build-graph-cli-local-context-v1',basis:'observed-local-process',scope:{packageId:carrier.attributes.package_id,binding:'workspace-package-in-observed-repo'},git:{before:state,after:state,consistency:'stable-context'},build:{before:{profile:'debug'},after:{profile:'debug'},completeInputs:false}});return raw;};
   for(const kind of ['call','guard','failure','resource']){
    const item=kind==='call'?{before:F.declared(F.basic(),'same',[{key:'call',request:{op:'callPaths',from:'app::entry',to:'app::entry'}}])}:F.semantic(kind),left=F.clone(item.before),right=F.clone(item.before),procedure=left.queries[0].request.function||left.queries[0].request.from;
    attach(F.withPackageCarrier(left.graph,procedure),'1'.repeat(40));attach(F.withPackageCarrier(right.graph,procedure),'2'.repeat(40));
    const same=await snapshots({before:left,after:right,mappings:item.mappings}),context=await h.ui.runRevisionQuery(same),expectedContext=await Analysis.create(raw,{rawText:h.raw}).query(same);assert.equal(expectedContext.error,undefined);assert.deepEqual(normalized(context),expectedContext);assert.deepEqual(normalized(context.changes),[]);assert(context.differences.some(d=>d.kind==='git-commit-context'));
    assert.deepEqual(normalized(context.sides.before.capture),same.before.evidence.graph);assert.deepEqual(normalized(context.sides.after.capture),same.after.evidence.graph);assert.equal(context.treeComparisons[0].beforeCommitContext,'1'.repeat(40));assert.equal(context.treeComparisons[0].afterCommitContext,'2'.repeat(40));assert.notDeepEqual(same.before.evidence.operations.at(-1).result.graph,same.after.evidence.operations.at(-1).result.graph);
    assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:context.replay})),{...expectedContext,replayed:true});
   }
  }finally{h.dispose();}
 });
 test(mode+': scope/phase/filter continuity and public model mutation preserve private referenced evidence',async()=>{
  const raw=F.scoped(),events=await launch(worker,raw),{h}=events;try{
   const generation=events.catalog;h.ui.refresh(JSON.stringify(raw));await eventually(()=>events.catalog>generation,'fresh exposed model');const request={op:'exportRevision',input:{selection:{scope:{packageIds:['app']},phase:'application'}}},first=await h.ui.queryRevisions(request);assert(first.snapshot.evidence.operations.find(o=>o.key==='$entries').result.entries.items.every(e=>e.packageId==='app'));
   events.publicModel.procedures[0].id='mutated-public-model';events.publicModel.coverage.partial=true;raw.nodes[0].attributes.version='mutated-raw';assert.deepEqual(normalized(await h.ui.queryRevisions(request)),normalized(first));const output=normalized(first);output.snapshot.evidence.packages[0].version='mutated-output';assert.deepEqual(normalized(await h.ui.queryRevisions(request)),normalized(first));
   for(const [left,right]of [[{phase:'application'},{phase:'build'}],[{category:'filesystem'},{category:'network'}],[{scope:{packageIds:['app']}},{scope:{packageIds:['bridge']}}]]){
    const side=extra=>F.declared(F.scoped(),'same',[{key:'route',request:{op:'effectPaths',function:'app::effect',...extra}}]),q=await snapshots({before:side(left),after:side(right)}),value=await h.ui.runRevisionQuery(q),expected=await Analysis.create(F.scoped()).query(q);assert.deepEqual(normalized(value),expected);assert.equal(value.changes.find(c=>c.key==='route').questionEquivalent,false);
   }
  }finally{h.dispose();}
 });
 test(mode+': null/omitted automatic and explicit selectors preserve question parity and partial coverage',async()=>{
  const raw=F.scoped(),events=await launch(worker,raw),{h}=events;try{
   const side=nil=>({...F.declared(raw,'same',[{key:'effect',request:{op:'effectPaths',function:'app::effect',...(nil?{scope:null,entryId:null,effectId:null,category:null,kind:null,phase:null,includePossible:null}:{})}},{key:'call',request:{op:'callPaths',from:'app::main',to:'app::effect',...(nil?{scope:null}:{})}}]),selection:nil?{scope:null,function:null,phase:null}:{}}),api=Analysis.create(raw,{rawText:h.raw});
   const exports=[];for(const nil of [false,true]){const request={op:'exportRevision',input:side(nil)},value=await h.ui.queryRevisions(request),expected=await api.query(request);assert.equal(expected.error,undefined);assert.deepEqual(normalized(value),expected);exports.push(value.snapshot);assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:value.replay})),{...expected,replayed:true});}
   assert(exports[1].evidence.operations.some(o=>o.key.startsWith('$route:')));assert.equal(exports[1].evidence.operations[0].result.request.scope,null);assert(exports[1].evidence.operations.some(o=>!o.complete));
   for(const [before,after]of [[exports[1],exports[1]],[exports[0],exports[1]],[exports[1],exports[0]]]){const request={op:'compareRevisions',before,after},value=await h.ui.runRevisionQuery(request),expected=await api.query(request);assert.equal(expected.error,undefined);assert.deepEqual(normalized(value),expected);assert(!value.differences.some(d=>d.kind.startsWith('question:')));assert.deepEqual(normalized(value.changes),F.scopedUnownedEffectChanges(before,after));assert.equal(value.completion.evidenceComplete,false);assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:value.replay})),{...expected,replayed:true});}
   const empty=side(true);empty.selection.scope={packageIds:[]};empty.queries[0].request.scope={packageIds:[]};const none=await h.ui.queryRevisions({op:'exportRevision',input:empty});assert.equal(none.snapshot.evidence.operations[0].result.entries.total,0);assert(exports[1].evidence.operations[0].result.entries.total>0);const diff=await h.ui.queryRevisions({op:'compareRevisions',before:exports[1],after:none.snapshot});assert(diff.differences.some(d=>d.kind==='question:$entries'));assert.equal(diff.changes.find(c=>c.key==='effect').questionEquivalent,false);
   for(const scope of [false,[],{packageIds:'app'}]){const invalid=side(true);invalid.selection.scope=scope;await assert.rejects(h.ui.queryRevisions({op:'exportRevision',input:invalid}),{code:'INVALID_SCOPE'});}
   const other=side(true);other.queries[0].request.function='app::main';const unrelated=await h.ui.queryRevisions({op:'exportRevision',input:other});assert.equal((await h.ui.queryRevisions({op:'compareRevisions',before:exports[1],after:unrelated.snapshot})).changes.find(c=>c.key==='effect').questionEquivalent,false);
  }finally{h.dispose();}
 });
 test(mode+': same-content baseline keeps original pretty bytes/source and saved export/compare/replay',async()=>{
  const raw=F.basic(),pretty=JSON.stringify(raw,null,2),minified=JSON.stringify(raw),source={kind:'fixture',path:'/fixtures/current-pretty.json'},events=await launch(worker,raw),{h}=events;try{
   await h.ui.queryRevisions({op:'exportRevision'});
   // Supply loader source metadata at its evidence-construction seam; the real
   // admission, registries and worker/fallback requests remain unmodified.
   const evidence=worker?events.worker.context.AnalysisEvidence:h.context.AnalysisEvidence,create=evidence.create;
   evidence.create=(graph,options)=>create(graph,options&&options.rawText===pretty?{...options,source}:options);
   const generation=events.catalog;h.ui.refresh(pretty);await eventually(()=>events.catalog>generation,'pretty current capture with source metadata');
   const api=Analysis.create(raw,{rawText:pretty,source,revisionCaptures:[JSON.parse(minified)]}),request={op:'exportRevision',input:{declaration:{},queries:[]}},saved=await h.ui.queryRevisions(request),expected=await api.query(request);assert.equal(expected.error,undefined);assert.deepEqual(normalized(saved),expected);assert.equal(saved.snapshot.evidence.graph.sha256,Evidence.hasher().update(pretty).digest('hex'));assert.deepEqual(normalized(saved.snapshot.evidence.graph.source),source);
   const registered=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:minified});assert.equal(registered.capture.contentSha256,saved.snapshot.evidence.graph.contentSha256);assert.deepEqual(normalized(await h.ui.queryRevisions(request)),expected);assert.deepEqual(normalized((await h.ui.queryRevisions({op:'exportRevision',input:{...request.input,capture:registered.capture}})).snapshot),expected.snapshot);assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:saved.replay})),{...expected,replayed:true});
   const compare={op:'compareRevisions',before:saved.snapshot,after:saved.snapshot},value=await h.ui.runRevisionQuery(compare),apiValue=await api.query(normalized(compare));assert.equal(apiValue.error,undefined);assert.deepEqual(normalized(value),apiValue);assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:value.replay})),{...apiValue,replayed:true});
   const baseline=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:JSON.stringify(F.basic(true))});assert.equal((await h.ui.queryRevisions({op:'exportRevision',input:{capture:baseline.capture}})).operation,'exportRevision');await h.ui.queryRevisions({op:'registerRevisionCapture',raw:minified});assert.equal((await h.ui.queryRevisions({op:'exportRevision',input:{capture:baseline.capture}})).operation,'exportRevision');
   const other=F.basic(true);other.label='replacement';const replacement=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:JSON.stringify(other)});assert.equal((await h.ui.queryRevisions({op:'exportRevision',input:{capture:replacement.capture}})).operation,'exportRevision');await assert.rejects(h.ui.queryRevisions({op:'exportRevision',input:{capture:baseline.capture}}),{code:'CAPTURE_UNAVAILABLE'});await assert.rejects(h.ui.queryRevisions({op:'exportRevision',input:{capture:{contentSha256:'0'.repeat(64)}}}),{code:'CAPTURE_UNAVAILABLE'});assert.deepEqual(normalized(await h.ui.queryRevisions(request)),expected);
   const forged=normalized(saved.snapshot);forged.evidence.graph.source.path='/forged';forged.evidenceHash=Evidence.digest(forged.evidence);forged.contentHash=Evidence.digest({version:forged.version,inputHash:forged.inputHash,evidenceHash:forged.evidenceHash});await assert.rejects(h.ui.queryRevisions({op:'compareRevisions',before:forged,after:saved.snapshot}),{code:'VERSION_MISMATCH'});
  }finally{h.dispose();}
 });
 test(mode+': browser default/configured registration follows advertised API/schema admission limits',async()=>{
  const raw=F.basic(),events=await launch(worker,raw),{h}=events;try{
   const api=Analysis.create(raw,{rawText:h.raw}),caps=await api.query({op:'capabilities'}),schema=(await api.query({op:'schema'})).schema,c=caps.revisionComparison,limit=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Baseline capture byte limit');assert(caps.operations.includes('registerRevisionCapture'));assert(c.operations.includes('registerRevisionCapture'));assert.deepEqual(schema.request.operations.registerRevisionCapture,['raw']);assert.deepEqual(schema.revisionComparison,c);assert.equal(c.standaloneCaptureImportBytes,512*1024*1024);assert.equal(c.standaloneCaptureImportMaxBytes,1024*1024*1024);assert.equal(Number(limit.value),c.standaloneCaptureImportBytes);assert.equal(Number(limit.max),c.standaloneCaptureImportMaxBytes);assert.equal(c.bundleInputBytes,4*1024*1024);assert.equal(c.retainedBytes,32*1024*1024);assert.equal(c.outputBytes,8*1024*1024);assert.equal(c.captureAdmission.atomic,true);assert.equal(c.captureAdmission.queryBudgetsApply,false);assert.equal(c.captureAdmission.cancellationChecks,'before-and-after');
   const text=JSON.stringify(F.basic(true));for(const maxCaptureBytes of [undefined,c.standaloneCaptureImportMaxBytes]){const request={op:'registerRevisionCapture',raw:text,...(maxCaptureBytes==null?{}:{maxCaptureBytes})},registered=await h.ui.queryRevisions(request);assert.deepEqual(normalized(registered),await api.query(request));assert.equal((await h.ui.queryRevisions({op:'exportRevision',input:{capture:registered.capture}})).operation,'exportRevision');}
   for(const [maxCaptureBytes,code]of [[c.standaloneCaptureImportMaxBytes+1,'INVALID_BUDGET'],[Buffer.byteLength(text)-1,'REVISION_BUDGET']]){const request={op:'registerRevisionCapture',raw:text,maxCaptureBytes};assert.equal((await api.query(request)).error.code,code);await assert.rejects(h.ui.queryRevisions(request),{code});}
  }finally{h.dispose();}
 });
 test(mode+': baseline file import admits large unselected payload and immutable small reference replay',async()=>{
  const raw=F.large();raw.nodes.push({id:'unselected-baseline',attributes:{kind:'file',package_id:'elsewhere',payload:'x'.repeat(68*1024*1024)}});const text=JSON.stringify(raw),events=await launch(worker,F.basic()),{h}=events;try{
   const file=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Import baseline capture'),limit=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Baseline capture byte limit');limit.value=String(96*1024*1024);file.files=[{size:Buffer.byteLength(text),text:async()=>text}];file.listeners.change();
   await eventually(()=>disclosure(h)&&disclosure(h).operation==='registerRevisionCapture','large baseline file registered');const registered=disclosure(h);assert.equal(registered.capture.contentSha256,Evidence.digest(raw));
   const first=await h.ui.queryRevisions({op:'exportRevision',input:{capture:registered.capture,selection:{function:'app::entry',scope:{packageIds:['app']}}}});assert(Buffer.byteLength(JSON.stringify(first))<1000000);first.snapshot.evidence.packages[0].version='output-only';const fresh=await h.ui.queryRevisions({op:'exportRevision',input:{capture:registered.capture,selection:{function:'app::entry',scope:{packageIds:['app']}}}});assert.notEqual(fresh.snapshot.evidence.packages[0].version,'output-only');
   const request={op:'compareRevisions',before:fresh.snapshot,after:fresh.snapshot},value=await h.ui.runRevisionQuery(request);assert.equal(value.operation,'compareRevisions');assert.deepEqual(normalized(await h.ui.queryRevisions({op:'replay',replay:value.replay})),{...normalized(value),replayed:true});
  }finally{h.dispose();}
 });
 test(mode+': escaped wire strings and keys obey configured final bytes in export and comparison',async()=>{
  const raw=F.basic(),events=await launch(worker,raw),{h}=events;try{for(const text of ['\0'.repeat(100000),'"\\'.repeat(40000),'\ud800'.repeat(40000),'é𐀀'.repeat(25000)]){
   const request={op:'exportRevision',input:{declaration:{revision:{value:text,provenance:'wire '+text}}},budgets:{maxOutputBytes:1048576}},expected=await Analysis.create(raw,{rawText:h.raw}).query(request);
   if(expected.error)await assert.rejects(h.ui.queryRevisions(request),{code:expected.error.code,message:expected.error.message});else{const value=await h.ui.queryRevisions(request);assert.deepEqual(normalized(value),expected);assert(Buffer.byteLength(JSON.stringify(value))<=1048576);const q={op:'compareRevisions',before:value.snapshot,after:value.snapshot,budgets:{maxOutputBytes:1048576}},compared=await Analysis.create(raw,{rawText:h.raw}).query(q);if(compared.error)await assert.rejects(h.ui.queryRevisions(q),{code:compared.error.code,message:compared.error.message});else assert(Buffer.byteLength(JSON.stringify(await h.ui.queryRevisions(q)))<=1048576);}
   const graph=F.basic();graph[text]='escaped-key';const keyRequest={op:'exportRevision',input:F.declared(graph,'same'),budgets:{maxOutputBytes:1048576}},keyExpected=await Analysis.create(raw,{rawText:h.raw}).query(keyRequest);if(keyExpected.error)await assert.rejects(h.ui.queryRevisions(keyRequest),{code:keyExpected.error.code,message:keyExpected.error.message});else assert(Buffer.byteLength(JSON.stringify(await h.ui.queryRevisions(keyRequest)))<=1048576);
  }}finally{h.dispose();}
 });
 test(mode+': shared admission/final wire bounds produce matching asynchronous errors',async()=>{
  const item=F.semantic('guard'),request=await snapshots(item),{h}=await launch(worker,item.after.graph);try{for(const budgets of [{maxWork:1},{maxRetainedBytes:64},{maxOutputBytes:64}]){const q={...request,budgets},expected=await Analysis.create(item.after.graph).query(q);assert(expected.error);await assert.rejects(h.ui.runRevisionQuery(q),{code:expected.error.code,message:expected.error.message});assert.equal(disclosure(h),undefined);}}finally{h.dispose();}
 });
}
if(process.env.REVISION_BASELINE_CAPTURE||process.env.REVISION_CANDIDATE_CAPTURE||process.env.REVISION_BASELINE_HTML||process.env.REVISION_CANDIDATE_HTML)test('CURRENT paired emitted HTML and actual capture bytes share all 18 embedded modules in worker/fallback',async()=>{
 for(const key of ['REVISION_BASELINE_CAPTURE','REVISION_CANDIDATE_CAPTURE','REVISION_BASELINE_HTML','REVISION_CANDIDATE_HTML'])assert(process.env[key],key);
 const before=JSON.parse(fs.readFileSync(process.env.REVISION_BASELINE_CAPTURE,'utf8')),after=JSON.parse(fs.readFileSync(process.env.REVISION_CANDIDATE_CAPTURE,'utf8'));
 for(const worker of [false,true])for(const side of ['before','after']){const raw=side==='before'?before:after,html=fs.readFileSync(process.env[side==='before'?'REVISION_BASELINE_HTML':'REVISION_CANDIDATE_HTML'],'utf8'),events=await launch(worker,raw,{html}),{h}=events;try{
  const own=await h.ui.queryRevisions({op:'exportRevision',input:{queries:F.captureQueries(raw,side==='after'),declaration:{}}});assert.equal(own.snapshot.evidence.graph.contentSha256,Evidence.digest(raw));assert(own.snapshot.evidence.captureContexts.some(c=>c.record&&c.record.git.after.treeOid));
  const otherRaw=side==='before'?after:before,registered=await h.ui.queryRevisions({op:'registerRevisionCapture',raw:JSON.stringify(otherRaw)}),other=await h.ui.queryRevisions({op:'exportRevision',input:{capture:registered.capture,queries:F.captureQueries(otherRaw,side==='before'),declaration:{}}});
  const request={op:'compareRevisions',before:side==='before'?own.snapshot:other.snapshot,after:side==='after'?own.snapshot:other.snapshot,mappings:F.captureMappings(before,after)},expected=await Analysis.create(raw,{rawText:h.raw,revisionCaptures:[otherRaw]}).query(request),value=await h.ui.runRevisionQuery(request);assert.equal(expected.error,undefined);assert.deepEqual(normalized(value),expected);
  if(side==='after'){const buttons=descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Inspect after function');assert(buttons.length);for(const b of buttons)click(b);assert(events.focus.length);assert(events.focus.every(id=>events.accepted.has(id)));assert(value.changes.some(c=>c.after&&c.after.nodeId&&Model.build(raw).procedures.some(p=>p.symbol_id===c.after.nodeId&&p.id!==c.after.nodeId)));}
  const row=value.changes.find(c=>c.key==='guard');assert.equal(row.before.finding.candidateBypass,false);assert.equal(row.after.finding.candidateBypass,true);click(button(h,'Replay revision query'));assert.deepEqual(await completed(h,request,v=>v.replayed),{...expected,replayed:true});
 }finally{h.dispose();}}
});
