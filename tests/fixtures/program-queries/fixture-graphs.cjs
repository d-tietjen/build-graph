/* Generic declared user input -> cross-package relay -> decode; compile-shaped facts only. */
'use strict';
const G = require('../guard-obligations/fixture-graphs.cjs');
const {fn,block:b,call,op,place:p,assign:a,use,branch,captured,constant:c} = G;
function fixture(nearMiss=false) {
  const raw=captured(fn('app::investigate',2,[call('bb0','bridge::relay',[op(1)],p(3),'bb1'),
    call('bb1','policy::check',[op(3)],p(4),'bb2'),branch('bb2',4,'bb3','bb4'),
    call('bb3','app::decode',[op(nearMiss?2:3)],p(0),'bb4'),b('bb4')]),
    fn('bridge::relay',1,[call('bb0','dependency::relay',[op(1)],p(0),'bb1'),b('bb1')]),
    fn('dependency::relay',1,[b('bb0',[a(p(0),use(op(1)))])]),
    fn('policy::check',1,[b('bb0',[a(p(0),use(c()))])]),
    fn('app::decode',1,[b('bb0',[a(p(0),use(op(1)))])]),
    fn('other::decode',1,[b('bb0',[a(p(0),use(c()))])]));
  for(const n of raw.nodes){n.id='graph:'+n.id;n.attributes.unit_key='unit:'+n.attributes.package_id;n.attributes.source_digest='0123456789abcdef';n.attributes.display_path=n.attributes.path.split('::').at(-1);}
  return raw;
}
function valueQuery(){return {op:'valueFlow',function:'app::investigate',model:{version:1,sources:[{id:'declared-user-input',at:{procedure:'app::investigate',port:'parameter',index:0}}],sinks:[{id:'declared-decoder',at:{call:'app::investigate#bb3@call',port:'argument',index:0}}],summaries:[]}};}
function guardQuery(){return {op:'guardObligations',function:'app::investigate',model:{version:1,rules:[{id:'declared-review-condition',operation:{call:'app::investigate#bb3@call',bindings:{value:{index:0}}},requires:[{id:'successful-check',at:{call:'app::investigate#bb1@call',bindings:{value:{index:0}}},success:true}]}],summaries:[]}};}
function plan(value=valueQuery(),guard=guardQuery()){
  return {op:'programQuery',version:1,steps:[
    {name:'values',op:'analyze',query:value},{name:'guards',op:'analyze',query:guard},
    {name:'sinks',op:'filter',from:'values',where:[{field:'stepKind',test:'eq',value:'sink'}]},
    {name:'operations',op:'filter',from:'guards',where:[{field:'stepKind',test:'eq',value:'sensitive-operation'}]},
    {name:'combined',op:'join',left:'sinks',right:'operations',on:{left:'callsiteId',right:'callsiteId'}},
    {name:'summary',op:'project',from:'combined',fields:{call:'left.callsiteId',input:'left.sourceId',guard:'right.witness.classification',source:'left.source',identity:'left.identity'}},
    {name:'evidence',op:'slice',from:'combined',direction:'backward',relations:['valueEvidence','guardEvidence'],depth:64}
  ],return:['summary','evidence']};
}
function terminalFixture(){return captured(fn('terminals',0,[b('bb0',[],'opaque',[G.edge('bb1'),
  {target:null,kind:'normal',action:'continue'},{target:null,kind:'unwind',action:'continue'},
  {target:null,kind:'unwind',action:'terminate'},{target:null,kind:'unwind',action:'unreachable'}]),b('bb1')]));}
function controlPlan(procedure='terminals',block='bb0',depth=1){return {op:'programQuery',version:1,steps:[
  {name:'entry',op:'select',kind:'block',procedures:[procedure],where:[{field:'blockId',test:'eq',value:block}]},
  {name:'control',op:'slice',from:'entry',relations:['control'],depth}],return:['control']};}
function nearLimitPlan(literal='x'.repeat(65300)){return {op:'programQuery',version:1,steps:[
  {name:'empty',op:'select',kind:'function',procedures:['app::investigate'],where:[{field:'id',test:'eq',value:literal}]}],return:['empty']};}
function replayFixture(){const raw=fixture();raw.nodes[0].attributes.capture_provenance_v1=JSON.stringify({tree:'fixture-build-context:'+ 'x'.repeat(70000)});return raw;}
function projectionFixture(){
 const raw=captured(fn('indexed',3,[b('bb0',[
   a(p(1),use(c())),a(p(4),use(op(1))),a(p(1),use(c())),a(p(5),use(op(1))),
   a(p(6,0),use(op(2))),a(p(0),use(op(6,0)))])]));
 G.update(raw,'indexed',f=>{const s=f.value_facts.blocks[0].statements;
   s[0].destination.projection=[{kind:'unsupported',reason:'index projection',offset:0,min_length:2,from_end:false}];
   s[1].value.operands[0].place.projection=[{kind:'unsupported',reason:'index projection',offset:1,min_length:2,from_end:false}];
   s[2].destination.projection=[{kind:'unsupported',reason:'dynamic index',local:2}];
   s[3].value.operands[0].place.projection=[{kind:'unsupported',reason:'dynamic index',local:3}];
 });return raw;
}
module.exports={fixture,valueQuery,guardQuery,plan,G,terminalFixture,controlPlan,nearLimitPlan,replayFixture,projectionFixture};
