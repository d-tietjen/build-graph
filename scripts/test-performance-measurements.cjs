'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const Analysis=require('../src/analysis-api.js'),Evidence=require('../src/analysis-evidence.js'),Measurements=require('../src/performance-measurements.js');
const F=require('../tests/fixtures/performance-measurements/fixture-graphs.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function imported(q=F.request(),raw=F.graph()){const value=await Analysis.create(raw).query(q);assert.equal(value.error,undefined,JSON.stringify(value.error));return value;}
async function lowestWork(query,request){
 let best=await query({...F.clone(request),timeoutMs:5000});assert.equal(best.error,undefined);
 const limits=best.request.budgets,at=maxWork=>({...F.clone(request),timeoutMs:5000,budgets:{...limits,maxWork}});let lower=1,upper=limits.maxWork;
 assert.equal((await query(at(lower))).error.code,'MEASUREMENT_BUDGET');
 while(upper-lower>1){const middle=Math.floor((lower+upper)/2),value=await query(at(middle));if(value.error){assert.equal(value.error.code,'MEASUREMENT_BUDGET');lower=middle;}else{upper=middle;best=value;}}
 assert.equal(best.request.budgets.maxWork,upper);return {value:best,at,boundary:upper};
}
test('exact IDs, duplicate display names, recursion and separate sampled/benchmark units',async()=>{
 const v=await imported(),d=v.data,p=d.profiles[0],root=p.nodes.find(n=>n.node.id==='item:fixture::root'),work=p.nodes.find(n=>n.node.id==='item:fixture::work');
 assert.equal(d.benchmarks[0].binding.node.id,'item:fixture::work');assert.notEqual(d.benchmarks[0].binding.node.id,d.benchmarks[0].binding.node.procedureId);assert.equal(p.total,12);assert.deepEqual([root.inclusive,root.exclusive],[10,0]);assert.deepEqual([work.inclusive,work.exclusive,work.occurrenceWeight],[12,12,19]);
 assert(p.flame.some(f=>f.depth===2&&f.frame==='work'));assert(p.edges.some(e=>e.source==='item:fixture::root'&&e.target==='item:fixture::work'&&e.sampledAdjacencyWeight===10));assert(p.edges.some(e=>e.source===e.target&&e.sampledAdjacencyWeight===7));assert(d.diagnostics.some(x=>x.from==='external'));assert.equal(v.semantics.samplesAreInvocations,false);assert.equal(v.semantics.samplesAreElapsedTrace,false);assert.equal(v.semantics.missingSamplesProveUnused,false);assert.equal(d.benchmarks[0].estimate.value,100);assert.equal(d.benchmarks[0].unit,'ns/iteration');assert.equal(p.unit,'samples');
});
test('names alone, exact-vs-declared ownership, conflicting mappings and inline unknown remain visible',async()=>{
 const q=F.request(),b=F.benchmark();delete b.target;q.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});let v=await imported(q);assert.equal(v.data.benchmarks[0].binding.status,'unmatched');
 q.input.mappings=[{sourceId:'bench',recordId:b.id,target:{nodeId:'item:fixture::work'},provenance:'User supplied mapping'}];v=await imported(q);assert.equal(v.data.benchmarks[0].binding.status,'declared');assert.match(v.data.benchmarks[0].binding.basis,/not compiler-confirmed/);
 q.input.mappings.push({...q.input.mappings[0],target:{nodeId:'item:other::work'}});v=await imported(q);assert.equal(v.data.benchmarks[0].binding.status,'ambiguous');
 delete q.input.sources[1].frameIdentities.work.inlined;v=await imported(q);assert.equal(v.data.profiles[0].edges.length,0);assert(v.data.profiles[0].stacks[0].frames.some(f=>f.inlined===null));
 q.input.mappings=[];b.target={functionId:'compiler:shared'};q.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});v=await Analysis.create(F.graph()).query(q);assert.equal(v.error.code,'INVALID_MEASUREMENTS');
});
test('Criterion 0.5.1 preserves original file bytes, all supported stats and throughput',async()=>{
 const q=F.request();q.input.sources=[F.criterion()];const v=await imported(q),d=v.data,source=JSON.parse(q.input.sources[0].text);assert.equal(d.benchmarks.length,4);assert(d.benchmarks.every(b=>b.unit==='ns/iteration'&&b.binding.status==='unmatched'));assert.equal(d.benchmarks[0].throughput.perIteration,64);assert.equal(d.snapshot.sourcePins[0].sha256,hash(q.input.sources[0].text));assert.equal(d.snapshot.sourcePins[0].files.estimatesSha256,hash(source.estimatesText));assert.equal(d.snapshot.sourcePins[0].files.benchmarkSha256,hash(source.benchmarkText));
 const loaded=await Analysis.create(F.graph()).query({op:'loadMeasurements',snapshot:d.snapshot});assert.equal(loaded.error,undefined);assert.deepEqual(loaded.data,d);
});
for(const variant of ['version','custom measurement','unknown estimate','bad interval','bad metadata','fraction throughput','malformed JSON','negative folded','unsafe count','deep stack'])test('rejects unsupported/malformed '+variant,async()=>{
 const q=F.request();if(['negative folded','unsafe count','deep stack'].includes(variant)){q.input.sources=[q.input.sources[1]];q.input.sources[0].text=variant==='negative folded'?'work -2':variant==='unsafe count'?'work 9007199254740992':Array(129).fill('work').join(';')+' 1';}
 else if(variant==='malformed JSON')q.input.sources[0].text='{';else{q.input.sources=[F.criterion()];const s=JSON.parse(q.input.sources[0].text),e=JSON.parse(s.estimatesText),m=JSON.parse(s.benchmarkText);if(variant==='version')s.criterionVersion='0.6.0';if(variant==='custom measurement')s.measurement='Cycles';if(variant==='unknown estimate')e.mean.extra=1;if(variant==='bad interval')e.mean.confidence_interval.upper_bound=10;if(variant==='bad metadata')delete m.full_id;if(variant==='fraction throughput')m.throughput.Bytes=1.5;s.estimatesText=JSON.stringify(e);s.benchmarkText=JSON.stringify(m);q.input.sources[0].text=JSON.stringify(s);}
 const v=await Analysis.create(F.graph()).query(q);assert(v.error);assert.match(v.error.code,/MEASUREMENTS|BUDGET/);assert.equal(v.data,undefined);
});
test('immutable snapshot/source/model replay, implicit/explicit capture equality and corruption pins',async()=>{
 const raw=F.graph(),api=Analysis.create(raw),q=F.request(raw),original=F.clone(q);delete q.input.capture;const pending=api.query(q);q.input.sources[0].text='mutated';raw.nodes.length=0;const v=await pending;assert.equal(v.error,undefined);const explicit=await api.query(original);assert.deepEqual(v,explicit);
 const replay=F.clone(v.replay),again=api.query({op:'replay',replay});replay.request.input.sources[0].text='mutated replay';assert.deepEqual(await again,{...v,replayed:true});
 const exported=F.clone(v.data.snapshot);v.data.snapshot.input.sources[0].text='mutated result';const loaded=await api.query({op:'loadMeasurements',snapshot:exported});assert.equal(loaded.error,undefined);assert.equal(loaded.data.snapshot.input.sources[0].text,original.input.sources[0].text);
 for(const edit of [s=>s.input.sources[0].text+=' ',s=>s.sourcePins[0].sha256='0'.repeat(64),s=>s.version='different']){const s=F.clone(exported);edit(s);assert((await api.query({op:'loadMeasurements',snapshot:s})).error);}
 const r=F.clone(explicit.replay);delete r.request.input.capture;assert.equal((await api.query({op:'replay',replay:r})).error.code,'INVALID_REPLAY');
});
for(const mode of ['core','API'])test(mode+': exact saved replay integrity precedes default repair for import/load/compare',async()=>{
 const raw=F.graph(),endpoint=mode==='core'?Measurements.create({capture:{contentSha256:Evidence.digest(raw)},functions:()=>[],edges:[]}):Analysis.create(raw);
 const query=async q=>{const value=await endpoint.query(q);assert.equal(value.error,undefined,JSON.stringify(value.error));return value;};
 const explicit=F.request(raw),implicit=F.clone(explicit);delete implicit.input.capture;
 const first=await query(explicit);assert.deepEqual(await query(implicit),first);assert.equal(implicit.input.capture,undefined);
 const load={op:'loadMeasurements',snapshot:first.data.snapshot},compare={op:'compareMeasurements',before:first.data.snapshot,after:first.data.snapshot};
 for(const request of [explicit,implicit,load,compare]){
  const value=await query(request),saved=F.clone(value.replay);assert.deepEqual(await query({op:'replay',replay:saved}),{...value,replayed:true});assert.deepEqual(saved,value.replay);
  const input=r=>r.request.op==='importMeasurements'?r.request.input:r.request.op==='loadMeasurements'?r.request.snapshot.input:r.request.before.input;
  const repairs=[
   ['deleted timeout',r=>{delete r.request.timeoutMs;}],['null timeout',r=>{r.request.timeoutMs=null;}],
   ['deleted budgets',r=>{delete r.request.budgets;}],['null budgets',r=>{r.request.budgets=null;}],
   ...Object.keys(value.request.budgets).map(key=>['deleted default '+key,r=>{delete r.request.budgets[key];}])
  ];
  const corruptions=[
   ['deleted capture',r=>{delete input(r).capture;}],['null capture',r=>{input(r).capture=null;}],...repairs,
   ...repairs.map(([label,edit])=>['rehashed '+label,r=>{edit(r);r.requestHash=Evidence.digest(r.request,true);}]),
   ['changed capture',r=>{input(r).capture.contentSha256='a'.repeat(64);}],['foreign current capture',r=>{r.captureSha256='b'.repeat(64);}],
   ['changed source',r=>{input(r).sources[0].text+=' ';}],['changed hash',r=>{r.requestHash='0'.repeat(64);}],['changed version',r=>{r.version='different';}]
  ];
  for(const [label,edit] of corruptions){const replay=F.clone(saved);edit(replay);const unchanged=F.clone(replay),q={op:'replay',replay};
   if(mode==='core')await assert.rejects(endpoint.query(q),error=>{assert.equal(error.code,'INVALID_REPLAY',label);assert.equal(error.data,undefined);assert.equal(error.snapshot,undefined);assert.equal(error.replay,undefined);return true;},label);
   else{const invalid=await endpoint.query(q);assert.equal(invalid.error.code,'INVALID_REPLAY',label);assert.equal(invalid.data,undefined);assert.equal(invalid.replay,undefined);}
   assert.deepEqual(replay,unchanged,label+' must remain unmodified');
  }
 }
});
for(const mode of ['core','API'])test(mode+': exact and adjacent work boundaries preserve complete import/load/compare replay',async()=>{
 const raw=F.graph(),endpoint=mode==='core'?Measurements.create({capture:{contentSha256:Evidence.digest(raw)},functions:()=>{assert.fail('Empty benchmark sources must not build indexes');},edges:[]}):Analysis.create(raw);
 const query=q=>endpoint.query(q).catch(error=>({error})),explicit={op:'importMeasurements',input:{schemaVersion:1,capture:{contentSha256:Evidence.digest(raw)},sources:[{id:'empty',format:'generic-benchmark-v1',text:'{"schemaVersion":1,"benchmarks":[]}\n'}]}},implicit=F.clone(explicit);delete implicit.input.capture;
 const first=await query(explicit);assert.equal(first.error,undefined);const snapshot=first.data.snapshot;
 const incomplete=value=>{assert.equal(value.error.code,'MEASUREMENT_BUDGET');for(const key of ['data','snapshot','replay']){assert.equal(value[key],undefined);assert.equal(value.error[key],undefined);}};
 let explicitValue;
 for(const request of [explicit,implicit,{op:'loadMeasurements',snapshot},{op:'compareMeasurements',before:snapshot,after:snapshot}]){
  const bound=await lowestWork(query,request);assert(bound.boundary>1);
  if(request===explicit)explicitValue=bound.value;else if(request===implicit)assert.deepEqual(bound.value,explicitValue);
  for(const maxWork of [bound.boundary,bound.boundary+1]){
   const value=maxWork===bound.boundary?bound.value:await query(bound.at(maxWork));assert.equal(value.error,undefined);
   assert.deepEqual(value.request,value.replay.request);assert.equal(value.replay.requestHash,Evidence.digest(value.request,true));
   const saved=F.clone(value.replay);assert.deepEqual(await query({op:'replay',replay:saved}),{...value,replayed:true});assert.deepEqual(saved,value.replay);
   if(value.operation==='compareMeasurements'){assert.deepEqual(value.data.before,snapshot);assert.deepEqual(value.data.after,snapshot);}else assert.deepEqual(value.data.snapshot,snapshot);
  }
  incomplete(await query(bound.at(bound.boundary-1)));
  const replay=F.clone(bound.value.replay);replay.request.budgets.maxWork=bound.boundary-1;replay.requestHash=Evidence.digest(replay.request,true);incomplete(await query({op:'replay',replay}));
 }
});
test('the single request hash remains work-bounded and timer-cancellable before completion on fresh and replay paths',async()=>{
 const raw=F.graph(),engine=Measurements.create({capture:{contentSha256:Evidence.digest(raw)},functions:()=>{assert.fail('Empty benchmark sources must not build indexes');},edges:[]});
 const request={op:'importMeasurements',timeoutMs:5000,input:{schemaVersion:1,provenance:{note:'x'.repeat(65536)},sources:[{id:'empty',format:'generic-benchmark-v1',text:'{"schemaVersion":1,"benchmarks":[]}'}]}},value=await engine.query(request),original=Evidence.hasher;
 const bounded=F.clone(request);bounded.budgets={maxWork:1};const saved=F.clone(value.replay);saved.request.budgets.maxWork=1;saved.requestHash=Evidence.digest(saved.request,true);
 for(const [q,code] of [[request,'CANCELLED'],[{op:'replay',replay:value.replay},'CANCELLED'],[bounded,'MEASUREMENT_BUDGET'],[{op:'replay',replay:saved},'MEASUREMENT_BUDGET']]){
  let cancelled=false,started=0,completed=0;Evidence.hasher=()=>{started++;const h=original();return {update:text=>h.update(text),digest:encoding=>{completed++;return h.digest(encoding);}};};
  const timer=code==='CANCELLED'?setTimeout(()=>{cancelled=true;},0):null;
  try{await assert.rejects(engine.query(q,{cancelled:()=>cancelled}),error=>{assert.equal(error.code,code);assert.equal(error.data,undefined);assert.equal(error.snapshot,undefined);assert.equal(error.replay,undefined);return true;});assert.equal(started,1);assert.equal(completed,0);}
  finally{if(timer!==null)clearTimeout(timer);Evidence.hasher=original;}
 }
});
test('shared core/API admission rejects effective oversized request and replay before a full ownership clone',async()=>{
 const Snapshot=require('../src/analysis-snapshot.js'),raw=F.graph(),api=Analysis.create(raw),engine=Measurements.create({capture:{contentSha256:Evidence.digest(raw)},functions:()=>[],edges:[]});
 const original=Snapshot.dispatchCopy;
 for(const key of ['maxRetainedBytes','maxOutputBytes'])for(const replayed of [false,true]){
  const request=F.request(raw);request.input.provenance.note='x'.repeat(131072);request.timeoutMs=2000;request.budgets={maxWork:2000000,maxOutputBytes:33554432,maxRetainedBytes:67108864,[key]:65536};
  const q=replayed?{op:'replay',replay:{schemaVersion:1,version:Measurements.VERSION,operation:request.op,captureSha256:Evidence.digest(raw),requestHash:Evidence.digest(request),request}}:request;
  assert(JSON.stringify(q).length>65536&&JSON.stringify(q).length<8388608);
  for(const mode of ['shared','core','API']){const attempts=[];Snapshot.dispatchCopy=function(value,limit){const attempt={value,limit,completed:false};attempts.push(attempt);const owned=original(value,limit);attempt.completed=true;return owned;};
   try{
    if(mode==='shared')assert.throws(()=>Measurements.admitRequest(q),{code:'MEASUREMENT_BUDGET'});
    else if(mode==='core')await assert.rejects(engine.query(q),error=>{assert.equal(error.code,'MEASUREMENT_BUDGET');assert.equal(error.data,undefined);assert.equal(error.snapshot,undefined);assert.equal(error.replay,undefined);return true;});
    else{const invalid=await api.query(q);assert.equal(invalid.error.code,'MEASUREMENT_BUDGET');assert.equal(invalid.data,undefined);assert.equal(invalid.replay,undefined);}
    assert.equal(attempts.length,1);assert.equal(attempts[0].value,q);assert.equal(attempts[0].limit,65536);assert.equal(attempts[0].completed,false,'effective admission must fail before native JSON ownership cloning');
   }finally{Snapshot.dispatchCopy=original;}
  }
 }
});
test('capture mismatch disables attachment but preserves complete measurements and declarations',async()=>{
 const q=F.request();q.input.capture={contentSha256:'0'.repeat(64),build:'original'};const v=await imported(q);assert.equal(v.data.coverage.captureMatches,false);assert.equal(v.data.benchmarks[0].binding.status,'capture-mismatch');assert.equal(v.data.profiles[0].nodes.length,0);assert.equal(v.data.profiles[0].total,12);assert.equal(v.data.snapshot.input.capture.build,'original');
});
test('compatible cross-capture baseline retains provenance changes and honest uncertainty',async()=>{
 const api=Analysis.create(F.graph()),before=(await imported()).data.snapshot,q=F.request(),b=F.benchmark();b.estimate={value:80,confidenceInterval:{level:0.9,lower:70,upper:90}};q.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});q.input.capture.contentSha256='a'.repeat(64);q.input.provenance.build.id='next-build';q.input.provenance.tree.sha='next-tree';q.input.provenance.recordedAt='2026-02-01T00:00:00Z';const after=(await imported(q)).data.snapshot;
 const request={op:'compareMeasurements',before,after},v=await api.query(request);assert.equal(v.error,undefined);const c=v.data.comparisons[0];assert.equal(c.compatible,true);assert.equal(c.ratio,.8);assert(c.provenanceChanges.some(x=>x.field==='capture'));assert(c.provenanceChanges.some(x=>x.field==='recordedAt'));assert.deepEqual(c.before.estimate.confidenceInterval.level,.95);assert.match(c.derivedEndpointRange.label,/no joint confidence/);assert.match(c.uncertainty,/not a significance test/);assert.deepEqual(await api.query({op:'replay',replay:v.replay}),{...v,replayed:true});
 delete q.input.provenance.machine;const unknown=(await imported(q)).data.snapshot,v2=await api.query({op:'compareMeasurements',before,after:unknown});assert.equal(v2.data.comparisons[0].compatible,false);assert(v2.data.comparisons[0].reasons.includes('Unknown machine'));assert.equal(v2.data.comparisons[0].ratio,undefined);
 b.subject='renamed-subject';q.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});q.input.provenance.machine=F.provenance().machine;const renamed=(await imported(q)).data.snapshot,linked=await api.query({op:'compareMeasurements',before,after:renamed,subjectMappings:[{before:F.benchmark().subject,after:b.subject,provenance:'Explicit subject continuity'}]});assert.equal(linked.data.comparisons[0].compatible,true);
});
test('bounded source/request/output/work and cancellable cooperative import return no partial snapshot',async()=>{
 const q=F.request(),engine=Measurements.create({capture:{contentSha256:Evidence.digest(F.graph())},functions:()=>[],edges:[]});let checks=0;await assert.rejects(engine.query(q,{cancelled:()=>++checks>2}),{code:'CANCELLED'});
 for(const edit of [x=>x.budgets={maxWork:1},x=>x.budgets={maxOutputBytes:50},x=>x.input.sources[0].text='x'.repeat(4194304),x=>x.input.sources[1].text=Array(20001).fill('frame 1').join('\n')]){const r=F.request();edit(r);assert((await Analysis.create(F.graph()).query(r)).error);}
 const escaped=F.request();escaped.input.sources[0].text='\u0000'.repeat(1500000);const result=await Analysis.create(F.graph()).query(escaped);assert(result.error);assert.equal(result.data,undefined);
});
test('optional creation is lazy and reuses a completed minimal identity index across queries',async()=>{
 let calls=0;const q=F.request(),engine=Measurements.create({capture:{contentSha256:Evidence.digest(F.graph())},functions:()=>{calls++;return [{id:'item:fixture::root',procedureId:'fixture::root'},{id:'item:fixture::work',functionId:'compiler:shared',buildUnitId:'fixture:lib'}];},edges:[{source:'item:fixture::root',target:'item:fixture::work',kind:'call'}]});assert.equal(calls,0);await engine.query(q);await engine.query(q);assert.equal(calls,1);
});
test('large admitted identity contexts remain optional, budgeted and cancellable without publishing partial indexes',async()=>{
 let admissions=0,checks=0;const q=F.request();q.input.sources=q.input.sources.slice(0,1);const functions=()=>{admissions++;return Array.from({length:50000},(_,i)=>i?{id:'node:'+i}:{id:'item:fixture::work',functionId:'compiler:shared',buildUnitId:'fixture:lib'});};
 const engine=Measurements.create({capture:{contentSha256:Evidence.digest(F.graph())},functions,edges:[]});assert.equal(admissions,0);await assert.rejects(engine.query(q,{cancelled:()=>++checks>600}),{code:'CANCELLED'});assert.equal(admissions,1);const v=await engine.query(q);assert.equal(admissions,2);assert.equal(v.data.benchmarks[0].binding.node.id,'item:fixture::work');await engine.query(q);assert.equal(admissions,2);
});
for(const scheduler of ['immediate','channel','timer'])test(scheduler+': fair task yields retain bounded complete indexes and release resources on every exit',async()=>{
 const vm=require('node:vm'),{MessageChannel}=require('node:worker_threads'),Snapshot=require('../src/analysis-snapshot.js');
 const active=new Set();let turns=0,created=0;
 class TrackedChannel{
  constructor(){const channel=new MessageChannel();created++;const port=native=>{active.add(native);return {set onmessage(fn){native.onmessage=fn;},postMessage(value){turns++;native.postMessage(value);},close(){active.delete(native);native.close();}};};this.port1=port(channel.port1);this.port2=port(channel.port2);}
 }
 const context={module:{exports:{}},require:name=>name==='./analysis-evidence.js'?Evidence:name==='./analysis-snapshot.js'?Snapshot:assert.fail(name),setTimeout:(fn,delay)=>{if(scheduler==='timer')turns++;return setTimeout(fn,delay);}};
 if(scheduler==='immediate')context.setImmediate=fn=>{turns++;return setImmediate(fn);};
 if(scheduler==='channel')context.MessageChannel=TrackedChannel;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/performance-measurements.js'),'utf8'),context);
 const count=scheduler==='timer'?128:50000,identities=Array.from({length:count},(_,i)=>i?{id:'node:'+i}:{id:'item:fixture::work',functionId:'compiler:shared',buildUnitId:'fixture:lib'});
 let admissions=0,onAdmission=null;const q=F.request();q.input.sources=q.input.sources.slice(0,1);
 const engine=context.module.exports.create({capture:{contentSha256:Evidence.digest(F.graph())},functions:()=>{admissions++;if(onAdmission)onAdmission();return identities;},edges:[]});
 const closed=()=>assert.equal(active.size,0,'query task ports must close on success, error and cancellation');
 const rejected=async(request,control,code)=>{await assert.rejects(engine.query(request,control),error=>{assert.equal(error.code,code);for(const key of ['data','snapshot','replay'])assert.equal(error[key],undefined);return true;});closed();};
 try{
 await rejected({...q,budgets:{maxWork:1000}},undefined,'MEASUREMENT_BUDGET');
 if(scheduler!=='timer')await rejected({...q,budgets:{maxRetainedBytes:65536}},undefined,'MEASUREMENT_BUDGET');
 await rejected({...q,timeoutMs:1},undefined,'MEASUREMENT_TIMEOUT');
 for(const cancelBy of ['timer','message']){
  let cancelled=false,timer;const before=admissions,channel=cancelBy==='message'?new MessageChannel():null;
  if(channel)channel.port1.onmessage=()=>{cancelled=true;};
  onAdmission=()=>{if(channel)channel.port2.postMessage(null);else timer=setTimeout(()=>{cancelled=true;},0);};
  try{await rejected(q,{cancelled:()=>cancelled},'CANCELLED');assert.equal(admissions,before+1,'cancellation must interrupt index admission');}
  finally{clearTimeout(timer);if(channel){channel.port1.close();channel.port2.close();}onAdmission=null;}
 }
 const before=admissions,value=await engine.query(q);closed();assert.equal(admissions,before+1,'failed admissions must never publish partial indexes');assert.equal(value.request.timeoutMs,2000);assert.equal(value.data.benchmarks[0].binding.node.id,'item:fixture::work');
 assert.deepEqual(await engine.query(q),value);closed();
 for(const result of await Promise.all([engine.query(q),engine.query(q)]))assert.deepEqual(result,value);closed();assert.equal(admissions,before+1,'only the complete index may be cached');assert(turns>0,'use real host task turns');
 if(scheduler==='channel')assert(created>0);else assert.equal(created,0);
 }finally{for(const port of active)port.close();}
});
test('pinned upstream real-profile excerpt remains real, hash checked and fully unmatched',async()=>{
 const q=F.request();q.input.sources=[F.realProfile()];const source=q.input.sources[0],p=source.provenance,dir=path.join(__dirname,'../tests/fixtures/performance-measurements');assert.equal(hash(source.text),p.foldedSha256);assert.equal(hash(fs.readFileSync(path.join(dir,'real-perf-excerpt.txt'))),p.excerptSha256);assert.equal(p.commit,'41fee1f99f9276008b7cd112fca19dc3ea84ac32');const v=await imported(q);assert.equal(v.data.profiles[0].total,p.sampleRecords);assert.equal(v.data.profiles[0].nodes.length,0);assert.equal(v.data.snapshot.input.sources[0].provenance.origin,'real upstream perf script profile, not a synthetic benchmark');
});
test('actual CLI accepts a complete local measurement request and saved-snapshot load',()=>{
 const os=require('node:os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'measurements-cli-'));try{const raw=F.graph(),graph=path.join(dir,'graph.json');fs.writeFileSync(graph,JSON.stringify(raw));const run=q=>{const r=spawnSync(process.execPath,['scripts/query-analysis.cjs','--graph',graph],{cwd:path.join(__dirname,'..'),input:JSON.stringify(q),encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);};const value=run(F.request(raw));assert.equal(value.operation,'importMeasurements');const loaded=run({op:'loadMeasurements',snapshot:value.data.snapshot});assert.deepEqual(loaded.data,value.data);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
if(process.env.PERFORMANCE_CAPTURE||process.env.PERFORMANCE_BASELINE_CAPTURE)test('fresh paired compiler captures bind exact distinct IDs through the current API',async()=>{
 for(const key of ['PERFORMANCE_CAPTURE','PERFORMANCE_BASELINE_CAPTURE']){assert(process.env[key],key);const raw=JSON.parse(fs.readFileSync(process.env[key],'utf8')),q=await F.captureRequest(raw),v=await imported(q,raw);assert.equal(v.data.benchmarks[0].binding.status,'exact-id');assert.notEqual(v.data.benchmarks[0].binding.node.id,v.data.benchmarks[0].binding.node.procedureId);assert.deepEqual(v.data.benchmarks[0].target,q.input.sources[1].frameIdentities['physical-frame'].target);assert.equal(v.data.profiles[0].total,5);assert.equal(v.data.profiles[0].nodes.length,1);assert.equal(v.data.coverage.captureMatches,true);}
});

test('bilateral observation and subject continuity preserve every ambiguous source through API and replay',async()=>{
 const api=Analysis.create(F.graph());
 for(const scenario of F.comparisonCases()){
  const before=(await imported(scenario.before)).data.snapshot,after=(await imported(scenario.after)).data.snapshot;
  for(const reverse of [false,true]){
   const request={op:'compareMeasurements',before:reverse?after:before,after:reverse?before:after};
   if(scenario.subjectMappings)request.subjectMappings=scenario.subjectMappings.map(m=>reverse?{before:m.after,after:m.before,provenance:m.provenance}:m);
   const v=await api.query(request);assert.equal(v.error,undefined,scenario.name);assert.deepEqual(v.data.before,request.before);assert.deepEqual(v.data.after,request.after);
   if(scenario.compatible||reverse&&scenario.reverseCompatible){assert.equal(v.data.comparisons.length,1,scenario.name);assert.equal(v.data.comparisons[0].compatible,true);}
   else if(scenario.incompatible){assert.equal(v.data.comparisons.length,1,scenario.name);assert.equal(v.data.comparisons[0].compatible,false);assert.equal(v.data.comparisons[0].ratio,undefined);}
   else{assert.equal(v.data.comparisons.length,0,scenario.name);assert.equal(v.data.unmatched.length,request.before.input.sources.length,scenario.name);assert(v.data.unmatched.every(r=>r.status==='ambiguous'&&!('ratio' in r)));assert.deepEqual(v.data.unmatched.map(r=>r.before.sourceId),request.before.input.sources.map(s=>s.id));assert(v.data.unmatched.every(r=>r.candidates.length>0));}
   assert.deepEqual(await api.query({op:'replay',replay:v.replay}),{...v,replayed:true},scenario.name);
  }
 }
});

test('delimiter-safe real fixture preserves every raw physical frame, Java boundary and recursive context',async()=>{
 const rawStacks=F.realRawStacks(),source=F.realProfile(),expected=new Map();
 assert.equal(rawStacks.length,16);assert.equal(F.decodeFoldedFrame(F.encodeFoldedFrame('literal%3B;class%')),'literal%3B;class%');
 for(const frames of rawStacks){const key=JSON.stringify(frames);expected.set(key,(expected.get(key)||0)+1);}
 const q=F.request();q.input.sources=[source];const v=await imported(q),p=v.data.profiles[0];assert.equal(p.stacks.length,expected.size);
 const actual=new Map(p.stacks.map(s=>[JSON.stringify(s.frames.map(f=>F.decodeFoldedFrame(f.frame))),s.weight]));assert.deepEqual(actual,expected);
 const java=p.stacks.find(s=>s.frames[0].frame==='java'),rawJava=rawStacks.find(s=>s[0]==='java');assert.equal(rawJava.length,46);assert.equal(java.frames.length,46);
 assert(java.frames.some(f=>f.frame==='Lio/netty/channel/nio/NioEventLoop%3B.processSelectedKeys'));assert(!java.frames.some(f=>f.frame==='.processSelectedKeys'));
 const recursivePositions=rawJava.flatMap((f,i)=>f==='Interpreter'?[i]:[]);assert.equal(recursivePositions.length,3);assert.deepEqual(java.frames.flatMap((f,i)=>f.frame==='Interpreter'?[i]:[]),recursivePositions);
 for(const stack of p.stacks){assert(stack.frames.every(f=>f.binding.status==='unmatched'&&f.inlined===null));for(let depth=0;depth<stack.frames.length;depth++){
  const paths=p.flame.filter(f=>f.depth===depth&&f.frame===stack.frames[depth].frame);assert(paths.some(frame=>{const path=[];for(let at=frame;at;at=at.parent===null?null:p.flame.find(f=>f.id===at.parent))path.unshift(F.decodeFoldedFrame(at.frame));return JSON.stringify(path)===JSON.stringify(stack.frames.slice(0,depth+1).map(f=>F.decodeFoldedFrame(f.frame)));}));
 }}
 assert.equal(p.nodes.length,0);assert.equal(p.edges.length,0);assert.deepEqual(await Analysis.create(F.graph()).query({op:'replay',replay:v.replay}),{...v,replayed:true});
});

test('tiny retained/output ceilings stop repeated long mapping expansion with host-safe input',async()=>{
 for(const budgets of [{maxRetainedBytes:65536},{maxOutputBytes:65536}]){
  const q=F.repeatedMappingRequest();q.budgets=budgets;assert(JSON.stringify(q).length<32768);const v=await Analysis.create(F.graph()).query(q);assert.equal(v.error.code,'MEASUREMENT_BUDGET');assert.equal(v.data,undefined);assert.equal(v.replay,undefined);
 }
 const q=F.repeatedMappingRequest();q.input.sources[0].text='tick;tick 1';const v=await imported(q);assert.equal(v.data.profiles[0].stacks[0].frames[0].binding.mapping.provenance.length,16384);assert.equal(v.data.profiles[0].stacks[0].frames[1].binding.mapping.provenance.length,16384);assert.deepEqual(await Analysis.create(F.graph()).query({op:'replay',replay:v.replay}),{...v,replayed:true});
});

test('warmed identity buckets charge every ambiguous candidate and preserve normal full evidence',async()=>{
 let calls=0;const engine=Measurements.create({capture:{contentSha256:Evidence.digest(F.graph())},functions:()=>{calls++;return Array.from({length:128},(_,i)=>({id:'node:'+i,procedureId:'shared'}));},edges:[]});
 const q=F.observations(['S']);let b=JSON.parse(q.input.sources[0].text).benchmarks[0];b.target={nodeId:'node:0'};q.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});await engine.query(q);assert.equal(calls,1);
 const wide=F.clone(q);wide.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:Array.from({length:20},(_,i)=>({...b,id:'wide:'+i,target:{procedureId:'shared'}}))});
 wide.budgets={maxWork:2500};await assert.rejects(engine.query(wide),{code:'MEASUREMENT_BUDGET'});assert.equal(calls,1);
 delete wide.budgets;const full=await engine.query(wide);assert.equal(full.data.benchmarks.length,20);assert(full.data.benchmarks.every(b=>b.binding.status==='ambiguous'&&b.binding.candidates.length===128));assert.deepEqual(await engine.query({op:'replay',replay:full.replay}),{...full,replayed:true});assert.equal(calls,1);
});

test('wide ambiguous comparison buckets remain bounded while preserving every source in full replay',async()=>{
 const api=Analysis.create(F.graph()),snapshot=async()=>{const q=F.observations(Array(48).fill('S'));return (await imported(q)).data.snapshot;},before=await snapshot(),after=await snapshot();
 const q={op:'compareMeasurements',before,after},full=await api.query(q);assert.equal(full.error,undefined);assert.equal(full.data.comparisons.length,0);assert.equal(full.data.unmatched.length,48);assert(full.data.unmatched.every(r=>r.candidates.length===48));
 const bounded=await api.query({...q,budgets:{maxWork:50000}});assert.equal(bounded.error.code,'MEASUREMENT_BUDGET');assert.equal(bounded.data,undefined);assert.equal(bounded.replay,undefined);assert.deepEqual(await api.query({op:'replay',replay:full.replay}),{...full,replayed:true});
});
