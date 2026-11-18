/* Functional execution is gated by independent exact-head source review. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js'),Evidence=require('../src/analysis-evidence.js'),Engine=require('../src/resource-risks.js');
const F=require('../tests/fixtures/resource-risks/fixture-graphs.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const run=item=>Analysis.create(item.raw).query(item.request);
const kinds=value=>value.witnesses.items.map(w=>w.kind);
function assertLimits(value){assert.equal(value.error,undefined);assert.equal(value.finding.measuredHotspot,false);assert.equal(value.finding.deadlockProven,false);assert.equal(value.finding.definitiveNegative,false);assert.equal(value.finding.vulnerabilityAbsenceProven,false);assert.equal(value.semantics.namesInferPolicy,false);assert.equal(value.semantics.measured,false);}
for(const item of F.cases())test(item.name+': paired declared model, bounded representatives and complete immutable replay',async()=>{
 const api=Analysis.create(item.raw),original=clone(item.request),value=await api.query(item.request);assertLimits(value);
 assert.equal(value.finding.candidateRisk,item.candidate,item.name);assert.equal(value.partialCoverage,item.partial,item.name);
 assert.equal(value.status,item.partial?'indeterminate':item.candidate?'static-candidate':'supported',item.name);
 assert.deepEqual(item.request,original);assert.deepEqual(await api.query({op:'replay',replay:value.replay}),{...value,replayed:true});
 for(const row of value.witnesses.items){assert(row.root);assert(row.provenance);assert.equal(row.measured,false);assert.equal(row.deadlockProven,false);
  for(const step of row.steps){assert(step.invocationId);assert(step.sourceIdentity.rawNodeId);assert(step.evidencePath);}
 }
});
for(const item of F.resolverCases())test(item.name+': reviewed source/lifecycle/constraint/invocation contract in portable core, API and replay',async()=>{
 const original=clone(item.request),core=Evidence.create(item.raw),direct=await core.analyzeResources(core.prepare(item.request),{now:()=>0}),api=Analysis.create(item.raw),value=await api.query(item.request);
 assertLimits(direct);F.assertResolver(direct,item);assert.deepEqual(value,direct,'complete API/core payload');assert.deepEqual(item.request,original);
 for(const replayed of [await api.query({op:'replay',replay:value.replay}),await core.analyzeResources(core.prepare({op:'replay',replay:direct.replay}),{now:()=>0})]){F.assertResolver(replayed,item);assert.deepEqual(replayed,{...value,replayed:true});}
 for(const row of value.witnesses.items)for(const step of row.steps){assert.equal(step.sourceIdentity.rawNodeId,'flow:'+step.procedure);assert.equal(step.sourceIdentity.procedureId,step.procedure);assert.equal(step.source.absolute_file,'/fixture/'+step.procedure+'.rs');assert(step.evidencePath);}
});
test('declared input ranges and correlated same-value successful predicates bound only that value',async()=>{
 const bounded=await run(F.allocation(true)),guarded=await run(F.allocation(false,true)),other=await run(F.allocation(false,true,true));
 assert.equal(bounded.witnesses.items[0].bound.maximum,64);assert.equal(guarded.witnesses.items[0].bound.guardId,'size-check');assert.equal(guarded.witnesses.items[0].bound.maximum,32);
 assert.equal(other.witnesses.items[0].bound.status,'unknown');
 const ignored=F.allocation(false,true);F.update(ignored.raw,'root',f=>{f.blocks.find(b=>b.id==='bb1').kind='goto';f.blocks.find(b=>b.id==='bb1').successors=[F.edge('bb2')];f.guard_facts.branches=[];});
 assert.equal((await run(ignored)).witnesses.items[0].bound.status,'unknown','calling a predicate without successful branch correlation proves no bound');
});
test('dependency through supported compute is conservative and does not transfer arithmetic ranges',async()=>{
 const item=F.allocation(true);F.update(item.raw,'root',f=>{const values=f.value_facts.blocks[0];values.statements=[{...F.assign(F.place(4),{kind:'compute',operands:[F.op(1),F.constant()]}),id:'bb0:s0'}];values.call.arguments=[F.op(4)];});
 const value=await run(item);assertLimits(value);assert.equal(value.witnesses.items[0].sources[0].id,'input-size');assert.equal(value.witnesses.items[0].bound.status,'unknown');
});
test('natural nested loops retain one representative with explicit loop bounds and no invented iterations',async()=>{
 for(const bounded of [false,true]){const value=await run(F.loops(true,bounded));const row=value.witnesses.items.find(w=>w.operationId==='repeated');assert(row);assert.equal(row.nestingDepth,2);assert.equal(row.repeated,true);assert(row.loops.every(l=>bounded?Number.isSafeInteger(l.maximum):l.maximum===null));assert(value.queryCoverage.gaps.some(g=>g.kind==='loop-bound-frontier'));assert.equal(value.finding.measuredHotspot,false);}
});
test('opposing order is only a conditional structural cycle; exclusive paths cannot join a concrete invocation',async()=>{
 const opposing=await run(F.locks()),consistent=await run(F.locks(false)),exclusive=await run(F.locks(true,true));
 const cycle=opposing.witnesses.items.find(w=>w.kind==='possible-lock-order-cycle');assert(cycle);assert.equal(cycle.conditionalUnion,true);assert.equal(cycle.concreteExecutionProven,false);assert.equal(cycle.conditionsSharedAcrossActors,false);assert.equal(cycle.orders.length,2);
 assert(!kinds(consistent).includes('possible-lock-order-cycle'));assert(!kinds(exclusive).includes('possible-lock-order-cycle'));
 assert.deepEqual(new Set(cycle.orders.map(o=>o.actor)),new Set(['root','actor']));
});
test('release/drop before suspension and invocation-start declarations preserve actual ordering',async()=>{
 assert(kinds(await run(F.suspension())).includes('lock-held-across-suspension'));assert(!kinds(await run(F.suspension(true))).includes('lock-held-across-suspension'));
 const item=F.suspension(true);item.request.model.operations.find(o=>o.kind==='suspend').node=undefined;Object.assign(item.request.model.operations.find(o=>o.kind==='suspend'),{call:'root#bb1@call',outcome:'invoke'});
 assert(kinds(await run(item)).includes('lock-held-across-suspension'),'suspending helper invocation begins before its release completion');
});
test('matching normal/unwind completions do not discharge a lock on the wrong outcome',async()=>{
 const item=F.suspension(true);item.request.model.operations.find(o=>o.kind==='drop').outcome='unwind';const value=await run(item);assert(kinds(value).includes('lock-held-across-suspension'));
});
test('unknown/native/async/callback/alias wrappers stay partial until an explicit complete invocation summary',async()=>{
 for(const kind of ['native','async','callback','alias']){const value=await run(F.unknown(kind));assert.equal(value.partialCoverage,true);assert.equal(value.finding.definitiveNegative,false);}
 const item=F.unknown();item.request.model.summaries=[{id:'declared-wrapper',version:1,call:'root#bb0@call',outcomes:['normal'],returns:'argument',argument:0,effects:'declared-resource-only'}];
 const value=await run(item);assert.equal(value.partialCoverage,false);assert.equal(value.finding.candidateRisk,true);assert(value.witnesses.items.some(w=>w.steps.some(s=>s.summaryId==='declared-wrapper')));
});
test('all generated work, source enrichment, state cloning and final joins share cancellation/time/byte budgets',async()=>{
 const item=F.loops(true);for(const budgets of [{maxWork:1},{maxRetainedBytes:128},{maxStates:1}]){item.request.budgets=budgets;const value=await run(item);assert.equal(value.completion.budgetExceeded,true);assert.equal(value.partialCoverage,true);assert.equal(value.finding.definitiveNegative,false);}
 delete item.request.budgets;const core=Evidence.create(item.raw);let checks=0;const cancelled=await core.analyzeResources(core.prepare(item.request),{now:()=>0,cancelled:()=>++checks>5});assert.equal(cancelled.completion.cancelled,true);
 const timed=await core.analyzeResources(core.prepare({...item.request,timeoutMs:1}),{now:(()=>{let n=0;return()=>n++;})()});assert.equal(timed.completion.timedOut,true);
 const long=F.allocation();const owner=long.raw.nodes[0];owner.attributes.source_absolute='/fixture/'+'x'.repeat(12000)+'/root.rs';F.update(long.raw,'root',f=>{for(const b of f.blocks)b.source_file='root.rs';});owner.source_file='root.rs';long.request.budgets={maxRetainedBytes:65536};
 const bounded=await run(long);assert.equal(bounded.completion.budgetExceeded,true);assert.equal(bounded.completion.evidenceComplete,false);assert(Buffer.byteLength(JSON.stringify(bounded))<65536);
});
test('validation is strict and API errors remain inside asynchronous JSON boundary',async()=>{
 for(const change of [q=>q.model.operations[0].version=2,q=>q.model.operations[0].cost.unit='milliseconds',q=>q.model.sources[0].maximum=-1,q=>q.model.operations[0].subject.index=-1,q=>q.model.operations[0].kind='Mutex::lock']){const item=F.allocation();change(item.request);assert.throws(()=>Engine.normalize(item.request));assert((await run(item)).error);}
 const api=Analysis.create(F.allocation().raw),cyclic={op:'resourceRisks'};cyclic.model=cyclic;let pending;assert.doesNotThrow(()=>{pending=api.query(cyclic);});assert((await pending).error);
});
if(process.env.RESOURCE_CAPTURE||process.env.RESOURCE_HTML)test('fresh owned Rust capture uses real supported scalar/guard/loop facts and unknown std/native controls',async()=>{
 assert(process.env.RESOURCE_CAPTURE&&process.env.RESOURCE_HTML,'both actual fresh capture and current emitted HTML required');const raw=JSON.parse(fs.readFileSync(process.env.RESOURCE_CAPTURE,'utf8')),api=Analysis.create(raw);
 for(const name of F.captureCases){const q=F.captureRequest(raw,name),value=await api.query(q);assertLimits(value);assert.deepEqual(await api.query({op:'replay',replay:value.replay}),{...value,replayed:true});
  if(name.startsWith('unsupported_')){assert.equal(value.partialCoverage,true,name);assert.equal(value.finding.definitiveNegative,false);}
  else{assert(q.model.operations.length>0,name+' real allocation call');assert(value.witnesses.items.some(w=>w.operationId),name+' real operation evidence');
   if(name==='unknown_size')assert.equal(value.witnesses.items.find(w=>w.operationId).bound.status,'unknown');
   if(name==='declared_bounded'||name==='guarded_size')assert.equal(value.witnesses.items.find(w=>w.operationId).bound.status,'declared-supported');
   if(name==='loop_work'||name==='nested_work'){assert.equal(value.partialCoverage,true);assert(value.witnesses.items.some(w=>w.repeated));if(name==='nested_work')assert(value.witnesses.items.some(w=>w.nestingDepth>=2));}
  }
 }
});
test('irreducible multi-entry loop regions remain explicit unknown coverage',async()=>{
 const raw=F.captured(F.fn('root',3,[F.branch('bb0',2,'bb1','bb2'),F.call('bb1','allocate',[F.op(1)],F.place(0),'bb2'),F.branch('bb2',3,'bb1','bb3'),F.block('bb3')]),F.fn('allocate',1,[F.block('bb0',[F.assign(F.place(0),F.use(F.op(1)))])])),request=F.query([F.operation('irreducible','bb1')]);
 const value=await run({raw,request});assert.equal(value.partialCoverage,true);assert(value.queryCoverage.gaps.some(g=>g.kind==='irreducible-loop-region'));assert(value.witnesses.items.some(w=>w.loops&&w.loops.some(l=>l.irreducible)));
});
test('the shared accounting session remains active after the last actor walker returns',async()=>{
 const Walker=require('../src/failure-obligations.js'),original=Walker.walk,item=F.locks();let returned=0,cancelled=false;
 Walker.walk=async function(...args){const result=await original.apply(this,args);if(++returned===2)cancelled=true;return result;};
 try{const core=Evidence.create(item.raw),value=await core.analyzeResources(core.prepare(item.request),{now:()=>0,cancelled:()=>cancelled});assert.equal(returned,2);assert.equal(value.completion.cancelled,true);assert.equal(value.status,'cancelled');assert.equal(value.completion.evidenceComplete,false);assert(!kinds(value).includes('possible-lock-order-cycle'));}finally{Walker.walk=original;}
});
