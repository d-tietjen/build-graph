#!/usr/bin/env node
/* Explicit local producer. No receipts are accepted from the candidate API. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const Candidates=require('../src/test-candidates.js'),Snapshot=require('../src/analysis-snapshot.js');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function stop(message){const e=new Error(message);e.code='CANDIDATE_EXECUTION';throw e;}
function integer(value,min,max,name){if(!Number.isSafeInteger(value)||value<min||value>max)stop(name+' outside '+min+'..'+max);return value;}
function resolveCompiler(command){
 if(command.includes(path.sep)){const item=path.resolve(command);fs.accessSync(item,fs.constants.X_OK);return item;}
 for(const dir of (process.env.PATH||'').split(path.delimiter)){const item=path.resolve(dir,command);try{fs.accessSync(item,fs.constants.X_OK);return item;}catch(_){}}
 stop('Local compiler is unavailable: '+command);
}
function processResult(command,args,options){
 return new Promise(resolve=>{
  const startedAt=new Date().toISOString(),start=performance.now(),chunks={stdout:[],stderr:[],observations:[]};
  let child,used=0,observationBytes=0,timedOut=false,outputExceeded=false,observationExceeded=false,error=null,timer,cleanupTimer,finished=false,exitCode=null,signal=null;
  function finish(){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(cleanupTimer);
   const streams=child?[child.stdout,child.stderr,...(options.observations?[child.stdio[3]]:[])]:[];
   resolve({command,args,cwd:options.cwd,startedAt,started:!!(child&&child.pid),exitCode,signal,error,timedOut,outputExceeded,observationExceeded,
    streamsComplete:!!child&&streams.every(stream=>stream.readableEnded),stdout:Buffer.concat(chunks.stdout).toString('utf8'),
    stderr:Buffer.concat(chunks.stderr).toString('utf8'),observations:Buffer.concat(chunks.observations).toString('utf8'),durationMs:performance.now()-start});}
  function terminate(){
   if(finished||cleanupTimer)return;
   // Only this detached child's process group is owned. Close inherited pipes too:
   // a descendant holding one open cannot extend the shared process/EOF deadline.
   if(child&&child.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch(_){}
   if(child)for(const stream of [child.stdout,child.stderr,child.stdio[3]])if(stream)stream.destroy();
   cleanupTimer=setTimeout(finish,100);
  }
  function receive(name,bytes){
   const observation=name==='observations',remaining=observation?options.maxObservationBytes-observationBytes:options.maxOutputBytes-used;
   if(remaining>0)chunks[name].push(bytes.subarray(0,remaining));
   if(observation)observationBytes+=bytes.length;else used+=bytes.length;
   if(!outputExceeded&&!observationExceeded&&(used>options.maxOutputBytes||observationBytes>(options.maxObservationBytes||0))){
    outputExceeded=used>options.maxOutputBytes;observationExceeded=observationBytes>(options.maxObservationBytes||0);terminate();
   }
  }
  try{child=spawn(command,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe',...(options.observations?['pipe']:[])],shell:false,detached:process.platform!=='win32',
    env:{...process.env,RUSTUP_AUTO_INSTALL:'0',RUSTUP_SKIP_UPDATE_CHECK:'1',CARGO_NET_OFFLINE:'true'}});}
  catch(e){error=e.message;finish();return;}
  timer=setTimeout(()=>{timedOut=true;terminate();},options.timeoutMs);
  child.stdout.on('data',b=>receive('stdout',b));child.stderr.on('data',b=>receive('stderr',b));
  if(options.observations)child.stdio[3].on('data',b=>receive('observations',b));
  for(const stream of [child.stdout,child.stderr,child.stdio[3]])if(stream)stream.on('error',e=>{error=e.message;terminate();});
  child.on('error',e=>{error=e.message;});
  child.on('exit',(code,reason)=>{exitCode=code;signal=reason;});
  child.on('close',(code,reason)=>{exitCode=code;signal=reason;finish();});
 });
}
function succeeded(p){return p.exitCode===0&&!p.error&&!p.timedOut&&!p.outputExceeded&&!p.observationExceeded&&p.streamsComplete;}
function canonicalOutput(requested,sourceRoot){
 const output=path.resolve(requested);let parent=path.dirname(output),parts=[path.basename(output)];
 try{fs.lstatSync(output);const e=new Error('EEXIST: output directory must be unused');e.code='EEXIST';throw e;}catch(e){if(e.code!=='ENOENT')throw e;}
 for(;;){
  try{fs.lstatSync(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;parts.unshift(path.basename(parent));const next=path.dirname(parent);if(next===parent)throw e;parent=next;}
 }
 const destination=path.join(fs.realpathSync(parent),...parts);
 if(destination===sourceRoot||destination.startsWith(sourceRoot+path.sep))stop('Output directory must be outside the read-only source root');
 // The canonical final path may be an existing alias even when the lexical path was unused.
 try{fs.lstatSync(destination);const e=new Error('EEXIST: output directory must be unused');e.code='EEXIST';throw e;}catch(e){if(e.code!=='ENOENT')throw e;}
 return destination;
}
function oracleEvidence(run,rows){
 const observedCases=[],lines=run.observations.split('\n');
 const invalid=()=>({status:'incomplete-or-invalid',observedCases:[],terminal:null});
 if(!run.streamsComplete||run.error||run.timedOut||run.outputExceeded||run.observationExceeded||lines.pop()!==''||lines.shift()!=='begin')return invalid();
 let terminal=null;
 for(const line of lines){
  const match=/^case (\d+) actual=(true|false|-?\d+) expected=(true|false|-?\d+)$/.exec(line);
  if(match){
   const index=Number(match[1]),parse=v=>v==='true'?true:v==='false'?false:Number(v),actual=parse(match[2]),expected=parse(match[3]);
   if(terminal||index!==observedCases.length||!rows[index]||rows[index].expected!==expected||typeof actual!==typeof expected||!Number.isSafeInteger(actual)&&typeof actual!=='boolean')return invalid();
   observedCases.push({index,actual,expected,basis:'generated harness instrumentation pipe'});
  }else if(line==='pass'&&!terminal){terminal={kind:'pass'};}
  else if(/^fail \d+$/.test(line)&&!terminal){terminal={kind:'fail',index:Number(line.slice(5))};}
  else return invalid();
 }
 const firstMismatch=observedCases.find(row=>row.actual!==row.expected);
 if(terminal&&terminal.kind==='pass'&&succeeded(run)&&observedCases.length===rows.length&&observedCases.every(row=>row.actual===row.expected))return{status:'passed',observedCases,terminal};
 if(terminal&&terminal.kind==='fail'&&run.exitCode!==null&&run.exitCode!==0&&!run.signal&&observedCases.length===rows.length&&firstMismatch&&terminal.index===firstMismatch.index)return{status:'failed',observedCases,terminal};
 return invalid();
}
async function execute(options){
 const timeoutMs=integer(options.timeoutMs??10000,1,60000,'timeoutMs'),maxOutputBytes=integer(options.maxOutputBytes??262144,1,1048576,'maxOutputBytes');
 const artifact=Snapshot.dispatchCopy(options.artifact,8388608);Candidates.verifyArtifact(artifact);
 if(process.platform==='win32'){const error=new Error('Generated observation channel requires a supported Unix host; no compiler started');error.code='CANDIDATE_UNSUPPORTED';throw error;}
 const sourceRoot=fs.realpathSync(options.sourceRoot),outputDir=canonicalOutput(options.outputDir,sourceRoot),declaration=artifact.manifest.target.declaration;
 const sourcePath=path.join(sourceRoot,declaration.sourcePath),actualPath=fs.realpathSync(sourcePath);
 if(actualPath!==sourcePath||!actualPath.startsWith(sourceRoot+path.sep))stop('Source path must be a regular file inside sourceRoot without symlinks');
 const stat=fs.statSync(actualPath);if(!stat.isFile()||stat.size>1048576)stop('Pinned source must be a regular file at most 1 MiB');
 const bytes=fs.readFileSync(actualPath);if(sha(bytes)!==declaration.sourceSha256)stop('Supplied source SHA-256 mismatch; no compiler started');
 const compiler=resolveCompiler(options.rustc||'rustc');
 // mkdir without recursive refuses an existing directory; source trees are never written.
 fs.mkdirSync(outputDir,{mode:0o700});
 const copiedSource=path.join(outputDir,declaration.sourcePath),harnessPath=path.join(outputDir,'candidate.rs'),binaryPath=path.join(outputDir,'candidate-test');
 fs.mkdirSync(path.dirname(copiedSource),{recursive:true,mode:0o700});fs.writeFileSync(copiedSource,bytes,{flag:'wx',mode:0o600});
 fs.writeFileSync(harnessPath,artifact.code,{flag:'wx',mode:0o600});
 const maxObservationBytes=artifact.manifest.inputs.cases.length*96+64;
 const config={cwd:outputDir,timeoutMs,maxOutputBytes};
 const compilerIdentity=await processResult(compiler,['--version','--verbose'],config);
 const receipt={schemaVersion:1,producer:'local-test-candidate-runner-v1',artifactIntegrity:artifact.integrity,
  state:'generated-unrun',executionObserved:false,findingReproduced:false,witnessReached:'unknown',capturedApplicationCorrespondence:'unknown',
  oracleBasis:'caller-declared',kind:artifact.manifest.kind,
  source:{originalPath:actualPath,copiedPath:copiedSource,sha256:sha(bytes),bytes:bytes.length},
  harness:{path:harnessPath,sha256:sha(Buffer.from(artifact.code)),configuration:'separate rustc --edition=2021 --test build; not captured application build',completeCompilerInputs:false,
    unobservedInputs:['transitive modules/includes','environment','toolchain internals','generated inputs','external dependencies']},
  capturedContext:{graph:artifact.manifest.evidence.graph,captureContexts:artifact.manifest.evidence.captureContexts,target:artifact.manifest.target.captured},
  host:{platform:process.platform,architecture:process.arch},limits:{timeoutMs,maxOutputBytes,maxObservationBytes},observationBoundary:{channel:'inherited-fd-3-unix-v1',diagnosticStdoutTrusted:false,nativeCodeAuthenticated:false,nativeCodeSandboxed:false,scope:'generated instrumentation separate from subject diagnostics; same-process native code can access the channel'},processPolicy:{shell:false,rustupAutoInstall:false,cargoNetOffline:true},compilerExecutable:{invocationPath:compiler,resolvedPath:fs.realpathSync(compiler)},compiler:compilerIdentity,compile:null,run:null,observedCases:[],declaredCaseCount:artifact.manifest.inputs.cases.length};
 if(succeeded(compilerIdentity)){
  receipt.compile=await processResult(compiler,['--edition=2021','--test',harnessPath,'-o',binaryPath],config);
  receipt.state=succeeded(receipt.compile)?'compiled':'compile-failed';
  if(receipt.state==='compiled')receipt.binary={path:binaryPath,sha256:sha(fs.readFileSync(binaryPath))};
  if(receipt.state==='compiled'&&options.run===true){
   receipt.run=await processResult(binaryPath,['--nocapture','--test-threads=1'],{...config,observations:true,maxObservationBytes});receipt.executionObserved=receipt.run.started;
   const evidence=oracleEvidence(receipt.run,artifact.manifest.inputs.cases);
   receipt.observedCases=evidence.observedCases;receipt.oracleCompletion={status:evidence.status,terminal:evidence.terminal};
   receipt.state=evidence.status==='passed'?'passing-regression':evidence.status==='failed'?'failing-reproduction':'execution-failed';
  }
 }else receipt.state='compile-failed';
 receipt.receiptSha256=sha(Buffer.from(JSON.stringify(receipt)));
 fs.writeFileSync(path.join(outputDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 return receipt;
}
function args(argv){
 const o={};for(let i=0;i<argv.length;i++){
  if(argv[i]==='--run')o.run=true;
  else if(['--artifact','--source-root','--output-dir','--rustc','--timeout-ms','--max-output-bytes'].includes(argv[i])&&argv[i+1]){const key=argv[i].slice(2).replace(/-([a-z])/g,(_,v)=>v.toUpperCase());o[key]=argv[++i];}
  else stop('Unknown or incomplete argument: '+argv[i]);
 }
 if(!o.artifact||!o.sourceRoot||!o.outputDir)stop('Usage: run-test-candidate.cjs --artifact PATH --source-root PATH --output-dir UNUSED_PATH [--run]');
 const stat=fs.statSync(o.artifact);if(stat.size>8388608)stop('Artifact input exceeds 8 MiB');
 const value=JSON.parse(fs.readFileSync(o.artifact,'utf8'));o.artifact=value.artifact||value;
 if(o.timeoutMs!=null)o.timeoutMs=Number(o.timeoutMs);if(o.maxOutputBytes!=null)o.maxOutputBytes=Number(o.maxOutputBytes);return o;
}
if(require.main===module)Promise.resolve().then(()=>execute(args(process.argv.slice(2)))).then(receipt=>{process.stdout.write(JSON.stringify(receipt)+'\n');
 if(['compile-failed','execution-failed','failing-reproduction'].includes(receipt.state))process.exitCode=1;
}).catch(error=>{process.stderr.write(error.code+': '+error.message+'\n');process.exitCode=2;});
module.exports={execute,processResult,oracleEvidence};
