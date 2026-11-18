/* Compare independently recomputed source-linked static evidence; no semantic engines here. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./analysis-snapshot.js') : root.AnalysisSnapshot);
  if (common) module.exports = api;
  root.RevisionComparison = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Snapshot) {
  'use strict';
  var VERSION = 'semantic-revision-comparison-v1';
  function checkObject(v, keys, name) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(function (k) { return !keys.includes(k); })) Snapshot.fail('INVALID_REVISION', name + ' has unsupported fields'); }
  async function compare(request, runtime) {
    request=Snapshot.dispatchCopy(request,8388608);
    var replayed = request && request.op === 'replay', descriptor = replayed && request.replay;
    if (replayed) {
      if (!descriptor || descriptor.version !== VERSION || descriptor.operation !== 'compareRevisions') Snapshot.fail('INVALID_REPLAY', 'Unsupported revision replay');
      request = descriptor.request;
    }
    var s = Snapshot.session(request, runtime), q = await s.copy(request, 8388608);
    checkObject(q, ['op','before','after','mappings','packageMappings','equivalences','timeoutMs','budgets'], 'comparison request');
    if (q.op !== 'compareRevisions') Snapshot.fail('INVALID_REVISION', 'compareRevisions operation required');
    if (replayed && await s.hash(q) !== descriptor.requestHash) Snapshot.fail('INVALID_REPLAY', 'Revision replay request binding failed');
    for(var field of ['mappings','packageMappings','equivalences'])if(q[field]!=null&&(!Array.isArray(q[field])||q[field].length>(field==='equivalences'?32:2000)))Snapshot.fail('INVALID_MAPPING','Bounded mapping arrays required');
    var before = await Snapshot.importSide(q.before, s), after = await Snapshot.importSide(q.after, s);
    var a = before.evidence, b = after.evidence, differences = [], mappings = [], changes = [];
    async function equal(x, y) { return await s.hash(x) === await s.hash(y); }
    async function difference(kind, x, y, required) {
      var same = await equal(x, y); if (!same || required && (x == null || y == null)) differences.push({ kind: kind, before: x, after: y, status: x == null || y == null ? 'unavailable' : 'different' });
      return same && (!required || x != null && y != null);
    }
    // Captured provenance is distinct from declarations, and source paths never establish revisions.
    function config(side, key) {
      var observed = side.provenance[key], declared = side.declaration.configuration;
      if (observed && observed.status === 'captured' && !observed.truncated) return { basis: 'captured', values: Array.from(new Set(observed.items.map(function (i) { return JSON.stringify(i.value); }))).sort() };
      return declared ? { basis: 'caller-declared', value: declared[key], provenance: declared.provenance } : null;
    }
    var compatible = true, declared = false;
    for (var key of ['target','features','toolchain']) {
      var x = config(a,key), y = config(b,key); if (x && x.basis === 'caller-declared' || y && y.basis === 'caller-declared') declared = true;
      compatible = await difference('configuration:' + key,x,y,true) && compatible;
    }
    compatible = await difference('analysis-versions',a.versions,b.versions,true) && compatible;
    // Validate the whole package join before using it for context or selectors.
    // An explicit join may not collide with another package's implicit exact join.
    var packages = new Map(), packageUsed = new Set(), packageTargets = new Map(), packageSources = new Map();
    for (var m of q.packageMappings || []) {
      await s.tick(); checkObject(m,['before','after','provenance'],'package mapping');
      if (packages.has(m.before) || packageUsed.has(m.after) || !a.packages.some(function(p){return p.id===m.before;}) || !b.packages.some(function(p){return p.id===m.after;}) || typeof m.provenance!=='string' || !m.provenance) Snapshot.fail('INVALID_MAPPING','Package mapping must be exact, unique and declared');
      packages.set(m.before,m); packageUsed.add(m.after);
    }
    for (var p of a.packages) {
      await s.tick(); var pm=packages.get(p.id), target=pm?pm.after:p.id;
      if (!b.packages.some(function(r){return r.id===target;})) continue;
      if (packageSources.has(target)) Snapshot.fail('INVALID_MAPPING','Package joins must be one-to-one, including exact identities');
      packageTargets.set(p.id,target); packageSources.set(target,p.id);
    }
    var treeComparisons=[], contextsA=new Map(), contextsB=new Map(), pairedContext=new Set();
    for (var sideContexts of [[a,contextsA],[b,contextsB]]) for (var ctx of sideContexts[0].captureContexts||[]) {
      await s.tick(); if (!sideContexts[1].has(ctx.packageId)) sideContexts[1].set(ctx.packageId,[]);
      sideContexts[1].get(ctx.packageId).push(ctx);
    }
    async function contextPair(beforeId,afterId) {
      var left=contextsA.get(beforeId)||[], right=contextsB.get(afterId)||[];
      var contextA=left.length===1?left[0]:null, contextB=right.length===1?right[0]:null;
      var ga=contextA&&contextA.record&&contextA.record.git, gb=contextB&&contextB.record&&contextB.record.git;
      var treeA=ga&&ga.after&&ga.after.treeOid?{objectFormat:ga.after.objectFormat,treeOid:ga.after.treeOid}:null, treeB=gb&&gb.after&&gb.after.treeOid?{objectFormat:gb.after.objectFormat,treeOid:gb.after.treeOid}:null;
      var bound=!!(contextA&&contextA.record&&contextA.record.scope.binding==='workspace-package-in-observed-repo'&&contextB&&contextB.record&&contextB.record.scope.binding==='workspace-package-in-observed-repo');
      var stable=bound&&ga.consistency==='stable-context'&&gb.consistency==='stable-context'&&ga.after.status==='clean-tracked-context'&&gb.after.status==='clean-tracked-context';
      var sameTree=!!treeA&&!!treeB&&await equal(treeA,treeB), sameBuild=!!contextA&&!!contextB&&!!contextA.buildFingerprint&&contextA.buildFingerprint===contextB.buildFingerprint;
      treeComparisons.push({beforePackageId:beforeId,afterPackageId:afterId,beforeContexts:left,afterContexts:right,contextStatus:left.length>1||right.length>1?'ambiguous':!contextA||!contextB?'unavailable':'paired',beforeTree:treeA,afterTree:treeB,sameTree:sameTree,sameCapturedBuildContext:sameBuild,
        beforeCommitContext:ga&&ga.after.commitOid||null,afterCommitContext:gb&&gb.after.commitOid||null,treeBinding:bound?'captured-repo-package-scope':'unavailable',stableTrackedContext:stable,completeCompilerInputs:false});
      if (left.length>1||right.length>1) differences.push({kind:'capture-context',before:left,after:right,status:'ambiguous'});
      await difference('git-commit-context',ga&&ga.after.commitOid||null,gb&&gb.after.commitOid||null);
      if (!sameTree) differences.push({kind:'git-tree',before:treeA,after:treeB,status:treeA&&treeB?'different':'unavailable'});
      if (!sameBuild) differences.push({kind:'build-context',before:contextA&&contextA.buildFingerprint||null,after:contextB&&contextB.buildFingerprint||null,status:contextA&&contextB?'different':'unavailable'});
      if (!stable || !sameBuild) declared=true;
      // Observed unmatched presence remains known, but continuity is unavailable.
      if (contextA&&contextB&&!sameBuild) compatible=false;
    }
    for (var id of contextsA.keys()) {
      await s.tick(); var target=packageTargets.get(id)||null;
      if (target&&contextsB.has(target)) pairedContext.add(target);
      await contextPair(id,target);
    }
    for (var id of contextsB.keys()) { await s.tick(); if (!pairedContext.has(id)) await contextPair(null,id); }
    if (!contextsA.size||!contextsB.size) { declared=true; differences.push({kind:'git-tree',before:contextsA.size?'captured-records':null,after:contextsB.size?'captured-records':null,status:'unavailable'}); }
    await difference('source-revision', { captured: a.provenance.sourceRevision, declared: a.declaration.revision || null }, { captured: b.provenance.sourceRevision, declared: b.declaration.revision || null });
    var nodeA = new Map(), nodeB = new Map();
    for(var sidePair of [[a,nodeA],[b,nodeB]])for(var definition of sidePair[0].definitions){await s.tick();for(var id of [definition.nodeId,definition.procedure])if(id){if(!sidePair[1].has(id))sidePair[1].set(id,definition);else if(sidePair[1].get(id)!==definition)sidePair[1].set(id,null);}}
    var mapA = new Map(a.definitions.map(function (d) { return [d.procedure,d]; })), mapB = new Map(b.definitions.map(function (d) { return [d.procedure,d]; })), pairs = new Map(), usedB = new Set();
    for (var m of q.mappings || []) {
      await s.tick(); checkObject(m,['before','after','provenance','certainty'],'symbol mapping');
      if (!mapA.has(m.before) || !mapB.has(m.after) || pairs.has(m.before) || usedB.has(m.after) || typeof m.provenance !== 'string' || !m.provenance || !['declared','uncertain'].includes(m.certainty)) Snapshot.fail('INVALID_MAPPING', 'Symbol mappings require unique exact side procedures and declared/uncertain provenance');
      pairs.set(m.before, m.after); usedB.add(m.after); mappings.push({before:m.before,after:m.after,basis:'caller-'+m.certainty,provenance:m.provenance,established:false});
    }
    var byKeyA = new Map(), byKeyB = new Map();
    for (var sides of [[a,byKeyA],[b,byKeyB]]) for (var d of sides[0].definitions) { await s.tick(); if (d.matchKey) { if (!sides[1].has(d.matchKey)) sides[1].set(d.matchKey,[]); sides[1].get(d.matchKey).push(d); } }
    for (var d of a.definitions) {
      await s.tick(); var candidates = byKeyB.get(d.matchKey) || [];
      if (!pairs.has(d.procedure) && d.matchKey && (byKeyA.get(d.matchKey) || []).length === 1 && candidates.length === 1 && !usedB.has(candidates[0].procedure)) {
        pairs.set(d.procedure,candidates[0].procedure); usedB.add(candidates[0].procedure); mappings.push({before:d.procedure,after:candidates[0].procedure,basis:'unique-original-compiler-and-build-scope',established:true});
      }
    }
    if ((q.mappings || []).length > 2000 || (q.packageMappings || []).length > 2000 || (q.equivalences || []).length > 32) Snapshot.fail('INVALID_MAPPING','Mapping count limit reached');
    function mappedNode(side, id) { return (side === a ? nodeA : nodeB).get(id); }
    var mappingRecords=new Map();for(var m of mappings){await s.tick();mappingRecords.set(m.before+'\u0000'+m.after,m);}
    function mappingFor(beforeId, afterId) { return mappingRecords.get(beforeId+'\u0000'+afterId); }
    async function add(kind, status, left, right, identity, completeness, extra) {
      await s.tick(); if (changes.length >= 1000) Snapshot.fail('REVISION_BUDGET','Change record limit reached');
      changes.push(Object.assign({kind:kind,status:status,before:left,after:right,mapping:identity || null,
        comparison: !compatible ? 'incompatible-or-unavailable' : !completeness ? 'incomplete' : declared || identity && !identity.established ? 'conditional' : 'comparable',
        classification: kind === 'dependency' ? 'observed' : 'modeled', securityRegressionProven:false, resolvedFindingProven:false},extra || {}));
    }
    async function inventory(kind, left, right, completeA, completeB, owner, semantic) {
      var consumed = new Set();
      for (var l of left) {
        await s.tick(); var ld = owner ? mappedNode(a,owner(l)) : null, target = ld && pairs.get(ld.procedure), identity = null, matches = [];
        for (var r of right) { await s.tick(); var rd = owner ? mappedNode(b,owner(r)) : null;
          if (ld && rd && target === rd.procedure && await equal(semantic(l),semantic(r))) matches.push(r);
        }
        if (matches.length === 1 && !consumed.has(matches[0])) { var r = matches[0]; consumed.add(r); identity = mappingFor(ld.procedure,target);
          if (!await equal(l,r)) await add(kind,'changed',l,r,identity,completeA && completeB);
        } else await add(kind, completeB ? 'removed-or-unmatched' : 'candidate-unavailable',l,null,null,completeA && completeB);
      }
      for (var r of right) { await s.tick(); if (!consumed.has(r)) await add(kind,completeA ? 'added-or-unmatched' : 'baseline-unavailable',null,r,null,completeA && completeB); }
    }
    // Resolve every endpoint through exact side ownership plus established or
    // explicitly declared one-to-one continuity. Equal strings alone are no proof.
    var questionComplete=true;
    function functionKey(side,id) {
      var d=mappedNode(side,id); if (!d) return null;
      var beforeId=side===a?d.procedure:(mappings.find(function(m){return m.after===d.procedure;})||{}).before;
      var afterId=beforeId&&pairs.get(beforeId), m=afterId&&mappingFor(beforeId,afterId);
      return m&&m.basis!=='caller-uncertain'?beforeId:null;
    }
    async function question(operation,side) {
      var request=operation.result.request, out={}, valid=true;
      // Public engines treat null optional selectors as absent. Keep explicit
      // empty package scopes, which select no inventory rows, distinct.
      var optional=['scope'];
      if (['entrypoints','effects','effectPaths','buildInventory'].includes(operation.operation)) optional=optional.concat(['function','entryId','effectId','category','kind','phase','includePossible']);
      if (operation.operation==='advisoryExposure') optional=optional.concat(['packageId','phase']);
      function endpoint(id) { var key=functionKey(side,id); if (!key) valid=false; return key; }
      async function recordKey(id,name) {
        var rows=[];
        for (var op of side.operations) for (var row of op.result[name]&&op.result[name].items||[]) { await s.tick(); if (row.id===id&&!rows.some(function(r){return r.id===row.id;})) rows.push(row); }
        if (rows.length!==1) { valid=false; return null; }
        var row=rows[0]; return {owner:endpoint(row.nodeId),kind:row.kind||null,category:row.category||null,operation:row.operation||null,adapter:row.provenance&&row.provenance.adapter||null,rule:row.provenance&&row.provenance.rule||null};
      }
      for (var key of Object.keys(request)) {
        await s.tick(); var value=request[key]; if (key==='model'||key==='snapshot'||value==null&&optional.includes(key)) continue;
        if (['function','from','to'].includes(key)) out[key]=endpoint(value);
        else if (key==='actors') out[key]=value.map(endpoint).sort();
        else if (key==='entryId'||key==='effectId') out[key]=await recordKey(value,key==='entryId'?'entries':'effects');
        else if (key==='packageId') { out[key]=side===a?(packageTargets.has(value)?value:null):packageSources.get(value)||null; if (!out[key]) valid=false; }
        else if (key==='scope') {
          var ids=[]; for (var id of value.packageIds) { await s.tick(); var joined=side===a?(packageTargets.has(id)?id:null):packageSources.get(id)||null; if (!joined) valid=false; ids.push(joined); }
          out.scope={packageIds:ids.sort(),dependencies:value.dependencies||'none'};
        } else if (key!=='page') out[key]=value;
      }
      if (operation.operation==='effectPaths'&&out.includePossible==null) out.includePossible=true;
      // Page defaults apply independently to every result collection.
      var pageNames={entrypoints:['entries'],effects:['effects'],buildInventory:['inventory','units','relationships'],effectPaths:['entries','effects','nodes','edges','witnesses'],callPaths:['nodes','edges','unknowns'],advisoryExposure:['findings','unmatched','diagnostics']}[operation.operation]||[];
      out.page={}; for (var name of pageNames) { var page=request.page&&(request.page[name]||request.page)||{}; out.page[name]={offset:page.offset||0,limit:page.limit||50}; }
      return {selectors:out,valid:valid};
    }
    async function sameQuestion(left,right) {
      var qa=await question(left,a),qb=await question(right,b),same=qa.valid&&qb.valid&&await equal(qa.selectors,qb.selectors);
      if (!same) { questionComplete=false; differences.push({kind:'question:'+left.key,before:left.result.request,after:right.result.request,status:'non-equivalent'}); }
      return same;
    }
    // Explicit semantic result projections exclude capture/transport envelopes.
    // Nested advisory route envelopes are also evidence wrappers, not outcomes.
    async function semanticResult(result) {
      var fields=['operation','status','partialCoverage','endpoints','nodes','edges','membership','entries','effects','witnesses','finding','findings','inventory','units','relationships','entryEffectCoverage','buildExecutionCoverage','adapterVersions','queryCoverage','coverage','capability','rules','semantics','assumptions','scope','selection','unmatched','diagnostics','nativeCoverage','snapshot','completion'];
      async function project(value,key) {
        await s.tick(); if (!value||typeof value!=='object') return value;
        await s.tick(16); var out=Array.isArray(value)?[]:{}, envelope=value.request&&value.replay;
        for (var name of Object.keys(value)) {
          if (envelope&&['request','replay','replayed','graph','provenance','versions','captureDiagnostics'].includes(name)) continue;
          if (key==='completion'&&['work','states','instances','retainedBytes','evidenceBytes','evidenceAccounting','timeoutMs','limits'].includes(name)) continue;
          out[name]=await project(value[name],name);
        }
        return out;
      }
      var out={}; for (var field of fields) if (result[field]!==undefined) out[field]=await project(result[field],field);
      return out;
    }
    var entriesA = a.operations.find(function(o){return o.key==='$entries';}), entriesB = b.operations.find(function(o){return o.key==='$entries';});
    var entriesQuestion=await sameQuestion(entriesA,entriesB);
    await inventory('entry',entriesA.result.entries.items,entriesB.result.entries.items,entriesA.complete&&entriesQuestion,entriesB.complete&&entriesQuestion,function(r){return r.nodeId;},function(r){return {kind:r.kind,phases:r.phases};});
    var effectsA = a.operations.find(function(o){return o.key==='$effects';}), effectsB = b.operations.find(function(o){return o.key==='$effects';});
    var effectsQuestion=await sameQuestion(effectsA,effectsB);
    await inventory('sensitive-effect',effectsA.result.effects.items,effectsB.result.effects.items,effectsA.complete&&effectsQuestion,effectsB.complete&&effectsQuestion,function(r){return r.nodeId;},function(r){return {category:r.category,operation:r.operation,phases:r.phases};});
    // Package IDs include exact versions/sources. Version-spanning joins require a declared one-to-one mapping.
    var joined = new Set(),packageByB=new Map(),inclusionA=new Map(),inclusionB=new Map();
    for(var pb of b.packages){await s.tick();packageByB.set(pb.id,pb);}
    for(var sideLinks of [[a.dependencies,inclusionA],[b.dependencies,inclusionB]])for(var dep of sideLinks[0]){await s.tick();if(!sideLinks[1].has(dep.target))sideLinks[1].set(dep.target,[]);sideLinks[1].get(dep.target).push(dep);}
    for (var p of a.packages) { await s.tick(); var m=packages.get(p.id), id=m?m.after:p.id, r=packageByB.get(id)||null;
      if(r)joined.add(r.id);if(!r || !await equal(p,r))await add('dependency',r?'changed':'removed-or-unmatched',p,r,m?{basis:'caller-declared',provenance:m.provenance,established:false}:null,!a.packagesTruncated&&!b.packagesTruncated&&!a.packageCoverage.catalogIncomplete&&!b.packageCoverage.catalogIncomplete,{beforeInclusion:inclusionA.get(p.id)||[],afterInclusion:r?inclusionB.get(r.id)||[]:[]});
    }
    for(var r of b.packages){await s.tick();if(!joined.has(r.id))await add('dependency','added-or-unmatched',null,r,null,!a.packagesTruncated&&!b.packagesTruncated);}
    var equivalences=new Map();
    for(var eq of q.equivalences||[]){await s.tick();checkObject(eq,['key','beforeModelHash','afterModelHash','provenance'],'model equivalence');if(typeof eq.key!=='string'||equivalences.has(eq.key)||typeof eq.provenance!=='string'||!eq.provenance)Snapshot.fail('INVALID_MAPPING','Model equivalence requires unique key and provenance');equivalences.set(eq.key,eq);}
    var usedOps=new Set();
    for(var opA of a.operations){
      await s.tick();if(['$entries','$effects','$build'].includes(opA.key))continue;
      var wanted=opA.key;
      if(opA.key.startsWith('$route:')){
        var entryA=entriesA.result.entries.items.find(function(e){return '$route:'+e.id===opA.key;}), defA=entryA&&mappedNode(a,entryA.nodeId), entryB=defA&&entriesB.result.entries.items.find(function(e){var d=mappedNode(b,e.nodeId);return d&&d.procedure===pairs.get(defA.procedure)&&e.kind===entryA.kind;});
        wanted=entryB?'$route:'+entryB.id:null;
      }
      var opB=b.operations.find(function(o){return o.key===wanted;}), equivalent=opB&&opA.modelHash===opB.modelHash, eq=equivalences.get(opA.key);
      if(opB&&!equivalent){differences.push({kind:'model:'+opA.key,before:opA.modelHash,after:opB.modelHash,status:'different'});if(eq&&eq.beforeModelHash===opA.modelHash&&eq.afterModelHash===opB.modelHash)equivalent=true;}
      if(opB)usedOps.add(opB.key);
      var rootA=opA.result.request.function,rootB=opB&&opB.result.request.function,da=rootA&&mappedNode(a,rootA),db=rootB&&mappedNode(b,rootB),identity=da&&db?mappingFor(da.procedure,db.procedure):null;
      var matched=!!opB&&await sameQuestion(opA,opB), outputSame=!!opB&&await equal(await semanticResult(opA.result),await semanticResult(opB.result));
      if(!opB||!matched||!outputSame) await add(opA.key.startsWith('$route:')?'entry-reachability':opA.operation,opB?(matched?'changed':'non-equivalent-question'):'candidate-unavailable',opA.result,opB?opB.result:null,identity,matched&&equivalent&&opA.complete&&opB.complete,{key:opA.key,beforeFinding:opA.result.finding||null,afterFinding:opB&&opB.result.finding||null,questionEquivalent:matched,modelEquivalent:!!equivalent,modelEquivalence:eq||null,beforeComplete:opA.complete,afterComplete:!!opB&&opB.complete});
    }
    for(var opB of b.operations){await s.tick();if(!['$entries','$effects','$build'].includes(opB.key)&&!usedOps.has(opB.key))await add(opB.key.startsWith('$route:')?'entry-reachability':opB.operation,'baseline-unavailable',null,opB.result,null,false,{key:opB.key,beforeComplete:false,afterComplete:opB.complete});}
    var unmatched={before:[],after:[]};
    for(var d of a.definitions){await s.tick();if(!pairs.has(d.procedure))unmatched.before.push(d);}
    for(var d of b.definitions){await s.tick();if(!usedB.has(d.procedure))unmatched.after.push(d);}
    var requestHash=await s.hash(q), result={schemaVersion:1,operation:'compareRevisions',version:VERSION,replayed:replayed,
      status:compatible?(declared?'conditional':'compared'):'incompatible-or-unavailable',differences:differences,treeComparisons:treeComparisons,mappings:mappings,unmatched:unmatched,changes:changes,
      sides:{before:{contentHash:before.contentHash,capture:a.graph,provenance:a.provenance,declaration:a.declaration,captureContexts:a.captureContexts},after:{contentHash:after.contentHash,capture:b.graph,provenance:b.provenance,declaration:b.declaration,captureContexts:b.captureContexts}},
      completion:{complete:true,evidenceComplete:questionComplete&&a.routeInventoryComplete&&b.routeInventoryComplete&&a.operations.every(function(o){return o.complete;})&&b.operations.every(function(o){return o.complete;})&&changes.every(function(c){return c.comparison==='comparable'||c.comparison==='conditional';})&&!a.definitionsTruncated&&!b.definitionsTruncated&&!a.dependenciesTruncated&&!b.dependenciesTruncated&&!a.identityCoverageIncomplete&&!b.identityCoverageIncomplete},
      semantics:{basis:'independently recomputed captured static evidence',runtimeObservationsCompared:false,branchFeasibilitySolved:false,vulnerabilityAbsenceProven:false,contentDigestProvesProducerAuthenticity:false,namesEstablishIdentity:false},
      replay:{version:VERSION,operation:'compareRevisions',requestHash:requestHash,request:q}};
    // Final wire materialization is part of the same session, before finalization.
    return await s.copy(result,s.limits.maxOutputBytes);
  }
  async function query(request, current, runtime) {
    // Registration is one bounded atomic admission, outside cooperative query
    // allocation/output budgets. Native parse and private index construction run
    // once; following small reference queries retain cancellation and time checks.
    if(request&&request.op==='registerRevisionCapture') {
      var admitted=Snapshot.captureRequest(request);
      if(!runtime||!runtime.registerCapture)Snapshot.fail('CAPTURE_UNAVAILABLE','No capture registry');
      if(runtime.cancelled&&runtime.cancelled())Snapshot.fail('CANCELLED','Capture registration cancelled');
      var token=Snapshot.admitCapture(JSON.parse(admitted.raw),{maxCaptureBytes:admitted.maxCaptureBytes}),hash=Snapshot.captureHash(token);
      if(runtime.cancelled&&runtime.cancelled())Snapshot.fail('CANCELLED','Capture registration cancelled');
      runtime.registerCapture(hash,token);
      return {schemaVersion:1,operation:'registerRevisionCapture',capture:{contentSha256:hash},integrityOnly:true};
    }
    request=Snapshot.dispatchCopy(request,8388608);
    var replayed = request && request.op === 'replay';
    if (request && (request.op === 'compareRevisions' || replayed && request.replay && request.replay.operation === 'compareRevisions')) return await compare(request,runtime);
    var original = request;
    if(replayed){var replay=request.replay;if(!replay||replay.version!==VERSION||replay.operation!=='exportRevision')Snapshot.fail('INVALID_REPLAY','Unsupported revision export replay');request=replay.request;}
    if(!request||request.op!=='exportRevision')Snapshot.fail('INVALID_REVISION','exportRevision operation required');
    checkObject(request,['op','input','timeoutMs','budgets'],'export request');
    var s=Snapshot.session(request,runtime),q=await s.copy(request,4194304);
    if(replayed&&await s.hash(q)!==original.replay.requestHash)Snapshot.fail('INVALID_REPLAY','Export replay request binding failed');
    var input=q.input||{capture:{contentSha256:current}};
    if(!input.graph&&!input.capture)input.capture={contentSha256:current};
    q.input=input;
    var snapshot=await Snapshot.exportSide(input,q,runtime,s),value={schemaVersion:1,operation:'exportRevision',version:VERSION,replayed:replayed,snapshot:snapshot,
      replay:{version:VERSION,operation:'exportRevision',requestHash:await s.hash(q),request:q}};
    return await s.copy(value,s.limits.maxOutputBytes);
  }
  return {VERSION:VERSION,compare:compare,query:query,admitCapture:Snapshot.admitCapture};
});
