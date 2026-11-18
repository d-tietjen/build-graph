/* Actual emitted viewer transport and semantic controls; no copied application JS. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js');
const F=require('../tests/fixtures/failure-obligations/fixture-graphs.cjs');
const {harness,descendants,until,normalized}=require('./test-viewer-effects.cjs');
const panel=h=>h.elements.get('failure-obligations-content');
const disclosure=el=>{const pre=descendants(el).find(e=>e.tagName==='pre');return pre&&JSON.parse(pre.textContent);};
function button(el,text){const b=descendants(el).find(e=>e.tagName==='button'&&e.textContent===text);assert(b,text);return b;}
function click(el){if(el.listeners.click)el.listeners.click();else el.onclick();}
const textOf=el=>descendants(el).map(e=>e.textContent).join('\n');
// Fallback witnesses belong to the viewer VM; construct expected ID arrays here.
const stepIds=(w,key)=>Array.from(w.steps,s=>s[key]).filter(Boolean);
const settle=()=>new Promise(r=>setTimeout(r,20));
function observe(h,worker){
  const results=[],focus=[],messages=[];let catalog=0,instance=null;
  Object.assign(h.context.STATE_UI,{hasProcedure(){return true;},focus(id){focus.push(id);},activate(){},setAnalysis(v){results.push(v);},setData(){catalog++;}});
  if(worker){const original=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(value){instance=this;messages.push(normalized(value));return original.call(this,value);};}
  return{results,focus,messages,get worker(){return instance;},get catalog(){return catalog;}};
}
function assertParity(browser,api,message){assert.deepEqual(normalized(browser),api,message);}
async function launch(worker,item,options={}){const h=await harness(worker,item.raw,{allowEmptyEntries:true,...options});return{h,events:observe(h,worker)};}
for(const worker of [false,true]){
  const transport=worker?'worker':'fallback';
  test(transport+': explicit empty-entry readiness observes completed inventory and keeps catalog errors',async()=>{
    const h=await harness(worker,{nodes:[],edges:[]},{allowEmptyEntries:true});
    assert.equal((await h.ui.queryEntryEffects({op:'entrypoints'})).entries.total,0);h.dispose();
    await assert.rejects(harness(worker,{nodes:null,edges:[]},{allowEmptyEntries:true}),/graph requires nodes and edges arrays/);
  });
  test(transport+': paired protocol forms share the complete API payload and replay',async()=>{
    for(const item of F.cases()){
      const {h}=await launch(worker,item);
      try{
        const input=descendants(panel(h)).find(e=>e.attributes['aria-label']==='Declarative failure-obligation request');
        input.value=JSON.stringify(item.request);input.listeners.input();click(button(panel(h),'Run failure query'));
        await until(()=>disclosure(panel(h)));
        const value=disclosure(panel(h)),api=await Analysis.create(item.raw,{rawText:h.raw}).query(item.request);
        assertParity(value,api,item.name);assert.equal(value.finding.candidateViolation,item.violation,item.name);assert.equal(value.partialCoverage,item.partial,item.name);
        if(item.gap)assert(value.queryCoverage.gaps.some(g=>g.kind===item.gap),item.name);
        if(item.name==='disjoint-malformed-targets'){
          assert(value.captureDiagnostics.items.some(d=>d.procedure==='disjoint'&&d.nodeId==='disjoint#bb0'));
          assert.equal(value.captureDiagnostics.total,1);assert.equal(value.captureDiagnostics.items.length,1);assert.equal(value.captureDiagnostics.truncated,false);
          assert.deepEqual(value.queryCoverage.gaps,[]);
        }
        if(item.name.startsWith('callback-row-')){
          assert.equal(value.finding.supportedCompliantPath,!item.partial,item.name);
          if(item.partial)assert.equal(value.witnesses.items.length,0,item.name);
        }
        if(item.name==='modelled-external'){
          const call=value.witnesses.items.flatMap(w=>w.steps).find(s=>s.kind==='call'&&s.callsiteId==='root#bb1@call');
          assert(call);assert.equal(call.target,null,'uncaptured summary target survives panel JSON');
        }
        assert(textOf(panel(h)).includes('Protocol correctness'));assert(textOf(panel(h)).includes(item.request.model.provenance)||value.assumptions.some(a=>a.includes(item.request.model.provenance)));
        click(button(panel(h),'Replay failure query'));await until(()=>disclosure(panel(h))&&disclosure(panel(h)).replayed);
        assert.deepEqual(disclosure(panel(h)).witnesses,api.witnesses,item.name+' replay');
        if(item.name.startsWith('callback-row-')||item.name==='modelled-external')assertParity(disclosure(panel(h)),{...api,replayed:true},item.name+' complete transport replay');
      }finally{h.dispose();}
    }
  });
  test(transport+': flow/source action consumes one matching captured prefix, root and invocation context',async()=>{
    const item=F.unwind(true),{h,events}=await launch(worker,item);
    try{
      h.context.STATE_UI.pins=['keep-pin'];const value=await h.ui.runFailureQuery(item.request),first=value.witnesses.items[0];assert(first);
      click(button(panel(h),'Open execution flow'));const opened=events.results.at(-1);
      assert.deepEqual(normalized(opened.activeNodeIds),stepIds(first,'nodeId'));
      assert.deepEqual(normalized(opened.activeCallIds),stepIds(first,'callsiteId'));
      assert.deepEqual(normalized(opened.activeEdgeIds),stepIds(first,'edgeId'));
      assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(first));
      assert.equal(events.focus.at(-1),first.steps[0].procedure);assert.equal(first.root,item.request.function);
      assert.deepEqual(h.context.STATE_UI.pins,['keep-pin']);assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/fixture/')));
      assert(first.steps.some(s=>s.sourceIdentity.functionId&&s.evidencePath));
      const second=value.witnesses.items.find(w=>w.outcome!==first.outcome);assert(second,'a different normal/unwind outcome');
      const offset=value.witnesses.items.slice(0,value.witnesses.items.indexOf(second)).reduce((n,w)=>n+w.steps.length,0);
      const opens=descendants(panel(h)).filter(e=>e.tagName==='button'&&e.textContent==='Open execution flow');click(opens[offset]);
      const selected=events.results.at(-1);
      assert.deepEqual(normalized(selected.activeNodeIds),stepIds(second,'nodeId'));
      assert.deepEqual(normalized(selected.activeCallIds),stepIds(second,'callsiteId'));
      assert.deepEqual(normalized(selected.activeEdgeIds),stepIds(second,'edgeId'));
      assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(second),'actual serializer retains the second complete witness');
      assert.equal(events.focus.at(-1),second.steps[0].procedure);assert.deepEqual(h.context.STATE_UI.pins,['keep-pin']);
      const before=events.results.length;h.ui.cancelValues();h.ui.cancelGuards();h.ui.cancelOrdered();h.ui.cancelConnections();assert.equal(events.results.length,before,'older other actors cannot clear this witness');
      h.ui.analyzeState(['root']);await until(()=>events.results.length>before);const newer=events.results.at(-1),evidence=disclosure(h.elements.get('state-evidence'));
      h.ui.cancelFailures();assert.equal(events.results.at(-1),newer);assert.deepEqual(disclosure(h.elements.get('state-evidence')),evidence,'failure clear cannot clobber newer pin evidence');
    }finally{h.dispose();}
  });
  test(transport+': long accepted owner/source metadata remains bounded in the actual API, replay and panel payload',async()=>{
    const item=F.longMetadata();item.request.budgets={maxRetainedBytes:65536};const {h}=await launch(worker,item);
    try{
      const value=await h.ui.runFailureQuery(item.request),api=await Analysis.create(item.raw,{rawText:h.raw}).query(item.request);
      assertParity(value,api,'bounded final transport payload');assert.deepEqual(disclosure(panel(h)),normalized(value));
      assert.equal(value.status,'indeterminate');assert.equal(value.partialCoverage,true);assert.equal(value.completion.budgetExceeded,true);
      assert.equal(value.completion.evidenceComplete,false);assert.equal(value.witnesses.truncated,true);
      assert(value.completion.retainedBytes>65536,'counter includes the rejected reservation');
      assert(Buffer.byteLength(JSON.stringify(normalized(value)))<65536,'no uncharged owner/source expansion crosses the transport');
      click(button(panel(h),'Replay failure query'));await until(()=>disclosure(panel(h))&&disclosure(panel(h)).replayed);
      assert.deepEqual(disclosure(panel(h)).witnesses,api.witnesses);assert.deepEqual(disclosure(panel(h)).completion,api.completion);
    }finally{h.dispose();}
  });
  test(transport+': actual in-flight cancellation interrupts generated source enrichment before retaining a witness',async()=>{
    const item=F.longMetadata(),{h,events}=await launch(worker,item);let target,original,finished,entered=false;
    try{
      assert.equal((await h.ui.queryFailures(item.request)).status,'supported-compliant');
      target=worker?events.worker.context.FailureObligations:h.context.FailureObligations;original=target.analyze;
      // Observe the real enrichment boundary and schedule the ordinary UI cancel;
      // retain the production callback, accounting, timer yields and transports.
      target.analyze=async function(index,request,runtime,enrich){
        finished=await original(index,request,runtime,async(step,retain)=>{
          if(!entered){entered=true;setTimeout(()=>h.ui.cancelFailures(),0);}
          return enrich(step,retain);
        });return finished;
      };
      const pending=h.ui.runFailureQuery(item.request);pending.catch(()=>{});await assert.rejects(pending,/cancelled/);
      await until(()=>finished,'core completion after enrichment cancellation');assert(entered);
      assert.equal(finished.completion.cancelled,true);assert.equal(finished.status,'cancelled');assert.equal(finished.witnesses.items.length,0);
      assert.equal(disclosure(panel(h)),undefined);
    }finally{if(target&&original)target.analyze=original;h.dispose();}
  });
  test(transport+': invalid requests reject inside the async boundary and match API JSON errors',async()=>{
    const item=F.resource('clean'),{h}=await launch(worker,item);
    try{
      const invalid=normalized(item.request);invalid.model.rules[0].transitions[0].subject.index=-1;
      const api=await Analysis.create(item.raw).query(invalid);await assert.rejects(h.ui.runFailureQuery(invalid),{code:api.error.code,message:api.error.message});assert.equal(disclosure(panel(h)),undefined);
      const cyclic={op:'failureObligations'};cyclic.model=cyclic;
      for(const input of [cyclic,{op:'failureObligations',model:{n:1n}}]){let pending;assert.doesNotThrow(()=>{pending=h.ui.queryFailures(input);});assert.equal(typeof pending.then,'function');await assert.rejects(pending,{code:'INVALID_REQUEST',message:'request must be JSON serializable'});}
      const input=descendants(panel(h)).find(e=>e.tagName==='textarea');input.value='{';click(button(panel(h),'Run failure query'));assert.match(textOf(panel(h)),/Failure query error:/);assert.equal(disclosure(panel(h)),undefined);
    }finally{h.dispose();}
  });
  test(transport+': dispatched requests and nested replay models snapshot before caller mutations',async()=>{
    const item=F.resource('clean'),{h}=await launch(worker,item);
    try{
      const original=normalized(item.request),pending=h.ui.queryFailures(item.request);item.request.model.rules[0].terminal.normal=[];item.request.model.provenance='mutated';
      const value=await pending,api=await Analysis.create(item.raw,{rawText:h.raw}).query(original);assertParity(value,api,'dispatch snapshot');
      const request={op:'replay',replay:normalized(value.replay)},replayed=h.ui.queryFailures(request);request.replay.request.model.rules.length=0;request.replay.capture.contentSha256='mutated';
      const replay=await replayed;assert.deepEqual(normalized(replay.witnesses),api.witnesses);assert.equal(replay.replayed,true);
      const scoped=normalized(original);scoped.scope={packageIds:['package:root'],dependencies:'none'};
      assertParity(await h.ui.queryFailures(scoped),await Analysis.create(item.raw,{rawText:h.raw}).query(scoped),'view scope parity');
    }finally{h.dispose();}
  });
  test(transport+': real in-flight cancellation, stale replies, refresh and worker errors preserve ownership',async()=>{
    const item=F.resource('clean');F.update(item.raw,'root',f=>{const v=f.value_facts.blocks[0];for(let i=0;i<10000;i++)v.statements.push({id:'bb0:s'+i,kind:'nop'});});
    const {h,events}=await launch(worker,item);
    try{
      const pending=h.ui.runFailureQuery(item.request);pending.catch(()=>{});await new Promise(r=>setTimeout(r,5));h.ui.cancelFailures();await assert.rejects(pending,/cancelled/);await settle();assert.equal(disclosure(panel(h)),undefined);
      const fresh=F.resource('missing'),before=events.catalog;h.ui.refresh(JSON.stringify(fresh.raw));await until(()=>events.catalog>before);
      const value=await h.ui.runFailureQuery(fresh.request);assert.equal(value.finding.candidateViolation,true);
      const captured=disclosure(panel(h));
      if(worker){
        const current=events.messages.filter(m=>m.type==='failure_query').at(-1);assert(current);
        events.worker.onmessage({data:{type:'failure_result',catalogToken:current.catalogToken-1,requestId:current.requestId,result:{status:'stale'}}});
        events.worker.onmessage({data:{type:'failure_error',catalogToken:current.catalogToken,requestId:current.requestId-1,message:'stale-error'}});
        assert.deepEqual(disclosure(panel(h)),captured);
      }
      click(button(panel(h),'Open execution flow'));const latest=events.results.at(-1);h.ui.cancelGuards();assert.equal(events.results.at(-1),latest);
      const oldReplay=value.replay,changed=F.resource('clean'),count=events.catalog;h.ui.refresh(JSON.stringify(changed.raw));await until(()=>events.catalog>count);assert.equal(disclosure(panel(h)),undefined);
      await assert.rejects(h.ui.runFailureQuery({op:'replay',replay:oldReplay}),/digest/);assert.equal(disclosure(panel(h)),undefined);
      if(worker){
        const count=events.catalog;const inFlight=h.ui.runFailureQuery(changed.request);inFlight.catch(()=>{});events.worker.onerror();await assert.rejects(inFlight,/cancelled/);h.ui.refresh(JSON.stringify(changed.raw));await until(()=>events.catalog>count);assert.equal(disclosure(panel(h)),undefined);
        const fallback=await h.ui.runFailureQuery(changed.request);assert.equal(fallback.status,'supported-compliant');
      }
    }finally{h.dispose();}
  });
}
if(process.env.FAILURE_CAPTURE||process.env.FAILURE_HTML)test('CURRENT emitted HTML: fresh compiler graph, module bytes, both transports, source/state/replay',async()=>{
  assert(process.env.FAILURE_CAPTURE&&process.env.FAILURE_HTML,'both fresh capture and current emitted HTML required');
  const raw=JSON.parse(fs.readFileSync(process.env.FAILURE_CAPTURE,'utf8')),html=fs.readFileSync(process.env.FAILURE_HTML,'utf8');
  assert(!html.includes('/*__FAILURE_OBLIGATIONS_JS__*/'));
  for(const worker of [false,true]){
    const {h,events}=await launch(worker,{raw},{html});
    try{
      const api=Analysis.create(raw,{rawText:h.raw});
      for(const [name,violation]of F.captureCases){const q=F.captureRequest(raw,name);assert(q.model.rules.every(rule=>rule.transitions.length>0),name+' nonempty declared protocol');
        const value=await h.ui.runFailureQuery(q),expected=await api.query(q);assertParity(value,expected,name);assert.equal(value.finding.candidateViolation,violation,name);
        if(name==='suspend_cleanup'){
          assert.equal(value.status,'indeterminate');assert.equal(value.partialCoverage,true);assert.equal(value.finding.classification,'unknown');assert.equal(value.finding.supportedCompliantPath,false);assert.deepEqual(normalized(value.witnesses.items),[]);
          assert(value.queryCoverage.gaps.some(g=>g.kind==='legacy capture has no typed value capability'&&g.procedure===q.function));
        }
        if(value.witnesses.items.length){click(button(panel(h),'Open execution flow'));const first=value.witnesses.items[0];assert.deepEqual(normalized(events.results.at(-1).activeCallIds),stepIds(first,'callsiteId'));assert.deepEqual(disclosure(h.elements.get('state-evidence')).selectedWitness,normalized(first));assert(descendants(panel(h)).some(e=>e.tagName==='a'&&e.href.startsWith('vscode://file/')));}
        click(button(panel(h),'Replay failure query'));await until(()=>disclosure(panel(h))&&disclosure(panel(h)).replayed);assert.deepEqual(disclosure(panel(h)).witnesses,expected.witnesses,name+' emitted replay');assertParity(disclosure(panel(h)),{...expected,replayed:true},name+' complete emitted replay');
      }
    }finally{h.dispose();}
  }
});
