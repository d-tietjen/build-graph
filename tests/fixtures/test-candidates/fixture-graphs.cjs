'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const Model=require('../../../src/execution-model.js'),Flow=require('../../../src/execution-flow.js'),CallGraph=require('../../../src/call-graph.js'),Paths=require('../../../src/call-paths.js');
const {callable}=require('../entry-effects/fixture-graphs.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function sourceRoot(baseline=false){return path.join(__dirname,baseline?'baseline':'candidate');}
function sourceHash(baseline=false){return crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot(baseline),'src/lib.rs'))).digest('hex');}
function graph(distinct=false){const raw={nodes:[{id:'package:fixture',attributes:{kind:'crate',crate:'fixture',package_id:'fixture',workspace_member:'true',version:'0.1.0'}},
 ...callable('fixture::normalize','fixture',[],{function_id:'compiler:normalize',unit_key:'fixture:lib'})],edges:[]};
 if(distinct){raw.nodes[1].id='item:fixture::normalize';raw.nodes[2].attributes.symbol_id=raw.nodes[1].id;}return raw;}
function sourceVariants(){return [
 {name:'absolute omitted enrichment',file:'/fixtures/fixture.rs',capturedAbsolute:null,endpointAbsolute:'/fixtures/fixture.rs'},
 {name:'absolute explicit enrichment',file:'/fixtures/fixture.rs',enrichment:'/fixtures/fixture.rs',capturedAbsolute:'/fixtures/fixture.rs',endpointAbsolute:'/fixtures/fixture.rs'},
 {name:'relative unresolved null enrichment',file:'fixture.rs',enrichment:null,capturedAbsolute:null,endpointAbsolute:null}
 ].map(v=>{const raw=graph(true);for(const n of raw.nodes.slice(1)){n.source_file=v.file;if(v.enrichment===undefined)delete n.attributes.source_absolute;else n.attributes.source_absolute=v.enrichment;}return{...v,raw};});}
function request(baseline=false,raw=graph(),target='fixture::normalize',endpoint=target){
 return {op:'testCandidates',target,queryKey:'route',input:{selection:{function:target},queries:[{key:'route',request:{op:'callPaths',from:endpoint,to:endpoint}}]},
  callable:{kind:'public-free-function',path:'normalize',sourcePath:'src/lib.rs',sourceSha256:sourceHash(baseline),parameters:['u8'],returns:'u8',setup:'none',provenance:'Owned fixture declaration; captured signature not inferred'},
  oracle:{kind:'identity',parameter:0,provenance:'Fixture specification: normalize(x) returns x for every u8'},cases:[{inputs:[7]}]};
}
function acceptedBinding(raw,procedure){
 const model=Model.build(raw),flow=Flow.catalog(raw);Flow.applyModelTargets(flow,model);
 const endpoints=Paths.create(raw,{model,callGraph:CallGraph.build(raw,flow)}).functions();
 const matches=endpoints.filter(e=>e.procedureId===procedure&&e.bodyStatus==='captured'&&e.bodyAvailability==='available'&&e.ownership.status==='exact'&&e.ownership.packageIds.length===1&&e.packageId===e.ownership.packageIds[0]);
 assert.equal(matches.length,1,'one accepted exact graph endpoint for the Model procedure');
 const owners=model.procedures.filter(p=>p.id===procedure);assert.equal(owners.length,1,'one accepted Model procedure');
 assert.equal(owners[0].symbol_id||owners[0].rawFlowNodeId,matches[0].id);return{procedure,endpoint:matches[0].id};
}
function distinctRequest(baseline=false,raw=graph(true)){const binding=acceptedBinding(raw,'fixture::normalize');return request(baseline,raw,binding.procedure,binding.endpoint);}
function captureBinding(raw){
 const model=Model.build(raw),rows=model.procedures.filter(p=>p.display_path==='test_candidate_fixture::normalize');
 assert.equal(rows.length,1,'one accepted original captured normalize procedure');return acceptedBinding(raw,rows[0].id);
}
function captureTarget(raw){return captureBinding(raw).procedure;}
function captureRequest(raw,baseline=false){const binding=captureBinding(raw);return request(baseline,raw,binding.procedure,binding.endpoint);}
module.exports={clone,sourceRoot,sourceHash,graph,sourceVariants,request,distinctRequest,acceptedBinding,captureTarget,captureRequest};
