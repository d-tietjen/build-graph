'use strict';
const assert=require('node:assert/strict');
const E=require('../entry-effects/fixture-graphs.cjs'),G=require('../guard-obligations/fixture-graphs.cjs'),F=require('../failure-obligations/fixture-graphs.cjs'),R=require('../resource-risks/fixture-graphs.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function provenance(raw,revision='baseline'){
 for(const n of raw.nodes){const a=n.attributes||{};Object.assign(a,{target_triple:'fixture-target',features:'[]',rustc_version:'fixture-rustc-v1',source_revision:revision});
  if(a.kind==='flow_function'||a.kind==='function')Object.assign(a,{unit_key:'fixture-unit:'+a.package_id,capture_scope:a.capture_scope||'workspace',target_name:'fixture',target_kind:'["lib"]',original_symbol_id:'original:'+a.path});
 }
 return raw;
}
function basic(candidate=false){const attributes={function_id:'compiler:main',unit_key:'unit:app',original_symbol_id:'mangled:main'};
 const raw={nodes:[{id:'crate-app',attributes:{kind:'crate',crate:'app',package_id:'app',version:'0.1.0',workspace_member:'true',supply_chain_dependencies:JSON.stringify([{package_id:candidate?'dep@2':'dep@1',kind:'normal',name:'dependency'}])}},
 {id:'crate-dep',attributes:{kind:'crate',crate:'dependency',package_id:candidate?'dep@2':'dep@1',version:candidate?'2.0.0':'1.0.0',package_source:'registry+https://github.com/rust-lang/crates.io-index',workspace_member:'false'}},
 ...E.callable('app::entry','app',candidate?[E.standard('std::fs::write')]:[],attributes),
 ...(candidate?E.callable('app::new_entry','app',[],{function_id:'compiler:new'}):[])],edges:[]};return provenance(raw,candidate?'candidate':'baseline');}
