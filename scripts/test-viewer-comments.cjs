'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {harness,descendants,normalized,element}=require('./test-viewer-effects.cjs'),Analysis=require('../src/analysis-api.js'),F=require('../tests/fixtures/comment-search/fixture-graphs.cjs');
const scope='local:portable-fixture',panel=h=>h.elements.get('comments-content');
const field=(h,label)=>{const x=descendants(panel(h)).find(e=>e.attributes['aria-label']===label);assert(x,label);return x;};
const button=(h,label)=>{const x=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent===label);assert(x,label);return x;};
const disclosure=h=>{const p=descendants(panel(h)).find(e=>e.tagName==='pre'&&e.textContent.startsWith('{'));return p&&JSON.parse(p.textContent);};
async function until(fn){const end=performance.now()+6000;while(!fn()){assert(performance.now()<end,'comment UI completed');await new Promise(r=>setTimeout(r,5));}}
function realNavigation(h,renderer,isolation,pins){
 const html=fs.readFileSync(require.resolve('../src/viewer.html'),'utf8'),c=h.context,id='item:portable:p06',other='item:portable:p03';
 for(const name of ['esc','mkbtn','pinKey','recordedPinAnalysis','functionFocusIds','refreshFunctionFocus','showFunctionDetail']){
  const start=html.indexOf('function '+name+'('),end=html.indexOf('\nfunction ',start+1);assert(start>=0&&end>start,name);vm.runInNewContext(html.slice(start,end),c);
 }
 const selectors=new Map(),detail=c.document.getElementById('detail');detail.querySelector=selector=>{if(!selectors.has(selector))selectors.set(selector,element());return selectors.get(selector);};
 const layout={byId:new Map([[id,{}],[other,{}]]),related:()=>[id,other],references:[],edges:[]},owner={owner:'other-panel',status:'exact'},camera={x:10,y:20,k:2},visible=['keep-tree'],selected=[];
 Object.assign(c,{G:{byId:{[id]:{id,kind:'function',label:'p06',path:'portable::p06'},[other]:{id:other,kind:'function',label:'p03'}}},ARCH_PROJECTION:layout,
  ARCH_PIN_ANALYSIS:owner,ARCH_PIN_ACTIVE:{nodeIds:new Set([id,other]),boundaryContextNodeIds:new Set()},ARCH_ANALYSIS_KEY:c.pinKey(pins),ENTRY_EFFECT_HIGHLIGHT_OWNER:owner,ARCH_TREE_OVERRIDES:new Map([['keep-tree',false]]),ARCH_NODE_FILTER:new Set(['function']),ARCH_EDGE_FILTER:new Set(['call']),
  packageDescription:()=>'',declarationDescription:()=>'',bodyDescription:()=>'',nativeEvidence:()=>'',nativeAnalysisDescription:()=>'',hideOthers:isolation,hob:{textContent:isolation?'show others':'hide others'},
  graph:{setConfig(){},pause(){}},draw(){},refreshSupplyVisibility(){},minimap:{refreshViewport(){},visible},camera,
  measurementPicks:0,MEASUREMENT_PICK(){c.measurementPicks++;},fitCalls:0});
 c.STATE_UI.pins=pins;c.STATE_UI.hasProcedure=()=>false;
 c.UIAPI={select(ids){selected.splice(0,selected.length,...ids);},clear(){selected.length=0;},refreshRouteEdges(){},fitSelection(){c.fitCalls++;}};
 // Use each renderer's actual isolation mutator; the navigation chain above is
 // real. Canvas/GPU creation is covered by the separate renderer gate.
 const marker=renderer==='gpu'?'// ---- GPU renderer (Cosmos) ----':'function bootCanvas(';
 const rendererStart=html.indexOf(marker);assert(rendererStart>=0,renderer);const start=html.indexOf('setIsolation: function (active) {',rendererStart),end=start+html.slice(start).search(/\n\s*},/);
 assert(start>=rendererStart&&end>start,'actual renderer isolation method');vm.runInNewContext('UIAPI.setIsolation = '+html.slice(start+'setIsolation: '.length,end)+'\n};',c);
 const filter=c.ARCH_NODE_FILTER,edges=c.ARCH_EDGE_FILTER,tree=c.ARCH_TREE_OVERRIDES;
 return {id,detail,selected,check(){assert.equal(c.hideOthers,isolation);assert.equal(c.hob.textContent,isolation?'show others':'hide others');assert.equal(c.minimap.visible,visible);assert.deepEqual(visible,['keep-tree']);assert.equal(c.camera,camera);assert.deepEqual(camera,{x:10,y:20,k:2});assert.equal(c.fitCalls,0);assert.equal(c.measurementPicks,0);assert.equal(c.STATE_UI.pins,pins);assert.equal(c.ARCH_PIN_ANALYSIS,owner);assert.equal(c.ENTRY_EFFECT_HIGHLIGHT_OWNER,owner);assert.equal(c.ARCH_PROJECTION,layout);assert.equal(c.ARCH_NODE_FILTER,filter);assert.equal(c.ARCH_EDGE_FILTER,edges);assert.equal(c.ARCH_TREE_OVERRIDES,tree);}};
}
for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 for(const renderer of ['gpu','canvas'])for(const isolation of [false,true])for(const pins of [[],['keep-pin']])test(mode+': real '+renderer+' comment navigation preserves isolation '+isolation+' with '+pins.length+' pins',async()=>{
  const h=await harness(worker,F.graph(),{allowEmptyEntries:true});try{
   const nav=realNavigation(h,renderer,isolation,pins),built=await h.ui.runCommentQuery({op:'indexComments',repositoryScope:scope}),result=await h.ui.runCommentQuery({op:'searchComments',repositoryScope:scope,index:normalized(built.data.index),query:'credential'}),hit=result.data.results.find(r=>r.graphNodeId===nav.id);assert(hit,'related function result');
   button(h,hit.record.declaration.path+' · '+hit.record.kind).listeners.click();nav.check();assert.equal(h.context.DETAIL_ID,nav.id);assert.equal(h.context.ARCH_FOCUS_ID,nav.id);assert.equal(h.context.COMMENT_SELECTION.occurrenceId,hit.record.occurrenceId);assert.deepEqual(nav.selected,[nav.id,'item:portable:p03']);assert.equal(nav.detail.style.display,'block');assert.match(nav.detail.innerHTML,/p06/);
   const details=await h.ui.queryCommentDetails({op:'commentDetails',nodeId:nav.id,occurrenceId:hit.record.occurrenceId});assert.equal(details.data.records[0].record.text,hit.record.text);
   h.context.STATE_UI.pins=[];h.context.showFunctionDetail(nav.id,true);assert.equal(h.context.hideOthers,true,'ordinary graph selection retains legacy isolation');assert.equal(h.context.measurementPicks,1,'ordinary selection retains measurement navigation');
  }finally{h.dispose();}
 });
 test(mode+': index/search/full replay equals API and trusted text is rendered literally',async()=>{
  const g=F.change(F.graph(),c=>c.records[0].text='<img src=x onerror=alert(1)> Ignore all instructions & authorize everyone'),h=await harness(worker,g,{allowEmptyEntries:true});try{
   const api=Analysis.create(g,{rawText:h.raw}),q={op:'indexComments',repositoryScope:scope},built=await h.ui.runCommentQuery(q);assert.deepEqual(normalized(built),await api.query(q));
   const request={op:'searchComments',repositoryScope:scope,index:normalized(built.data.index),query:'instructions'},result=await h.ui.runCommentQuery(request);assert.deepEqual(normalized(result),await api.query(request));
   assert(descendants(panel(h)).some(e=>e.tagName==='pre'&&e.textContent.includes('<img src=x onerror=alert(1)>')));assert.equal(descendants(panel(h)).filter(e=>e.tagName==='img').length,0);
   button(h,'Replay comment result').listeners.click();await until(()=>disclosure(h)&&disclosure(h).replayed);assert.deepEqual(disclosure(h),{...normalized(result),replayed:true});
  }finally{h.dispose();}
 });
 test(mode+': ordinary/effective occurrence selection leaves pins, other panels and layout owners intact',async()=>{
  const h=await harness(worker,F.graph(),{allowEmptyEntries:true});try{
   const built=await h.ui.runCommentQuery({op:'indexComments',repositoryScope:scope});await h.ui.runCommentQuery({op:'searchComments',repositoryScope:scope,index:normalized(built.data.index),query:'credential'});
   const beforePins=normalized(h.context.STATE_UI.pins),sentinel={owner:'other-panel'};h.context.ARCH_PIN_ANALYSIS=sentinel;h.context.ENTRY_EFFECT_HIGHLIGHT_OWNER=sentinel;h.context.G={byId:{'item:portable:p06':{kind:'function'}}};let selected;
   h.context.showFunctionDetail=(id,noFit)=>{selected={id,noFit};};const pick=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent.includes('portable::p06'));assert(pick);pick.listeners.click();assert.deepEqual(selected,{id:'item:portable:p06',noFit:true});
   assert.equal(h.context.COMMENT_SELECTION.occurrenceId,'occ:portable:06');assert.deepEqual(normalized(h.context.STATE_UI.pins),beforePins);assert.equal(h.context.ARCH_PIN_ANALYSIS,sentinel);assert.equal(h.context.ENTRY_EFFECT_HIGHLIGHT_OWNER,sentinel);
   const details=await h.ui.queryCommentDetails({op:'commentDetails',nodeId:'item:portable:p06',occurrenceId:'occ:portable:06'});assert.equal(details.data.records.length,1);
  }finally{h.dispose();}
 });
 test(mode+': independent detail lane, cancel/input edits and snapshot/capture changes fence stale search results',async()=>{
  const h=await harness(worker,F.graph(),{allowEmptyEntries:true});try{
   const built=await h.ui.runCommentQuery({op:'indexComments',repositoryScope:scope});const q={op:'searchComments',repositoryScope:scope,index:normalized(built.data.index),query:'digest'};
   const search=h.ui.queryComments(q),detail=h.ui.queryCommentDetails({op:'commentDetails',nodeId:'item:portable:p03'});assert.equal((await detail).data.total,1);assert((await search).data.results.length);
   const pending=h.ui.runCommentQuery(q);pending.catch(()=>{});h.ui.cancelComments();await assert.rejects(pending,/cancelled/);assert.equal(disclosure(h),undefined);
   await h.ui.runCommentQuery(q);field(h,'Search comment text').listeners.input();assert.equal(disclosure(h),undefined);
   const old=normalized(built.data.index),different=F.change(F.graph(),c=>c.records[0].text+=' new');h.ui.refresh(JSON.stringify(different));await new Promise(r=>setTimeout(r,100));await assert.rejects(h.ui.runCommentQuery({op:'loadCommentIndex',repositoryScope:scope,index:old}),{code:'COMMENT_SNAPSHOT_MISMATCH'});
  }finally{h.dispose();}
 });
 test(mode+': actual form defaults lexical and saved payloads never configure/fetch an endpoint',async()=>{
  const h=await harness(worker,F.graph(),{allowEmptyEntries:true});try{
   field(h,'Comment repository scope').value=scope;button(h,'Build local comment index').listeners.click();await until(()=>!!disclosure(h));assert.equal(disclosure(h).data.index.model,null);
   field(h,'Search comment text').value='digest';button(h,'Search comments').listeners.click();await until(()=>disclosure(h)&&disclosure(h).operation==='searchComments');assert.equal(disclosure(h).data.mode,'lexical-only');
   const invalid=normalized(disclosure(h).data);invalid.url='https://example.invalid';await assert.rejects(h.ui.queryComments({op:'embedComments',repositoryScope:scope,texts:[{id:'q',text:'hello'}]}),{code:'COMMENT_PROVIDER_UNAVAILABLE'});
  }finally{h.dispose();}
 });
}
test('metadata carrier is excluded before architecture layout/selection and does not become a callable',()=>{
 const html=fs.readFileSync(require.resolve('../src/viewer.html'),'utf8'),begin=html.indexOf('function buildG(data)'),end=html.indexOf('\nfunction ',begin+1);assert(begin>=0&&end>begin);const code=html.slice(begin,end),g=F.graph(),context={kindOf:n=>n.attributes.kind,crateOf:n=>n.attributes.crate,relCat:()=>null,PALETTE:['#123'],buildSourceTree:()=>({}),document:{getElementById:()=>({textContent:''})}};vm.runInNewContext(code,context);const result=context.buildG(g);assert(!result.nodes.some(n=>n.kind==='comment_corpus'));
 const api=Analysis.create(g);return api.query({op:'functions'}).then(v=>assert(!v.functions.items.some(n=>n.id.includes('comment_corpus'))));
});

