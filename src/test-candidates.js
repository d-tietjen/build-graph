/* Reproducible local test proposals. Static witnesses never become execution receipts. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./analysis-snapshot.js') : root.AnalysisSnapshot,
    common ? require('./revision-comparison.js') : root.RevisionComparison,
    common ? require('./analysis-evidence.js') : root.AnalysisEvidence);
  if (common) module.exports = api;
  root.TestCandidates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Snapshot, Revisions, Evidence) {
  'use strict';
  var VERSION = 'test-candidates-v1', MAX_CASES = 4096;
  var TYPES = { bool: null, u8: [0,255], i8: [-128,127], u16: [0,65535], i16: [-32768,32767], u32: [0,4294967295], i32: [-2147483648,2147483647] };
  var STATES = ['generated-unrun','compiled','compile-failed','failing-reproduction','passing-regression','execution-failed'];
  var KEYWORDS = new Set('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try'.split(' '));
  function fail(message) { Snapshot.fail('INVALID_CANDIDATE', message); }
  function keys(v, allowed, name) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(function (k) { return !allowed.includes(k); })) fail(name + ' has unsupported fields');
  }
  function text(v, name) { if (typeof v !== 'string' || !v || v.length > 4096) fail(name + ' requires 1..4096 characters'); return v; }
  function scalar(type, value) { return type === 'bool' ? typeof value === 'boolean' :
    Object.prototype.hasOwnProperty.call(TYPES,type) && Number.isSafeInteger(value) && value >= TYPES[type][0] && value <= TYPES[type][1]; }
  function literal(type, value) { if (!scalar(type,value)) fail('Value outside declared scalar type ' + type); return String(value) + (type === 'bool' ? '' : type); }
  function relativePath(value) {
    return typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_.\/-]+\.rs$/.test(value) &&
      value[0] !== '/' && value.split('/').every(function (part) { return part && part !== '.' && part !== '..'; });
  }
  function sourcePathConflict(value) {
    return ['candidate.rs','candidate-test','receipt.json'].some(function (reserved) {
      return value === reserved || value.startsWith(reserved + '/') || reserved.startsWith(value + '/');
    });
  }
  function sourceFacts(source) {
    var facts = Object.assign({}, source), file = facts.source_file, absolute = facts.absolute_file;
    if (absolute != null && (typeof absolute !== 'string' || absolute[0] !== '/')) fail('Captured absolute source enrichment is malformed');
    if (typeof file === 'string' && file[0] === '/') {
      if (absolute != null && absolute !== file) fail('Captured absolute source facts conflict');
      // Compare equivalent optional enrichment without changing retained evidence.
      facts.absolute_file = file;
    }
    return facts;
  }
  function rustPath(value) { return typeof value === 'string' && value.length <= 256 && /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/.test(value) && value.split('::').every(function(v){return v !== '_' && !KEYWORDS.has(v);}); }
  function capability() { return { version: VERSION, operation: 'testCandidates', localOnly: true, automaticExecution: false,
    types: Object.keys(TYPES), callable: 'caller-declared public free Rust function', maxParameters: 8, maxCases: MAX_CASES,
    oracles: ['cases','identity','constant'], harness: 'rustc-test-std-only', fuzzing: 'bounded deterministic domain enumeration; not coverage-guided',
    states: STATES.slice(), capturedSignatureInferred: false, reachingInputsSolved: false, executionReceipts: 'scripts/run-test-candidate.cjs only; never imported as query evidence' }; }
  function integrity(manifest, code) {
    return { algorithm: 'sha256/canonical-json-v1', manifestSha256: Evidence.digest(manifest),
      codeSha256: Evidence.hasher().update(code).digest('hex'), artifactSha256: Evidence.digest({ manifest: manifest, code: code }) };
  }
  function render(callable, cases) {
    var lines = ['// Generated proposal. Inputs and oracle are caller declarations, not solved path conditions.',
      '// fd 3 is an instrumentation pipe, not authentication or a native-code sandbox.',
      '#[path = ' + JSON.stringify(callable.sourcePath) + ']', 'mod subject;', '', '#[test]', 'fn generated_declared_oracle() {',
      '    let mut observations = unsafe { <::std::fs::File as ::std::os::fd::FromRawFd>::from_raw_fd(3) };',
      '    ::std::io::Write::write_all(&mut observations, b"begin\\n").expect("observation pipe");',
      '    let mut oracle_failure = ::std::option::Option::None;'];
    cases.forEach(function (row, index) {
      var args = row.inputs.map(function (v,i) { return literal(callable.parameters[i],v); }).join(', ');
      var expected = literal(callable.returns,row.expected);
      lines.push('    {', '        let actual: ' + callable.returns + ' = subject::' + callable.path + '(' + args + ');',
        '        let expected = ' + expected + ';',
        '        let oracle = ::std::panic::catch_unwind(|| { ::std::assert_eq!(actual, expected, "BG_ORACLE_MISMATCH ' + index + '"); });',
        '        ::std::io::Write::write_all(&mut observations, ::std::format!("case ' + index + ' actual={:?} expected={:?}\\n", actual, expected).as_bytes()).expect("observation pipe");',
        '        if let ::std::result::Result::Err(failure) = oracle {',
        '            if oracle_failure.is_none() { oracle_failure = ::std::option::Option::Some((' + index + 'usize, failure)); }', '        }', '    }');
    });
    lines.push('    if let ::std::option::Option::Some((index, failure)) = oracle_failure {',
      '        ::std::io::Write::write_all(&mut observations, ::std::format!("fail {}\\n", index).as_bytes()).expect("observation pipe");',
      '        ::std::panic::resume_unwind(failure);', '    }', '    ::std::io::Write::write_all(&mut observations, b"pass\\n").expect("observation pipe");', '}', ''); return lines.join('\n');
  }
  function verifyArtifact(artifact) {
    keys(artifact,['manifest','code','integrity'],'artifact');
    var m=artifact.manifest, c=m && m.target && m.target.declaration;
    if (!m || m.version !== VERSION || m.schemaVersion !== 1 || m.state !== 'generated-unrun' || m.executionObserved !== false ||
        !m.support || m.support.status !== 'generated' || !c || c.kind !== 'public-free-function' || c.setup !== 'none' ||
        !relativePath(c.sourcePath) || sourcePathConflict(c.sourcePath) || !/^[a-f0-9]{64}$/.test(c.sourceSha256) || !rustPath(c.path) ||
        !Array.isArray(c.parameters) || c.parameters.length > 8 || c.parameters.some(function(t){return !Object.prototype.hasOwnProperty.call(TYPES,t);}) ||
        !Object.prototype.hasOwnProperty.call(TYPES,c.returns) || !m.inputs || !Array.isArray(m.inputs.cases) || !m.inputs.cases.length || m.inputs.cases.length > MAX_CASES)
      fail('Artifact is not a supported generated-unrun scalar proposal');
    for (var row of m.inputs.cases) if (!row || !Array.isArray(row.inputs) || row.inputs.length !== c.parameters.length || row.inputs.some(function(v,i){return !scalar(c.parameters[i],v);}) || !scalar(c.returns,row.expected)) fail('Malformed generated case');
    if (artifact.code !== render(c,m.inputs.cases) || Evidence.digest(artifact.integrity) !== Evidence.digest(integrity(m,artifact.code))) fail('Artifact code or manifest integrity mismatch');
    return true;
  }
  async function query(request, current, runtime) {
    request = Snapshot.dispatchCopy(request,8388608);
    var replayed = request && request.op === 'replay', descriptor = replayed && request.replay;
    if (replayed) {
      if (!descriptor || descriptor.version !== VERSION || descriptor.operation !== 'testCandidates') Snapshot.fail('INVALID_REPLAY','Unsupported test candidate replay');
      request = descriptor.request;
    }
    keys(request,['op','input','target','queryKey','witnessSha256','revision','callable','oracle','cases','fuzz','timeoutMs','budgets'],'candidate request');
    if (request.op !== 'testCandidates') fail('testCandidates operation required');
    // Normalize the dispatch-owned request before charging either path's copy.
    var input = request.input || {};
    if (!input.graph && !input.capture) {
      if (replayed) Snapshot.fail('INVALID_REPLAY','Candidate replay request binding failed');
      input.capture = {contentSha256:current};
    }
    request.input = input;
    var s = Snapshot.session(request,runtime), q = await s.copy(request,8388608);
    input = q.input;
    // Charge the same complete request hash before either path reserves child work.
    var requestHash = await s.hash(q);
    if (replayed && requestHash !== descriptor.requestHash) Snapshot.fail('INVALID_REPLAY','Candidate replay request binding failed');
    text(q.target,'target'); text(q.queryKey,'queryKey');
    var snapshot = await Snapshot.exportSide(input,q,runtime,s), side = snapshot.evidence;
    var operations = side.operations.filter(function (o) { return o.key === q.queryKey; });
    if (operations.length !== 1) fail('queryKey must select exactly one recomputed query');
    var operation = operations[0], selected = operation.result;
    var definitions = side.definitions.filter(function (d) { return d.procedure === q.target; });
    if (definitions.length !== 1) fail('target requires one captured side definition');
    if (selected.request.op === 'callPaths') {
      var endpoint = selected.endpoints && selected.endpoints.from, definition = definitions[0];
      if (!endpoint || endpoint.id !== selected.request.from || endpoint.procedureId !== q.target ||
          endpoint.bodyStatus !== 'captured' || endpoint.bodyAvailability !== 'available' ||
          !endpoint.ownership || endpoint.ownership.status !== 'exact' || endpoint.ownership.packageIds.length !== 1 ||
          !endpoint.packageId || endpoint.ownership.packageIds[0] !== endpoint.packageId ||
          definition.nodeId !== endpoint.id || definition.identity.procedureId !== endpoint.procedureId ||
          definition.scope.packageId !== endpoint.packageId || definition.identity.packageId !== endpoint.packageId ||
          definition.identity.functionId !== endpoint.functionId || definition.scope.buildUnitId !== endpoint.buildUnitId ||
          !definition.identity.rawNodeId || await s.hash(sourceFacts(definition.source)) !== await s.hash(sourceFacts(endpoint.source)))
        fail('callPaths root requires one exact captured endpoint/procedure identity with matching owner and source facts');
    } else if (selected.request.function !== q.target) fail('target must be the selected query exact root function');
    var revision = null;
    if (q.revision != null) {
      keys(q.revision,['before','after','mappings','packageMappings','equivalences','side','key'],'revision selection');
      if (!['before','after'].includes(q.revision.side) || q.revision.key !== q.queryKey) fail('revision requires exact side and matching query key');
      // The public comparator owns its own session. Reserve a disjoint ceiling
      // from this query so nested comparison cannot multiply the shared budget.
      var stats=s.stats(), child={maxWork:Math.max(1,Math.floor((s.limits.maxWork-stats.work)/2)),
        maxRetainedBytes:Math.max(1,Math.floor((s.limits.maxRetainedBytes-stats.retainedBytes)/2)),maxOutputBytes:s.limits.maxOutputBytes};
      var revisionRequest = {op:'compareRevisions',before:q.revision.before,after:q.revision.after,timeoutMs:q.timeoutMs,budgets:child};
      for (var name of ['mappings','packageMappings','equivalences']) if (q.revision[name] != null) revisionRequest[name] = q.revision[name];
      revision = await Revisions.compare(revisionRequest,Object.assign({},runtime,{cancelled:function(){s.check();return false;}}));
      await s.charge(child.maxWork); await s.tick(child.maxRetainedBytes);
      var revisionSide = q.revision[q.revision.side];
      if (revisionSide.inputHash !== snapshot.inputHash || revisionSide.evidenceHash !== snapshot.evidenceHash) fail('selected revision side must match the complete candidate input/query/model/capture pins');
      var changes = revision.changes.filter(function (c) { return c.key === q.revision.key; });
      revision = {side:q.revision.side,key:q.revision.key,comparison:revision,selectedChanges:changes,
        selectionStatus:changes.length === 1 ? 'exact-change' : 'no-unique-change'};
    }
    var diagnostics = [], unsupported = [], witness = null;
    var witnesses = selected.witnesses;
    if (q.witnessSha256 != null) {
      if (typeof q.witnessSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(q.witnessSha256)) fail('witnessSha256 requires an exact canonical SHA-256');
      var matches = [];
      for (var row of witnesses && witnesses.items || []) { await s.tick(); if (await s.hash(row) === q.witnessSha256) matches.push(row); }
      if (matches.length !== 1 || witnesses.truncated || witnesses.offset > 0 || matches[0].truncated) unsupported.push('Selected witness is missing, ambiguous, paged or truncated; no replacement was selected');
      else witness = matches[0];
    } else diagnostics.push('No exact witness selected; test inputs are query-level proposals');
    if (!operation.complete) diagnostics.push('Selected static query has incomplete coverage; no absence or feasibility conclusion');
    if (revision && revision.selectionStatus !== 'exact-change') unsupported.push('Selected revision query has no unique changed row');
    keys(q.callable,['kind','path','sourcePath','sourceSha256','parameters','returns','setup','provenance'],'callable declaration');
    var callable = q.callable;
    text(callable.provenance,'callable provenance');
    if (!relativePath(callable.sourcePath) || sourcePathConflict(callable.sourcePath)) fail('sourcePath must be a safe relative .rs path without traversal or reserved producer output collisions');
    if (!rustPath(callable.path)) fail('callable path must contain plain non-keyword Rust identifiers');
    if (typeof callable.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(callable.sourceSha256)) fail('sourceSha256 must pin supplied source bytes');
    if (callable.kind !== 'public-free-function') unsupported.push('Only caller-declared public free functions are supported');
    if (!Array.isArray(callable.parameters) || callable.parameters.length > 8 || callable.parameters.some(function(t){return !Object.prototype.hasOwnProperty.call(TYPES,t);}) || !Object.prototype.hasOwnProperty.call(TYPES,callable.returns)) unsupported.push('Signature requires at most eight supported scalar parameters and one scalar return');
    if (callable.setup !== 'none') unsupported.push('Dependencies, methods, async, generics, references and custom setup are unsupported');
    keys(q.oracle,['kind','parameter','value','provenance'],'oracle declaration'); text(q.oracle.provenance,'oracle provenance');
    if (!['cases','identity','constant'].includes(q.oracle.kind)) unsupported.push('Unsupported declared observable oracle');
    var cases = [], kind = q.fuzz == null ? 'regression' : 'bounded-input-fuzz';
    if (!unsupported.length) {
      if (q.oracle.kind === 'identity' && (!Number.isSafeInteger(q.oracle.parameter) || q.oracle.parameter < 0 || q.oracle.parameter >= callable.parameters.length || callable.parameters[q.oracle.parameter] !== callable.returns)) fail('identity oracle requires a same-type parameter');
      if (q.oracle.kind === 'constant' && !scalar(callable.returns,q.oracle.value)) fail('constant oracle value must match return type');
      function expected(inputs, supplied) { return q.oracle.kind === 'identity' ? inputs[q.oracle.parameter] : q.oracle.kind === 'constant' ? q.oracle.value : supplied; }
      if (q.fuzz != null) {
        keys(q.fuzz,['domains','maxCases','provenance'],'fuzz declaration'); text(q.fuzz.provenance,'fuzz provenance');
        if (q.oracle.kind === 'cases') fail('bounded fuzz requires identity or constant oracle');
        if (q.cases != null) fail('Choose explicit regression cases or bounded fuzz domains');
        if (!Number.isSafeInteger(q.fuzz.maxCases) || q.fuzz.maxCases < 1 || q.fuzz.maxCases > MAX_CASES || !Array.isArray(q.fuzz.domains) || q.fuzz.domains.length !== callable.parameters.length) fail('fuzz requires one finite domain per parameter and maxCases 1..4096');
        var count = 1;
        for (var i=0;i<q.fuzz.domains.length;i++) {
          var domain=q.fuzz.domains[i];
          if (!Array.isArray(domain) || !domain.length || domain.length > 256 || domain.some(function(v){return !scalar(callable.parameters[i],v);}) || new Set(domain).size !== domain.length) fail('Each domain needs 1..256 unique typed scalar seeds');
          count *= domain.length; if (count > q.fuzz.maxCases) fail('Cartesian domain exceeds declared case budget; nothing was silently sampled');
        }
        async function enumerate(values) {
          await s.tick();
          if (values.length === callable.parameters.length) { cases.push({inputs:values,expected:expected(values)}); return; }
          for (var value of q.fuzz.domains[values.length]) await enumerate(values.concat([value]));
        }
        await enumerate([]);
      } else {
        if (!Array.isArray(q.cases) || !q.cases.length || q.cases.length > MAX_CASES) fail('Regression requires 1..4096 explicit input cases');
        for (var item of q.cases) {
          await s.tick(); keys(item,['inputs','expected'],'regression case');
          if (!Array.isArray(item.inputs) || item.inputs.length !== callable.parameters.length || item.inputs.some(function(v,i){return !scalar(callable.parameters[i],v);})) fail('Inputs must match declared scalar signature');
          var value = expected(item.inputs,item.expected);
          if (!scalar(callable.returns,value) || item.expected != null && item.expected !== value) fail('Expected value must match declared oracle and return type');
          cases.push({inputs:item.inputs,expected:value});
        }
      }
    }
    diagnostics.push('Predicates are unsolved; no supplied seed is asserted to reach a static witness',
      'Opaque dependencies, unknown calls and setup gaps remain those of the complete recomputed query',
      'Callable signature, source binding and observable oracle are caller declarations',
      'Supplied source correspondence to the captured application is unknown; a new rustc test build is separate');
    var manifest = {schemaVersion:1,version:VERSION,kind:kind,state:'generated-unrun',executionObserved:false,
      support:{status:unsupported.length?'unsupported':'generated',reasons:unsupported,diagnostics:diagnostics},
      target:{captured:definitions[0],declaration:callable,capturedSourceCorrespondence:'unknown'},
      expectedBehavior:{basis:'caller-declared',oracle:q.oracle,findingReproduced:false},
      inputs:{basis:'caller-declared',cases:cases,fuzz:q.fuzz || null,reachingInputProven:false,branchFeasibilitySolved:false},
      evidence:{graph:side.graph,provenance:side.provenance,versions:side.versions,captureContexts:side.captureContexts,
        sideInputHash:snapshot.inputHash,sideEvidenceHash:snapshot.evidenceHash,query:operation,selectedWitness:witness,
        witnessSha256:witness?await s.hash(witness):null,revision:revision},
      harness:{convention:'rustc-test-std-only',file:'candidate.rs',compileArguments:['--edition=2021','--test','candidate.rs','-o','candidate-test'],
        runArguments:['--nocapture','--test-threads=1'],observationChannel:'inherited-fd-3-unix-v1',nativeCodeAuthenticated:false,completeCompilerInputs:false,coverageGuided:false},
      execution:{state:'generated-unrun',receipts:[],staticEvidenceIsExecution:false}};
    var code = unsupported.length ? '' : render(callable,cases);
    // Charge escaped wire bytes and retained strings before final result/replay materialization.
    manifest = await s.copy(manifest,s.limits.maxOutputBytes); await s.tick(code.length*2);
    var codeHasher=Evidence.hasher();for(var offset=0;offset<code.length;offset+=2048){await s.tick();codeHasher.update(code.slice(offset,offset+2048));}
    var artifact = {manifest:manifest,code:code,integrity:{algorithm:'sha256/canonical-json-v1',manifestSha256:await s.hash(manifest),
      codeSha256:codeHasher.digest('hex'),artifactSha256:await s.hash({manifest:manifest,code:code})}};
    var result = {schemaVersion:1,operation:'testCandidates',version:VERSION,replayed:replayed,artifact:artifact,
      semantics:{staticCandidate:true,executionObserved:false,findingReproduced:false,branchFeasibilitySolved:false},
      replay:{version:VERSION,operation:'testCandidates',requestHash:requestHash,request:q}};
    return await s.copy(result,s.limits.maxOutputBytes);
  }
  return {VERSION:VERSION,query:query,capability:capability,integrity:integrity,verifyArtifact:verifyArtifact};
});
