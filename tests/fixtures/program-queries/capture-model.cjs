/* Fixture-owned exact declarations. Matching names here never adds production inference. */
'use strict';
const assert=require('node:assert/strict'), Guard=require('../guard-obligations/capture-model.cjs'), Value=require('../value-flow/capture-model.cjs');
const {plan}=require('./fixture-graphs.cjs');
function guardPlan(raw,nearMiss=false){
 const guard=Guard.request(raw,'early_return'),root=guard.function;
 const value={op:'valueFlow',function:root,model:{version:1,sources:[{id:'declared-user-input',at:{procedure:root,port:'parameter',index:nearMiss?0:3}}],sinks:[{id:'declared-operation',at:{call:guard.model.rules[0].operation.call,port:'argument',index:3}}],summaries:[]}};
 return plan(value,guard);
}
function assertGuard(raw,result,nearMiss=false){
 assert.equal(result.error,undefined);const slice=result.results.evidence;
 if(nearMiss){assert.equal(result.results.summary.rows.length,0);assert.equal(slice.rows.length,0);return;}
 assert(result.results.summary.rows.length>0);const members=new Set(slice.rows.map(r=>r.stepKind));
 // This root parameter is the declared source; inherited call inputs carry
 // `parameter` steps only in the separate cross-package propagation fixture.
 for(const kind of ['source','sink','guard-result','guard-outcome','sensitive-operation'])assert(members.has(kind),kind+' independently required by source fixture');
 const guard=Guard.request(raw,'early_return'),root=guard.function,rule=guard.model.rules[0],required=rule.requires[0];
 const one=kind=>{const rows=slice.rows.filter(r=>r.stepKind===kind);assert.equal(rows.length,1,'unique fixture '+kind);return rows[0];};
 const input=one('source'),owners=Guard.rows(raw).filter(r=>r.f.function===root);assert.equal(owners.length,1);
 const {n,f}=owners[0],local=f.value_facts.locals.find(l=>l.local===f.value_facts.parameter_locals[3]);assert(local&&local.role==='parameter');
 assert.equal(input.kind,'valueStep');assert.equal(input.sourceId,'declared-user-input');
 assert.deepEqual(input.detail.endpoint,{procedure:root,port:'parameter',index:3,fields:[]});
 assert.equal(input.procedureId,root);assert.equal(input.detail.sourceProcedure,root);assert.equal(input.detail.nodeId,root+'#'+f.entry);
 assert.equal(input.detail.factId,'local:'+local.local);assert.equal(input.detail.place,'l'+local.local);
 const span={source_file:local.source_file,source_location:local.source_location};
 assert(span.source_file&&Number.isInteger(span.source_location)&&span.source_location>0);
 assert.deepEqual(input.detail.source,span);for(const key of Object.keys(span))assert.equal(input.source[key],span[key]);
 assert.equal(input.source.absolute_file,n.attributes.target_src_path);
 for(const [key,value] of Object.entries({rawNodeId:n.id,procedureId:root,functionId:f.function_id,packageId:n.attributes.package_id,buildUnitId:n.attributes.unit_key,sourceDigest:n.attributes.source_digest}))assert.equal(input.identity[key],value,'exact source owner '+key);
 assert.equal(input.evidencePath,'/nodes/'+raw.nodes.indexOf(n)+'/attributes/flow#value_facts');
 const sink=one('sink'),operation=one('sensitive-operation'),checked=one('guard-result'),outcome=one('guard-outcome');
 assert.equal(sink.callsiteId,rule.operation.call);assert.equal(sink.sinkId,'declared-operation');
 assert.deepEqual(sink.detail.endpoint,{call:rule.operation.call,port:'argument',index:3,fields:[]});
 assert.equal(operation.callsiteId,rule.operation.call);assert.equal(operation.detail.ruleId,rule.id);assert.equal(operation.witness.classification,'supported-compliant');
 for(const row of [checked,outcome]){assert.equal(row.callsiteId,required.at.call);assert.equal(row.detail.requirementId,required.id);}
 assert.deepEqual(checked.detail.bindings,operation.detail.bindings);
 assert.equal(outcome.detail.outcome,true);assert.equal(outcome.detail.requiredOutcome,true);assert.equal(outcome.detail.successful,true);
 assert(operation.witness.requirements.some(r=>r.requirementId===required.id&&r.guardCall===required.at.call&&r.satisfied&&r.requiredOutcome===true&&r.successfulInvocation===outcome.detail.guardInvocationId&&r.reason==='same-path-success-and-exact-bindings'));
 assert(result.results.summary.rows.every(r=>r.call===rule.operation.call&&r.input==='declared-user-input'&&r.guard==='supported-compliant'));
 assert(slice.rows.every(r=>r.identity.rawNodeId&&r.identity.functionId&&r.evidencePath));
}
function valuePlan(raw,name='positive'){
 const q=Value.request(raw,name);return {op:'programQuery',version:1,steps:[{name:'values',op:'analyze',query:q},{name:'sinks',op:'filter',from:'values',where:[{field:'stepKind',test:'eq',value:'sink'}]},{name:'evidence',op:'slice',from:'sinks',relations:['valueEvidence'],direction:'backward',depth:64}],return:['values','evidence']};
}
// Inspect actual captured action-only successors. Each plan selects the source
// block directly, so bounded depth one must include its real exits even when
// unrelated procedure paths are long or branch-heavy.
function controlCases(raw){
 const cases=new Map();raw.nodes.forEach((node,index)=>{if((node.attributes||{}).kind!=='flow_function')return;
   const flow=JSON.parse(node.attributes.flow),bytes=Buffer.byteLength(node.attributes.flow,'utf8');(flow.blocks||[]).forEach((block,bi)=>(block.successors||[]).forEach(edge=>{
     if(edge&&edge.target==null&&['continue','terminate','unreachable'].includes(edge.action)&&(!cases.has(edge.action)||bytes<cases.get(edge.action).bytes))cases.set(edge.action,{procedure:flow.function,block:block.id,successors:block.successors,prefix:'/nodes/'+index+'/attributes/flow#blocks/'+bi+'/successors/',bytes});
   }));
 });assert(cases.has('continue'),'compiler capture must contain a real continue exit');return [...cases.values()];
}
function assertControl(result,control){
 assert.equal(result.error,undefined,JSON.stringify(result.error));const table=result.results.control,seed=table.slice.seeds[0],edges=table.slice.relations.filter(r=>r.from===seed);
 assert.equal(edges.length,control.successors.length,'each raw successor remains distinct');
 control.successors.forEach((edge,index)=>{const found=edges.find(r=>r.evidencePath===control.prefix+index);assert(found,'exact successor pointer '+index);assert.equal(found.successorIndex,index);assert.deepEqual(JSON.parse(JSON.stringify(found.successor)),edge);assert.equal(found.action,edge.action||null);assert.equal(found.edgeKind,edge.kind==='unwind'?'unwind':'normal');
   const target=table.rows.find(r=>r.id===found.to);assert(target,'bounded slice includes actual target');
   if(edge.target!=null){assert.equal(target.kind,'block');assert.equal(target.blockId,edge.target);}
   else{assert.equal(target.kind,'exit');assert.equal(target.action,edge.action);assert.equal(target.exitKind,edge.action==='continue'?(edge.kind==='unwind'?'unwind':'return'):edge.action);assert.equal(target.evidencePath,control.prefix+index);}
 });assert(!table.slice.unmatched.some(r=>r.reason==='invalid-control-successor'));
}
module.exports={guardPlan,assertGuard,valuePlan,controlCases,assertControl};