function declared(raw,revision,queries=[]){return{graph:raw,declaration:{revision:{value:revision,provenance:'explicit fixture label, not captured Git proof'}},queries};}
function withPackageCarrier(raw,procedure){
 const rows=captureRows(raw).filter(({f})=>f.function===procedure);assert.equal(rows.length,1,'exact procedure owns the fixture package carrier');
 const a=rows[0].n.attributes;assert.equal(typeof a.package_id,'string');
 if(!raw.nodes.some(n=>n.attributes.kind==='crate'&&n.attributes.package_id===a.package_id))raw.nodes.unshift({id:'package-carrier:'+a.package_id,attributes:{kind:'crate',crate:a.package_id,package_id:a.package_id,version:'0.1.0',workspace_member:'true',target_triple:a.target_triple,features:a.features,rustc_version:a.rustc_version,source_revision:a.source_revision}});
 return raw;
}
// The scoped fixture includes a compiler-identified external call, but no captured
// definition for its boundary. Equal selector strings cannot establish ownership.
function scopedUnownedEffectChanges(before,after){
 function rows(side){
  const op=side.evidence.operations.find(o=>o.key==='$effects');assert.equal(op.complete,false);
  const effects=clone(op.result.effects.items).filter(r=>r.bodyStatus==='unavailable');
  for(const row of effects)assert(!side.evidence.definitions.some(d=>d.nodeId===row.nodeId||d.procedure===row.nodeId),'external owner has no captured definition');
  assert.deepEqual(effects.map(r=>({category:r.category,operation:r.operation,callsites:r.callsites,source:r.source})),[
   {category:'unknown',operation:'additional-effects-unavailable',callsites:[{id:'app::effect#bb0@call',source:{source_file:'fixture.rs',source_location:4}}],source:{source_file:null,source_location:null,absolute_file:null}},
   {category:'filesystem',operation:'write',callsites:[{id:'app::effect#bb0@call',source:{source_file:'fixture.rs',source_location:4}}],source:{source_file:null,source_location:null,absolute_file:null}}
  ]);
  return effects;
 }
 const props={kind:'sensitive-effect',mapping:null,comparison:'incomplete',classification:'modeled',securityRegressionProven:false,resolvedFindingProven:false};
 return rows(before).map(row=>({...props,status:'candidate-unavailable',before:row,after:null})).concat(rows(after).map(row=>({...props,status:'baseline-unavailable',before:null,after:row})));
}
function semantic(kind){let before,after;
 if(kind==='guard'){before=G.scenario('early-return');after=G.scenario('fail-open');}
 if(kind==='failure'){before=F.resource('clean');after=F.resource('missing');}
 if(kind==='resource'){before=R.suspension(true);after=R.suspension(false);}
 provenance(before.raw);provenance(after.raw,'candidate');return{before:declared(before.raw,'before',[{key:kind,request:before.request}]),after:declared(after.raw,'after',[{key:kind,request:after.request}]),mappings:[{before:'root',after:'root',certainty:'declared',provenance:'Fixture constructor explicitly preserves this original occurrence'}]};
}
function rename(raw,from,to){
 const copy=clone(raw);
 for(const n of copy.nodes){if(n.id===from)n.id=to;const a=n.attributes||{};if(a.symbol_id===from)a.symbol_id=to;if(a.path===from)a.path=to;
  if(a.flow){const body=JSON.parse(a.flow);if(body.function===from)body.function=to;for(const b of body.blocks||[])if(b.callee===from)b.callee=to;a.flow=JSON.stringify(body);}}
 for(const e of copy.edges){if(e.source===from)e.source=to;if(e.target===from)e.target=to;}return copy;
}
function separateProcedures(raw){
 const copy=clone(raw),ids=new Map(copy.nodes.filter(n=>n.attributes.kind==='flow_function').map(n=>[JSON.parse(n.attributes.flow).function,'procedure:'+JSON.parse(n.attributes.flow).function]));
 for(const n of copy.nodes)if(n.attributes.flow){const body=JSON.parse(n.attributes.flow);body.function=ids.get(body.function);for(const b of body.blocks||[]){if(ids.has(b.callee))b.callee=ids.get(b.callee);if(b.callee_targets)b.callee_targets=b.callee_targets.map(id=>ids.get(id)||id);}n.attributes.flow=JSON.stringify(body);}
 return copy;
}
function scoped(){
 const raw={nodes:[...basic().nodes.filter(n=>n.attributes.kind==='crate'),{id:'bridge-package',attributes:{kind:'crate',crate:'bridge',package_id:'bridge',workspace_member:'true'}},
  ...E.callable('app::main','app',['bridge::middle'],{function_id:'main'}),...E.callable('bridge::middle','bridge',['app::effect'],{function_id:'middle'}),
  ...E.callable('app::effect','app',[E.standard('std::fs::write')],{function_id:'effect'}),...E.callable('app::build::main','app',['app::effect'],{function_id:'builder'})],edges:[]};
 provenance(raw,'same-source');
 for(const n of raw.nodes){const a=n.attributes;if(a.path==='app::main')Object.assign(a,{target_kind:'["bin"]',rustdoc_root_function:'true'});if(a.path==='app::build::main')Object.assign(a,{target_kind:'["custom-build"]',target_name:'builder',capture_scope:'build_dependency',rustdoc_root_function:'true'});}
 return raw;
}
function large(){const raw=basic();for(let i=0;i<2200;i++)raw.nodes.push({id:'unrelated:'+i,attributes:{kind:'file',package_id:'elsewhere'}});for(let i=0;i<5100;i++)raw.edges.push({source:'unrelated:'+(i%2200),target:'unrelated:'+((i+1)%2200),relation:'contains'});return raw;}
function captureRows(raw){return raw.nodes.filter(n=>(n.attributes||{}).kind==='flow_function').map(n=>({n,f:JSON.parse(n.attributes.flow)}));}
function captureFunction(raw,name){const rows=captureRows(raw).filter(({n})=>n.attributes.display_path==='revision_comparison_fixture::'+name);assert.equal(rows.length,1,name+' captured original procedure');return rows[0];}
function captureQueries(raw,candidate=false){
 const root=captureFunction(raw,'guarded').f,check=captureFunction(raw,'check').f,effect=captureFunction(raw,'effect').f;
 const site=(flow,target)=>{const rows=flow.blocks.filter(b=>b.callee===target||Array.isArray(b.callee_targets)&&b.callee_targets.includes(target));assert.equal(rows.length,1,'exact paired callsite');return flow.function+'#'+rows[0].id+'@call';};
 const guard={op:'guardObligations',function:root.function,model:{version:1,rules:[{id:'declared-value-check',operation:{call:site(root,effect.function),bindings:{value:{index:0}}},requires:[{id:'successful-value-check',at:{call:site(root,check.function),bindings:{value:{index:0}}},success:true}]}],summaries:[]}};
 const cleanup=captureFunction(raw,'cleanup').f,acquire=captureFunction(raw,'acquire').f,release=captureFunction(raw,'release').f;
 const terminal=Object.fromEntries(['normal','error','unwind','cancel','drop'].map(o=>[o,['idle']]));
 const transitions=[{id:'acquire',call:site(cleanup,acquire.function),outcome:'normal',subject:{port:'argument',index:0,fields:[]},from:['idle'],to:'held'}];
 if(!candidate)transitions.push({id:'release',call:site(cleanup,release.function),outcome:'normal',subject:{port:'argument',index:0,fields:[]},from:['held'],to:'idle'});
 const failure={op:'failureObligations',function:cleanup.function,model:{version:1,provenance:'Controlled capture protocol, not name-inferred',rules:[{id:'handle',states:['idle','held'],initial:'idle',terminal,transitions}],outcomes:[],summaries:[]}};
 const resource={op:'resourceRisks',function:root.function,actors:[],model:{version:1,provenance:'Controlled scalar allocation model, no measured cost',sources:[{id:'size',at:{procedure:root.function,port:'parameter',index:0,fields:[]}}],operations:[{id:'work',version:1,kind:'allocation',call:site(root,effect.function),outcome:'normal',subject:{port:'argument',index:0,fields:[]},cost:{perUnit:1,unit:'bytes'}}],guardBounds:candidate?[]:[{id:'limit',version:1,call:site(root,check.function),subject:{port:'argument',index:0,fields:[]},success:true,maximum:64}],loopBounds:[],summaries:[]}};
 return[{key:'guard',request:guard},{key:'failure',request:failure},{key:'resource',request:resource}];
}
function captureMappings(before,after){return['guarded','cleanup','write_entry'].map(name=>({before:captureFunction(before,name).f.function,after:captureFunction(after,name).f.function,certainty:'declared',provenance:'Owned paired fixture source declares continuity of '+name+'; compiler IDs are not assumed stable across builds'}));}
module.exports={clone,provenance,basic,declared,withPackageCarrier,scopedUnownedEffectChanges,semantic,large,captureRows,captureFunction,captureQueries,captureMappings,rename,separateProcedures,scoped};
