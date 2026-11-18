'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Analysis=require('../src/analysis-api.js'),Candidates=require('../src/test-candidates.js'),Evidence=require('../src/analysis-evidence.js'),F=require('../tests/fixtures/test-candidates/fixture-graphs.cjs');
const Snapshot=require('../src/analysis-snapshot.js');
const Guards=require('../tests/fixtures/guard-obligations/fixture-graphs.cjs');
test('API/schema advertise bounded local proposals with no automatic execution',async()=>{
 const api=Analysis.create(F.graph()),caps=await api.query({op:'capabilities'}),schema=(await api.query({op:'schema'})).schema;
 assert(caps.operations.includes('testCandidates'));assert.deepEqual(caps.testCandidates,schema.testCandidates);assert.equal(caps.testCandidates.maxCases,4096);assert.equal(caps.testCandidates.automaticExecution,false);
});
test('exact query/source provenance, deterministic regression code, immutable replay and artifact integrity',async()=>{
 const raw=F.graph(),api=Analysis.create(raw),q=F.request(),pending=api.query(q);q.cases[0].inputs[0]=99;
 const value=await pending;assert.equal(value.error,undefined);const a=value.artifact,m=a.manifest;
 assert.equal(m.state,'generated-unrun');assert.equal(m.executionObserved,false);assert.deepEqual(m.inputs.cases,[{inputs:[7],expected:7}]);assert.equal(m.target.captured.procedure,'fixture::normalize');
 assert.equal(m.target.capturedSourceCorrespondence,'unknown');assert.equal(m.evidence.query.result.operation,'callPaths');assert.equal(m.evidence.graph.contentSha256,Evidence.digest(raw));
 assert.match(a.code,/subject::normalize\(7u8\)/);assert.match(a.code,/BG_ORACLE_MISMATCH 0/);assert(Candidates.verifyArtifact(a));assert.deepEqual(a.integrity,Candidates.integrity(m,a.code));
 assert.deepEqual(await api.query({op:'replay',replay:value.replay}),{...value,replayed:true});
 const bad=F.clone(value.replay);bad.request.callable.path='other';assert.equal((await api.query({op:'replay',replay:bad})).error.code,'INVALID_REPLAY');
 a.code+='\nfn injected() {}';assert.throws(()=>Candidates.verifyArtifact(a),/integrity mismatch/);
});
test('distinct exact graph endpoint and accepted procedure bind in core, API and immutable replay',async()=>{
 const raw=F.graph(true),q=F.distinctRequest(false,raw),api=Analysis.create(raw),value=await api.query(q);assert.equal(value.error,undefined);
 const m=value.artifact.manifest,e=m.evidence.query.result.endpoints.from;
 assert.notEqual(e.id,e.procedureId);assert.equal(e.id,'item:fixture::normalize');assert.equal(e.procedureId,q.target);assert.equal(m.target.captured.nodeId,e.id);assert.equal(m.target.captured.procedure,q.target);
 assert.equal(m.target.captured.identity.packageId,e.packageId);assert.deepEqual(m.target.captured.source,e.source);assert(Candidates.verifyArtifact(value.artifact));
 const core=F.clone(q);core.input.graph=raw;const direct=await Candidates.query(core,null);assert.equal(direct.artifact.manifest.target.captured.procedure,q.target);assert.deepEqual(direct.artifact.manifest.evidence.query.result.endpoints.from,e);
 assert.deepEqual(await api.query({op:'replay',replay:value.replay}),{...value,replayed:true});
 const wrong=F.clone(q);wrong.target=e.id;assert.equal((await api.query(wrong)).error.code,'INVALID_CANDIDATE');
 const alias=F.clone(q);alias.input.queries[0].request.from=q.target;assert.equal((await api.query(alias)).error.code,'EXACT_ID_REQUIRED');
});
test('ambiguous body/owner, foreign/unavailable owner and unavailable body cannot invent accepted endpoint identity',async()=>{
 const controls=[
  raw=>{const duplicate=F.clone(raw.nodes[2]);duplicate.id='duplicate-flow';raw.nodes.push(duplicate);},
  raw=>{const other=F.clone(raw.nodes[0]);other.id='other-package';other.attributes.package_id='fixture-other';raw.nodes.push(other);delete raw.nodes[1].attributes.package_id;delete raw.nodes[2].attributes.package_id;},
  raw=>{raw.nodes[1].attributes.package_id='foreign-owner';},
  raw=>{delete raw.nodes[0].attributes.package_id;delete raw.nodes[0].attributes.crate;delete raw.nodes[1].attributes.package_id;delete raw.nodes[1].attributes.crate;delete raw.nodes[2].attributes.package_id;delete raw.nodes[2].attributes.crate;},
  raw=>{raw.nodes.splice(2,1);},
  raw=>{const body=JSON.parse(raw.nodes[2].attributes.flow);body.blocks=[{id:'bb0',kind:'opaque',label:'pre-optimization MIR unavailable',successors:[]}];raw.nodes[2].attributes.flow=JSON.stringify(body);}
 ];
 for(const edit of controls){const raw=F.graph(true),q=F.distinctRequest(false,raw);edit(raw);const value=await Analysis.create(raw).query(q);assert.equal(value.error.code,'INVALID_CANDIDATE');}
});
for(const variant of F.sourceVariants())test('distinct-ID source facts retain '+variant.name+' through core/API/replay',async()=>{
 const {raw}=variant,before=F.clone(raw),q=F.distinctRequest(false,raw),api=Analysis.create(raw),value=await api.query(q);assert.equal(value.error,undefined);
 const m=value.artifact.manifest,e=m.evidence.query.result.endpoints.from;
 assert.notEqual(e.id,e.procedureId);assert.equal(e.procedureId,q.target);
 assert.deepEqual(m.target.captured.source,{source_file:variant.file,source_location:3,absolute_file:variant.capturedAbsolute});
 assert.deepEqual(e.source,{source_file:variant.file,source_location:3,absolute_file:variant.endpointAbsolute});
 assert.equal(m.target.capturedSourceCorrespondence,'unknown');assert.equal(m.target.declaration.sourceSha256,F.sourceHash());assert(Candidates.verifyArtifact(value.artifact));
 const core=F.clone(q);core.input.graph=raw;const direct=await Candidates.query(core,null);assert.deepEqual(direct.artifact.manifest.target.captured.source,m.target.captured.source);assert.deepEqual(direct.artifact.manifest.evidence.query.result.endpoints.from.source,e.source);
 assert.deepEqual(await api.query({op:'replay',replay:value.replay}),{...value,replayed:true});assert.deepEqual(raw,before);
});
test('source comparison rejects differing recorded files, locations and known absolute enrichment',async t=>{
 const exportSide=Snapshot.exportSide;let edit,edited;
 t.mock.method(Snapshot,'exportSide',async(...args)=>{
  const snapshot=await exportSide(...args),operations=snapshot.evidence.operations.filter(o=>o.key==='route');
  assert.equal(operations.length,1);const operation=operations[0];assert.equal(operation.key,'route');assert.equal(operation.operation,'callPaths');
  const result=operation.result;assert(result);assert.equal(result.operation,'callPaths');assert(result.request);assert.equal(result.request.op,'callPaths');
  assert.equal(result.request.from,'item:fixture::normalize');assert.equal(result.request.to,'item:fixture::normalize');assert(result.endpoints);
  const endpoint=result.endpoints.from;assert(endpoint);assert.equal(endpoint.id,'item:fixture::normalize');assert.equal(endpoint.procedureId,'fixture::normalize');
  assert.deepEqual(endpoint.source,{source_file:'fixture.rs',source_location:3,absolute_file:'/fixtures/fixture.rs'});
  edit(endpoint.source);edited=true;return snapshot;
 });
 for(const change of [s=>s.source_file='different.rs',s=>s.source_location=4,s=>s.absolute_file='/different/fixture.rs']){
  edit=change;edited=false;const raw=F.graph(true),q=F.distinctRequest(false,raw);q.input.graph=raw;
  await assert.rejects(Candidates.query(q,null),{code:'INVALID_CANDIDATE'});
  assert.equal(edited,true);
 }
});
test('malformed enrichment and conflicting recorded absolute paths cannot normalize into equality',async()=>{
 for(const enrichment of ['relative.rs',true,{},'/different/fixture.rs']){
  const raw=F.sourceVariants()[0].raw;for(const n of raw.nodes.slice(1))n.attributes.source_absolute=enrichment;
  const value=await Analysis.create(raw).query(F.distinctRequest(false,raw));assert.equal(value.error.code,'INVALID_CANDIDATE');
 }
});
test('reserved producer paths are rejected by generation and canonical artifact admission',async()=>{
 const api=Analysis.create(F.graph()),value=await api.query(F.request());assert.equal(value.error,undefined);
 for(const sourcePath of ['candidate.rs','candidate.rs/subject.rs','candidate-test/subject.rs','receipt.json/subject.rs']){
  const q=F.request();q.callable.sourcePath=sourcePath;assert.equal((await api.query(q)).error.code,'INVALID_CANDIDATE',sourcePath);
  const artifact=F.clone(value.artifact);artifact.manifest.target.declaration.sourcePath=sourcePath;artifact.integrity=Candidates.integrity(artifact.manifest,artifact.code);
  assert.throws(()=>Candidates.verifyArtifact(artifact),/supported generated-unrun scalar proposal/,sourcePath);
 }
 assert(Candidates.verifyArtifact(value.artifact));assert.equal(value.artifact.manifest.target.declaration.sourcePath,'src/lib.rs');
});
test('finite fuzz domains enumerate every typed seed deterministically and enforce actual domain budget',async()=>{
 const api=Analysis.create(F.graph()),q=F.request();delete q.cases;q.fuzz={domains:[[0,1,7,255]],maxCases:4,provenance:'Finite boundary and known defect seeds'};
 const value=await api.query(q);assert.equal(value.error,undefined);assert.equal(value.artifact.manifest.kind,'bounded-input-fuzz');assert.deepEqual(value.artifact.manifest.inputs.cases,[0,1,7,255].map(n=>({inputs:[n],expected:n})));assert(Candidates.verifyArtifact(value.artifact));
 for(const change of [q=>q.fuzz.maxCases=3,q=>q.fuzz.domains=[[0,0]],q=>q.fuzz.domains=[[256]],q=>q.fuzz.domains=[[]]]){const bad=F.clone(q);change(bad);assert.equal((await api.query(bad)).error.code,'INVALID_CANDIDATE');}
 const multi=F.clone(q);multi.callable.parameters=['u8','bool'];multi.fuzz.domains=[[0,7],[false,true]];multi.fuzz.maxCases=4;assert.deepEqual((await api.query(multi)).artifact.manifest.inputs.cases.map(r=>r.inputs),[[0,false],[0,true],[7,false],[7,true]]);
});
test('all supported scalar literals and declared constant/case oracles remain type checked',async()=>{
 const api=Analysis.create(F.graph());
 for(const [type,value]of [['bool',false],['i8',-128],['u8',255],['i16',-32768],['u16',65535],['i32',-2147483648],['u32',4294967295]]){
  const q=F.request();q.callable.parameters=[type];q.callable.returns=type;q.oracle={kind:'constant',value,provenance:'Explicit scalar specification'};q.cases=[{inputs:[value]}];const result=await api.query(q);assert.equal(result.error,undefined,type);assert(Candidates.verifyArtifact(result.artifact));assert.equal(result.artifact.manifest.inputs.cases[0].expected,value);
 }
 const q=F.request();q.oracle={kind:'cases',provenance:'Exact expected return table'};q.cases=[{inputs:[1],expected:2}];assert.equal((await api.query(q)).artifact.manifest.inputs.cases[0].expected,2);
 q.cases[0].expected='assert!(false)';assert.equal((await api.query(q)).error.code,'INVALID_CANDIDATE');
});
test('unsupported callable/setup shapes produce explicit unrun manifests without code',async()=>{
 const api=Analysis.create(F.graph());
 for(const edit of [q=>q.callable.kind='async-function',q=>q.callable.parameters=['&[u8]'],q=>q.callable.setup='database',q=>q.callable.returns='Result<u8,Error>',q=>q.oracle.kind='panic']){
  const q=F.request();edit(q);const value=await api.query(q);assert.equal(value.error,undefined);assert.equal(value.artifact.manifest.support.status,'unsupported');assert.equal(value.artifact.code,'');assert.equal(value.artifact.manifest.executionObserved,false);assert(value.artifact.manifest.support.reasons.length);
 }
 for(const path of ['../outside.rs','/tmp/outside.rs','src/a".rs','src/../lib.rs']){const q=F.request();q.callable.sourcePath=path;assert.equal((await api.query(q)).error.code,'INVALID_CANDIDATE');}
 const injected=F.request();injected.callable.path='normalize(); panic!("x")';assert.equal((await api.query(injected)).error.code,'INVALID_CANDIDATE');
});
test('selected predicate witness is matched by full canonical hash; opaque and unsolved evidence remains visible',async()=>{
 const item=Guards.scenario('fail-open'),api=Analysis.create(item.raw),selected=await api.query(item.request);assert.equal(selected.error,undefined);assert(selected.witnesses.items.length);
 const q=F.request();q.target=item.request.function;q.input={selection:{function:q.target},queries:[{key:'guard',request:item.request}]};q.queryKey='guard';q.witnessSha256=Evidence.digest(selected.witnesses.items[0]);
 const value=await api.query(q);assert.equal(value.error,undefined);assert.deepEqual(value.artifact.manifest.evidence.selectedWitness,F.clone(selected.witnesses.items[0]));assert.equal(value.artifact.manifest.evidence.witnessSha256,q.witnessSha256);assert.equal(Evidence.digest(value.artifact.manifest.evidence.selectedWitness),q.witnessSha256);assert.equal(value.artifact.manifest.inputs.reachingInputProven,false);assert.equal(value.artifact.manifest.expectedBehavior.findingReproduced,false);
 const exported=await api.query({op:'exportRevision',input:q.input});assert.deepEqual(value.artifact.manifest.evidence.query,exported.snapshot.evidence.operations.find(o=>o.key==='guard'));assert(value.artifact.manifest.support.diagnostics.some(t=>t.includes('unsolved')));
 const unpinned=F.clone(value.replay);delete unpinned.request.input.capture;assert.equal((await api.query({op:'replay',replay:unpinned})).error.code,'INVALID_REPLAY');
 q.witnessSha256='0'.repeat(64);const missing=await api.query(q);assert.equal(missing.artifact.manifest.support.status,'unsupported');assert.equal(missing.artifact.manifest.evidence.selectedWitness,null);assert.equal(missing.artifact.code,'');
});
test('unreachable target route stays static/unreachable and never becomes a solved input',async()=>{
 const raw=F.graph();raw.nodes.push(...require('../tests/fixtures/entry-effects/fixture-graphs.cjs').callable('fixture::other','fixture',[]));
 const q=F.request();q.input.queries[0].request.to='fixture::other';const value=await Analysis.create(raw).query(q);assert.equal(value.error,undefined);assert.equal(value.artifact.manifest.inputs.reachingInputProven,false);assert.equal(value.artifact.manifest.evidence.query.result.status,'no-captured-route');assert.equal(value.artifact.manifest.executionObserved,false);
});
test('private admitted capture references preserve original pins and do not trust mutable catalogs or returned objects',async()=>{
 const raw=F.graph(),api=Analysis.create(raw),q=F.request(),first=await api.query(q);assert.equal(first.error,undefined);raw.nodes[0].attributes.version='mutated';api.catalog.packages.length=0;
 const second=await api.query(q);assert.deepEqual(second,first);second.artifact.manifest.inputs.cases[0].expected=99;assert.deepEqual(await api.query(q),first);
 const baseline=F.graph();baseline.label='baseline';const registered=await api.query({op:'registerRevisionCapture',raw:JSON.stringify(baseline)});q.input.capture=registered.capture;const own=await api.query(q);assert.equal(own.artifact.manifest.evidence.graph.contentSha256,Evidence.digest(baseline));
});
for(const mode of ['explicit graph','implicit current reference','explicit reference'])test(mode+': revision changes preserve complete replay accounting and exact side pins',async()=>{
 const R=require('../tests/fixtures/revision-comparison/fixture-graphs.cjs'),item=R.semantic('guard'),raw=item.after.graph,api=Analysis.create(raw);
 if(mode!=='explicit graph'){
  const registered=await api.query({op:'registerRevisionCapture',raw:JSON.stringify(item.before.graph)});assert.equal(registered.error,undefined);
  delete item.before.graph;item.before.capture=registered.capture;delete item.after.graph;item.after.capture={contentSha256:Evidence.digest(raw)};
 }
 const before=await api.query({op:'exportRevision',input:item.before}),after=await api.query({op:'exportRevision',input:item.after});assert.equal(before.error,undefined);assert.equal(after.error,undefined);
 const q=F.request();q.target='root';q.queryKey='guard';q.input=F.clone(after.snapshot.input);if(mode==='implicit current reference')delete q.input.capture;
 q.revision={before:before.snapshot,after:after.snapshot,side:'after',key:'guard',mappings:item.mappings};
 const original=F.clone(q),pending=api.query(q);assert.deepEqual(q,original);q.input.declaration.revision.value='mutated caller input';q.revision.after.input.declaration.revision.value='mutated caller snapshot';q.cases[0].inputs[0]=99;
 const value=await pending;assert.equal(value.error,undefined);const rev=value.artifact.manifest.evidence.revision;assert.equal(rev.selectionStatus,'exact-change');assert.equal(rev.comparison.operation,'compareRevisions');assert.equal(rev.side,'after');assert.equal(rev.selectedChanges[0].key,'guard');
 assert.equal(value.replay.requestHash,Evidence.digest(value.replay.request));assert.equal(rev.comparison.replay.requestHash,Evidence.digest(rev.comparison.replay.request));assert(rev.comparison.replay.request.budgets.maxWork>0);assert(rev.comparison.replay.request.budgets.maxWork<Snapshot.LIMITS.maxWork);assert(rev.comparison.replay.request.budgets.maxRetainedBytes>0);assert(rev.comparison.replay.request.budgets.maxRetainedBytes<Snapshot.LIMITS.maxRetainedBytes);
 const replay=F.clone(value.replay),again=api.query({op:'replay',replay});replay.request.input.declaration.revision.value='mutated replay caller';
 const replayed=await again;assert.deepEqual(replayed,{...value,replayed:true});assert.deepEqual(replayed.artifact.manifest,value.artifact.manifest);
 const comparison=replayed.artifact.manifest.evidence.revision.comparison.replay;assert.deepEqual(comparison.request,rev.comparison.replay.request);assert.deepEqual(comparison.request.budgets,rev.comparison.replay.request.budgets);assert.equal(comparison.requestHash,Evidence.digest(comparison.request));assert.equal(replayed.replay.requestHash,Evidence.digest(replayed.replay.request));
 if(mode==='implicit current reference')assert.deepEqual(await api.query(value.replay.request),value);
 const unpinned=F.clone(value.replay);delete unpinned.request.input[mode==='explicit graph'?'graph':'capture'];assert.equal((await api.query({op:'replay',replay:unpinned})).error.code,'INVALID_REPLAY');
 const changed=F.clone(value.replay);if(mode==='explicit graph')changed.request.input.graph.label='changed replay graph';else changed.request.input.capture=before.snapshot.input.capture;assert.equal((await api.query({op:'replay',replay:changed})).error.code,'INVALID_REPLAY');
 for(const edit of [q=>q.input.declaration.revision.value='unrelated input',q=>q.input.queries[0].request.model.rules[0].id='different model',q=>q.revision.side='before']){const different=F.clone(original);edit(different);assert.equal((await api.query(different)).error.code,'INVALID_CANDIDATE');}
 const forged=F.clone(original);forged.revision.after.evidence.operations.at(-1).result.finding.candidateBypass=false;assert.equal((await api.query(forged)).error.code,'SNAPSHOT_MISMATCH');
 for(const budgets of [{maxWork:1},{maxRetainedBytes:32},{maxOutputBytes:64}])assert.equal((await api.query({...F.clone(original),budgets})).error.code,'REVISION_BUDGET');
});
test('budgets/cancellation and escaped UTF8 are enforced before publishing artifacts',async()=>{
 const raw=F.graph(),api=Analysis.create(raw);
 for(const budgets of [{maxWork:1},{maxRetainedBytes:32},{maxOutputBytes:64}])assert.equal((await api.query({...F.request(),budgets})).error.code,'REVISION_BUDGET');
 await assert.rejects(Candidates.query(F.request(),Evidence.digest(raw),{cancelled:()=>true}),{code:'CANCELLED'});
 const q=F.request();q.callable.provenance='\0'.repeat(4096);q.budgets={maxOutputBytes:10000};assert.equal((await api.query(q)).error.code,'REVISION_BUDGET');
});
if(process.env.TEST_CANDIDATE_CAPTURE||process.env.TEST_CANDIDATE_BASELINE_CAPTURE)test('fresh compiler captures retain actual before/after source/build context in generated-unrun artifacts',async()=>{
 for(const key of ['TEST_CANDIDATE_CAPTURE','TEST_CANDIDATE_BASELINE_CAPTURE'])assert(process.env[key],key);
 for(const baseline of [true,false]){const raw=JSON.parse(fs.readFileSync(process.env[baseline?'TEST_CANDIDATE_BASELINE_CAPTURE':'TEST_CANDIDATE_CAPTURE'],'utf8')),api=Analysis.create(raw),q=F.captureRequest(raw,baseline),value=await api.query(q);assert.equal(value.error,undefined);assert(Candidates.verifyArtifact(value.artifact));const endpoint=value.artifact.manifest.evidence.query.result.endpoints.from;assert.notEqual(endpoint.id,endpoint.procedureId);assert.equal(endpoint.procedureId,q.target);assert.equal(endpoint.id,q.input.queries[0].request.from);assert(value.artifact.manifest.evidence.captureContexts.some(c=>c.record&&c.record.git.after.treeOid));assert.equal(value.artifact.manifest.executionObserved,false);}
});
