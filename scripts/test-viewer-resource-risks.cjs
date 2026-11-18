/* Real viewer form, emitted Blob worker, fallback, source and ownership checks. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js'),F=require('../tests/fixtures/resource-risks/fixture-graphs.cjs');
const {harness,descendants,until,normalized}=require('./test-viewer-effects.cjs');
const panel=h=>h.elements.get('resource-risks-content');
const disclosure=el=>{const pre=descendants(el).find(e=>e.tagName==='pre');return pre&&JSON.parse(pre.textContent);};
const button=(el,text)=>{const b=descendants(el).find(e=>e.tagName==='button'&&e.textContent===text);assert(b,text);return b;};
const click=b=>b.listeners.click();
const ids=(w,k)=>Array.from(w.steps,s=>s[k]).filter(Boolean);
const settle=()=>new Promise(r=>setTimeout(r,20));
async function resourceDisclosure(h,request,replayed=false){
 const query=request.op==='replay'?request.replay.request:request,deadline=performance.now()+(query.timeoutMs??2000)+500;
 for(;;){
  const texts=descendants(panel(h)).concat(descendants(h.panel)).map(e=>e.textContent).concat(h.elements.get('flow-status')?.textContent||'');
  const error=texts.find(text=>/^(?:Resource query error:|Flow (?:catalog|worker) error:)|Entry\/effect worker failed/.test(text));assert.equal(error,undefined,error);
  assert(performance.now()<deadline,'expected completed resource disclosure within query timeout plus 500 ms transport margin');
  const value=disclosure(panel(h));if(value&&(!replayed||value.replayed))return value;await new Promise(r=>setTimeout(r,5));
 }
}
async function launch(worker,item,options={}){
 const h=await harness(worker,item.raw,{allowEmptyEntries:true,...options}),results=[],focus=[],messages=[];let count=0,instance;
 Object.assign(h.context.STATE_UI,{hasProcedure(){return true;},focus(id){focus.push(id);},activate(){},setAnalysis(value){results.push(value);},setData(){count++;}});
 if(worker){const original=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(value){instance=this;messages.push(normalized(value));return original.call(this,value);};}
 return{h,results,focus,messages,get worker(){return instance;},get catalog(){return count;}};
}
for(const worker of [false,true]){
 const transport=worker?'worker':'fallback';
 test(transport+': all four resolver contracts cross the actual form, transport, complete JSON and replay',async()=>{
  for(const item of F.resolverCases()){const events=await launch(worker,item),{h}=events;try{
   const input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Declarative resource-risk request');input.value=JSON.stringify(item.request);input.listeners.input();click(button(panel(h),'Run resource query'));await resourceDisclosure(h,item.request);
   const expected=await Analysis.create(item.raw,{rawText:h.raw}).query(item.request),actual=disclosure(panel(h));F.assertResolver(actual,item);assert.deepEqual(actual,expected,item.name+' complete portable payload');
   if(item.contract.kind==='unsupported-invoke'&&item.contract.held){click(button(panel(h),'Open execution flow'));const selected=expected.witnesses.items[0];assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(selected));assert.deepEqual(normalized(events.results.at(-1).activeCallIds),ids(selected,'callsiteId'));assert.equal(events.focus.at(-1),'root');assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/fixture/root.rs')));}
   click(button(panel(h),'Replay resource query'));await resourceDisclosure(h,item.request,true);F.assertResolver(disclosure(panel(h)),item);assert.deepEqual(disclosure(panel(h)),{...expected,replayed:true},item.name+' complete replay');
  }finally{h.dispose();}}
 });
 test(transport+': nested cycle orders keep distinct exact roots, constraints and separate flow actions',async()=>{
  for(const mode of ['compatible','independent']){const item=F.nestedLocks(mode),events=await launch(worker,item),{h}=events;try{
   const value=await h.ui.runResourceQuery(item.request),cycle=value.witnesses.items.find(w=>w.kind==='possible-lock-order-cycle');F.assertResolver(value,{...item,candidate:true,partial:false});assert(cycle);
   const opens=descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Open execution flow');let at=value.witnesses.items.slice(0,value.witnesses.items.indexOf(cycle)).reduce((n,w)=>n+w.steps.length,0);
   for(const selected of cycle.orders){click(opens[at]);at+=selected.steps.length;const opened=events.results.at(-1);assert.deepEqual(normalized(opened.activeNodeIds),ids(selected,'nodeId'));assert.deepEqual(normalized(opened.activeCallIds),ids(selected,'callsiteId'));assert.deepEqual(normalized(opened.activeEdgeIds),ids(selected,'edgeId'));assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(selected));assert.equal(events.focus.at(-1),selected.root);assert.deepEqual(Array.from(h.context.ENTRY_EFFECT_ACTIVE.nodes).sort(),Array.from(new Set(selected.steps.map(s=>s.sourceIdentity.rawNodeId))).sort());}
  }finally{h.dispose();}}
 });
 test(transport+': paired forms preserve the complete portable API payload, assumptions and replay',async()=>{
  for(const item of F.cases()){const {h}=await launch(worker,item);try{
   const input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Declarative resource-risk request');input.value=JSON.stringify(item.request);input.listeners.input();click(button(panel(h),'Run resource query'));await resourceDisclosure(h,item.request);
   const expected=await Analysis.create(item.raw,{rawText:h.raw}).query(item.request);assert.deepEqual(disclosure(panel(h)),expected,item.name);assert.equal(expected.finding.candidateRisk,item.candidate);assert.equal(expected.partialCoverage,item.partial);
   assert(descendants(panel(h)).some(e=>e.textContent.includes('Static candidates are not measured hotspots')));
   click(button(panel(h),'Replay resource query'));await resourceDisclosure(h,item.request,true);assert.deepEqual(disclosure(panel(h)),{...expected,replayed:true},item.name+' complete replay');
  }finally{h.dispose();}}
 });
 test(transport+': selected cycle order opens only its own exact root/invocation/steps and owns map separately from flow',async()=>{
  const item=F.locks(),events=await launch(worker,item),{h}=events;try{
   h.context.STATE_UI.pins=['keep'];const value=await h.ui.runResourceQuery(item.request),cycle=value.witnesses.items.find(w=>w.kind==='possible-lock-order-cycle');assert(cycle);
   const opens=descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Open execution flow');const prior=value.witnesses.items.slice(0,value.witnesses.items.indexOf(cycle)).reduce((n,w)=>n+w.steps.length,0);
   click(opens[prior+cycle.orders[0].steps.length]);const selected=cycle.orders[1],opened=events.results.at(-1);assert.deepEqual(normalized(opened.activeNodeIds),ids(selected,'nodeId'));assert.deepEqual(normalized(opened.activeCallIds),ids(selected,'callsiteId'));assert.deepEqual(normalized(opened.activeEdgeIds),ids(selected,'edgeId'));
   assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(selected));assert.equal(events.focus.at(-1),selected.steps[0].procedure);assert.deepEqual(h.context.STATE_UI.pins,['keep']);
   const expectedMap=Array.from(new Set(selected.steps.map(s=>s.sourceIdentity.rawNodeId)));assert.deepEqual(Array.from(h.context.ENTRY_EFFECT_ACTIVE.nodes).sort(),expectedMap.sort());
   assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/fixture/')));
   const map=h.context.ENTRY_EFFECT_ACTIVE,oldResults=events.results.length;h.ui.cancelFailures();h.ui.cancelValues();h.ui.cancelGuards();h.ui.cancelConnections();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,map);assert.equal(events.results.length,oldResults);
   // A newer map owner survives resource reset, while a newer pin actor also
   // owns flow independently. This exercises the actual shared lease functions.
   const lease=h.context.claimEntryEffectHighlight({},99);h.context.applyEntryEffectHighlight({activeNodeIds:['newer'],activeEdgePairs:[]},lease);const newerMap=h.context.ENTRY_EFFECT_ACTIVE;
   h.ui.analyzeState(['root']);await until(()=>events.results.length>oldResults);const newerFlow=events.results.at(-1),newerEvidence=disclosure(h.elements.get('state-evidence'));
   h.ui.cancelResources();assert.equal(h.context.ENTRY_EFFECT_ACTIVE,newerMap);assert.equal(events.results.at(-1),newerFlow);assert.deepEqual(disclosure(h.elements.get('state-evidence')),newerEvidence);assert.deepEqual(h.context.STATE_UI.pins,['keep']);
  }finally{h.dispose();}
 });
 test(transport+': dispatched models and replay are immutable; malformed JSON/errors remain async',async()=>{
  const item=F.allocation(),{h}=await launch(worker,item);try{
   const original=normalized(item.request),pending=h.ui.queryResources(item.request);item.request.model.operations.length=0;const value=await pending;assert.deepEqual(normalized(value),await Analysis.create(item.raw,{rawText:h.raw}).query(original));
   const replay={op:'replay',replay:normalized(value.replay)},again=h.ui.queryResources(replay);replay.replay.request.model.sources.length=0;assert.deepEqual(normalized(await again),{...normalized(value),replayed:true});
   const invalid=normalized(original);invalid.model.operations[0].subject.index=-1;const api=await Analysis.create(item.raw).query(invalid);await assert.rejects(h.ui.runResourceQuery(invalid),{code:api.error.code,message:api.error.message});assert.equal(disclosure(panel(h)),undefined);
   const cyclic={op:'resourceRisks'};cyclic.model=cyclic;for(const q of [cyclic,{op:'resourceRisks',model:{n:1n}}]){let promise;assert.doesNotThrow(()=>{promise=h.ui.queryResources(q);});await assert.rejects(promise,{code:'INVALID_REQUEST',message:'request must be JSON serializable'});}
   const input=descendants(panel(h)).find(e=>e.tagName==='textarea');input.value='{';click(button(panel(h),'Run resource query'));assert(descendants(panel(h)).some(e=>e.textContent.includes('Resource query error:')));assert.equal(disclosure(panel(h)),undefined);
  }finally{h.dispose();}
 });
 test(transport+': actual in-flight cancellation, stale catalog/replies, reset and worker errors fence all results',async()=>{
  const item=F.allocation();F.update(item.raw,'root',f=>{for(let i=0;i<10000;i++)f.value_facts.blocks[0].statements.push({id:'bb0:s'+i,kind:'nop'});});
  const events=await launch(worker,item),{h}=events;try{
   const pending=h.ui.runResourceQuery(item.request);pending.catch(()=>{});await new Promise(r=>setTimeout(r,5));h.ui.cancelResources();await assert.rejects(pending,/cancelled/);await settle();assert.equal(disclosure(panel(h)),undefined);
   const fresh=F.allocation(true),before=events.catalog;h.ui.refresh(JSON.stringify(fresh.raw));await until(()=>events.catalog>before);const value=await h.ui.runResourceQuery(fresh.request);assert.equal(value.finding.candidateRisk,false);const current=disclosure(panel(h));
   if(worker){const request=events.messages.filter(m=>m.type==='resource_query').at(-1);events.worker.onmessage({data:{type:'resource_result',catalogToken:request.catalogToken-1,requestId:request.requestId,result:{status:'stale'}}});events.worker.onmessage({data:{type:'resource_error',catalogToken:request.catalogToken,requestId:request.requestId-1,message:'stale'}});assert.deepEqual(disclosure(panel(h)),current);}
   const same=F.allocation();assert.deepEqual(same.raw,fresh.raw,'model-only bounds do not change the capture');
   const count=events.catalog;h.ui.refresh(JSON.stringify(same.raw));await until(()=>events.catalog>count);assert.equal(disclosure(panel(h)),undefined);
   const replay={op:'replay',replay:normalized(value.replay)},sameReplay=await h.ui.runResourceQuery(replay);assert.equal(sameReplay.graph.contentSha256,value.graph.contentSha256);assert.deepEqual(normalized(sameReplay),{...normalized(value),replayed:true});
   const changed=F.allocation();F.update(changed.raw,'root',f=>{f.value_facts.blocks[0].call.arguments=[F.op(2)];});
   const beforeChange=events.catalog;h.ui.refresh(JSON.stringify(changed.raw));await until(()=>events.catalog>beforeChange);assert.equal(disclosure(panel(h)),undefined);
   const changedApi=Analysis.create(changed.raw,{rawText:JSON.stringify(changed.raw)}),changedExpected=await changedApi.query(changed.request),changedValue=await h.ui.runResourceQuery(changed.request);
   assert.equal(changedExpected.error,undefined);assert.equal(changedExpected.partialCoverage,false);assert.deepEqual(normalized(changedValue),changedExpected);assert.notEqual(changedValue.graph.contentSha256,value.graph.contentSha256);
   const mismatch=await changedApi.query(replay);assert.equal(mismatch.error.code,'CAPTURE_MISMATCH');assert.match(mismatch.error.message,/digest/);await assert.rejects(h.ui.runResourceQuery(replay),{code:mismatch.error.code,message:mismatch.error.message});
   if(worker){const before=events.catalog,pending=h.ui.runResourceQuery(F.allocation().request);pending.catch(()=>{});events.worker.onerror();await assert.rejects(pending,/cancelled/);h.ui.refresh(JSON.stringify(F.allocation().raw));await until(()=>events.catalog>before);assert.equal((await h.ui.runResourceQuery(F.allocation().request)).finding.candidateRisk,true);}
  }finally{h.dispose();}
 });
 test(transport+': generated source metadata and final wire payload remain bounded in both real transports',async()=>{
  const item=F.allocation();item.raw.nodes[0].attributes.unit_key='u'.repeat(12000);item.request.budgets={maxRetainedBytes:65536};const {h}=await launch(worker,item);try{
   const value=await h.ui.runResourceQuery(item.request),expected=await Analysis.create(item.raw,{rawText:h.raw}).query(item.request);assert.deepEqual(normalized(value),expected);assert.equal(value.partialCoverage,true);assert.equal(value.completion.budgetExceeded,true);assert.equal(value.completion.evidenceComplete,false);assert(Buffer.byteLength(JSON.stringify(normalized(value)))<65536);
   click(button(panel(h),'Replay resource query'));await resourceDisclosure(h,item.request,true);assert.deepEqual(disclosure(panel(h)),{...expected,replayed:true});
  }finally{h.dispose();}
 });
}
if(process.env.RESOURCE_CAPTURE||process.env.RESOURCE_HTML)test('CURRENT emitted HTML: exact fresh Rust capture and all current module bytes in both transports',async()=>{
 assert(process.env.RESOURCE_CAPTURE&&process.env.RESOURCE_HTML,'both actual owned capture and current HTML required');const raw=JSON.parse(fs.readFileSync(process.env.RESOURCE_CAPTURE,'utf8')),html=fs.readFileSync(process.env.RESOURCE_HTML,'utf8');assert(!html.includes('/*__RESOURCE_RISKS_JS__*/'));
 for(const worker of [false,true]){const {h}=await launch(worker,{raw},{html});try{const api=Analysis.create(raw,{rawText:h.raw});
  for(const name of F.captureCases){const q=F.captureRequest(raw,name),value=await h.ui.runResourceQuery(q),expected=await api.query(q);assert.deepEqual(normalized(value),expected,name);
   if(name.startsWith('unsupported_'))assert.equal(value.partialCoverage,true,name);
   if(value.witnesses.items.length){click(button(panel(h),'Open execution flow'));const first=value.witnesses.items[0];assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(first));assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/')));}
   click(button(panel(h),'Replay resource query'));await resourceDisclosure(h,q,true);assert.deepEqual(disclosure(panel(h)),{...expected,replayed:true},name+' complete emitted replay');
  }
 }finally{h.dispose();}}
});
for(const worker of [false,true])test((worker?'worker':'fallback')+': actual source-enrichment cancellation retains no unfinished representative',async()=>{
 const item=F.allocation(),events=await launch(worker,item),{h}=events;let target,original,finished,entered=false;
 try{await h.ui.queryResources(item.request);target=worker?events.worker.context.ResourceRisks:h.context.ResourceRisks;original=target.analyze;
  target.analyze=async function(index,request,runtime,enrich){finished=await original(index,request,runtime,async(step,retain)=>{if(!entered){entered=true;setTimeout(()=>h.ui.cancelResources(),0);}return enrich(step,retain);});return finished;};
  const pending=h.ui.runResourceQuery(item.request);pending.catch(()=>{});await assert.rejects(pending,/cancelled/);await until(()=>finished,'resource core completes after enrichment cancel');assert(entered);assert.equal(finished.completion.cancelled,true);assert.equal(finished.witnesses.items.length,0);assert.equal(disclosure(panel(h)),undefined);
 }finally{if(target&&original)target.analyze=original;h.dispose();}
});
