/* Product execution deferred until independent source review. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const Analysis=require('../src/analysis-api.js'),Evidence=require('../src/analysis-evidence.js'),Programs=require('../src/program-queries.js');
const Values=require('../src/value-flow.js');
const F=require('../tests/fixtures/program-queries/fixture-graphs.cjs'),C=require('../tests/fixtures/program-queries/capture-model.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
const api=raw=>Analysis.create(raw||F.fixture());
const simple=()=>({op:'programQuery',version:1,steps:[{name:'functions',op:'select',kind:'function',procedures:['app::investigate']},{name:'rows',op:'project',from:'functions',fields:{id:'id',identity:'identity',source:'source'}}],return:['rows']});
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r.error));assert.equal(r.completion.complete,true);return r;};
const preflight=(r,code)=>{assert.equal(r.error.code,code);assert.equal(r.error.step,'preflight');assert.deepEqual(r.results,{});for(const k of ['work','states','evidence','retainedBytes','rows'])assert.equal(r.completion[k],0,k);return r;};
test('one combined query agrees with public analyzers and independently expected source membership',async()=>{
 for(const near of [false,true]){const raw=F.fixture(near),a=api(raw),r=ok(await a.query(F.plan())),v=await a.query(F.valueQuery()),g=await a.query(F.guardQuery());
  assert.equal(v.finding.candidateInfluence,!near);assert.equal(g.finding.candidateBypass,near);
  const members=r.results.evidence.rows,summary=r.results.summary.rows;
  if(near){assert.equal(summary.length,0);assert.equal(members.length,0);continue;}
  assert(summary.every(s=>s.call==='app::investigate#bb3@call'&&s.guard==='supported-compliant'));
  for(const required of ['parameter','argument-to-parameter','return-to-destination','sink','guard-result','guard-outcome','sensitive-operation'])assert(members.some(m=>m.stepKind===required),required);
  assert(members.some(m=>m.procedureId==='dependency::relay'));assert(!members.some(m=>m.procedureId==='other::decode'));
  assert(members.every(m=>m.identity.rawNodeId.startsWith('graph:flow:')&&m.identity.functionId.startsWith('compiler:')&&m.evidencePath.startsWith('/nodes/')));
  const actualValues=members.filter(m=>m.kind==='valueStep').map(m=>m.detail),expected=v.witnesses.items.flatMap(w=>w.steps).map(({sourceIdentity,identity,evidencePath,views,...step})=>({...step,source:{source_file:step.source.source_file,source_location:step.source.source_location}}));
  assert.deepEqual(actualValues.map(Evidence.digest).sort(),expected.map(Evidence.digest).sort());
  assert.equal(r.results.evidence.slice.analysisCoverage.values.status,v.status);assert.equal(r.results.evidence.slice.analysisCoverage.guards.status,g.status);
 }
});
test('full normalized payload, hash, build context and cold/warm/replay remain deterministic and owned',async()=>{
 const raw=F.fixture(),a=api(raw),input=F.plan(),pending=a.query(input);input.steps[0].query.model.sources[0].id='mutated';raw.nodes[0].source_file='mutated';
 const first=ok(await pending),second=ok(await a.query(F.plan()));assert.deepEqual(second,first);
 assert.deepEqual(first.replay.plan,F.plan());assert.deepEqual(first.plan,Programs.normalize(F.plan()));assert.equal(first.replay.normalizedPlanSha256,Evidence.digest(first.plan));
 assert.equal(first.capture.buildContext.status,'unavailable');assert(first.capture.buildContext.missing.length);
 const replay=ok(await a.query({op:'replay',replay:first.replay}));assert.deepEqual(replay,first);
 const fresh=ok(await api().query({op:'replay',replay:first.replay}));assert.deepEqual(fresh,first);
 second.results.evidence.rows[0].identity.rawNodeId='forged';assert.deepEqual(ok(await a.query(F.plan())),first);
 for(const [change,code] of [[r=>delete r.resultSha256,'INVALID_PROGRAM_REPLAY'],[r=>r.resultSha256='0'.repeat(64),'RESULT_MISMATCH'],[r=>r.capture.contentSha256='0'.repeat(64),'CAPTURE_MISMATCH'],[r=>r.versions.programFacts='v0','VERSION_MISMATCH'],[r=>delete r.normalizedPlanSha256,'INVALID_PROGRAM_REPLAY'],[r=>r.normalizedPlanSha256='0'.repeat(64),'INVALID_PROGRAM_REPLAY'],[r=>r.plan.steps[0].query.model.sources[0].id='changed-valid-declaration','INVALID_PROGRAM_REPLAY']]){const receipt=copy(first.replay);change(receipt);const bad=await a.query({op:'replay',replay:receipt});assert.equal(bad.error.code,code);assert.deepEqual(bad.results,{});if(code==='INVALID_PROGRAM_REPLAY')preflight(bad,code);}
});
test('typed syntactic usages, unavailable kinds and exact ID scopes do not invent dependence',async()=>{
 const a=api(),q={op:'programQuery',version:1,steps:[{name:'args',op:'select',kind:'argument',procedures:['app::investigate'],where:[{field:'callsiteId',test:'eq',value:'app::investigate#bb3@call'}]},{name:'places',op:'traverse',from:'args',relations:['reads'],depth:1},{name:'usage',op:'slice',from:'places',relations:['reads','writes'],direction:'usage',depth:1}],return:['args','usage']};
 const r=ok(await a.query(q));assert.equal(r.results.args.rows.length,1);assert(r.results.usage.rows.some(x=>x.kind==='place'));assert(r.results.usage.slice.relations.every(x=>['reads','writes'].includes(x.kind)));
 const bad=copy(q);bad.steps[0].procedures=['graph:flow:app::investigate'];assert.equal((await a.query(bad)).error.code,'STALE_PROGRAM_REFERENCE');
 const legacy=F.fixture();for(const n of legacy.nodes){const f=JSON.parse(n.attributes.flow);delete f.value_facts;delete f.guard_facts;n.attributes.flow=JSON.stringify(f);}
 const result=ok(await api(legacy).query({op:'programQuery',version:1,steps:[{name:'unknowns',op:'select',kind:'boundary',procedures:['app::investigate']}],return:['unknowns']}));assert(result.results.unknowns.rows.some(r=>r.unavailableKinds.includes('value')));
});
test('action-only control exits preserve Model policy, successor identity and bounded frontiers',async()=>{
 const raw=F.terminalFixture(),a=api(raw),flow=JSON.parse(raw.nodes[0].attributes.flow),control={successors:flow.blocks[0].successors,prefix:'/nodes/0/attributes/flow#blocks/0/successors/'};
 const first=ok(await a.query(F.controlPlan()));C.assertControl(first,control);
 assert.deepEqual(first.results.control.rows.filter(r=>r.kind==='exit').map(r=>r.exitKind),['return','unwind','terminate','unreachable']);
 assert.deepEqual(ok(await a.query({op:'replay',replay:first.replay})),first);
 const bounded=ok(await a.query(F.controlPlan('terminals','bb0',0)));assert.equal(bounded.results.control.slice.frontiers.length,5);assert(bounded.results.control.slice.frontiers.every(f=>JSON.parse(f.nextId.slice(4))[2]!==null));
 const malformed=F.terminalFixture();F.G.update(malformed,'terminals',f=>{f.blocks[0].successors=[null,{target:'missing',kind:'normal'},{target:null,kind:'unwind',action:'unsupported'}];});
 const rejected=ok(await api(malformed).query(F.controlPlan()));assert.equal(rejected.results.control.slice.unmatched.length,3);assert(rejected.results.control.slice.partialCoverage);assert(rejected.results.control.slice.unmatched.every(r=>r.kind==='boundary'&&r.reason==='invalid-control-successor'&&r.classification==='unknown'));
 F.G.update(malformed,'terminals',f=>{delete f.blocks[0].successors;});const missing=ok(await api(malformed).query(F.controlPlan()));assert.equal(missing.results.control.slice.unmatched[0].evidencePath,'/nodes/0/attributes/flow#blocks/0/successors');
});
test('unsupported projection occurrences retain descriptors and unknown usages without false joins',async()=>{
 const raw=F.projectionFixture(),a=api(raw),q={op:'programQuery',version:1,steps:[
   {name:'places',op:'select',kind:'place',procedures:['indexed']},
   {name:'unknowns',op:'filter',from:'places',where:[{field:'classification',test:'eq',value:'unknown'}]},
   {name:'details',op:'project',from:'unknowns',fields:{id:'id',projection:'projection',pointer:'evidencePath',classification:'classification'}},
   {name:'usage',op:'slice',from:'details',relations:['reads','writes'],direction:'usage',depth:1},
   {name:'supported',op:'filter',from:'places',where:[{field:'local',test:'eq',value:6}]},
   {name:'fieldUsage',op:'slice',from:'supported',relations:['reads','writes'],direction:'usage',depth:1}],return:['details','usage','fieldUsage']};
 const r=ok(await a.query(q)),details=r.results.details.rows,usage=r.results.usage;
 assert.equal(details.length,4);assert.equal(new Set(details.map(p=>p.id)).size,4);assert(details.every(p=>p.classification==='unknown'));
 assert.deepEqual(details.map(p=>p.projection[0]),[
   {kind:'unsupported',reason:'index projection',offset:0,min_length:2,from_end:false},
   {kind:'unsupported',reason:'index projection',offset:1,min_length:2,from_end:false},
   {kind:'unsupported',reason:'dynamic index',local:2},{kind:'unsupported',reason:'dynamic index',local:3}]);
 assert.equal(usage.slice.unmatched.length,4);assert(usage.slice.partialCoverage);assert.equal(usage.slice.relations.length,4);
 for(const place of details){assert.equal(usage.slice.relations.filter(edge=>edge.to===place.id).length,1);const edge=usage.slice.relations.find(edge=>edge.to===place.id);assert.equal(edge.classification,'unknown');assert.equal(edge.evidencePath,place.pointer);const tuple=JSON.parse(place.id.slice(4));assert(tuple[2][1][1].startsWith('value_facts/blocks/0/statements/'));}
 const supported=r.results.fieldUsage;assert.equal(supported.rows.filter(p=>p.kind==='place').length,1);assert.equal(supported.slice.relations.length,2);assert(supported.slice.relations.every(edge=>edge.classification==='compiler-confirmed'));assert.equal(supported.slice.partialCoverage,false);
 assert.deepEqual(ok(await a.query({op:'replay',replay:r.replay})),r);
 const direct=await a.query({op:'valueFlow',function:'indexed',model:{version:1,sources:[{id:'input',at:{procedure:'indexed',port:'parameter',index:0}}],sinks:[{id:'output',at:{procedure:'indexed',port:'return'}}],summaries:[]}});assert(direct.queryCoverage.partial);assert(direct.queryCoverage.gaps.some(g=>g.kind.includes('unsupported')));
});
test('near-limit plans and captured build context replay within a distinct finite envelope',async()=>{
 const raw=F.replayFixture(),a=api(raw),size=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
 for(const literal of ['x'.repeat(65300),'é\u0000"\\'.repeat(5400)]){
   const q=F.nearLimitPlan(literal);assert(size(q)<=Programs.schema().inputBytes);const r=ok(await a.query(q)),replay={op:'replay',replay:r.replay};assert.deepEqual(r.replay.plan,q);assert.equal(r.replay.normalizedPlanSha256,Evidence.digest(r.plan));assert(size(replay)>Programs.schema().inputBytes);assert(size(replay)<=Programs.schema().replayInputBytes);assert.equal(r.capture.buildContext.status,'captured');
   if(literal[0]==='x')assert(size(r.plan)>Programs.schema().inputBytes,'default expansion crosses the fresh-plan cap');
   assert.deepEqual(ok(await a.query(replay)),r);assert.deepEqual(ok(await api(raw).query(replay)),r);
 }
 const first=ok(await a.query(F.nearLimitPlan())),oversized={op:'replay',replay:copy(first.replay)};oversized.replay.plan.steps[0].where[0].value='x'.repeat(Programs.schema().replayInputBytes);assert.equal((await a.query(oversized)).error.code,'PROGRAM_BYTES');
 const ordinary=F.nearLimitPlan('x'.repeat(65536));assert.equal((await a.query(ordinary)).error.code,'PROGRAM_BYTES');assert.throws(()=>Programs.normalize(ordinary,true),/byte budget/);
 const malformed={op:'replay',replay:copy(first.replay),extra:true};assert.equal((await a.query(malformed)).error.code,'PROGRAM_BYTES');assert.equal(Programs.isReplayRequest(malformed),false);
 const missingHash={op:'replay',replay:copy(first.replay)};delete missingHash.replay.resultSha256;assert.equal(Programs.isReplayRequest(missingHash),false);assert.equal((await a.query(missingHash)).error.code,'PROGRAM_BYTES');
 const getter={};Object.defineProperty(getter,'op',{enumerable:true,get(){throw new Error('must not execute');}});assert.throws(()=>Programs.admitRequest(getter),/Accessors/);
});
test('replay re-admits the original declaration and pins normalization before query work',async()=>{
 const a=api(),q=F.nearLimitPlan('x'),first=ok(await a.query(q)),oversized={op:'replay',replay:copy(first.replay)};
 oversized.replay.plan.steps[0].where[0].value='x'.repeat(200000);assert(Programs.isReplayRequest(oversized));assert(Buffer.byteLength(JSON.stringify(oversized),'utf8')<Programs.schema().replayInputBytes);
 preflight(await a.query(oversized),'PROGRAM_BYTES');assert.throws(()=>Programs.normalize(oversized.replay.plan),/byte budget/);
 const changed={op:'replay',replay:copy(first.replay)};changed.replay.plan.steps[0].where[0].value='changed-valid-literal';preflight(await a.query(changed),'INVALID_PROGRAM_REPLAY');
 const semanticPlan=F.plan(),semantic=ok(await a.query(semanticPlan)),normalize=Values.normalize,analyze=Values.analyze;let analyzerCalls=0;
 try{Values.normalize=input=>{const normalized=normalize(input);normalized.model.sources[0].id='changed-normalizer-semantics';return normalized;};Values.analyze=()=>{analyzerCalls++;throw new Error('Replay must reject before analyzer execution');};
  preflight(await a.query({op:'replay',replay:semantic.replay}),'INVALID_PROGRAM_REPLAY');assert.equal(analyzerCalls,0);assert.deepEqual(semantic.replay.plan,semanticPlan);
 }finally{Values.normalize=normalize;Values.analyze=analyze;}
 assert.deepEqual(ok(await a.query({op:'replay',replay:first.replay})),first);
});
test('minimum-distance slices keep short-path descendants; DAG convergence is not a cycle',async()=>{
 const {fn,block:b,edge,graph}=F.G;const raw=graph(fn('dag',0,[b('bb0',[],'branch',[edge('bb1'),edge('bb3')]),b('bb1',[],'goto',[edge('bb2')]),b('bb2',[],'goto',[edge('bb3')]),b('bb3',[],'goto',[edge('bb4')]),b('bb4')]));
 const q={op:'programQuery',version:1,steps:[{name:'entry',op:'select',kind:'block',procedures:['dag'],where:[{field:'blockId',test:'eq',value:'bb0'}]},{name:'slice',op:'slice',from:'entry',relations:['control'],depth:2}],return:['slice']};
 const result=ok(await api(raw).query(q));assert(result.results.slice.rows.some(r=>r.blockId==='bb4'));assert.equal(result.results.slice.slice.cycles.length,0);
 F.G.update(raw,'dag',f=>{f.blocks.at(-1).kind='goto';f.blocks.at(-1).successors=[edge('bb0')];});q.steps[1].depth=10;const loop=ok(await api(raw).query(q));assert(loop.results.slice.slice.cycles.length);assert(!loop.results.slice.slice.truncated);
});
test('recursion, callbacks, missing dependency/native bodies and conditions remain explicit',async()=>{
 const {fn,block:b,call,op,place:p,captured}=F.G;const raw=captured(fn('recursive',1,[call('bb0','recursive',[op(1)],p(0),'bb1'),call('bb1','uncaptured::native',[op(1)],p(0),'bb2',[],{native_call:{symbol:'opaque',abi:'C'}}),b('bb2')]));
 const q={op:'programQuery',version:1,steps:[{name:'root',op:'select',kind:'function',procedures:['recursive']},{name:'slice',op:'slice',from:'root',relations:['contains','calls'],depth:10}],return:['slice']};
 const r=ok(await api(raw).query(q));assert(r.results.slice.slice.cycles.some(c=>c.kind==='recursion'));assert(r.results.slice.slice.unmatched.some(b=>b.classification==='unknown'));
 const root=F.fixture(),a=api(root),control=ok(await a.query({op:'programQuery',version:1,steps:[{name:'root',op:'select',kind:'block',procedures:['app::investigate']},{name:'slice',op:'slice',from:'root',relations:['control'],depth:5}],return:['slice']}));assert(control.results.slice.slice.conditions.some(c=>c.kind==='condition'));
 const callback=F.G.helper('callback',true),calls=ok(await api(callback.raw).query({op:'programQuery',version:1,steps:[{name:'calls',op:'select',kind:'boundary',procedures:['wrapper']}],return:['calls']}));assert(calls.results.calls.rows.some(r=>r.reason==='callback-binding-context-required'));
});
test('strict validation rejects unsupported plans before analysis, joins or host evaluation',async()=>{
 for(const change of [q=>q.steps[0].where=[{field:'identity.__proto__',test:'eq',value:1}],q=>q.steps[0].evaluate='return process',q=>q.steps[1].fields.refs='id',q=>q.steps[1].from='future',q=>q.budgets=[],q=>q.steps[0].kind='taint',q=>q.steps.push({name:'bad',op:'traverse',from:'rows',relations:['inferred-flow']}),q=>q.version=2]){const q=simple();change(q);const result=await api().query(q);assert(result.error);assert.deepEqual(result.results,{});}
 const cyc=simple();cyc.self=cyc;assert.equal((await api().query(cyc)).error.code,'INVALID_PROGRAM_PLAN');
 const getter=simple();Object.defineProperty(getter.steps[0],'where',{enumerable:true,get(){throw new Error('must not execute');}});assert.match((await api().query(getter)).error.message,/Accessors/);
});
test('work, discarded intermediates, retained memory, output escaping and cancellation publish atomically',async()=>{
 for(const budgets of [{maxWork:1},{maxRows:1},{maxRetainedBytes:100},{maxOutputBytes:100}]){const q=simple();q.budgets=budgets;const result=await api().query(q);assert(result.error,JSON.stringify(budgets));assert.deepEqual(result.results,{});assert.equal(result.completion.complete,false);}
 const q=simple(),raw=F.fixture();raw.nodes[0].source_file='\u0000'.repeat(1200);q.budgets={maxOutputBytes:6000};assert.equal((await api(raw).query(q)).error.code,'PROGRAM_BYTES');
 const core=Evidence.create(F.fixture());let calls=0;const r=await core.queryProgram(F.plan(),{cancelled:()=>++calls>20});assert.equal(r.error.code,'PROGRAM_CANCELLED');assert.deepEqual(r.results,{});
 const timed=await core.queryProgram(simple(),{now:()=>{calls+=1000;return calls;}});assert.equal(timed.completion.timedOut,true);
});
test('large legacy controls use bounded lazy owners; repeated backward calls reuse capture index',async()=>{
 const raw=F.fixture();for(let i=0;i<1000;i++)raw.nodes.push({id:'legacy:'+i,attributes:{kind:'flow_function',path:'legacy:'+i,flow:JSON.stringify({version:1,function:'legacy:'+i,entry:'bb0',blocks:[{id:'bb0',kind:'return',successors:[]}]})}});
 const a=api(raw),r=ok(await a.query(simple()));assert.equal(r.results.rows.rows.length,1);assert(r.completion.work<100000);
 const q={op:'programQuery',version:1,steps:[{name:'target',op:'select',kind:'function',procedures:['dependency::relay']},{name:'incoming',op:'slice',from:'target',relations:['calls','contains'],direction:'backward',depth:4}],return:['incoming']};
 const first=ok(await a.query(q));assert(first.results.incoming.rows.some(r=>r.procedureId==='bridge::relay'));assert.deepEqual(ok(await a.query(q)),first);
});
test('schema and existing operations remain available',async()=>{const a=api(),s=await a.query({op:'schema'}),c=await a.query({op:'capabilities'});assert(s.schema.programQuery.fact);assert(s.schema.programQuery.replay.required.includes('normalizedPlanSha256'));assert(c.programQuery.readOnly);assert(c.operations.includes('programQuery'));assert((await a.query({op:'functions'})).functions.items.length);});
test('CLI single, stdin, JSONL and full replay match the shared API payload and hash',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'program-query-'));try{const raw=F.fixture(),file=path.join(temp,'capture.json');fs.writeFileSync(file,JSON.stringify(raw));const q=simple(),expected=ok(await api(raw).query(q)),cli=path.join(__dirname,'query-analysis.cjs');
 for(const args of [['--request',JSON.stringify(q)],[]]){const result=cp.spawnSync(process.execPath,[cli,'--graph',file,...args],{input:JSON.stringify(q),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected);}
 const stream=cp.spawnSync(process.execPath,[cli,'--graph',file,'--jsonl'],{input:[q,{op:'replay',replay:expected.replay},q].map(JSON.stringify).join('\n'),encoding:'utf8'});assert.equal(stream.status,0,stream.stderr);for(const row of stream.stdout.trim().split('\n'))assert.deepEqual(JSON.parse(row),expected);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('near-limit replay agrees through CLI request, stdin and JSONL with scoped rejection controls',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'program-replay-'));try{const raw=F.replayFixture(),file=path.join(temp,'capture.json');fs.writeFileSync(file,JSON.stringify(raw));const a=api(raw),q=F.nearLimitPlan(),expected=ok(await a.query(q)),replay={op:'replay',replay:expected.replay},cli=path.join(__dirname,'query-analysis.cjs');
 for(const request of [q,replay])for(const args of [['--request',JSON.stringify(request)],[]]){const result=cp.spawnSync(process.execPath,[cli,'--graph',file,...args],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:2097152});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected);}
 const changed=copy(replay);changed.replay.resultSha256='0'.repeat(64);const oversized=copy(replay);oversized.replay.plan.steps[0].where[0].value='x'.repeat(Programs.schema().replayInputBytes);const other={op:'functions',unused:'x'.repeat(65536)},malformed={...replay,extra:true};
 const inner=copy(replay);inner.replay.plan.steps[0].where[0].value='x'.repeat(200000);assert(Programs.isReplayRequest(inner));const declaration=copy(replay);declaration.replay.plan.steps[0].where[0].value='changed-valid-literal';
 for(const request of [inner,declaration])for(const args of [['--request',JSON.stringify(request)],[]]){const result=cp.spawnSync(process.execPath,[cli,'--graph',file,...args],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:2097152});assert.equal(result.status,1,result.stderr);const response=JSON.parse(result.stdout);preflight(response,request===inner?'PROGRAM_BYTES':'INVALID_PROGRAM_REPLAY');assert.deepEqual(response,await a.query(request));}
 const escaped=F.nearLimitPlan('é\u0000"\\'.repeat(5400)),escapedExpected=ok(await a.query(escaped));
 const stream=cp.spawnSync(process.execPath,[cli,'--graph',file,'--jsonl'],{input:[q,replay,changed,oversized,other,malformed,escaped,{op:'replay',replay:escapedExpected.replay},inner,declaration,replay].map(JSON.stringify).join('\n'),encoding:'utf8',maxBuffer:2097152});assert.equal(stream.status,0,stream.stderr);const responses=stream.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(responses[0],expected);assert.deepEqual(responses[1],expected);assert.deepEqual(responses[2],await a.query(changed));assert.equal(responses[3].error.code,'INVALID_JSON');assert.match(responses[3].error.message,/Program replay exceeds/);assert(responses.slice(4,6).every(r=>r.error.code==='INVALID_JSON'&&/65536/.test(r.error.message)));assert.deepEqual(responses[6],escapedExpected);assert.deepEqual(responses[7],escapedExpected);preflight(responses[8],'PROGRAM_BYTES');assert.deepEqual(responses[8],await a.query(inner));preflight(responses[9],'INVALID_PROGRAM_REPLAY');assert.deepEqual(responses[9],await a.query(declaration));assert.deepEqual(responses[10],expected);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
for(const key of ['GUARD','VALUE'])if(process.env[key+'_CAPTURE'])test('real '+key.toLowerCase()+' capture control slices preserve action-only successors',async()=>{const raw=JSON.parse(fs.readFileSync(process.env[key+'_CAPTURE'])),a=api(raw);for(const control of C.controlCases(raw)){const q=F.controlPlan(control.procedure,control.block),r=ok(await a.query(q));C.assertControl(r,control);assert.deepEqual(ok(await a.query({op:'replay',replay:r.replay})),r);}});
if(process.env.GUARD_CAPTURE)test('real multi-crate guard capture combines declared input influence and conditions',async()=>{const raw=JSON.parse(fs.readFileSync(process.env.GUARD_CAPTURE)),a=api(raw);for(const near of [false,true]){const q=C.guardPlan(raw,near),r=ok(await a.query(q));C.assertGuard(raw,r,near);const v=await a.query(q.steps[0].query),g=await a.query(q.steps[1].query);if(!near){assert.equal(r.results.evidence.slice.analysisCoverage.values.status,v.status);assert.equal(r.results.evidence.slice.analysisCoverage.guards.status,g.status);}assert.deepEqual(ok(await a.query({op:'replay',replay:r.replay})),r);}});
if(process.env.VALUE_CAPTURE)test('real multi-crate value capture slice matches independently declared positive and near-miss sources',async()=>{const raw=JSON.parse(fs.readFileSync(process.env.VALUE_CAPTURE)),a=api(raw);for(const name of ['positive','swapped']){const q=C.valuePlan(raw,name),r=ok(await a.query(q)),direct=await a.query(q.steps[0].query);assert.equal(r.results.values.analysis.status,direct.status);assert.equal(r.results.values.analysis.finding.candidateInfluence,name==='positive');if(name==='positive'){assert(r.results.evidence.rows.some(x=>x.stepKind==='sink'));assert(r.results.evidence.rows.some(x=>x.stepKind==='argument-to-parameter'));}assert.deepEqual(ok(await a.query({op:'replay',replay:r.replay})),r);}});
