/* Executes the actual emitted Blob-worker and fallback lane after source review. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Analysis=require('../src/analysis-api.js'),F=require('../tests/fixtures/program-queries/fixture-graphs.cjs'),C=require('../tests/fixtures/program-queries/capture-model.cjs');
const src=path.join(__dirname,'..','src'),template=fs.readFileSync(path.join(src,'viewer.html'),'utf8');
const modules=['execution-flow','flow-map','call-graph','architecture-organization','execution-model','value-flow','guard-obligations','failure-obligations','resource-risks','supply-chain','call-paths','advisory-exposure','program-queries','analysis-evidence','entry-effects','analysis-snapshot','revision-comparison','test-candidates','comment-search','performance-measurements','execution-model-view','trace-waterfall'];
const moduleIds=Object.fromEntries(modules.map(name=>[(name==='execution-flow'?'flow-engine':name)+'-source',name]));
const json=v=>JSON.parse(JSON.stringify(v));
function element(tag='div'){const e={tagName:tag,value:'',textContent:'',style:{},attributes:{},listeners:{},children:[],clientWidth:980,parentElement:{clientWidth:980},classList:{add(){},remove(){},toggle(){}},setAttribute(k,v){this.attributes[k]=String(v);},addEventListener(k,v){this.listeners[k]=v;},querySelectorAll(){return [];},querySelector(){return null;},appendChild(v){this.children.push(v);return v;},replaceChildren(...v){this.children=v;}};Object.defineProperty(e,'options',{get(){return this.children.filter(c=>c.tagName==='option');}});return e;}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function until(check){for(let i=0;i<1000&&!check();i++)await new Promise(r=>setTimeout(r,1));assert(check(),'viewer update arrived');}
async function harness(useWorker,raw=F.fixture(),html=template){
 const elements=new Map(),blobs=new Map(),workers=[],ready=deferred(),highlights=[],focus=[],messages=[];let nextGate=null,catalogs=0;
 function get(id){if(!elements.has(id)){const e=element();if(moduleIds[id]){const source=fs.readFileSync(path.join(src,moduleIds[id]+'.js'),'utf8');if(html===template)e.textContent=source;else{const match=html.match(new RegExp('<script\\b[^>]*\\bid="'+id+'"[^>]*>([\\s\\S]*?)<\\/script>'));assert(match,'emitted '+id);assert.equal(match[1],source,'current emitted bytes '+id);e.textContent=match[1];}}elements.set(id,e);}return elements.get(id);}
 function observe(target){const create=target.AnalysisEvidence.create;target.AnalysisEvidence.create=(...args)=>{const e=create(...args),query=e.queryProgram;e.queryProgram=(...q)=>{if(!nextGate)return query(...q);const gate=nextGate;nextGate=null;gate.started.resolve();return gate.release.promise.then(()=>query(...q));};return e;};}
 const context={TextEncoder,Uint8Array,Int32Array,setTimeout,clearTimeout,setImmediate,MessageChannel,performance,window:{},document:{getElementById:get,createElement:element,createElementNS:(_,tag)=>element(tag)},ARCH_PIN_ANALYSIS:null,ARCH_PIN_ACTIVE:null,ARCH_ANALYSIS_KEY:'',CALL_UI:null,setFunctionProjection(){},setFunctionAnalysis(){},setArchitectureActive(){},ensureArchitecture(){}};
 for(const id of Object.keys(moduleIds))vm.runInNewContext(get(id).textContent,context);observe(context);
 if(useWorker){context.Blob=class{constructor(parts){this.source=parts.join('');}};context.URL={createObjectURL(blob){const key='blob:'+blobs.size;blobs.set(key,blob.source);return key;}};
  context.Worker=class{constructor(url){this.context={TextEncoder,Uint8Array,Int32Array,setTimeout,clearTimeout,setImmediate,MessageChannel,self:{postMessage:data=>setImmediate(()=>this.onmessage&&this.onmessage({data:structuredClone(data)}))}};vm.runInNewContext(blobs.get(url),this.context);observe(this.context);workers.push(this);}postMessage(data){const copy=structuredClone(data);messages.push(copy);setImmediate(()=>this.context.self.onmessage({data:copy}));}terminate(){this.onmessage=null;}};
 }
 const begin=html.indexOf('var FLOW_UI = null, STATE_UI = null, WATERFALL_UI = null;'),end=html.indexOf('// ---- GPU renderer (Cosmos) ----',begin);assert(begin>=0&&end>begin);vm.runInNewContext(html.slice(begin,end),context);
 context.STATE_UI={pins:['app::investigate'],setData(){catalogs++;},hasProcedure(){return true;},setAnalysis(v){highlights.push(v);},focus(v){focus.push(v);},activate(){}};
 const rawText=JSON.stringify(raw),ui=context.setupFlowUI(rawText,ready.resolve);await ready.promise;context.FLOW_UI=ui;
 return {ui,context,elements,workers,messages,highlights,focus,gate(){const gate={started:deferred(),release:deferred()};nextGate=gate;return gate;},async refresh(next=raw){const old=catalogs;ui.refresh(JSON.stringify(next));await until(()=>catalogs>old);}};
}
for(const worker of [false,true]){
 test((worker?'worker':'fallback')+' complete program payload/replay matches shared API without changing view owners',async()=>{
  const raw=F.fixture(),h=await harness(worker,raw),a=Analysis.create(raw),q=F.plan();
  const pending=h.ui.queryProgram(q);q.steps[0].query.model.sources[0].id='mutated-after-dispatch';const r=await pending,expected=await a.query(F.plan());assert.equal(r.error,undefined,JSON.stringify(r.error));assert.deepEqual(json(r),expected);
  assert.deepEqual(json(await h.ui.queryProgram({op:'replay',replay:r.replay})),expected);assert.deepEqual(h.context.STATE_UI.pins,['app::investigate']);assert.equal(h.highlights.length,0);assert.equal(h.focus.length,0);
  const bad=F.plan();bad.steps.at(-1).relations=['invented'];assert.deepEqual(json(await h.ui.queryProgram(bad)),await a.query(bad));
 });
 test((worker?'worker':'fallback')+' near-limit replay retains the bounded original and pinned canonical plan',async()=>{
  const raw=F.replayFixture(),h=await harness(worker,raw),a=Analysis.create(raw),q=F.nearLimitPlan('é\u0000"\\'.repeat(5400)),expected=await a.query(q);assert.equal(expected.error,undefined,JSON.stringify(expected.error));
  const r=await h.ui.queryProgram(q);assert.deepEqual(json(r),expected);assert.deepEqual(json(r.replay.plan),q);assert.match(r.replay.normalizedPlanSha256,/^[0-9a-f]{64}$/);const replay={op:'replay',replay:r.replay};assert(Buffer.byteLength(JSON.stringify(replay),'utf8')>65536);assert.deepEqual(json(await h.ui.queryProgram(replay)),expected);
  const expanded=F.nearLimitPlan(),large=await h.ui.queryProgram(expanded);assert.equal(large.error,undefined,JSON.stringify(large.error));assert.deepEqual(json(large.replay.plan),expanded);assert(Buffer.byteLength(JSON.stringify(large.plan),'utf8')>65536);assert.deepEqual(json(await h.ui.queryProgram({op:'replay',replay:large.replay})),await a.query(expanded));
  const inner=json(replay);inner.replay.plan.steps[0].where[0].value='x'.repeat(200000);assert(h.context.ProgramQueries.isReplayRequest(inner));const changed=json(replay);changed.replay.plan.steps[0].where[0].value='changed-valid-literal';
  for(const request of [inner,changed]){const bad=await h.ui.queryProgram(request);assert.deepEqual(json(bad),await a.query(request));assert.equal(bad.error.code,request===inner?'PROGRAM_BYTES':'INVALID_PROGRAM_REPLAY');assert.equal(bad.error.step,'preflight');assert.deepEqual(json(bad.results),{});for(const k of ['work','states','evidence','retainedBytes','rows'])assert.equal(bad.completion[k],0,k);}
  const oversized=json(replay);oversized.replay.plan.steps[0].where[0].value='x'.repeat(h.context.ProgramQueries.schema().replayInputBytes);await assert.rejects(h.ui.queryProgram(oversized),/byte budget/);
  await assert.rejects(h.ui.queryProgram({...replay,extra:true}),/byte budget/);await assert.rejects(h.ui.queryProgram(F.nearLimitPlan('x'.repeat(65536))),/byte budget/);assert.equal(h.highlights.length,0);
 });
 test((worker?'worker':'fallback')+' terminal and unsupported projection facts agree with the shared API',async()=>{
  const cases=[[F.terminalFixture(),F.controlPlan()],[F.projectionFixture(),{op:'programQuery',version:1,steps:[{name:'places',op:'select',kind:'place',procedures:['indexed'],where:[{field:'classification',test:'eq',value:'unknown'}]},{name:'usage',op:'slice',from:'places',relations:['reads','writes'],direction:'usage',depth:1}],return:['places','usage']}]];
  for(const [raw,q] of cases){const h=await harness(worker,raw),expected=await Analysis.create(raw).query(q);assert.equal(expected.error,undefined,JSON.stringify(expected.error));const r=await h.ui.queryProgram(q);assert.deepEqual(json(r),expected);assert.deepEqual(json(await h.ui.queryProgram({op:'replay',replay:r.replay})),expected);}
 });
 test((worker?'worker':'fallback')+' cancel, supersession and capture replacement settle pending work and reject stale replies',async()=>{
  const h=await harness(worker),gate=h.gate(),pending=h.ui.queryProgram(F.plan());const rejection=assert.rejects(pending,/superseded|cancelled/);await gate.started.promise;h.ui.cancelProgram();await rejection;gate.release.resolve();
  const second=h.gate(),old=h.ui.queryProgram(F.plan()),oldRejected=assert.rejects(old,/superseded|cancelled/);await second.started.promise;const fresh=await h.ui.queryProgram(F.plan());assert.equal(fresh.error,undefined);second.release.resolve();await oldRejected;
  const third=h.gate(),replaced=h.ui.queryProgram(F.plan()),replacedRejected=assert.rejects(replaced,/superseded|cancelled/);await third.started.promise;await h.refresh(F.fixture(true));await replacedRejected;third.release.resolve();const current=await h.ui.queryProgram(F.plan());assert.equal(current.results.summary.rows.length,0);assert.equal(h.highlights.length,0);
 });
}
test('worker failure settles a pending program query before fallback reload',async()=>{const h=await harness(true),gate=h.gate(),pending=h.ui.queryProgram(F.plan()),rejected=assert.rejects(pending,/superseded|cancelled/);await gate.started.promise;h.workers[0].onerror();await rejected;gate.release.resolve();await h.refresh();const result=await h.ui.queryProgram(F.plan());assert.equal(result.error,undefined);});
for(const [key,build,assertion] of [['GUARD',raw=>C.guardPlan(raw),(raw,r)=>C.assertGuard(raw,r)],['VALUE',raw=>C.valuePlan(raw),(raw,r)=>{assert(r.results.evidence.rows.some(v=>v.stepKind==='sink'));}]])if(process.env[key+'_CAPTURE'])test('emitted '+key.toLowerCase()+' compiler capture has complete worker/fallback/API replay agreement',async()=>{
 const raw=JSON.parse(fs.readFileSync(process.env[key+'_CAPTURE'])),html=fs.readFileSync(process.env[key+'_HTML']||path.join(path.dirname(process.env[key+'_CAPTURE']),'graph.html'),'utf8'),q=build(raw),expected=await Analysis.create(raw).query(q);assert.equal(expected.error,undefined,JSON.stringify(expected.error));assertion(raw,expected);
 for(const worker of [false,true]){const h=await harness(worker,raw,html),actual=await h.ui.queryProgram(q);assert.deepEqual(json(actual),expected);assert.deepEqual(json(await h.ui.queryProgram({op:'replay',replay:actual.replay})),expected);assert.equal(h.highlights.length,0);
  for(const control of C.controlCases(raw)){const plan=F.controlPlan(control.procedure,control.block),shared=await Analysis.create(raw).query(plan),result=await h.ui.queryProgram(plan);C.assertControl(result,control);assert.deepEqual(json(result),shared);assert.deepEqual(json(await h.ui.queryProgram({op:'replay',replay:result.replay})),shared);}
 }
});
