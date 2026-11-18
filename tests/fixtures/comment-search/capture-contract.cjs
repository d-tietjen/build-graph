'use strict';
// Shared acceptance assertions for actual captures, never a capture producer.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),F=require('./fixture-graphs.cjs');
const measured=JSON.parse(fs.readFileSync(path.join(__dirname,'model-vectors.json'),'utf8'));
const documents=measured.documents.map(v=>({...F.input.documents.find(d=>d.id===v.id),...v}));
const scope='local:portable-fixture',plain=x=>JSON.parse(JSON.stringify(x));
const edit={before:'/// Retries temporary failures with an exponentially increasing delay. Stops after',after:'/// Retries temporary failures with a bounded increasing delay. Stops after'};
const afterSource=F.source.replace(edit.before,edit.after);
const provenance={model:measured.model,kind:'pinned-local-onnx-measurement',fixtureSha256:'38c07152430f0923b609baf07f04a0657a2b412ca47e44cb3e7fcf4a00cbb653',provenanceSha256:'262a84bcbce26469f42e628c7e0440c8b232c74fa631ac04ecbf8275c72b245b'};
function captured(file){const bytes=fs.readFileSync(file),raw=bytes[0]===31&&bytes[1]===139?require('node:zlib').gunzipSync(bytes):bytes;return {graph:JSON.parse(raw),rawText:raw.toString('utf8')};}
function ok(value){value=plain(value);assert.equal(value.error,undefined,JSON.stringify(value.error));return value;}
function index(extra={}){return {op:'indexComments',repositoryScope:scope,...extra};}
function search(saved,q){const vector=measured.queries.find(v=>v.id===q.id);assert.equal(vector.textSha256,F.sha(q.text));return {op:'searchComments',repositoryScope:scope,index:saved,query:q.text,queryVector:vector.vector,queryProvenance:provenance,limit:100};}
function exactLinks(row,graph){
 const r=row.record,target=row.scope.target;
 if(row.graphNodeId){const n=graph.nodes.find(n=>n.id===row.graphNodeId),a=n&&n.attributes;assert(n,'exact graph node exists');assert.equal(a.package_id,row.scope.packageId);assert.equal(n.source_file,r.file);assert.equal(a.path,r.declaration.path);assert.equal(a.kind,r.declaration.kind);assert.equal(a.target_name,target.name);assert.equal(a.target_src_path,target.source);assert.deepEqual(JSON.parse(a.target_kind),target.kind);assert.equal(n.source_location,r.declaration.begin[0]);assert.equal(a.source_absolute,r.sourceAbsolute);}
 if(row.fileNodeId){const n=graph.nodes.find(n=>n.id===row.fileNodeId);assert(n,'exact file node exists');assert.equal(n.attributes.kind,'file');assert.equal(n.attributes.package_id,row.scope.packageId);assert.equal(n.source_file,r.file);}
}
async function sourceRows(query,saved,source,expected=documents){
 const rows=new Map();
 for(const doc of expected){
  const chunks=saved.chunks.filter(c=>c.textSha256===doc.textSha256&&c.kind===doc.kind);assert.equal(chunks.length,1,doc.id+' has one exact captured text chunk');const chunk=chunks[0];assert.equal(chunk.text,doc.text);assert.notEqual(chunk.occurrenceId,doc.id,'portable fixture IDs are never relabelled compiler IDs');
  const details=ok(await query({op:'commentDetails',occurrenceId:chunk.occurrenceId})),matches=details.data.records.filter(row=>row.record.text===doc.text&&row.record.kind===doc.kind);assert.equal(matches.length,1,doc.id+' has one actual source occurrence');const row=matches[0],r=row.record;
  assert.equal(r.occurrenceId,chunk.occurrenceId);assert.equal(r.file,'source.rs');assert.equal(r.sourceSha256,F.sha(source));assert.equal(r.sourceStatus,'matching-local-observation');assert.equal(r.declaration.kind,'function');assert.equal(r.declaration.path.split('::').at(-1),F.input.documents.find(d=>d.id===doc.id).symbol);assert(r.declaration.originalId);assert.equal(r.sourceAbsolute,row.scope.target.source);assert.deepEqual(row.scope.target.kind,['lib']);
  for(const pin of [row.artifactSha256,row.buildSha256,row.sourceSnapshotSha256])assert.match(pin,/^[a-f0-9]{64}$/);
  if(doc.kind==='line'){assert.equal(r.ownership,'exact-supported-body');assert.equal(Buffer.from(source).subarray(r.range.startByte,r.range.endByte).toString('utf8'),doc.text);assert(r.range.endByte>r.range.startByte);}
  else{assert.equal(r.ownership,'compiler-original-occurrence');assert.equal(r.range,null,'effective docs retain declaration citations, not fabricated doc token ranges');}
  rows.set(doc.id,row);
 }
 return rows;
}
async function seeded(query){
 assert.equal(F.sha(fs.readFileSync(path.join(__dirname,'model-vectors.json'))),provenance.fixtureSha256);const start=ok(await query(index({model:measured.model}))),byText=new Map(measured.documents.map(d=>[d.textSha256,d]));
 const vectors=start.data.pending.filter(p=>byText.has(p.textSha256)).map(p=>({key:p.key,vector:byText.get(p.textSha256).vector}));assert.equal(vectors.length,8,'baseline has all eight exact measured texts');
 const built=ok(await query(index({model:measured.model,previous:start.data.index,vectors,vectorProvenance:provenance})));assert.equal(built.data.index.chunks.filter(c=>c.vector).length,8,'only the eight measured source texts receive vectors');return {index:built.data.index,model:measured,rows:await sourceRows(query,built.data.index,F.source)};
}
async function ownershipControls(query,graph){
 const corpus=graph.nodes.filter(n=>n.attributes.kind==='comment_corpus').map(n=>JSON.parse(n.attributes.comment_corpus)).find(c=>JSON.stringify(c.scope.target.kind)==='["bin"]');assert(corpus,'same-named binary target has its independent corpus');assert.equal(corpus.exportStatus,'successful-rustdoc-observation');
 const records=corpus.records,docs=records.filter(r=>r.kind==='effective-doc'),one=text=>{const found=docs.filter(r=>r.text===text);assert.equal(found.length,1,text);return found[0];};
 const owned=['Module-owned effective docs.','Trait identity remains distinct from its implementations.','This contract belongs to the original trait method.',"This text belongs to A's implementation, not the trait declaration.",'Same method name; a different original implementation occurrence.','A named type with a documented field.','The original field owns this documentation.','Original named variant field.','Original tuple field.'].map(one);assert.equal(new Set(owned.map(r=>r.occurrenceId)).size,owned.length,'method/type/field/trait/module ownership remains original-occurrence distinct');
 const upper=one('Same normalized graph spelling as the next declaration.'),lower=one('A separate original occurrence despite normalized name collision.');assert.notEqual(upper.occurrenceId,lower.occurrenceId);assert.notEqual(upper.declaration.path,lower.declaration.path);assert.equal(upper.graphNodeId,lower.graphNodeId,'fixture really exercises graph normalization collision');assert(one('Third ordinal.').declaration.path.endsWith('tuple_field_2'));
 for(const record of [...owned,upper,lower]){const details=ok(await query({op:'commentDetails',occurrenceId:record.occurrenceId}));assert(details.data.records.some(row=>row.record.text===record.text));for(const row of details.data.records)exactLinks(row,graph);}
 const source=fs.readFileSync(path.join(__dirname,'ownership.rs'),'utf8');for(const r of records.filter(r=>r.range)){assert.equal(Buffer.from(source).subarray(r.range.startByte,r.range.endByte).toString('utf8'),r.text);assert.equal(r.sourceSha256,F.sha(source));}
 for(const text of ['// Retain at file level; do not infer a body through const signature braces.','// Retain at file level because the enclosing original body is uncertain.','// Macro-origin body text is not attached through a callsite span.','// Exact local text can remain file evidence, with no exported symbol owner.']){const r=records.find(r=>r.text===text);assert(r,text);assert.equal(r.ownership,'file-unattached');assert.equal(r.occurrenceId,null);assert.equal(r.graphNodeId,null);}
 assert(records.some(r=>r.text==='// Unicode body intent: café 🦀.'&&r.ownership==='exact-supported-body'));assert(!docs.some(r=>r.text==='Not present in this configured compiler export.'));assert(!records.some(r=>r.text.includes('not a comment')&&r.kind==='line'));
 const bundled=docs.find(r=>r.declaration.name==='bundled');assert(bundled,'include_str effective docs retained');assert.equal(bundled.range,null);assert(corpus.coverage.diagnostics.some(d=>d.includes('Included/expanded/cfg source origin is unverified')));
}
function relevance(value,q){
 value=ok(value);assert.equal(value.data.mode,'hybrid-lexical-embedding');for(const expected of q.expectedDocIds){const doc=documents.find(d=>d.id===expected);assert(value.data.results.slice(0,3).some(r=>r.chunk.textSha256===doc.textSha256),q.id+' predeclared actual source-linked top-3 relevance');}
 if(!q.expectedDocIds.length)assert(value.data.relevance.includes('Unrelated queries may still have nearest vectors'));
 for(const hit of value.data.results){assert.equal(hit.record.text.slice(hit.chunk.startUtf16,hit.chunk.endUtf16),hit.matchedText);assert(hit.record.sourceSha256);assert(hit.provenance.artifactSha256);assert(hit.provenance.buildSha256);}return value;
}
async function changed(query,first){
 const next=ok(await query(index({model:measured.model,previous:first.index})));assert.notEqual(next.data.index.captureSha256,first.index.captureSha256);assert.deepEqual(next.data.index.corpusPins.map(p=>p.scopeSha256).sort(),first.index.corpusPins.map(p=>p.scopeSha256).sort(),'same physical package/target/source identity is required');
 assert.equal(next.data.incremental.reusedVectors,7);assert.equal(next.data.incremental.missingVectors,first.index.chunks.filter(c=>!c.vector).length+1);assert.equal(next.data.index.chunks.filter(c=>c.vector).length,7);
 assert.notDeepEqual(next.data.index.corpusPins.map(p=>p.sourceSnapshotSha256),first.index.corpusPins.map(p=>p.sourceSnapshotSha256));assert.notDeepEqual(next.data.index.corpusPins.map(p=>p.artifactSha256),first.index.corpusPins.map(p=>p.artifactSha256));
 const rows=await sourceRows(query,next.data.index,afterSource,documents.slice(1));for(const [id,row] of rows)assert.equal(row.record.occurrenceId,first.rows.get(id).record.occurrenceId,'unchanged original occurrence identity');
 const old=documents[0],replacement=old.text.replace('an exponentially increasing delay','a bounded increasing delay'),chunks=next.data.index.chunks.filter(c=>c.occurrenceId===first.rows.get(old.id).record.occurrenceId&&c.kind==='effective-doc');assert.equal(chunks.length,1);assert.equal(chunks[0].text,replacement);assert.equal(chunks[0].vector,null,'edited text has no measured vector; never reuse the old vector');assert(!next.data.index.chunks.some(c=>c.textSha256===old.textSha256));
 return {index:next.data.index,rows};
}
module.exports={measured,scope,plain,edit,afterSource,provenance,captured,ok,index,search,exactLinks,sourceRows,seeded,ownershipControls,relevance,changed};