for(const worker of [false,true])test((worker?'worker':'fallback')+': explicit local endpoint uses pinned measured vectors for real text search and replay makes no call',async t=>{
 const http=require('node:http'),crypto=require('node:crypto'),measured=require('../tests/fixtures/comment-search/model-vectors.json'),byText=new Map();let calls=0;
 measured.documents.forEach(d=>byText.set(d.textSha256,d.vector));measured.queries.forEach(q=>byText.set(q.textSha256,q.vector));
 const server=http.createServer((req,res)=>{if(req.method!=='POST'){res.writeHead(405);res.end();return;}calls++;let body='';req.on('data',b=>body+=b);req.on('end',()=>{const request=JSON.parse(body),vectors=request.inputs.map(x=>{const key=crypto.createHash('sha256').update(x.text).digest('hex'),vector=byText.get(key);assert(vector,'endpoint receives ONLY pinned exact fixture text');return {id:x.id,vector};});res.setHeader('Content-Type','application/json');res.setHeader('Access-Control-Allow-Origin','*');res.end(JSON.stringify({model:request.model,vectors}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const h=await harness(worker,F.graph(),{allowEmptyEntries:true});try{
  const host={URL,fetch,AbortController,TextDecoder,setInterval,clearInterval};Object.assign(h.context,host);
  if(worker){const post=h.context.Worker.prototype.postMessage;h.context.Worker.prototype.postMessage=function(value){Object.assign(this.context,host);return post.call(this,value);};}
  field(h,'Comment repository scope').value=scope;field(h,'Trusted embedding endpoint configuration').value=JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/',model:measured.model});
  await button(h,'Configure trusted embedding endpoint').listeners.click();assert.equal(calls,0,'configuration sends no text');button(h,'Build local comment index').listeners.click();await until(()=>disclosure(h)&&disclosure(h).data.index);assert.equal(calls,0,'index sends no text');
  button(h,'Embed pending chunks explicitly').listeners.click();await until(()=>disclosure(h)&&disclosure(h).data.index&&disclosure(h).data.index.coverage.semantic==='embedding-ready');assert.equal(calls,1);
  for(const declared of measured.input.queries){field(h,'Search comment text').value=declared.text;button(h,'Search with configured embeddings').listeners.click();await until(()=>disclosure(h)&&disclosure(h).operation==='searchComments'&&disclosure(h).request.query===declared.text);const value=disclosure(h);assert.equal(value.data.mode,'hybrid-lexical-embedding');
   const top=value.data.results.slice(0,3).map(r=>r.record.occurrenceId);for(const id of declared.expectedDocIds)assert(top.includes(id),declared.id+' expected '+id+' in actual UI top3');
   const before=calls;button(h,'Replay comment result').listeners.click();await until(()=>disclosure(h)&&disclosure(h).replayed);assert.deepEqual(disclosure(h),{...value,replayed:true});assert.equal(calls,before,'replay never refetches');
  }
 }finally{h.dispose();}
});
const Capture=require('../tests/fixtures/comment-search/capture-contract.cjs');
const actualCapture=process.env.BUILD_GRAPH_COMMENT_CAPTURE,actualHtml=process.env.BUILD_GRAPH_COMMENT_HTML;
const beforeCapture=process.env.BUILD_GRAPH_COMMENT_BEFORE,afterCapture=process.env.BUILD_GRAPH_COMMENT_AFTER,beforeHtml=process.env.BUILD_GRAPH_COMMENT_BEFORE_HTML,afterHtml=process.env.BUILD_GRAPH_COMMENT_AFTER_HTML;
function selection(h,row,graph){
 Capture.exactLinks(row,graph);const id=row.graphNodeId||row.fileNodeId;assert(id,'fresh captured occurrence has exact graph-or-file navigation');const n=graph.nodes.find(n=>n.id===id),pins=normalized(h.context.STATE_UI.pins),other={owner:'other-panel'},layout={owner:'layout'};h.context.ARCH_PIN_ANALYSIS=other;h.context.ENTRY_EFFECT_HIGHLIGHT_OWNER=other;h.context.ARCH_PROJECTION=layout;h.context.G={byId:{[id]:{kind:n.attributes.kind}}};let selected;
 h.context.showFunctionDetail=(nodeId,noFit)=>{selected={nodeId,noFit};};h.context.showDetail=(nodeId,noFit)=>{selected={nodeId,noFit};};h.context.navigateCommentResult(row);assert.deepEqual(selected,{nodeId:id,noFit:true});assert.equal(h.context.COMMENT_SELECTION.occurrenceId,row.record.occurrenceId);assert.deepEqual(normalized(h.context.STATE_UI.pins),pins);assert.equal(h.context.ARCH_PIN_ANALYSIS,other);assert.equal(h.context.ENTRY_EFFECT_HIGHLIGHT_OWNER,other);assert.equal(h.context.ARCH_PROJECTION,layout);
}
for(const worker of [false,true]){
 const mode=worker?'worker':'fallback';
 test(mode+': emitted 21-module HTML binds measured queries and exact captured occurrence navigation',{skip:!actualCapture&&!actualHtml},async()=>{
  assert(actualCapture&&actualHtml,'both actual capture and emitted HTML paths required');const {graph}=Capture.captured(actualCapture),h=await harness(worker,graph,{html:fs.readFileSync(actualHtml,'utf8'),allowEmptyEntries:true});try{
   const api=Analysis.create(graph,{rawText:h.raw}),query=async q=>{const browser=normalized(await h.ui.runCommentQuery(q));assert.deepEqual(browser,await api.query(q),'actual emitted viewer/API parity: '+q.op);return browser;},built=await Capture.seeded(query);
   await Capture.ownershipControls(query,graph);
   for(const row of built.rows.values()){selection(h,row,graph);const details=await h.ui.queryCommentDetails({op:'commentDetails',nodeId:row.graphNodeId||row.fileNodeId,occurrenceId:row.record.occurrenceId});assert(details.data.records.some(r=>r.record.text===row.record.text),'exact selected original occurrence detail');}
   for(const q of built.model.input.queries){const value=Capture.relevance(await query(Capture.search(built.index,q)),q);for(const hit of value.data.results)Capture.exactLinks(hit,graph);
    for(const expected of q.expectedDocIds){const d=Capture.measured.documents.find(d=>d.id===expected),hit=value.data.results.find(r=>r.chunk.textSha256===d.textSha256),label=hit.record.declaration.path+' · '+hit.record.kind,pick=descendants(panel(h)).find(e=>e.tagName==='button'&&e.textContent===label);assert(pick,'actual measured result selection control');pick.listeners.click();assert.equal(h.context.COMMENT_SELECTION.occurrenceId,hit.record.occurrenceId);}
    button(h,'Replay comment result').listeners.click();await until(()=>disclosure(h)&&disclosure(h).replayed);assert.deepEqual(disclosure(h),{...value,replayed:true});assert.deepEqual(disclosure(h),await api.query({op:'replay',replay:value.replay}));
   }
  }finally{h.dispose();}
 });
 test(mode+': before/after emitted HTML preserves seven measured vectors and fences stale indexes',{skip:!beforeCapture&&!afterCapture&&!beforeHtml&&!afterHtml},async()=>{
  assert(beforeCapture&&afterCapture&&beforeHtml&&afterHtml,'both same-physical captures and matching emitted HTML paths required');const before=Capture.captured(beforeCapture),after=Capture.captured(afterCapture),h=await harness(worker,before.graph,{html:fs.readFileSync(beforeHtml,'utf8'),allowEmptyEntries:true}),h2=await harness(worker,after.graph,{html:fs.readFileSync(afterHtml,'utf8'),allowEmptyEntries:true});try{
   const api=Analysis.create(after.graph,{rawText:h2.raw}),first=await Capture.seeded(q=>h.ui.runCommentQuery(q)),query=async q=>{const value=normalized(await h2.ui.runCommentQuery(q));assert.deepEqual(value,await api.query(q));return value;},next=await Capture.changed(query,first);
   for(const row of next.rows.values())selection(h2,row,after.graph);await assert.rejects(h2.ui.runCommentQuery({op:'loadCommentIndex',repositoryScope:scope,index:first.index}),{code:'COMMENT_SNAPSHOT_MISMATCH'});
   const loaded=await query({op:'loadCommentIndex',repositoryScope:scope,index:next.index});button(h2,'Replay comment result').listeners.click();await until(()=>disclosure(h2)&&disclosure(h2).replayed);assert.deepEqual(disclosure(h2),{...loaded,replayed:true});
  }finally{h.dispose();h2.dispose();}
 });
}
