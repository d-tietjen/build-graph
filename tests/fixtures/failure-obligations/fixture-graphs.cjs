/* Test declarations, never production name-based policy. */
'use strict';
const assert = require('node:assert/strict');
const F = require('../guard-obligations/fixture-graphs.cjs');
const { fn, captured, call, block: b, edge, op, place: p, assign: a, use, constant: c, aggregate, branch, update } = F;
const terminal = states => Object.fromEntries(['normal','error','unwind','cancel','drop'].map(o => [o, states.slice()]));
const subject = (index = 0, fields = []) => ({ port: 'argument', index, fields });
const transition = (id, block, from, to, selected = subject(), caller = 'root', outcome = 'normal') => ({ id, call: caller + '#' + block + '@call', outcome, subject: selected, from, to });
const protocol = (transitions, kind = 'resource') => kind === 'resource' ? { id: 'resource', states: ['idle','held'], initial: 'idle', terminal: terminal(['idle']), transitions } :
  { id: 'transaction', states: ['idle','begun','dirty','done','rolled'], initial: 'idle', terminal: { ...terminal(['idle','done','rolled']), error: ['idle','rolled'], unwind: ['idle','rolled'] }, transitions };
const query = (rule, outcomes = [], summaries = []) => ({ op: 'failureObligations', function: 'root', model: { version: 1, provenance: 'controlled fixture protocol v1', rules: [rule], outcomes, summaries } });
const helper = (id, kind = 'return') => fn(id, 1, [b('bb0', [a(p(0), use(op(1)))], kind)]);
const result = (blocks, q, extra = [], params = 2) => ({ raw: captured(fn('root', params, blocks), helper('acquire'), helper('release'), ...extra), request: q });
function resource(kind = 'missing') {
  let blocks = [call('bb0','acquire',[op(1)],p(3),'bb1'), b('bb1')], outcomes = [];
  const ts = [transition('acquire','bb0',['idle'],'held')];
  if (kind === 'cancel-clean' || kind === 'drop-clean' || kind === 'clean' || kind === 'copy' || kind === 'move' || kind === 'field' || kind === 'wrong-parameter' || kind === 'overwrite') {
    let statements = [], selected = op(3);
    if (kind === 'copy') { statements = [a(p(4), use(op(3)))]; selected = op(4); }
    if (kind === 'move') { statements = [a(p(4), use({ ...op(3), kind: 'move' }))]; selected = op(4); }
    if (kind === 'field') { statements = [a(p(4), aggregate(op(3), op(2)))]; selected = op(4,0); }
    if (kind === 'wrong-parameter') selected = op(2);
    if (kind === 'overwrite') { statements = [a(p(3), use(c()))]; selected = op(3); }
    blocks[1] = call('bb1','release',[selected],p(0),'bb2',statements); blocks.push(b('bb2'));
    ts.push(transition('release','bb1',['held'],'idle'));
  }
  if (kind === 'cancel-clean' || kind === 'drop-clean') {
    const outcome=kind.split('-')[0];blocks[2]=b('bb2',[],outcome==='cancel'?'yield':'drop');outcomes.push({id:'declared-clean-'+outcome,node:'root#bb2',outcome});
  }
  if (kind === 'early-error') outcomes.push({ id: 'handled-failure', node: 'root#bb1', outcome: 'error' });
  if (['cancel','drop','yield','opaque','external'].includes(kind)) {
    blocks[1] = b('bb1', [], kind === 'cancel' ? 'yield' : kind === 'external' ? 'call' : kind);
    if (['cancel','drop'].includes(kind)) outcomes.push({ id: 'declared-' + kind, node: 'root#bb1', outcome: kind });
    if (kind === 'external') blocks[1] = call('bb1','unavailable_operation',[op(3)],p(0),'bb2',[],{ native_call: { symbol: 'unavailable_operation' } }), blocks.push(b('bb2'));
  }
  return result(blocks, query(protocol(ts), outcomes));
}
function transaction(clean = false) {
  const blocks = [call('bb0','begin',[op(1)],p(3),'bb1'), call('bb1','update',[op(3)],p(4),'bb2'),
    branch('bb2',2,'bb3','bb4'), call('bb3','commit',[op(4)],p(0),'bb5'),
    ...(clean ? [call('bb4','rollback',[op(4)],p(0),'bb5')] : [b('bb4',[], 'goto',[edge('bb5')])]), b('bb5')];
  const ts = [transition('begin','bb0',['idle'],'begun'),transition('update','bb1',['begun'],'dirty'),transition('commit','bb3',['dirty'],'done')];
  if (clean) ts.push(transition('rollback','bb4',['dirty'],'rolled'));
  return result(blocks, query(protocol(ts,'transaction'),[{ id:'failure-edge',node:'root#bb4',outcome:'error' }]), ['begin','update','commit','rollback'].map(id=>helper(id)));
}
function retry(idempotent = false, loop = false, once = false) {
  const blocks = [call('bb0','apply',[op(1)],p(3),'bb1'), ...(once ? [b('bb1')] : [call('bb1','apply',[op(3)],p(4),loop?'bb1':'bb2'), ...(!loop?[b('bb2')]:[])])];
  const ts = [transition('first','bb0',['idle'],'applied')];
  if (!once) ts.push(transition('retry','bb1',idempotent?['idle','applied']:['idle'],'applied'));
  return result(blocks, query({ id:'once',states:['idle','applied'],initial:'idle',terminal:terminal(['applied']),transitions:ts }),[helper('apply')]);
}
function unwind(clean = true, handled = false) {
  const blocks = [call('bb0','acquire',[op(1)],p(3),'bb1'),
    call('bb1','risky',[op(2)],p(4),'bb2',[],{successors:[edge('bb2'),{kind:'unwind',target:'bb3',label:'cleanup'}]}),
    call('bb2','release',[op(3)],p(0),'bb4'),
    ...(clean ? [call('bb3','release',[op(3)],p(0),'bb5')] : [b('bb3',[], 'goto',[edge('bb5')])]),b('bb4'),b('bb5',[],handled?'return':'unwind')];
  const risky=fn('risky',1,[branch('bb0',1,'bb1','bb2'),b('bb1',[a(p(0),use(op(1)))]),b('bb2',[],'unwind')]);
  const ts=[transition('acquire','bb0',['idle'],'held'),transition('release-normal','bb2',['held'],'idle')];
  if(clean)ts.push(transition('release-cleanup','bb3',['held'],'idle'));
  return result(blocks,query(protocol(ts),handled?[{id:'caught',node:'root#bb3',outcome:'error'}]:[]),[risky]);
}
function freshWrong(clean = false) {
  const blocks=[call('bb0','factory',[],p(1),'bb1'),call('bb1','acquire',[op(1)],p(3),'bb2'),call('bb2','factory',[],p(2),'bb3'),call('bb3','release',[op(clean?3:2)],p(0),'bb4'),b('bb4')];
  return result(blocks,query(protocol([transition('acquire','bb1',['idle'],'held'),transition('release','bb3',['held'],'idle')]),[],['bb0','bb2'].map((block,i)=>({id:'fresh-'+i,version:1,call:'root#'+block+'@call',outcomes:['normal'],returns:'fresh',effects:'declared-protocol-only'}))),[fn('factory',0,[b('bb0',[a(p(0),use(c()))])])],0);
}
function freshAggregate(nested = false, write = true) {
  const field = nested ? [0,0] : [0];
  const factory = fn('factory',0,[b('bb0',nested ? [a(p(1),aggregate(c(),c())),a(p(0),aggregate(op(1),c()))] : [a(p(0),aggregate(c(),c()))])]);
  const blocks = [call('bb0','factory',[],p(1),'bb1'),call('bb1','acquire',[op(1)],p(3),'bb2'),
    call('bb2','release',[op(4)],p(0),'bb3',[a(p(4),use(op(3))),...(write?[a(p(4,...field),use(op(4,...field)))]:[])]),b('bb3')];
  const item = result(blocks,query(protocol([transition('acquire','bb1',['idle'],'held'),transition('release','bb2',['held'],'idle')]),[],
    [{id:'fresh-tuple',version:1,call:'root#bb0@call',outcomes:['normal'],returns:'fresh',effects:'declared-protocol-only'}]),[factory],0);
  // Match every tuple/local/place/projection descriptor to its explicit layout.
  const type = shape => shape.kind === 'fields' ? '(' + shape.fields.map(type).join(',') + ')' : 'u64';
  for (const node of item.raw.nodes) {
    const flow = JSON.parse(node.attributes.flow), locals = flow.value_facts.locals;
    locals.forEach(local=>{local.type=type(local.shape);});
    function typed(place) { if(!place)return;place.type=type(place.shape);place.projection.forEach(part=>{part.type=type(part.shape);}); }
    for(const block of flow.value_facts.blocks){
      for(const statement of block.statements){typed(statement.destination);for(const operand of statement.value&&statement.value.operands||[])typed(operand.place);}
      if(block.call){typed(block.call.destination);for(const operand of [block.call.function,...block.call.arguments])typed(operand.place);}
    }
    node.attributes.flow=JSON.stringify(flow);
  }
  return item;
}
function metadataCases() {
  const cases = [{value:{},name:'object'},{value:'release',name:'string'},{value:['release',7],name:'member'}].map(({value,name})=>{
    const item=resource('clean');update(item.raw,'root',f=>{f.blocks.find(b=>b.id==='bb1').callee_targets=value;});
    return{name:'malformed-targets-'+name,...item,violation:false,partial:true,gap:'malformed-execution-record'};
  });
  const disjoint=resource('clean'), extra=captured(fn('disjoint',1,[call('bb0','release',[op(1)],p(0),'bb1',[],{callee_targets:{}}),b('bb1')]));
  disjoint.raw.nodes.push(...extra.nodes);cases.push({name:'disjoint-malformed-targets',...disjoint,violation:false,partial:false});
  for(const [name,fields]of [['nullable-targets',{callee_targets:null,native_target_ids:null,callback_args:null}],['empty-targets',{callee_targets:[],native_target_ids:[],callback_args:[]}],['valid-target-list',{callee_targets:['release']}],
    ['strict-null-callback',{callback_unknown:null}],['uncertain-callback',{callback_unknown:true}],['callback-parameter',{callback_parameter:0}]]){
    const item=resource('clean');update(item.raw,'root',f=>{Object.assign(f.blocks.find(b=>b.id==='bb1'),fields);});
    cases.push({name,...item,violation:false,partial:name.includes('callback')});
  }
  for(const [name,row,partial,gap]of [
    ['omitted',{index:0,parameter:null},false],
    ['false',{index:0,parameter:null,targets:null,unknown:false},false],
    ['empty-targets',{index:0,parameter:null,targets:[],unknown:false},false],
    ['true',{index:0,parameter:null,targets:[],unknown:true},true,'unknown-callback-binding'],
    ...[['null',null],['number',0],['string','false']].map(([name,unknown])=>[name,{index:0,parameter:null,targets:[],unknown},true,'malformed-execution-record'])
  ]){
    const item=resource('clean');update(item.raw,'root',f=>{f.blocks.find(b=>b.id==='bb1').callback_args=[row];});
    cases.push({name:'callback-row-'+name,...item,violation:false,partial,gap});
  }
  const external=resource('external');external.request.model.summaries=[{id:'declared-external',version:1,call:'root#bb1@call',outcomes:['normal'],returns:'unknown',effects:'declared-protocol-only'}];
  cases.push({name:'modelled-external',...external,violation:true,partial:false});
  return cases;
}
function longMetadata(size = 8192) {
  const item=resource('clean'), node=item.raw.nodes.find(n=>n.id==='flow:root');
  update(item.raw,'root',flow=>{
    for(const block of [...flow.blocks,...flow.value_facts.blocks]){
      block.source_file='root.rs';for(const statement of block.statements||[])statement.source_file='root.rs';
      if(block.call)block.call.source_file='root.rs';
    }
  });
  const previous=node.id;node.id='owner:'+ 'x'.repeat(size);node.source_file='root.rs';
  Object.assign(node.attributes,{unit_key:'unit:'+'u'.repeat(size),source_absolute:'/fixture/'+'s'.repeat(size)+'/root.rs',target_src_path:'/fixture/'+'s'.repeat(size)+'/root.rs'});
  for(const edge of item.raw.edges){if(edge.source===previous)edge.source=node.id;if(edge.target===previous)edge.target=node.id;}
  return item;
}
function crossCall() {
  const blocks=[call('bb0','acquire',[op(1)],p(3),'bb1'),call('bb1','forward',[op(3)],p(0),'bb2'),b('bb2')];
  const forward=fn('forward',1,[call('bb0','release',[op(1)],p(0),'bb1'),b('bb1')]);
  return result(blocks,query(protocol([transition('acquire','bb0',['idle'],'held'),transition('release-forward','bb0',['held'],'idle',subject(),'forward')])),[forward]);
}
function cases() { return [
  ...['missing','early-error','clean','copy','move','field','wrong-parameter','overwrite','cancel','drop','cancel-clean','drop-clean','yield','opaque','external'].map(name=>({name,...resource(name),violation:['missing','early-error','cancel','drop'].includes(name),partial:['wrong-parameter','overwrite','yield','opaque','external'].includes(name)})),
  ...[false,true].map(clean=>({name:'rollback-'+clean,...transaction(clean),violation:!clean,partial:false})),
  ...[false,true].flatMap(idempotent=>[false,true].map(loop=>({name:'retry-'+idempotent+'-'+loop,...retry(idempotent,loop),violation:!idempotent,partial:loop}))),
  {name:'once',...retry(false,false,true),violation:false,partial:false},
  ...[false,true].flatMap(clean=>[false,true].map(handled=>({name:'unwind-'+clean+'-'+handled,...unwind(clean,handled),violation:!clean,partial:false}))),
  ...[false,true].map(clean=>({name:'fresh-object-'+clean,...freshWrong(clean),violation:!clean,partial:false})),
  ...[false,true].flatMap(nested=>[false,true].map(write=>({name:'fresh-aggregate-'+nested+'-'+write,...freshAggregate(nested,write),violation:false,partial:write,gap:write?'unproven-subject-alias':null}))),
  ...metadataCases(),
  {name:'cross-call',...crossCall(),violation:false,partial:false}
]; }
// Capture-only helpers resolve known declarations to exact IDs for the test model.
function captureRows(raw) { return raw.nodes.filter(n=>(n.attributes||{}).kind==='flow_function').map(n=>({n,f:JSON.parse(n.attributes.flow)})); }
function declaration(raw,name) { const rows=captureRows(raw).filter(({n,f})=>(n.attributes.display_path||f.function)==='failure_obligations_fixture::'+name);assert.equal(rows.length,1,name);return rows[0]; }
function sites(raw,caller,name) { const target=declaration(raw,name).f.function;return caller.blocks.filter(b=>b.callee===target||Array.isArray(b.callee_targets)&&b.callee_targets.includes(target)); }
function captureRequest(raw,name) {
  let root=declaration(raw,name==='retry_idempotent'?'retry_duplicate':name).f;
  if(name==='suspend_cleanup') {
    const rows=captureRows(raw).filter(({n,f})=>(n.attributes.display_path||f.function)==='failure_obligations_fixture::suspend_cleanup::{closure#0}');assert.equal(rows.length,1,'captured async closure');root=rows[0].f;
  }
  const ts=[];
  const add=(callee,from,to,caller=root)=>sites(raw,caller,callee).forEach((b,i)=>ts.push(transition(callee+'-'+(caller===root?'':caller.function+'-')+i,b.id,from,to,subject(),caller.function)));
  let rule;
  if(name.startsWith('retry_')||name==='loop_retry') { add('apply',name==='retry_idempotent'?['idle','applied']:['idle'],'applied');rule={id:'once',states:['idle','applied'],initial:'idle',terminal:terminal(['applied']),transitions:ts}; }
  else if(['partial_update','proper_rollback'].includes(name)) { add('begin',['idle'],'begun');add('update',['begun'],'dirty');add('commit',['dirty'],'done');add('rollback',['dirty'],'rolled');rule=protocol(ts,'transaction'); }
  else {
    // The pinned compiler emits an opaque async body, so its policy is declared
    // on real captured resource callsites; the query root remains that body.
    const callers=name==='suspend_cleanup'?captureRows(raw).map(({f})=>f):[root];
    for(const caller of callers){add('acquire',['idle'],'held',caller);add('release',['held'],'idle',caller);}
    rule=protocol(ts);
  }
  if(name==='cross_call_cleanup') {
    const forward=declaration(raw,'cleanup_forward').f;
    sites(raw,forward,'release').forEach((b,i)=>ts.push(transition('forward-release-'+i,b.id,['held'],'idle',subject(),forward.function)));
  }
  const q=query(rule);q.function=root.function;
  // Both result paths are explicit source returns; no Result/Err name inference.
  if(['early_error','proper_cleanup','partial_update','proper_rollback'].includes(name)) {
    const commits=sites(raw,root,'commit');
    q.model.outcomes=commits.map((b,i)=>({id:'normal-commit-'+i,node:root.function+'#'+b.id,outcome:'normal'}));
    const branches=root.guard_facts.branches.filter(b=>b.kind==='boolean');assert.equal(branches.length,1,name+' boolean');
    const failure=branches[0].targets.find(t=>t.value===true);assert(failure);
    q.model.outcomes.push({id:'declared-error',node:root.function+'#'+failure.target,outcome:'error'});
  }
  return q;
}
const captureCases=[['early_error',true],['proper_cleanup',false],['partial_update',true],['proper_rollback',false],['retry_duplicate',true],['retry_idempotent',false],['retry_once',false],['loop_retry',true],['copied_cleanup',false],['cross_call_cleanup',false],['field_cleanup',false],['unwind_cleanup',false],['suspend_cleanup',false],['unavailable_external',false]];
module.exports={...F,terminal,subject,transition,protocol,query,helper,resource,transaction,retry,unwind,freshWrong,freshAggregate,metadataCases,longMetadata,crossCall,cases,captureRows,declaration,captureRequest,captureCases};
