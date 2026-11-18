/* Source regressions. Run only after independent source review. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const Analysis = require('../src/analysis-api.js'), Evidence = require('../src/analysis-evidence.js');
const Engine = require('../src/failure-obligations.js');
const Values = require('../src/value-flow.js'), Guards = require('../src/guard-obligations.js');
const F = require('../tests/fixtures/failure-obligations/fixture-graphs.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const run = item => Analysis.create(item.raw).query(item.request);
function indexFor(item) {
  const model=Evidence.create(item.raw).model;
  return Engine.build(Guards.build(Values.build(item.raw,model),model),model);
}
function assertCase(item, value) {
  assert.equal(value.error, undefined, item.name);
  assert.equal(value.finding.candidateViolation, item.violation, item.name);
  assert.equal(value.partialCoverage, item.partial, item.name);
  assert.equal(value.status, item.partial ? 'indeterminate' : item.violation ? 'candidate-violation' : 'supported-compliant', item.name);
  assert.equal(value.finding.definitiveNegative, false); assert.equal(value.finding.vulnerabilityAbsenceProven, false);
  assert.equal(value.semantics.namesInferPolicy, false); assert.equal(value.semantics.branchFeasibilitySolved, false);
  assert(value.request.model.provenance); assert(value.assumptions.some(a => a.includes(value.request.model.provenance)));
}
for (const item of F.cases()) test(item.name + ': declared protocol, identities and explicit coverage', async () => {
  const value = await run(item); assertCase(item, value);
  if(item.gap)assert(value.queryCoverage.gaps.some(g=>g.kind===item.gap),item.name);
  const replay=await Analysis.create(item.raw).query({op:'replay',replay:value.replay});assert.deepEqual(replay.witnesses,value.witnesses,item.name+' replay');
  for (const w of value.witnesses.items) {
    assert.equal(w.root, 'root'); assert(w.subject); assert(w.ruleId); assert(w.steps.length);
    for (const step of w.steps) { assert(step.invocationId); assert(step.sourceIdentity.rawNodeId); assert(step.evidencePath); }
  }
});
test('typed fresh tuple and nested ancestor writes lose distinctness without fabricating a violation',async()=>{
  for(const nested of [false,true])for(const write of [false,true]){
    const item=F.freshAggregate(nested,write),index=indexFor(item);
    for(const entry of index.procedures.values())assert.equal(entry.value.status,'captured','consistent typed aggregate descriptors');
    const value=await Engine.analyze(index,item.request);
    assert.equal(value.finding.candidateViolation,false);assert.equal(value.partialCoverage,write);
    assert.equal(value.status,write?'indeterminate':'supported-compliant');
    if(write)assert(value.queryCoverage.gaps.some(g=>g.kind==='unproven-subject-alias'));
  }
  assert.equal((await run(F.freshWrong())).finding.candidateViolation,true,'independent declared factory results remain distinct');
});
test('query-reachable malformed execution metadata cannot be repaired by a normalized direct target',async()=>{
  for(const item of F.metadataCases()){
    const value=await run(item);assertCase(item,value);
    if(item.name.startsWith('malformed-targets-')){
      assert(value.captureDiagnostics.items.some(d=>d.nodeId==='root#bb1'&&d.procedure==='root'));
      assert.equal(value.captureDiagnostics.total,1);assert.equal(value.captureDiagnostics.items.length,1);assert.equal(value.captureDiagnostics.truncated,false);
      assert(value.queryCoverage.gaps.some(g=>g.kind==='malformed-execution-record'));
      assert.equal(value.finding.supportedCompliantPath,false);assert.equal(value.witnesses.items.length,0);
    }
    if(item.name==='disjoint-malformed-targets'){
      assert(value.captureDiagnostics.items.some(d=>d.procedure==='disjoint'&&d.nodeId==='disjoint#bb0'));
      assert.equal(value.captureDiagnostics.total,1);assert.equal(value.captureDiagnostics.items.length,1);assert.equal(value.captureDiagnostics.truncated,false);
      assert.deepEqual(value.queryCoverage.gaps,[]);assert.equal(value.status,'supported-compliant');
    }
    if(item.name.startsWith('callback-row-')){
      const core=await Engine.analyze(indexFor(item),item.request);
      assert.equal(core.status,value.status,item.name+' shared core');assert.equal(core.partialCoverage,item.partial,item.name);
      assert.equal(core.finding.candidateViolation,false);assert.equal(core.finding.supportedCompliantPath,!item.partial);
      const replay=await Analysis.create(item.raw).query({op:'replay',replay:value.replay});
      assert.deepEqual(replay,{...value,replayed:true},item.name+' complete API replay');
      if(item.partial){
        for(const result of [core,value]){
          assert(result.queryCoverage.gaps.some(g=>g.kind===item.gap),item.name);
          assert.equal(result.witnesses.items.length,0);assert.equal(result.finding.supportedCompliantPath,false);
        }
      }
    }
  }
});
test('normal, handled error and propagated unwind retain exact cleanup edges and completion effects', async () => {
  for (const handled of [false,true]) {
    const item = F.unwind(true, handled), value = await run(item);
    const row = value.witnesses.items.find(w => w.outcome === (handled ? 'error' : 'unwind')); assert(row);
    assert.equal(row.state, 'idle'); assert.equal(row.classification, 'supported-compliant');
    const transition = row.steps.find(s=>s.transitionId==='release-cleanup'); assert(transition);
    assert(row.steps.some(s=>s.edgeId && s.edgeId.includes('root#bb1->root#bb3')));
    assert(row.steps.some(s=>s.procedure==='release' && s.invocationId!==transition.invocationId));
    assert(value.witnesses.items.some(w=>w.outcome==='normal'));
  }
  const item=F.unwind(false), q=item.request;
  q.model.rules[0].transitions.push(F.transition('only-on-unwind','bb1',['held'],'idle',F.subject(),'root','unwind'));
  const value=await run(item);
  assert.equal(value.finding.candidateViolation,false,'declared unwind completion discharges only the unwind path');
  assert(value.witnesses.items.filter(w=>w.outcome==='normal').every(w=>!w.steps.some(s=>s.transitionId==='only-on-unwind')));
});
test('edge outcome declarations distinguish handled failures without editing captured control', async () => {
  const item=F.resource('clean'), model=Evidence.create(item.raw).model;
  const edge=model.edges.find(e=>e.from==='root#bb0' && e.action==='normal'); assert(edge);
  item.request.model.outcomes=[{id:'handled-error-edge',edge:edge.id,outcome:'error'}];
  const value=await run(item); assert.equal(value.status,'supported-compliant');
  assert(value.witnesses.items.every(w=>w.outcome==='error'));
  assert(value.witnesses.items.some(w=>w.steps.some(s=>s.annotationId==='handled-error-edge' && s.edgeId===edge.id)));
});
test('cancel/drop declarations are modelled at accepted nodes; unmodelled yield/drop/opaque stay unknown', async () => {
  for(const kind of ['cancel','drop']) {
    const item=F.resource(kind), value=await run(item);
    assert.equal(value.finding.candidateViolation,true); assert(value.witnesses.items.every(w=>w.outcome===kind));
    assert(value.witnesses.items.some(w=>w.steps.some(s=>s.kind==='declared-outcome'&&s.modelled)));
    const clean=await run(F.resource(kind+'-clean'));assert.equal(clean.status,'supported-compliant');assert.equal(clean.finding.candidateViolation,false);
    item.request.model.outcomes=[]; const unknown=await run(item);
    assert.equal(unknown.status,'indeterminate'); assert.equal(unknown.finding.candidateViolation,false);
  }
});
test('unavailable external operation stays unknown until an explicit full invocation summary', async () => {
  const item=F.resource('external'); assert.equal((await run(item)).status,'indeterminate');
  item.request.model.summaries=[{id:'declared-external',version:1,call:'root#bb1@call',outcomes:['normal'],returns:'unknown',effects:'declared-protocol-only'}];
  const api=Analysis.create(item.raw),value=await api.query(item.request); assert.equal(value.status,'candidate-violation');
  assert(value.witnesses.items.some(w=>w.steps.some(s=>s.summaryId==='declared-external'&&s.modelled)));
  const core=await Engine.analyze(indexFor(item),item.request);
  for(const result of [core,value]){
    const steps=result.witnesses.items.flatMap(w=>w.steps),external=steps.filter(s=>s.kind==='call'&&s.callsiteId==='root#bb1@call'),known=steps.filter(s=>s.kind==='call'&&s.callsiteId==='root#bb0@call');
    assert(external.length);assert(external.every(s=>s.target===null),'uncaptured summary target is explicitly unknown');
    assert(known.length);assert(known.every(s=>s.target==='acquire'),'captured target ID remains exact');
    assert.deepEqual(clone(result),result,'complete core/API payload survives JSON round trip');
  }
  const replay=await api.query({op:'replay',replay:value.replay});assert.deepEqual(replay,{...value,replayed:true},'complete external-summary API replay');
});
test('summary cannot silently erase a captured unwind continuation', async () => {
  const item=F.unwind(true);
  item.request.model.summaries=[{id:'normal-only',version:1,call:'root#bb1@call',outcomes:['normal'],returns:'fresh',effects:'declared-protocol-only'}];
  const value=await run(item); assert.equal(value.status,'indeterminate');
  assert(value.queryCoverage.gaps.some(g=>g.kind==='summary-uncovered-continuation'));
});
test('root parameter origins do not prove different runtime resource IDs', async () => {
  const item=F.resource('wrong-parameter'), value=await run(item);
  assert.equal(value.finding.candidateViolation,false); assert(value.queryCoverage.gaps.some(g=>g.kind==='unproven-subject-alias'));
  const known=await run(F.freshWrong()); assert.equal(known.finding.candidateViolation,true);
  assert(known.witnesses.items.some(w=>w.reason==='unexpected-transition'));
});
test('callee moves, overwrite and unsupported aliases cannot reuse stale object identities', async () => {
  const moved=F.resource('move'); F.update(moved.raw,'root',f=>{f.value_facts.blocks.find(b=>b.id==='bb1').call.arguments=[F.op(3)];});
  const value=await run(moved); assert.equal(value.status,'indeterminate'); assert.equal(value.finding.candidateViolation,false);
  const aliased=F.resource('copy');F.update(aliased.raw,'root',f=>{const s=f.value_facts.blocks.find(b=>b.id==='bb1').statements[0];s.value={kind:'ref',place:F.place(3)};});
  const alias=await run(aliased); assert.equal(alias.status,'indeterminate'); assert.equal(alias.finding.candidateViolation,false);
});
test('symbol identity, raw body ownership, malformed typed facts and arity are separate capture gates', async () => {
  const changes=[
    f=>{f.function_id='compiler:contradiction';},
    f=>{f.value_facts.parameter_locals=[];},
    f=>{f.value_facts.blocks[0].call.arguments=[];},
    f=>{f.guard_facts.branches=[{block:'not-a-block',kind:'unsupported'}];},
    f=>{f.value_facts.locals[1].shape={kind:'reference',target:{kind:'scalar'}};}
  ];
  for(const change of changes) { const item=F.resource('clean');F.update(item.raw,'root',change);const value=await run(item);assert.equal(value.status,'indeterminate');assert.equal(value.finding.candidateViolation,false); }
  const ambiguous=F.resource('clean'), extra=clone(ambiguous.raw.nodes[0]);extra.id='second-body';ambiguous.raw.nodes.push(extra);
  const value=await run(ambiguous);assert.equal(value.status,'indeterminate');assert.equal(value.finding.candidateViolation,false);
  const missing=F.resource('clean');missing.raw.nodes=missing.raw.nodes.filter(n=>n.id!=='flow:release');
  assert.equal((await run(missing)).status,'indeterminate');
});
test('standard-looking unavailable symbols do not bypass body coverage', async () => {
  const item=F.resource('clean');F.update(item.raw,'root',f=>{f.blocks.find(b=>b.id==='bb1').callee='std::opaque_resource_operation';});
  const value=await run(item);assert.equal(value.status,'indeterminate');assert.equal(value.finding.candidateViolation,false);assert.equal(value.finding.supportedCompliantPath,false);
});
test('exact call IDs and model grammar reject ambiguous or malformed declarations', async () => {
  const changes=[q=>{q.model.version=2;},q=>{delete q.model.provenance;},q=>{q.model.rules[0].terminal.error=undefined;},
    q=>{q.model.rules[0].transitions.push(clone(q.model.rules[0].transitions[0]));},q=>{q.model.rules[0].transitions[0].subject.index=-1;},
    q=>{q.model.rules[0].transitions[0].outcome='error';},q=>{q.model.outcomes=[{id:'bad',node:'root#bb1',edge:'x',outcome:'cancel'}];},
    q=>{q.budgets={maxVisits:5};},q=>{q.model.summaries=[{id:'bad',version:1,call:'root#bb0@call',outcomes:['normal'],returns:'fresh',effects:'none'}];}];
  for(const change of changes){const item=F.resource('clean');change(item.request);assert.throws(()=>Engine.normalize(item.request),{code:'INVALID_FAILURE_OBLIGATIONS'});const value=await run(item);assert.equal(value.error.code,'INVALID_FAILURE_OBLIGATIONS');}
  const missing=F.resource('clean');missing.request.model.rules[0].transitions[0].call='root#missing@call';
  const value=await run(missing);assert.equal(value.status,'indeterminate');assert.equal(value.finding.candidateViolation,false);
});
test('full models, capabilities and results snapshot independently; replay fences capture/version/model identity', async () => {
  const item=F.resource('clean'), raw=clone(item.raw), request=clone(item.request), api=Analysis.create(raw), pending=api.query(request);
  request.model.rules[0].terminal.normal=[];request.model.provenance='mutated';raw.nodes.length=0;
  const value=await pending;assert.equal(value.status,'supported-compliant');assert.notEqual(value.request.model.provenance,'mutated');
  const original=clone(value), replay=await api.query({op:'replay',replay:value.replay});assert.deepEqual(replay.witnesses,value.witnesses);assert.deepEqual(replay.request,value.request);
  value.rules.length=0;value.witnesses.items.length=0;value.replay.request.model.rules.length=0;
  const again=await api.query(item.request);assert.deepEqual(again.witnesses,original.witnesses);
  const caps=await api.query({op:'capabilities'});assert(caps.operations.includes('failureObligations'));caps.failureObligations.version='mutated';
  assert.equal((await api.query({op:'capabilities'})).failureObligations.version,Engine.VERSION);
  const schema=await api.query({op:'schema'});assert.deepEqual(schema.schema.request.operations.failureObligations,['function','model']);
  const version=clone(original.replay);version.versions.failureObligations='wrong';assert.equal((await api.query({op:'replay',replay:version})).error.code,'VERSION_MISMATCH');
  const changed=F.resource('missing');assert.equal((await Analysis.create(changed.raw).query({op:'replay',replay:original.replay})).error.code,'CAPTURE_MISMATCH');
  const altered=clone(original.replay);altered.request.model.rules[0].terminal.normal=[];
  assert.equal((await api.query({op:'replay',replay:altered})).finding.candidateViolation,true,'replay includes the complete altered declaration');
});
test('all query budgets stop conservatively, including retention, forks, frames and fresh instances', async () => {
  for(const [key,n] of [['maxWork',1],['maxStates',1],['maxFrames',1],['maxInstances',1],['maxRetainedBytes',256]]) {
    const item=key==='maxInstances'?F.freshWrong():F.transaction(true);item.request.budgets={[key]:n};
    const value=await run(item);assert.equal(value.status,'indeterminate',key);assert.equal(value.partialCoverage,true,key);assert.equal(value.completion.budgetExceeded,true,key);assert.equal(value.finding.definitiveNegative,false,key);
  }
  const loop=await run(F.retry(false,true));assert.equal(loop.finding.candidateViolation,true);assert.equal(loop.partialCoverage,true);assert(loop.queryCoverage.gaps.some(g=>g.kind==='loop-bound-frontier'));
  const item=F.resource('clean');item.request.budgets={maxEvidence:1};const limited=await run(item);assert.equal(limited.witnesses.truncated,true);assert.equal(limited.completion.evidenceComplete,false);
});
test('nested fact/clone work genuinely yields so cancellation can interrupt a query', async () => {
  const item=F.transaction(true), core=Evidence.create(item.raw);let cancelled=false, turns=0;
  F.update(item.raw,'root',f=>{const values=f.value_facts.blocks[0];for(let i=0;i<5000;i++)values.statements.push({id:'bb0:s'+i,kind:'nop'});});
  const large=Evidence.create(item.raw), timer=setTimeout(()=>{cancelled=true;turns++;},0);
  const value=await large.analyzeFailures(large.prepare(item.request),{cancelled:()=>cancelled});clearTimeout(timer);
  assert.equal(turns,1);assert.equal(value.status,'cancelled');assert.equal(value.completion.cancelled,true);assert.equal(value.finding.candidateViolation,false);
  const timed=await core.analyzeFailures(core.prepare(item.request),{now:(()=>{let t=0;return()=>t+=1000;})()});
  assert.equal(timed.completion.timedOut,true);assert.equal(timed.finding.definitiveNegative,false);
});
test('final source/identity enrichment shares byte/work/time/cancellation bounds before payload retention',async()=>{
  const item=F.longMetadata(),original=clone(item.request),index=indexFor(item),plain=await Engine.analyze(index,item.request,{now:()=>0});
  assert.equal(plain.status,'supported-compliant');
  const core=Evidence.create(item.raw),full=await core.analyzeFailures(core.prepare(item.request),{now:()=>0});
  assert.equal(full.status,'supported-compliant');assert(full.completion.work>plain.completion.work);assert(full.completion.retainedBytes>plain.completion.retainedBytes);
  const step=full.witnesses.items.flatMap(w=>w.steps).find(s=>s.procedure==='root');
  assert.equal(step.sourceIdentity.rawNodeId,item.raw.nodes[0].id);assert.equal(step.identity.rawNodeId,item.raw.nodes[0].id);
  assert.equal(step.source.absolute_file,item.raw.nodes[0].attributes.source_absolute);assert.equal(step.identity.buildUnitId,item.raw.nodes[0].attributes.unit_key);
  item.request.budgets={maxRetainedBytes:65536};
  const api=Analysis.create(item.raw),limited=await api.query(item.request);
  assert.equal(limited.status,'indeterminate');assert.equal(limited.partialCoverage,true);assert.equal(limited.completion.budgetExceeded,true);
  assert.equal(limited.completion.evidenceComplete,false);assert.equal(limited.witnesses.truncated,true);
  assert(limited.completion.retainedBytes>limited.completion.limits.maxRetainedBytes,'rejected reservation is included in conservative counter');
  assert(Buffer.byteLength(JSON.stringify(limited))<65536,'fixed envelope and truncated generated payload fit this regression ceiling');
  const replay=await api.query({op:'replay',replay:limited.replay});assert.deepEqual(replay.witnesses,limited.witnesses);assert.deepEqual(replay.completion,limited.completion);
  item.request=clone(original);item.request.budgets={maxWork:plain.completion.work};
  assert.equal((await Engine.analyze(index,item.request,{now:()=>0})).completion.budgetExceeded,false,'unenriched core fits the same work ceiling');
  const workLimited=await core.analyzeFailures(core.prepare(item.request),{now:()=>0});assert.equal(workLimited.completion.budgetExceeded,true);assert.equal(workLimited.partialCoverage,true);
  item.request=clone(original);let checks=0,firstEnrichment=0;
  await Engine.analyze(index,item.request,{now:()=>0,cancelled:()=>{checks++;return false;}},async(step,retain)=>{if(!firstEnrichment)firstEnrichment=checks;return retain(step);});
  assert(firstEnrichment>0);checks=0;
  const cancelled=await core.analyzeFailures(core.prepare(item.request),{now:()=>0,cancelled:()=>++checks>firstEnrichment+5});
  assert.equal(cancelled.completion.cancelled,true);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.witnesses.items.length,0,'interrupted enrichment never retains an unfinished witness');
  item.request.timeoutMs=5000;let ticks=0;assert.equal((await Engine.analyze(index,item.request,{now:()=>++ticks})).status,'supported-compliant');assert(ticks<5000);
  item.request.timeoutMs=ticks;ticks=0;
  assert.equal((await Engine.analyze(index,item.request,{now:()=>++ticks})).completion.timedOut,false);
  ticks=0;const timed=await core.analyzeFailures(core.prepare(item.request),{now:()=>++ticks});assert.equal(timed.completion.timedOut,true);assert.equal(timed.partialCoverage,true);
  assert.deepEqual(original.model,item.request.model,'request/model declarations unchanged by metadata accounting');
});
if(process.env.FAILURE_CAPTURE||process.env.FAILURE_HTML)test('fresh controlled compiler capture exercises current portable engine and complete replay',async()=>{
  assert(process.env.FAILURE_CAPTURE&&process.env.FAILURE_HTML,'both fresh capture and emitted current HTML required');
  const raw=JSON.parse(fs.readFileSync(process.env.FAILURE_CAPTURE,'utf8')),api=Analysis.create(raw);
  for(const [name,violation] of F.captureCases){
    const q=F.captureRequest(raw,name);assert(q.model.rules.every(rule=>rule.transitions.length>0),name+' nonempty declared protocol');
    const value=await api.query(q);assert.equal(value.error,undefined,name);assert.equal(value.finding.candidateViolation,violation,name);assert.equal(value.finding.definitiveNegative,false);
    if(['loop_retry','unwind_cleanup','suspend_cleanup','unavailable_external'].includes(name))assert.equal(value.partialCoverage,true,name);else assert.equal(value.partialCoverage,false,name);
    if(name==='suspend_cleanup'){
      const flow=F.captureRows(raw).find(({f})=>f.function===q.function).f;
      assert.deepEqual(flow.blocks.map(b=>b.kind),['opaque']);assert.equal(flow.value_facts,undefined);assert.equal(flow.guard_facts,undefined);
      assert.equal(value.status,'indeterminate');assert.equal(value.finding.classification,'unknown');assert.equal(value.finding.supportedCompliantPath,false);assert.deepEqual(value.witnesses.items,[]);
      assert(value.queryCoverage.gaps.some(g=>g.kind==='legacy capture has no typed value capability'&&g.procedure===q.function));
    }
    const replay=await api.query({op:'replay',replay:value.replay});assert.deepEqual(replay.witnesses,value.witnesses,name);assert.deepEqual(replay,{...value,replayed:true},name+' complete replay');
  }
});
module.exports={assertCase};
