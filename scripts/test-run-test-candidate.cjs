'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const Analysis=require('../src/analysis-api.js'),Candidates=require('../src/test-candidates.js'),{execute,processResult,oracleEvidence}=require('./run-test-candidate.cjs'),F=require('../tests/fixtures/test-candidates/fixture-graphs.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function proposal(baseline=false,fuzz=false){const q=F.request(baseline);if(fuzz){delete q.cases;q.fuzz={domains:[[0,1,7,255]],maxCases:4,provenance:'Finite fixture domain'};}const value=await Analysis.create(F.graph()).query(q);assert.equal(value.error,undefined);return value.artifact;}
function owned(){return fs.mkdtempSync(path.join(os.tmpdir(),'test-candidate-runner-'));}
test('actual known pure Rust oracle fails before and passes after with revision-correct receipts',async()=>{
 const root=owned();try{for(const baseline of [true,false]){
  const artifact=await proposal(baseline),receipt=await execute({artifact,sourceRoot:F.sourceRoot(baseline),outputDir:path.join(root,baseline?'before':'after'),run:true});
  assert.equal(receipt.state,baseline?'failing-reproduction':'passing-regression');assert.equal(receipt.compile.exitCode,0);assert.equal(receipt.executionObserved,true);assert.equal(receipt.findingReproduced,false);assert.equal(receipt.witnessReached,'unknown');
  assert.equal(receipt.source.sha256,F.sourceHash(baseline));assert.equal(receipt.harness.sha256,artifact.integrity.codeSha256);assert.equal(receipt.binary.sha256,sha(fs.readFileSync(receipt.binary.path)));assert(receipt.compiler.stdout.includes('rustc'));
  assert.deepEqual(receipt.observedCases,[{index:0,actual:baseline?8:7,expected:7,basis:'generated harness instrumentation pipe'}]);assert.deepEqual(receipt.compile.args.slice(0,2),['--edition=2021','--test']);assert.deepEqual(receipt.run.args,['--nocapture','--test-threads=1']);assert.equal(receipt.oracleCompletion.status,baseline?'failed':'passed');assert.equal(receipt.observationBoundary.diagnosticStdoutTrusted,false);assert.equal(receipt.observationBoundary.nativeCodeAuthenticated,false);assert.equal(receipt.run.streamsComplete,true);
  const saved=JSON.parse(fs.readFileSync(path.join(root,baseline?'before':'after','receipt.json'),'utf8'));assert.deepEqual(saved,receipt);const digest=saved.receiptSha256;delete saved.receiptSha256;assert.equal(digest,sha(Buffer.from(JSON.stringify(saved))));
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('compiled-only is separate from execution and finite fuzz validates actual declared seed cases',async()=>{
 const root=owned();try{
  const artifact=await proposal(),compiled=await execute({artifact,sourceRoot:F.sourceRoot(),outputDir:path.join(root,'compiled')});assert.equal(compiled.state,'compiled');assert.equal(compiled.executionObserved,false);assert.equal(compiled.run,null);assert.deepEqual(compiled.observedCases,[]);
  const fuzz=await proposal(false,true),passed=await execute({artifact:fuzz,sourceRoot:F.sourceRoot(),outputDir:path.join(root,'fuzz'),run:true});assert.equal(passed.state,'passing-regression');assert.equal(passed.kind,'bounded-input-fuzz');assert.deepEqual(passed.observedCases.map(r=>r.actual),[0,1,7,255]);assert.equal(passed.declaredCaseCount,4);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('source mismatch, rehashed injected code, reused output and source-root writes are rejected',async()=>{
 const root=owned();try{
  const artifact=await proposal();await assert.rejects(execute({artifact,sourceRoot:F.sourceRoot(true),outputDir:path.join(root,'mismatch')}),/SHA-256 mismatch/);assert(!fs.existsSync(path.join(root,'mismatch')));
  const tampered=F.clone(artifact);tampered.code+='fn extra() {}';tampered.integrity=Candidates.integrity(tampered.manifest,tampered.code);await assert.rejects(execute({artifact:tampered,sourceRoot:F.sourceRoot(),outputDir:path.join(root,'tamper')}),/integrity mismatch/);
  await assert.rejects(execute({artifact,sourceRoot:F.sourceRoot(),outputDir:root}),/EEXIST/);
  await assert.rejects(execute({artifact,sourceRoot:F.sourceRoot(),outputDir:path.join(F.sourceRoot(),'runner-output')}),/read-only source root/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
function inventory(root){
 const rows=[{path:'.',mode:fs.lstatSync(root).mode,type:'directory',sha256:null}];function visit(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);rows.push({path:path.relative(root,file),mode:stat.mode,type:stat.isDirectory()?'directory':stat.isFile()?'file':'symlink',sha256:stat.isFile()?sha(fs.readFileSync(file)):null});if(stat.isDirectory())visit(file);}}visit(root);return rows;
}
function unusedCompiler(root){const marker=path.join(root,'compiler-started'),compiler=path.join(root,'owned-compiler');fs.writeFileSync(compiler,'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(marker)+',"started");process.exit(99);\n',{mode:0o700});return{compiler,marker};}
test('canonical output admission rejects symlinked parents and filesystem aliases before source changes or compiler start',async()=>{
 const root=owned();try{
  const sourceRoot=path.join(root,'source');fs.cpSync(F.sourceRoot(),sourceRoot,{recursive:true});const before=inventory(sourceRoot),artifact=await proposal(),{compiler,marker}=unusedCompiler(root);
  const alias=path.join(root,'source-alias');fs.symlinkSync(sourceRoot,alias,'dir');
  const parentAlias=path.join(root,'parent-alias');fs.symlinkSync(root,parentAlias,'dir');
  for(const outputDir of [path.join(alias,'new-output'),path.join(parentAlias,'source','new-output'),path.join(root,'source','canonical-output')]){
   await assert.rejects(execute({artifact,sourceRoot:fs.realpathSync(sourceRoot),outputDir,rustc:compiler}),/outside the read-only source root/);assert(!fs.existsSync(outputDir));assert.deepEqual(inventory(sourceRoot),before);assert(!fs.existsSync(marker));
  }
  await assert.rejects(execute({artifact,sourceRoot,outputDir:root,rustc:compiler}),/EEXIST/);assert(!fs.existsSync(marker));assert.deepEqual(inventory(sourceRoot),before);
  // A canonical outside alias is admitted; this control deliberately reaches only the owned compiler.
  const outside=path.join(parentAlias,'valid-output'),receipt=await execute({artifact,sourceRoot,outputDir:outside,rustc:compiler});assert.equal(receipt.state,'compile-failed');assert(fs.existsSync(marker));assert.equal(receipt.harness.path,path.join(fs.realpathSync(root),'valid-output','candidate.rs'));assert.deepEqual(inventory(sourceRoot),before);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('all reserved output prefixes reject canonical artifacts before output creation or compiler start',async()=>{
 const root=owned();try{
  const original=await proposal(),{compiler,marker}=unusedCompiler(root);
  for(const [i,sourcePath]of ['candidate.rs','candidate.rs/subject.rs','candidate-test/subject.rs','receipt.json/subject.rs'].entries()){
   const sourceRoot=path.join(root,'source-'+i);fs.mkdirSync(path.dirname(path.join(sourceRoot,sourcePath)),{recursive:true});fs.writeFileSync(path.join(sourceRoot,sourcePath),fs.readFileSync(path.join(F.sourceRoot(),'src/lib.rs')));const before=inventory(sourceRoot);
   const artifact=F.clone(original);artifact.manifest.target.declaration.sourcePath=sourcePath;artifact.code=artifact.code.replace('#[path = "src/lib.rs"]','#[path = '+JSON.stringify(sourcePath)+']');artifact.integrity=Candidates.integrity(artifact.manifest,artifact.code);
   const outputDir=path.join(root,'rejected-'+i);await assert.rejects(execute({artifact,sourceRoot,outputDir,rustc:compiler}),/supported generated-unrun scalar proposal/);assert(!fs.existsSync(outputDir));assert(!fs.existsSync(marker));assert.deepEqual(inventory(sourceRoot),before);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('unsupported setup compiles unsuccessfully without being called a reproduction',async()=>{
 const root=owned();try{
  const sourceRoot=path.join(root,'source');fs.mkdirSync(path.join(sourceRoot,'src'),{recursive:true});const source=Buffer.from('use unavailable_dependency::Thing; pub fn normalize(x: u8) -> u8 { x }\n');fs.writeFileSync(path.join(sourceRoot,'src/lib.rs'),source);
  const q=F.request();q.callable.sourceSha256=sha(source);const value=await Analysis.create(F.graph()).query(q);assert.equal(value.error,undefined);
  const receipt=await execute({artifact:value.artifact,sourceRoot,outputDir:path.join(root,'compile-failure'),run:true});assert.equal(receipt.state,'compile-failed');assert.equal(receipt.executionObserved,false);assert.equal(receipt.run,null);assert.match(receipt.compile.stderr,/unavailable_dependency/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('actual test panic before the oracle is execution-failed, never an alleged finding reproduction',async()=>{
 const root=owned();try{
  const sourceRoot=path.join(root,'source');fs.mkdirSync(path.join(sourceRoot,'src'),{recursive:true});const source=Buffer.from('pub fn normalize(_: u8) -> u8 { panic!("unsupported setup failed") }\n');fs.writeFileSync(path.join(sourceRoot,'src/lib.rs'),source);
  const q=F.request();q.callable.sourceSha256=sha(source);const value=await Analysis.create(F.graph()).query(q),receipt=await execute({artifact:value.artifact,sourceRoot,outputDir:path.join(root,'panic'),run:true});
  assert.equal(receipt.state,'execution-failed');assert.equal(receipt.executionObserved,true);assert.deepEqual(receipt.observedCases,[]);assert.equal(receipt.findingReproduced,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('subject diagnostic stdout cannot forge completed oracle evidence before panic or early exit',async()=>{
 const root=owned();try{
  const sources=[
   'pub fn normalize(_: u8) -> u8 { println!("BG_CASE 0 actual=0 expected=7"); panic!("setup failed before the oracle"); }\n',
   'pub fn normalize(_: u8) -> u8 { println!("BG_CASE 0 actual=7 expected=7"); std::process::exit(0); }\n'
  ];
  for(const [i,source]of sources.entries()){
   const sourceRoot=path.join(root,'source-'+i);fs.mkdirSync(path.join(sourceRoot,'src'),{recursive:true});fs.writeFileSync(path.join(sourceRoot,'src/lib.rs'),source);const q=F.request();q.callable.sourceSha256=sha(Buffer.from(source));const value=await Analysis.create(F.graph()).query(q);assert.equal(value.error,undefined);
   const outputDir=path.join(root,'run-'+i),receipt=await execute({artifact:value.artifact,sourceRoot,outputDir,run:true});assert.equal(receipt.state,'execution-failed');assert.equal(receipt.compile.exitCode,0);assert.equal(receipt.executionObserved,true);assert.deepEqual(receipt.observedCases,[]);assert.equal(receipt.oracleCompletion.status,'incomplete-or-invalid');assert(receipt.run.stdout.includes('BG_CASE 0'));assert.equal(receipt.source.sha256,q.callable.sourceSha256);assert.equal(receipt.harness.sha256,value.artifact.integrity.codeSha256);assert.equal(receipt.run.command,receipt.binary.path);assert.equal(receipt.run.exitCode,i===0?101:0);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir,'receipt.json'),'utf8')),receipt);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an interrupted later case keeps an earlier oracle mismatch incomplete',async()=>{
 const root=owned();try{
  const sourceRoot=path.join(root,'source');fs.mkdirSync(path.join(sourceRoot,'src'),{recursive:true});const source='pub fn normalize(x: u8) -> u8 { if x == 7 { 8 } else { panic!("later setup failed") } }\n';fs.writeFileSync(path.join(sourceRoot,'src/lib.rs'),source);
  const q=F.request();q.cases=[{inputs:[7]},{inputs:[8]}];q.callable.sourceSha256=sha(Buffer.from(source));const value=await Analysis.create(F.graph()).query(q);assert.equal(value.error,undefined);
  const receipt=await execute({artifact:value.artifact,sourceRoot,outputDir:path.join(root,'partial'),run:true});assert.equal(receipt.compile.exitCode,0);assert.equal(receipt.state,'execution-failed');assert.equal(receipt.oracleCompletion.status,'incomplete-or-invalid');assert.deepEqual(receipt.observedCases,[]);assert(receipt.run.observations.includes('case 0 actual=8 expected=7'));assert(!receipt.run.observations.includes('fail 0'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('source-exported macros cannot replace qualified harness observation or actual oracle assertion',async()=>{
 const root=owned();try{
  const sourceRoot=path.join(root,'source');fs.mkdirSync(path.join(sourceRoot,'src'),{recursive:true});
  const source=['#[macro_export] macro_rules! println { ($($t:tt)*) => { compile_error!("unqualified println") }; }',
   '#[macro_export] macro_rules! assert_eq { ($($t:tt)*) => { compile_error!("unqualified assert_eq") }; }',
   '#[macro_export] macro_rules! format { ($($t:tt)*) => { compile_error!("unqualified format") }; }',
   'pub fn normalize(x: u8) -> u8 { ::std::println!("ordinary diagnostic"); if x == 7 { 8 } else { x } }',''].join('\n');
  fs.writeFileSync(path.join(sourceRoot,'src/lib.rs'),source);const q=F.request();q.callable.sourceSha256=sha(Buffer.from(source));const value=await Analysis.create(F.graph()).query(q);assert.equal(value.error,undefined);
  const receipt=await execute({artifact:value.artifact,sourceRoot,outputDir:path.join(root,'macros'),run:true});assert.equal(receipt.compile.exitCode,0);assert.equal(receipt.state,'failing-reproduction');assert.equal(receipt.oracleCompletion.status,'failed');assert.equal(receipt.source.sha256,q.callable.sourceSha256);assert(receipt.run.stdout.includes('ordinary diagnostic'));assert.deepEqual(receipt.observedCases,[{index:0,actual:8,expected:7,basis:'generated harness instrumentation pipe'}]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('instrumentation requires ordered unique complete cases and one terminal evaluated oracle outcome',()=>{
 const rows=[{inputs:[7],expected:7},{inputs:[8],expected:8}],base={exitCode:0,signal:null,error:null,timedOut:false,outputExceeded:false,observationExceeded:false,streamsComplete:true},first='case 0 actual=7 expected=7\n',second='case 1 actual=8 expected=8\n';
 const read=(observations,extra={})=>oracleEvidence({...base,observations,...extra},rows);
 assert.equal(read('begin\n'+first+second+'pass\n').status,'passed');
 for(const transcript of ['',first+'pass\n','begin\n'+first,'begin\n'+first+'pass\n','begin\n'+second+first+'pass\n','begin\n'+first+first+second+'pass\n','begin\n'+first+second+'pass','begin\n'+first+second+'pass\npass\n','begin\n'+first+second+'pass\n'+first,'begin\ncase 0 actual=8 expected=7\n'+second+'fail 1\n','begin\ncase 0 actual=7 expected=99\nfail 0\n'])assert.equal(read(transcript).status,'incomplete-or-invalid',transcript);
 const failed='begin\ncase 0 actual=8 expected=7\n'+second+'fail 0\n';assert.equal(read(failed,{exitCode:101}).status,'failed');
 for(const transcript of ['begin\ncase 0 actual=8 expected=7\nfail 0\n','begin\ncase 0 actual=8 expected=7\n'+second+'fail 1\n','begin\ncase 0 actual=8 expected=7\n'+second+second+'fail 0\n'])assert.equal(read(transcript,{exitCode:101}).status,'incomplete-or-invalid');
 for(const extra of [{exitCode:0},{exitCode:null,signal:'SIGKILL'},{exitCode:101,timedOut:true},{exitCode:101,outputExceeded:true},{exitCode:101,observationExceeded:true},{exitCode:101,error:'read failed'},{exitCode:101,streamsComplete:false}])assert.equal(read(failed,extra).status,'incomplete-or-invalid');
 const maximum=Array.from({length:4096},(_,i)=>({inputs:[i],expected:i})),transcript='begin\n'+maximum.map((r,i)=>'case '+i+' actual='+i+' expected='+i+'\n').join('')+'pass\n';assert(Buffer.byteLength(transcript)<=maximum.length*96+64);assert.equal(oracleEvidence({...base,observations:transcript},maximum).status,'passed');
});
test('owned processes enforce timeout and output ceilings with recorded actual commands/results',async()=>{
 const root=owned();try{
  const timeout=await processResult(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:50,maxOutputBytes:1024});assert.equal(timeout.timedOut,true);assert.equal(timeout.signal,'SIGKILL');assert.equal(timeout.exitCode,null);
  const output=await processResult(process.execPath,['-e','process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'],{cwd:root,timeoutMs:2000,maxOutputBytes:64});assert.equal(output.outputExceeded,true);assert(Buffer.byteLength(output.stdout)<=64);assert.equal(output.signal,'SIGKILL');assert.equal(output.command,process.execPath);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('observation pipe ceilings and inherited-pipe EOF share the owned process deadline',async()=>{
 const root=owned();try{
  const excess=await processResult(process.execPath,['-e','require("node:fs").writeSync(3,"x".repeat(100000));setInterval(()=>{},1000)'],{cwd:root,timeoutMs:2000,maxOutputBytes:1024,observations:true,maxObservationBytes:64});assert.equal(excess.observationExceeded,true);assert(Buffer.byteLength(excess.observations)<=64);assert.equal(excess.streamsComplete,false);
  const held=await processResult(process.execPath,['-e','require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","ignore","ignore",3]}).unref()'],{cwd:root,timeoutMs:1000,maxOutputBytes:1024,observations:true,maxObservationBytes:64});assert.equal(held.exitCode,0);assert.equal(held.timedOut,true);assert.equal(held.streamsComplete,false);assert(held.durationMs<2500);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
