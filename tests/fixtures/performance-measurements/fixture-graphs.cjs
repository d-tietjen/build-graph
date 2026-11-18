'use strict';
const {callable}=require('../entry-effects/fixture-graphs.cjs');
const Evidence=require('../../../src/analysis-evidence.js');
const fs=require('node:fs'),path=require('node:path');
const clone=v=>JSON.parse(JSON.stringify(v));
function graph(){
 const raw={nodes:[{id:'package:fixture',attributes:{kind:'crate',crate:'fixture',package_id:'fixture',workspace_member:'true'}},
  {id:'package:other',attributes:{kind:'crate',crate:'other',package_id:'other',workspace_member:'true'}},
  ...callable('fixture::root','fixture',['fixture::work'],{function_id:'compiler:root',unit_key:'fixture:lib'}),
  ...callable('fixture::work','fixture',['fixture::work'],{function_id:'compiler:shared',unit_key:'fixture:lib',display_path:'same_name'}),
  ...callable('other::work','other',[],{function_id:'compiler:shared',unit_key:'other:lib',display_path:'same_name'})],edges:[]};
 for(const n of raw.nodes){if(n.attributes.kind!=='flow_function')continue;const flow=JSON.parse(n.attributes.flow);for(const b of flow.blocks){if(b.callee==='fixture::work'){b.callee_id='compiler:shared';b.callee_package_id='fixture';}}n.attributes.flow=JSON.stringify(flow);}
 for(const n of raw.nodes){if(n.attributes.kind==='function')n.id='item:'+n.id;else if(n.attributes.symbol_id)n.attributes.symbol_id='item:'+n.attributes.symbol_id;}
 return raw;
}
function provenance(){return {build:{id:'local-build'},tree:{sha:'source-tree'},workload:{id:'fixed-input',size:64},configuration:{mode:'release'},toolchain:{id:'declared-toolchain'},machine:{id:'local-machine'},environment:{os:'declared-os',load:'idle'},recordedAt:'2026-01-01T00:00:00Z'};}
function benchmark(){return {id:'case:mean',name:'same_name',subject:'normalize-fixed-input',method:{tool:'generic-bench',version:'1',measurement:'wall-time'},input:{size:64},unit:'ns/iteration',statistic:'mean',estimate:{value:100,standardError:2,confidenceInterval:{level:0.95,lower:95,upper:105}},throughput:{perIteration:64,unit:'bytes'},target:{functionId:'compiler:shared',buildUnitId:'fixture:lib'}};}
function request(raw=graph()){
 return {op:'importMeasurements',input:{schemaVersion:1,capture:{contentSha256:Evidence.digest(raw)},provenance:provenance(),sources:[
  {id:'bench',format:'generic-benchmark-v1',text:JSON.stringify({schemaVersion:1,benchmarks:[benchmark()]})},
  {id:'cpu',format:'folded-stacks-v1',unit:'samples',weightKind:'samples',text:'entry;work;work 7\nentry;work 3\nexternal;work 2\n',frameIdentities:{entry:{target:{nodeId:'item:fixture::root',procedureId:'fixture::root'},inlined:false,provenance:'Explicit fixture symbol table'},work:{target:{functionId:'compiler:shared',buildUnitId:'fixture:lib'},inlined:false,provenance:'Explicit fixture symbol table'}}}
 ],mappings:[]}};
}
function criterion(){const e={confidence_interval:{confidence_level:0.95,lower_bound:95,upper_bound:105},point_estimate:100,standard_error:2};
 const estimatesText=JSON.stringify({mean:e,median:e,median_abs_dev:e,slope:null,std_dev:e},null,2)+'\n';
 const benchmarkText=JSON.stringify({group_id:'group',function_id:'same_name',value_str:'64',throughput:{Bytes:64},full_id:'group/same_name/64',directory_name:'group/same_name/64',title:'group/same_name/64'},null,2)+'\n';
 return {id:'criterion',format:'criterion-json-v1',text:JSON.stringify({criterionVersion:'0.5.1',measurement:'WallTime',subject:'criterion-fixed-input',estimatesText,benchmarkText})};
}
function realProfile(){return {id:'upstream-real-profile',format:'folded-stacks-v1',unit:'samples',weightKind:'samples',text:fs.readFileSync(path.join(__dirname,'real-perf.folded'),'utf8'),provenance:JSON.parse(fs.readFileSync(path.join(__dirname,'real-profile-provenance.json'),'utf8'))};}
// Explicit fixture-label encoding; the general folded importer does not decode it.
const encodeFoldedFrame=label=>label.replace(/%/g,'%25').replace(/;/g,'%3B');
const decodeFoldedFrame=label=>label.replace(/%3B/g,';').replace(/%25/g,'%');
function realRawStacks(){
 const raw=fs.readFileSync(path.join(__dirname,'real-perf-excerpt.txt'),'utf8');
 return raw.trim().split(/\n\n/).map(record=>{const lines=record.split('\n'),header=/^(.+?)\s+\d+\/\d+/.exec(lines.shift());if(!header)throw new Error('Missing perf process header');
  return [header[1],...lines.map(line=>line.slice(0,line.lastIndexOf(' (')).replace(/^\s*[a-f0-9]+\s+/,'' )).reverse()];});
}
function observations(subjects){const q=request();q.input.sources=subjects.map((subject,i)=>{const b=benchmark();b.id='observation:'+i;b.subject=subject;b.estimate.value=100+i;b.estimate.confidenceInterval.lower=95+i;b.estimate.confidenceInterval.upper=105+i;return {id:'source:'+i,format:'generic-benchmark-v1',text:JSON.stringify({schemaVersion:1,benchmarks:[b]})};});return q;}
function comparisonCases(){
 const link=(before,after)=>({before,after,provenance:'Explicit fixture subject continuity'});
 const cases=[
  {name:'unique',before:observations(['S']),after:observations(['S']),compatible:true},
  {name:'unique rename',before:observations(['S']),after:observations(['U']),subjectMappings:[link('S','U')],compatible:true},
  {name:'duplicate before',before:observations(['S','S']),after:observations(['S']),ambiguous:2},
  {name:'duplicate after',before:observations(['S']),after:observations(['S','S']),ambiguous:1},
  {name:'many to one rename',before:observations(['S','T']),after:observations(['U']),subjectMappings:[link('S','U'),link('T','U')],ambiguous:2},
  {name:'rename collides with implicit continuity',reverseCompatible:true,before:observations(['S','T']),after:observations(['T']),subjectMappings:[link('S','T')],ambiguous:2}
 ];
 const cross=observations(['S']);cross.input.capture.contentSha256='a'.repeat(64);cross.input.provenance.build.id='next-build';cross.input.provenance.tree.sha='next-tree';cross.input.provenance.recordedAt='2026-02-01T00:00:00Z';cases.push({name:'cross build capture and collection time',before:observations(['S']),after:cross,compatible:true});
 for(const field of ['method','input','unit','workload','machine']){const after=observations(['S']);if(field==='machine')delete after.input.provenance.machine;else if(field==='workload')after.input.provenance.workload.id='different-workload';else{const b=JSON.parse(after.input.sources[0].text).benchmarks[0];if(field==='method')b.method.version='other';if(field==='input')b.input.size=65;if(field==='unit')b.unit='us/iteration';after.input.sources[0].text=JSON.stringify({schemaVersion:1,benchmarks:[b]});}cases.push({name:'incompatible '+field,before:observations(['S']),after,incompatible:true});}
 return cases;
}
function repeatedMappingRequest(){const q=request();q.input.sources=[{id:'repeated',format:'folded-stacks-v1',unit:'samples',weightKind:'samples',text:Array(40).fill(Array(20).fill('tick').join(';')+' 1').join('\n')}];q.input.mappings=[{sourceId:'repeated',recordId:'tick',target:{nodeId:'item:fixture::work'},provenance:'p'.repeat(16384)}];return q;}
function captureRequest(raw){const Analysis=require('../../../src/analysis-api.js'),api=Analysis.create(raw);return api.query({op:'functions',page:{limit:100}}).then(result=>{
 const row=result.functions.items.find(r=>r.identity&&r.identity.procedureId&&r.identity.functionId&&r.identity.buildUnitId);if(!row)throw new Error('Fresh compiler capture lacks an exact callable identity');
 if(row.id===row.identity.procedureId)throw new Error('Fresh compiler capture must expose distinct graph and procedure IDs');
 const q=request(raw),b=benchmark();b.target={nodeId:row.id,procedureId:row.identity.procedureId,functionId:row.identity.functionId,buildUnitId:row.identity.buildUnitId};q.input.sources=[{id:'fresh-bench',format:'generic-benchmark-v1',text:JSON.stringify({schemaVersion:1,benchmarks:[b]})},{id:'fresh-profile',format:'folded-stacks-v1',unit:'samples',weightKind:'samples',text:'physical-frame 5\n',frameIdentities:{'physical-frame':{target:b.target,inlined:false,provenance:'Exact fresh compiler identity, explicitly assigned to synthetic test samples'}}}];return q;
 });}
module.exports={clone,graph,provenance,benchmark,request,criterion,realProfile,captureRequest,encodeFoldedFrame,decodeFoldedFrame,realRawStacks,observations,comparisonCases,repeatedMappingRequest};
