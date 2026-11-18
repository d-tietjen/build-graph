/* Only controlled fixtures translate readable labels into exact imported IDs. */
'use strict';
const assert=require('node:assert/strict');
const Model=require('../../../src/execution-model.js'),Values=require('../../../src/value-flow.js'),Guards=require('../../../src/guard-obligations.js');
const F=require('../guard-obligations/fixture-graphs.cjs');
const {fn,captured,call,block:b,edge,op,place:p,assign:a,use,branch,update}=F;
const helper=id=>fn(id,1,[b('bb0',[a(p(0),use(op(1)))])]);
const subject=(index=0)=>({port:'argument',index,fields:[]});
const operation=(id,block,kind='allocation',caller='root',index=0)=>({id,version:1,kind,call:caller+'#'+block+'@call',outcome:'normal',subject:subject(index),...(['acquire','release','drop'].includes(kind)?{lockId:id.split(':')[0]}:{cost:{perUnit:8,unit:kind==='io'?'io-operations':'bytes'}})});
const query=(operations,sources=[{id:'input-size',at:{procedure:'root',port:'parameter',index:0,fields:[]}}])=>({op:'resourceRisks',function:'root',actors:[],model:{version:1,provenance:'controlled resource assumptions v1',sources,operations,guardBounds:[],loopBounds:[],summaries:[]}});
function allocation(bounded=false,guarded=false,wrong=false){
 const blocks=guarded?[call('bb0','predicate',[op(wrong?2:1)],p(3),'bb1'),branch('bb1',3,'bb2','bb4'),call('bb2','allocate',[op(1)],p(0),'bb4'),b('bb4')]:[call('bb0','allocate',[op(1)],p(0),'bb1'),b('bb1')];
 const q=query([operation('allocation',guarded?'bb2':'bb0')]);if(bounded)q.model.sources[0].maximum=64;
 if(guarded)q.model.guardBounds.push({id:'size-check',version:1,call:'root#bb0@call',subject:subject(),success:true,maximum:32});
 return{raw:captured(fn('root',2,blocks),helper('allocate'),helper('predicate')),request:q};
}
function loops(nested=false,bounded=false,kind='allocation'){
 const blocks=nested?[b('bb0',[],'goto',[edge('bb1')]),branch('bb1',2,'bb5','bb2'),branch('bb2',3,'bb4','bb3'),call('bb3','allocate',[op(1)],p(0),'bb2'),b('bb4',[],'goto',[edge('bb1')]),b('bb5')]:[branch('bb0',2,'bb2','bb1'),call('bb1','allocate',[op(1)],p(0),'bb0'),b('bb2')];
 const q=query([operation('repeated',nested?'bb3':'bb1',kind)]);
 if(bounded)q.model.loopBounds.push({id:'outer-bound',version:1,node:'root#'+(nested?'bb1':'bb0'),maximum:10},...(nested?[{id:'inner-bound',version:1,node:'root#bb2',maximum:4}]:[]));
 return{raw:captured(fn('root',nested?3:2,blocks),helper('allocate')),request:q};
}
function lockBlocks(reverse=false,offset=0){const one=reverse?2:1,two=reverse?1:2;return [call('bb'+offset,'lock',[op(one)],p(4),'bb'+(offset+1)),call('bb'+(offset+1),'lock',[op(two)],p(5),'bb'+(offset+2)),call('bb'+(offset+2),'unlock',[op(two)],p(0),'bb'+(offset+3)),call('bb'+(offset+3),'unlock',[op(one)],p(0),'bb'+(offset+4)),b('bb'+(offset+4))];}
const lockPath=(id,reverse=false)=>fn(id,3,lockBlocks(reverse));
function lockOps(id,reverse=false,offset=0){const one=reverse?'B':'A',two=reverse?'A':'B';return [[0,'acquire',one],[1,'acquire',two],[2,'release',two],[3,'release',one]].map(([i,kind,lock])=>({...operation(id+'-'+(offset+i),'bb'+(offset+i),kind,id),lockId:'shared:'+lock}));}
function locks(opposing=true,exclusive=false){
 let raw,q;if(exclusive){const blocks=[branch('bb0',3,'bb1','bb6'),...lockBlocks(false,1),...lockBlocks(true,6)];raw=captured(fn('root',3,blocks),helper('lock'),helper('unlock'));q=query([...lockOps('root',false,1),...lockOps('root',true,6)],[]);}
 else{raw=captured(lockPath('root'),lockPath('actor',opposing),helper('lock'),helper('unlock'));q=query([...lockOps('root'),...lockOps('actor',opposing)],[]);q.actors=['actor'];}
 return{raw,request:q};
}
function suspension(drop=false){
 const blocks=[call('bb0','lock',[op(1)],p(3),'bb1'),...(drop?[call('bb1','unlock',[op(1)],p(0),'bb2'),b('bb2')]:[b('bb1')])];
 const q=query([{...operation('hold','bb0','acquire'),lockId:'shared:A'},...(drop?[{...operation('drop','bb1','drop'),lockId:'shared:A'}]:[]),{id:'suspension-point',version:1,kind:'suspend',node:'root#'+(drop?'bb2':'bb1')}],[]);
 return{raw:captured(fn('root',2,blocks),helper('lock'),helper('unlock')),request:q};
}
function unknown(kind='native'){
 const item=allocation();update(item.raw,'root',f=>{const block=f.blocks[0];if(kind==='native')block.native_call={symbol:'opaque'};if(kind==='callback')block.callback_unknown=true;if(kind==='async')block.kind='yield';if(kind==='alias')f.value_facts.blocks[0].statements.unshift({id:'bb0:s-alias',kind:'unsupported',reason:'reference/RAII wrapper'});});return item;
}
function recursion(){const item={raw:captured(fn('root',1,[call('bb0','root',[op(1)],p(0),'bb1'),b('bb1')])),request:query([])};return item;}
function derivedSource(mode='immediate',bounded=false,selected='source'){
 const compute=local=>a(p(4),{kind:'compute',operands:[op(local),F.constant()]}),cross=mode.startsWith('cross'),further=mode==='further'||mode==='cross-compute';
 const consumed=selected==='ancestor'?2:selected==='unrelated'?3:further?4:1;
 const worker=cross?[call('bb0','relay',[op(consumed),op(3)],p(5),'bb1',further?[compute(1)]:[]),call('bb1','allocate',[op(5)],p(0),'bb2'),b('bb2')]:[call('bb0','allocate',[op(consumed)],p(0),'bb1',further?[compute(1)]:[]),b('bb1')];
 const q=query([operation('derived-allocation',cross?'bb1':'bb0','allocation','worker')],[{id:'callee-size',at:{procedure:'worker',port:'parameter',index:0,fields:[]},...(bounded?{maximum:40}:{})}]);
 const raw=captured(fn('root',2,[call('bb0','worker',[op(4),op(1),op(2)],p(0),'bb1',[compute(1)]),b('bb1')]),fn('worker',3,worker),fn('relay',2,[b('bb0',[a(p(0),use(op(selected==='swap'?2:1)))])]),helper('allocate'));
 return{raw,request:q,contract:{kind:'source',source:!['ancestor','unrelated','swap'].includes(selected),maximum:bounded&&!further?40:null,call:'worker#'+(cross?'bb1':'bb0')+'@call'}};
}
function repeatedLocks(releases=1,different=false,completion='normal',wrongRelease=false,wrongAcquire=false){
 const completed=(id,callee,local,next)=>call(id,callee,[op(local)],p(4),next,[],completion==='unwind'?{successors:[edge('normal-return'),{kind:'unwind',target:next,label:'cleanup'}]}:{});
 const blocks=[completed('bb0','lock',1,'bb1'),completed('bb1','lock',different?2:1,'bb2'),completed('bb2','unlock',1,'bb3'),...(releases===2?[completed('bb3','unlock',different?2:1,'bb4'),b('bb4')]:[b('bb3')]),...(completion==='unwind'?[b('normal-return')]:[])];
 const ops=[operation('first-acquire','bb0','acquire'),operation('second-acquire','bb1','acquire'),operation('first-release','bb2','release'),...(releases===2?[operation('second-release','bb3','drop')]:[])].map(o=>({...o,lockId:'shared:A',outcome:(o.kind==='acquire'?wrongAcquire:wrongRelease)?(completion==='normal'?'unwind':'normal'):completion}));
 const point='root#'+(releases===2?'bb4':'bb3');ops.push({id:'suspension-point',version:1,kind:'suspend',node:point});
 const completeHelper=id=>completion==='normal'?helper(id):fn(id,1,[b('bb0',[],'unwind')]);
 return{raw:captured(fn('root',2,blocks),completeHelper('lock'),completeHelper('unlock')),request:query(ops,[]),contract:{kind:'reacquire',held:wrongAcquire?0:wrongRelease?2:2-releases,subject:different?'invocation:1:parameter:1':'invocation:1:parameter:0',uncertain:different&&!wrongAcquire,point,completion,wrongAcquire,wrongRelease}};
}
function nestedLocks(mode='exclusive'){
 const rootBlocks=mode==='compatible'?[branch('bb0',3,'bb1','bb3'),call('bb1','forward',[op(1),op(2),op(3)],p(0),'bb2'),call('bb2','reverse',[op(1),op(2),op(3)],p(0),'bb3'),b('bb3')]:[branch('bb0',3,'bb1',mode==='independent'?'bb3':'bb2'),call('bb1','forward',[op(1),op(2),op(3)],p(0),'bb3'),...(mode==='independent'?[]:[call('bb2','reverse',[op(1),op(2),op(3)],p(0),'bb3')]),b('bb3')];
 const bridge=(id,target)=>fn(id,3,[call('bb0',target,[op(1),op(2),op(3)],p(0),'bb1'),b('bb1')]);
 const raw=captured(fn('root',3,rootBlocks),...(mode==='independent'?[fn('actor',3,[branch('bb0',3,'bb2','bb1'),call('bb1','reverse',[op(1),op(2),op(3)],p(0),'bb2'),b('bb2')])]:[]),bridge('forward','forward-leaf'),bridge('reverse','reverse-leaf'),lockPath('forward-leaf'),lockPath('reverse-leaf',true),helper('lock'),helper('unlock'));
 const q=query([...lockOps('forward-leaf'),...lockOps('reverse-leaf',true)],[]);if(mode==='independent')q.actors=['actor'];
 return{raw,request:q,contract:{kind:'nested',cycle:mode!=='exclusive',independent:mode==='independent'}};
}
function unsupportedSuspension(kind='external',released=false,wrongSelector=false){
 const targetBlock=released?'bb2':'bb1',end=released?'bb3':'bb2';
 const blocks=[call('bb0','lock',[op(1)],p(3),'bb1'),...(released?[call('bb1','unlock',[op(1)],p(0),'bb2')]:[]),call(targetBlock,kind==='external'?null:'missing',[],p(0),end,[],kind==='external'?{native_call:{symbol:'opaque'}}:{}),b(end)];
 const q=query([{...operation('hold','bb0','acquire'),lockId:'shared:A'},...(released?[{...operation('release','bb1','release'),lockId:'shared:A'}]:[]),{id:'suspension-point',version:1,kind:'suspend',call:'root#'+(wrongSelector?'bb0':targetBlock)+'@call',outcome:'invoke'}],[]);
 const raw=captured(fn('root',1,blocks),helper('lock'),helper('unlock'),...(kind==='missing'?[fn('missing',0,[b('bb0')])]:[]));
 if(kind==='missing')update(raw,'missing',f=>{delete f.value_facts;});
 return{raw,request:q,contract:{kind:'unsupported-invoke',held:!released&&!wrongSelector,call:'root#'+targetBlock+'@call',point:'root#'+targetBlock}};
}
function resolverCases(){return[
 ...['immediate','further','cross-call','cross-compute'].flatMap(mode=>[false,true].map(bounded=>({name:'source-'+mode+'-'+bounded,...derivedSource(mode,bounded),candidate:!bounded||mode==='further'||mode==='cross-compute',partial:false}))),
 ...['ancestor','unrelated','swap'].map(selected=>({name:'source-negative-'+selected,...derivedSource('cross-call',true,selected),candidate:false,partial:false})),
 ...['normal','unwind'].flatMap(completion=>[1,2].flatMap(releases=>[false,true].map(different=>({name:'reacquire-'+completion+'-'+releases+'-'+different,...repeatedLocks(releases,different,completion),candidate:releases===1,partial:different})))),
 ...['normal','unwind'].flatMap(completion=>[false,true].map(wrongAcquire=>({name:'reacquire-wrong-'+completion+'-'+wrongAcquire,...repeatedLocks(2,false,completion,!wrongAcquire,wrongAcquire),candidate:!wrongAcquire,partial:wrongAcquire}))),
 ...['exclusive','compatible','independent'].map(mode=>({name:'nested-'+mode,...nestedLocks(mode),candidate:mode!=='exclusive',partial:false})),
 ...['external','missing'].flatMap(kind=>[[false,false],[true,false],[false,true]].map(([released,wrong])=>({name:'unsupported-invoke-'+kind+'-'+released+'-'+wrong,...unsupportedSuspension(kind,released,wrong),candidate:!released&&!wrong,partial:true})))
];}
// Independent expected facts are shared by core/API/replay and both actual UI
// transports so parity cannot hide a common false negative or false positive.
function assertResolver(value,item){
 const c=item.contract,rows=value.witnesses.items;
 if(c.kind==='reacquire'){
  const model=Model.build(item.raw),values=Values.build(item.raw,model),guards=Guards.build(values,model);
  for(const id of ['root','lock','unlock']){assert.equal(values.procedures.get(id)?.status,'captured',item.name+' '+id+' value index');assert.equal(guards.procedures.get(id)?.status,'captured',item.name+' '+id+' guard index');}
 }
 assert.equal(value.error,undefined,item.name);assert.equal(value.finding.candidateRisk,item.candidate,item.name);assert.equal(value.partialCoverage,item.partial,item.name);
 assert.equal(value.finding.deadlockProven,false);assert.equal(value.finding.measuredHotspot,false);
 if(c.kind==='source'){
  const row=rows.find(w=>w.operationId==='derived-allocation');assert.equal(!!row,c.source,item.name);
  if(row){assert.deepEqual(row.sources.map(s=>s.id),['callee-size']);assert.equal(row.sources[0].maximum,item.request.model.sources[0].maximum??null);assert.equal(row.bound.maximum,c.maximum);assert.equal(row.bound.status,c.maximum==null?'unknown':'declared-supported');assert.equal(row.root,'root');assert(row.steps.some(s=>s.callsiteId===c.call));}
 }
 if(c.kind==='reacquire'){
  const held=rows.filter(w=>w.kind==='lock-held-across-suspension');assert.equal(held.length,c.held,item.name);assert(!rows.some(w=>w.kind==='possible-lock-order-cycle'||w.kind==='lock-order'));
  assert.equal(value.queryCoverage.gaps.some(g=>g.kind==='unproven-reacquired-lock-subject'),c.uncertain);
  for(const row of held){assert.equal(row.lockId,'shared:A');assert.equal(row.suspensionPoint,c.point);assert.equal(row.root,'root');assert(row.acquisitionBasis.includes('runtime reentrancy is not assumed'));assert(['first-acquire','second-acquire'].includes(row.acquisitionOperationId));if(c.held===1){assert.equal(row.subject,c.subject);assert.equal(row.acquisitionOperationId,c.uncertain?'second-acquire':'first-acquire');}}
 }
 if(c.kind==='nested'){
  const orders=rows.filter(w=>w.kind==='lock-order'),cycle=rows.find(w=>w.kind==='possible-lock-order-cycle');assert.equal(orders.length,2);assert.equal(!!cycle,c.cycle,item.name);
  const key='invocation:1:parameter:2';assert.deepEqual(Array.from(orders,o=>o.constraints[key]).sort(),c.independent||!c.cycle?[false,true]:[true,true]);assert(orders.every(o=>o.steps.some(s=>s.procedure===o.actor)));assert.equal(new Set(orders.map(o=>o.invocationId)).size,c.independent?1:2);
  if(cycle){assert.equal(cycle.conditionalUnion,true);assert.equal(cycle.concreteExecutionProven,false);assert.equal(cycle.conditionsSharedAcrossActors,false);assert.equal(cycle.orders.length,2);assert.deepEqual(new Set(cycle.orders.map(o=>o.root)),new Set(c.independent?['root','actor']:['root']));assert(cycle.orders.every(o=>Object.hasOwn(o.constraints,key)));}
 }
 if(c.kind==='unsupported-invoke'){
  const held=rows.filter(w=>w.kind==='lock-held-across-suspension');assert.equal(held.length,c.held?1:0,item.name);assert(value.queryCoverage.gaps.some(g=>g.kind==='unsupported-call-target'||g.kind==='legacy capture has no typed value capability'||g.kind==='missing-body'));
  if(held.length){const row=held[0],last=row.steps.at(-1);assert.equal(row.operationId,'suspension-point');assert.equal(row.suspensionPoint,c.point);assert.equal(row.root,'root');assert.equal(row.subject,'invocation:1:parameter:0');assert.equal(last.kind,'invocation');assert.equal(last.callsiteId,c.call);assert.equal(last.nodeId,c.point);assert.equal(last.procedure,'root');assert(!Object.hasOwn(last,'target'));assert(!Object.hasOwn(last,'outcome'));assert(!row.steps.some(s=>s.procedure==='missing'||s.callsiteId===c.call&&s.kind!=='invocation'));assert.equal(last.source.source_file,'/fixture/root.rs');}
 }
}
function cases(){return[
 {name:'unknown-size',...allocation(),candidate:true,partial:false},
 {name:'declared-bounded-size',...allocation(true),candidate:false,partial:false},
 {name:'guarded-same-size',...allocation(false,true),candidate:false,partial:false},
 {name:'guarded-other-size',...allocation(false,true,true),candidate:true,partial:false},
 ...[false,true].flatMap(nested=>[false,true].map(bounded=>({name:'loops-'+nested+'-'+bounded,...loops(nested,bounded),candidate:true,partial:true}))),
 ...['clone','io','work'].map(kind=>({name:'repeated-'+kind,...loops(false,false,kind),candidate:true,partial:true})),
 {name:'opposing-lock-order',...locks(),candidate:true,partial:false},
 {name:'consistent-lock-order',...locks(false),candidate:false,partial:false},
 {name:'exclusive-lock-order',...locks(true,true),candidate:false,partial:false},
 {name:'held-suspension',...suspension(),candidate:true,partial:false},
 {name:'drop-before-suspension',...suspension(true),candidate:false,partial:false},
 ...['native','callback','async','alias'].map(kind=>({name:'unknown-'+kind,...unknown(kind),candidate:false,partial:true})),
 {name:'recursion',...recursion(),candidate:true,partial:true}
];}
const captureRows=raw=>raw.nodes.filter(n=>(n.attributes||{}).kind==='flow_function').map(n=>({n,f:JSON.parse(n.attributes.flow)}));
function declaration(raw,name){const rows=captureRows(raw).filter(({n,f})=>(n.attributes.display_path||f.function)==='resource_risks_fixture::'+name);assert.equal(rows.length,1,name);return rows[0].f;}
function captureRequest(raw,name){
 let root=declaration(raw,name);if(name==='unsupported_async'){const closures=captureRows(raw).filter(({n})=>(n.attributes.display_path||'')==='resource_risks_fixture::unsupported_async::{closure#0}');assert.equal(closures.length,1);root=closures[0].f;}
 const q=query([],[{id:'input-size',at:{procedure:root.function,port:'parameter',index:0,fields:[]}}]);q.function=root.function;
 const target=declaration(raw,'allocate').function;
 for(const block of root.blocks)if(block.callee===target||Array.isArray(block.callee_targets)&&block.callee_targets.includes(target))q.model.operations.push(operation('allocate-'+block.id,block.id,'allocation',root.function));
 if(name==='declared_bounded')q.model.sources[0].maximum=64;
 if(name==='guarded_size'){
  const predicate=declaration(raw,'within_limit').function;
  const sites=root.blocks.filter(b=>b.callee===predicate||Array.isArray(b.callee_targets)&&b.callee_targets.includes(predicate));assert.equal(sites.length,1);
  q.model.guardBounds=[{id:'size-check',version:1,call:root.function+'#'+sites[0].id+'@call',subject:subject(),success:true,maximum:64}];
 }
 return q;
}
const captureCases=['unknown_size','declared_bounded','guarded_size','loop_work','nested_work','unsupported_mutex','unsupported_raii','unsupported_async','unsupported_native'];
module.exports={...F,subject,operation,query,allocation,loops,locks,suspension,unknown,recursion,derivedSource,repeatedLocks,nestedLocks,unsupportedSuspension,resolverCases,assertResolver,cases,captureRows,declaration,captureRequest,captureCases};
