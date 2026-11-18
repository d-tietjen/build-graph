/* Versioned, bounded JSON evidence queries over a captured build-graph document. */
'use strict';
const Flow = require('./execution-flow.js');
const Model = require('./execution-model.js');
const Evidence = require('./analysis-evidence.js');
const CallGraph = require('./call-graph.js');
const SupplyChain = require('./supply-chain.js');
const EntryEffects = require('./entry-effects.js');
const CallPaths = require('./call-paths.js');
const Advisories = require('./advisory-exposure.js');
const Revisions = require('./revision-comparison.js');
const TestCandidates = require('./test-candidates.js');
const PerformanceMeasurements = require('./performance-measurements.js');
const CommentSearch = require('./comment-search.js');
const Programs = require('./program-queries.js');

const SCHEMA_VERSION = 1;
const MAX_PAGE = 100;
const DEFAULT_ANALYSIS_MS = 2000;
const MAX_ANALYSIS_MS = 5000;
function bad(code, message) { const error = new Error(message); error.code = code; return error; }
function string(value, field) {
  if (typeof value !== 'string' || !value) throw bad('INVALID_REQUEST', `${field} must be a nonempty string`);
  return value;
}
function page(items, request, key) {
  const config = request.page && request.page[key] || request.page || {};
  const offset = config.offset == null ? 0 : config.offset;
  const limit = config.limit == null ? 50 : config.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE)
    throw bad('INVALID_PAGE', `page ${key} requires offset >= 0 and limit 1..${MAX_PAGE}`);
  const slice = items.slice(offset, offset + limit);
  return { total: items.length, offset, limit, items: slice,
    nextOffset: offset + slice.length < items.length ? offset + slice.length : null,
    truncated: offset + slice.length < items.length };
}
function validatePage(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('INVALID_PAGE', 'page must be an object');
  const names = new Set(['offset', 'limit', 'nodes', 'edges', 'calls', 'callTargets',
    'packages', 'dependencies', 'functions', 'incoming', 'outgoing', 'entries', 'effects', 'witnesses', 'inventory', 'units', 'relationships', 'findings', 'unmatched', 'diagnostics', 'unknowns']);
  for (const [key, item] of Object.entries(value)) {
    if (!names.has(key)) throw bad('INVALID_PAGE', `unknown page field ${key}`);
    if (key !== 'offset' && key !== 'limit' && (typeof item !== 'object' || item === null || Array.isArray(item)))
      throw bad('INVALID_PAGE', `page ${key} must be an object`);
  }
}
function source(n) { return { source_file: n && n.source_file || null, source_location: n && n.source_location || null }; }
function limited(values) {
  const items = Array.isArray(values) ? values : [];
  return { total: items.length, items: items.slice(0, MAX_PAGE), truncated: items.length > MAX_PAGE };
}
function nativeEvidence(value, kind) {
  let rows = value, malformed = false;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = []; malformed = true; }
  }
  if (rows != null && !Array.isArray(rows)) { rows = []; malformed = true; }
  if (!rows) rows = [];
  const invalidRecords = rows.filter(row => !row || typeof row !== 'object' || Array.isArray(row) ||
    Object.values(row).some(value => value != null && typeof value !== 'string') ||
    (kind === 'direct' ? typeof row.target_id !== 'string' || !row.target_id || typeof row.evidence !== 'string' || !row.evidence :
      !(typeof row.reason === 'string' && row.reason || typeof row.evidence === 'string' && row.evidence))).length;
  // These fields contain graph IDs and artifact paths used in follow-up queries.
  // Bound the list, but preserve each identifier exactly.
  const stringField = v => typeof v === 'string' ? v : null;
  const items = rows.slice(0, MAX_PAGE).map(row => kind === 'direct' ? {
    address: stringField(row && row.address), symbol: stringField(row && row.symbol),
    targetId: stringField(row && row.target_id), evidence: stringField(row && row.evidence),
    sourceArtifact: stringField(row && row.source_artifact)
  } : { address: stringField(row && row.address), symbol: stringField(row && row.symbol),
    evidence: stringField(row && row.evidence), reason: stringField(row && row.reason) });
  return { total: rows.length, items, truncated: rows.length > MAX_PAGE,
    status: malformed || invalidRecords ? 'invalid' : value == null ? 'unknown' : 'observed',
    invalidRecords, diagnostic: malformed || invalidRecords ? 'Malformed native evidence; missing entries are unknown.' : null };
}
function nativeLibraries(value) {
  let rows = value, malformed = false;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = []; malformed = true; }
  }
  if (rows != null && !Array.isArray(rows)) { rows = []; malformed = true; }
  if (!rows) rows = [];
  return { ...limited(rows.filter(row => typeof row === 'string')),
    status: malformed || rows.some(row => typeof row !== 'string') ? 'invalid' : value == null ? 'unknown' : 'observed',
    invalidRecords: rows.filter(row => typeof row !== 'string').length };
}
function summaryCoverage(model, catalog, flow) {
  const c = model.coverage || {}, b = c.bodyMapping || {}, s = c.bodySymbols || {};
  return { partial: !!c.partial || catalog.coverage.catalogIncomplete || flow.errors.length > 0,
    bodyMapping: b, bodySymbols: s, nativeSymbols: c.nativeSymbols || {},
    nativePartial: !!c.nativePartial,
    callsiteResolution: c.callsiteResolution || {},
    unresolvedCalls: c.unresolvedCalls || 0, dynamicCalls: c.dynamicCalls || 0,
    opaqueBlocks: c.opaqueBlocks || 0, yieldBlocks: c.yieldBlocks || 0,
    unavailableBodyCount: (c.unavailable || []).length, modelErrorCount: (c.errors || []).length,
    nativeCallBoundaries: (model.calls || []).filter(call => call.nativeCall).length,
    flowErrorCount: flow.errors.length, packageCatalog: catalog.coverage };
}
function create(rawDoc, options = {}) {
  Evidence.validateGraph(rawDoc);
  const catalog = SupplyChain.build(rawDoc);
  const flow = Flow.catalog(rawDoc);
  const model = Model.build(rawDoc);
  const evidenceCore = Evidence.create(rawDoc, { ...options, model });
  const identity = evidenceCore.graph;
  const comments = CommentSearch.create({capture:identity,nodes:rawDoc.nodes,fetch:options.commentFetch});
  if(options.commentProvider)comments.configureProvider(options.commentProvider);
  Flow.applyModelTargets(flow, model);
  const callGraph = CallGraph.build(rawDoc, flow);
  const entryEffects = EntryEffects.build(rawDoc, { flow, model, callGraph, catalog });
  const callPaths = CallPaths.create(rawDoc, { model, callGraph });
  const advisories = Advisories.create(rawDoc, { paths: callPaths, entries: entryEffects.entries,
    buildExecution: entryEffects.buildExecution, entryCoverage: entryEffects.coverage, digest: Evidence.digest });
  const measurements = PerformanceMeasurements.create({ capture: identity, functions: () => callPaths.functions(), edges: callGraph.edges, calls: model.calls });
  const rawById = new Map(rawDoc.nodes.map(n => [n.id, n]));
  const rawFlowClaims = new Map();
  for (const node of rawDoc.nodes) {
    const a = node.attributes || {};
    if (a.kind !== 'flow_function') continue;
    let body;
    try { body = typeof a.flow === 'string' ? JSON.parse(a.flow) : a.flow; } catch (_) { continue; }
    if (!body || typeof body.function !== 'string') continue;
    if (!rawFlowClaims.has(body.function)) rawFlowClaims.set(body.function, []);
    rawFlowClaims.get(body.function).push({ node, functionId: body.function_id || null });
  }
  const rawFlowByProcedure = new Map();
  for (const p of model.procedures) {
    // Model copies these facts from its imported body. That body must be among
    // the claims; a unique match proves its raw ID without trusting input order.
    const matches = (rawFlowClaims.get(p.id) || []).filter(({ node, functionId }) => {
      const a = node.attributes;
      return (a.symbol_id || null) === p.symbol_id && functionId === p.function_id &&
        (a.package_id || null) === p.package_id && (a.crate || null) === p.crate &&
        (a.capture_scope || null) === p.capture_scope && (a.display_path || p.id) === p.display_path &&
        (node.source_file || null) === p.source_file && (node.source_location || null) === p.source_location;
    });
    if (matches.length === 1) rawFlowByProcedure.set(p.id, matches[0].node);
  }
  const byProjectionId = new Map(callGraph.nodes.map(n => [n.id, n]));
  const aliases = new Map(callGraph.aliases);
  const byProcedure = new Map(model.procedures.map(p => [p.id, p]));
  const byModelNode = new Map(model.nodes.map(n => [n.id, n]));
  const byModelEdge = new Map(model.edges.map(e => [e.id, e]));
  const byCall = new Map(model.calls.map(c => [c.id, c]));
  const coverage = summaryCoverage(model, catalog, flow);
  function selectedIds(request) {
    if (request.scope == null) return null;
    const s = request.scope;
    if (!s || !Array.isArray(s.packageIds) || !s.packageIds.every(x => typeof x === 'string') ||
        !['none', 'direct', 'transitive'].includes(s.dependencies || 'none'))
      throw bad('INVALID_SCOPE', 'scope requires packageIds array and dependencies none/direct/transitive');
    if (s.packageIds.length > 100) throw bad('INVALID_SCOPE', 'scope accepts at most 100 package IDs');
    const result = catalog.scope(s);
    result.packageIdSet = new Set(result.packageIds);
    return result;
  }
  function ownership(nodeOrId) { return catalog.ownership(nodeOrId); }
  function inScope(nodeOrId, selected) {
    return !selected || catalog.matches(nodeOrId, selected.packageIdSet);
  }
  function scopeCoverage(selected) {
    if (!selected) return null;
    const c = selected.coverage;
    return { catalogIncomplete: c.catalogIncomplete, invalidDependencies: c.invalidDependencies,
      invalidCaptureSummaries: c.invalidCaptureSummaries || 0,
      unknownPackageIds: limited(c.unknownPackageIds), ambiguousNodeIds: limited(c.ambiguousNodeIds),
      unknownOwnershipCount: c.unknownOwnershipCount };
  }
  function procedureIdentity(id) {
    const raw = rawFlowByProcedure.get(id), p = byProcedure.get(id);
    // Evidence's path index can retain a rejected earlier body. Use only the
    // proven raw ID, and leave ambiguous provenance unknown.
    const identity = { ...evidenceCore.describe(null, raw && raw.id), procedureId: id };
    if (raw) identity.functionId = raw.attributes.function_id && raw.attributes.function_id !== p.function_id ?
      null : p.function_id || identity.functionId;
    identity.unknownFields = ['packageId', 'buildUnitId', 'functionId', 'sourceDigest']
      .filter(key => identity[key] == null);
    return identity;
  }
  function capturedProcedure(node) {
    const paths = [...new Set(node.flowPaths || [])];
    if (paths.length !== 1) return null;
    const p = byProcedure.get(paths[0]), raw = p && rawFlowByProcedure.get(p.id);
    if (!raw || raw.attributes.path !== p.id ||
        raw.attributes.function_id && raw.attributes.function_id !== p.function_id) return null;
    const declaration = rawById.get(node.id), a = declaration && declaration.attributes || {};
    if (a.kind === 'function' || a.kind === 'method') {
      if (p.symbol_id !== node.id || a.package_id && a.package_id !== p.package_id) return null;
    } else if (raw.id !== node.id) return null;
    if (node.package_id && node.package_id !== p.package_id) return null;
    return p;
  }
  function functionRow(node, selected) {
    const owner = ownership(node), association = catalog.association(node);
    // Declaration paths can differ from their captured procedure paths.
    const p = capturedProcedure(node);
    const nativeBoundary = node.language === 'native' &&
      (node.kind === 'boundary' || !!node.native_boundary_kind);
    const implementationOwner = nativeBoundary ? { status: 'unknown', packageIds: [] } : owner;
    const bodyStatus = p ? 'captured' : node.body_status === 'native_disassembly' ?
      'native_disassembly' : 'unavailable';
    return { id: node.id, path: node.path, displayPath: node.display_path || node.path,
      classification: 'observed', identity: p ? procedureIdentity(p.id) : evidenceCore.describe(null, node.id),
      kind: node.kind, crate: node.crate || null,
      packageId: node.package_id || null, packageRole: node.package_role || null,
      captureScope: node.capture_scope || null,
      language: node.language || 'rust', boundaryKind: node.boundaryKind || node.native_boundary_kind ||
        (node.language === 'native' ? 'native_symbol' : null),
      nativeSymbol: node.native_symbol || null, nativeArtifact: node.native_artifact || null,
      nativeLibraryId: node.native_library_id || null,
      nativeDeclarationPackageId: node.native_declaration_package_id || null,
      nativeAbi: node.native_abi || null,
      nativeLinkLibraries: nativeLibraries(node.native_link_libraries),
      nativeCallOriginFlowId: node.native_call_origin_flow_id || null,
      nativeCallsiteBlock: node.native_callsite_block || null,
      nativeCallEvidence: node.native_call_evidence || null,
      nativeCallOriginArtifact: node.native_call_origin_artifact || null,
      nativeCallOriginLibraryId: node.native_call_origin_library_id || null,
      nativeCallOriginObjectMember: node.native_call_origin_object_member || null,
      nativeCallsiteAddress: node.native_callsite_address || null,
      nativeResolution: node.native_resolution || null,
      nativeCallCoverage: node.native_call_coverage || null,
      nativeAnalysisScope: node.native_analysis_scope || null,
      nativeInstructionSetStatus: node.native_instruction_set_status || null,
      nativeDiagnostic: node.native_diagnostic || null,
      nativeDirectCalls: nativeEvidence(node.native_direct_calls, 'direct'),
      nativeCallDiagnostics: nativeEvidence(node.native_call_diagnostics, 'diagnostic'),
      source: source(node), body: p ? { status: 'captured', procedure: p.id,
        blocks: p.nodeIds.length - 5 } : { status: bodyStatus, procedure: null, blocks: 0 },
      ownership: owner, packageAssociation: association,
      implementationOwnership: implementationOwner,
      outsideScope: !inScope(node, selected), unknownCalls: node.unknownCalls || 0 };
  }
  function edgeRow(edge, selected) {
    const target = byProjectionId.get(edge.target), src = byProjectionId.get(edge.source);
    const sourceOwner = src ? ownership(src) : { status: 'unknown', packageIds: [] };
    const targetOwner = target ? ownership(target) : { status: 'unknown', packageIds: [] };
    const targetAssociation = target ? catalog.association(target) :
      { role: 'owner', status: 'unknown', packageIds: [] };
    const targetImplementationOwner = target && target.language === 'native' &&
      (target.kind === 'boundary' || target.native_boundary_kind) ?
      { status: 'unknown', packageIds: [] } : targetOwner;
    const crossesPackage = sourceOwner.status === 'exact' && targetImplementationOwner.status === 'exact' ?
      sourceOwner.packageIds[0] !== targetImplementationOwner.packageIds[0] : null;
    return { source: edge.source, target: edge.target,
      classification: edge.kind === 'candidate' ? 'possible' : edge.kind === 'call' ? 'modeled' : edge.kind === 'native_call' ? 'observed' : 'unknown',
      sourcePath: src && src.path || null, targetPath: target && target.path || null,
      kind: edge.kind, execution: edge.kind !== 'candidate' && edge.kind !== 'loop',
      boundaryKind: edge.boundaryKind || target && (target.boundaryKind || target.native_boundary_kind) ||
        target && target.language === 'native' && 'native_symbol' || null,
      nativeCall: edge.native_call || null,
      calleePackageId: edge.callee_package_id || null,
      calleeArtifact: edge.callee_artifact || null, calleeAbi: edge.callee_abi || null,
      referenceKind: edge.referenceKind || null, relation: edge.relation || null,
      sourceLocation: source(edge), callsites: edge.callsites && edge.callsites.slice(0, 20).map(site => ({
        id: site.id, source: source(site), reference: site.reference || null,
        nativeCall: site.native_call || null })) || [],
      callsitesTotal: edge.callsites && edge.callsites.length || 0,
      sourceOwnership: sourceOwner, targetOwnership: targetOwner,
      targetPackageAssociation: targetAssociation,
      targetPackageRole: target && target.package_role || null,
      targetImplementationOwnership: targetImplementationOwner, crossesPackage,
      crossesScope: !!selected && !!src && inScope(src, selected) && (!target || !inScope(target, selected)) };
  }
  function context(procedure, selected) {
    const owner = ownership((rawFlowByProcedure.get(procedure) || {}).id);
    return { ownership: owner, outsideScope: !!selected &&
      !owner.packageIds.some(id => selected.packageIdSet.has(id)) };
  }
  function modelNode(n, selected) { return { id: n.id, procedure: n.procedure,
    classification: n.block ? 'compiler-confirmed' : 'modeled', identity: procedureIdentity(n.procedure),
    block: n.block, kind: n.kind, label: n.label,
    source: source(n), sourceSnippet: typeof n.source_snippet === 'string' ? n.source_snippet.slice(0, 500) : null,
    ...context(n.procedure, selected) }; }
  function modelEdge(e, selected) { return { id: e.id, procedure: e.procedure, from: e.from, to: e.to, kind: e.kind,
    classification: e.kind === 'start' ? 'modeled' : 'compiler-confirmed', identity: procedureIdentity(e.procedure),
    source: source(byModelNode.get(e.from)),
    label: e.label, action: e.action || null, guard: e.guard || null,
    callsite: e.callsite || null, ...context(e.procedure, selected) }; }
  function modelCall(c, selected) { return { id: c.id, procedure: c.procedure, from: c.from,
    classification: c.resolution === 'idMatched' ? 'compiler-confirmed' : c.possibleDispatch ? 'possible' : c.unknown ? 'unknown' : 'modeled',
    identity: procedureIdentity(c.procedure),
    source: source(byModelNode.get(c.from)), directKey: c.directKey || null,
    calleeId: c.calleeId || null, targetKeys: limited(c.targetKeys),
    calleePackageId: c.calleePackageId || null, calleeCrate: c.calleeCrate || null,
    calleeArtifact: c.calleeArtifact || null, calleeAbi: c.calleeAbi || null,
    nativeCall: c.nativeCall || null, nativeTargetIds: limited(c.nativeTargetIds || []),
    nativeResolution: c.nativeResolution || null,
    boundaryKind: c.boundaryKind || null,
    targets: limited(c.targets), possibleTargets: limited(c.possibleTargets), unavailableTargets: limited(c.unavailableTargets),
    ambiguousTargets: limited(c.ambiguousTargets.map(t => ({ key: t.key, candidates: limited(t.candidates) }))),
    resolution: c.resolution, unknown: c.unknown,
    idUnmatched: c.idUnmatched, idMismatch: c.idMismatch, legacyUnverified: c.legacyUnverified,
    possibleDispatch: c.possibleDispatch, possibleUnknown: c.possibleUnknown,
    callbackParameter: c.callbackParameter, normalContinuationIds: limited(c.normal),
    unwindContinuationIds: limited(c.unwind), tail: c.tail, ...context(c.procedure, selected) }; }
  const revisionContext = Revisions.admitCapture(rawDoc, { sha256: identity.sha256, source: identity.source });
  const revisionCaptures = new Map([[identity.contentSha256, revisionContext]]);
  // Baselines are admitted once into private owned state and resolved by content.
  if (options.revisionCaptures != null && (!Array.isArray(options.revisionCaptures) || options.revisionCaptures.length > 1)) throw bad('INVALID_REVISION', 'Provide at most one baseline capture beside the current candidate');
  for (const captured of options.revisionCaptures || []) {
    const hash = Evidence.digest(captured);
    if (hash !== identity.contentSha256) revisionCaptures.set(hash, Revisions.admitCapture(captured));
  }
  function registerRevisionCapture(hash, token) {
    // A content reference to the current capture retains its original byte/source pins.
    if (hash === identity.contentSha256) return;
    for (const key of revisionCaptures.keys()) if (key !== identity.contentSha256) revisionCaptures.delete(key);
    revisionCaptures.set(hash, token);
  }
  function revisionComparisonContract() {
    return { version: Revisions.VERSION, operations: ['exportRevision','compareRevisions','registerRevisionCapture'],
      inputModes: ['capture-content-reference','bounded-self-contained-graph'], referenceDataRequired: true,
      bundleInputBytes: 4194304, standaloneCaptureImportBytes: 536870912, standaloneCaptureImportMaxBytes: 1073741824,
      retainedBytes: 33554432, outputBytes: 8388608,
      captureAdmission: { nodes: 200000, edges: 1000000, values: 16000000, depth: 40, atomic: true,
        phases: ['parse','owned-structure','hash','indexes'], cancellationChecks: 'before-and-after', queryBudgetsApply: false },
      exportedRecords: { definitions: 2000, packages: 2000, dependencies: 5000 } };
  }
  async function query(request, runtime) {
    try {
      if (request && (request.op === 'programQuery' || request.op === 'replay' && request.replay && request.replay.plan && request.replay.plan.op === 'programQuery')) return await evidenceCore.queryProgram(request, runtime);
      if(request && (CommentSearch.operations.includes(request.op) || request.op==='replay' && request.replay && CommentSearch.operations.includes(request.replay.operation)))return await comments.query(request);
      if (request && (PerformanceMeasurements.operations.includes(request.op) || request.op === 'replay' && request.replay && PerformanceMeasurements.operations.includes(request.replay.operation)))
        return await measurements.query(request);
      if (request && (request.op === 'testCandidates' || request.op === 'replay' && request.replay && request.replay.operation === 'testCandidates'))
        return await TestCandidates.query(request, identity.contentSha256, { resolveCapture: hash => revisionCaptures.get(hash) });
      if (request && (['exportRevision','compareRevisions','registerRevisionCapture'].includes(request.op) || request.op === 'replay' && request.replay && ['exportRevision','compareRevisions'].includes(request.replay.operation)))
        return await Revisions.query(request, identity.contentSha256, { resolveCapture: hash => revisionCaptures.get(hash), registerCapture: registerRevisionCapture });
      const prepared = evidenceCore.prepare(request);
      request = prepared.request;
      function response(op, data) { return { schemaVersion: SCHEMA_VERSION, operation: op,
        ...evidenceCore.envelope(prepared),
        semantics: { basis: 'captured graph and imported MIR', branchFeasibilitySolved: false,
          vulnerabilityAbsenceProven: false }, ...data }; }
      const op = string(request.op, 'op');
      validatePage(request.page);
      const selected = selectedIds(request);
      if (op === 'schema') return response(op, { schema: { programQuery: Programs.schema(),
        request: { required: ['op'], optional: ['scope', 'page', 'function', 'pins', 'roots', 'timeoutMs', 'replay',
          'entryId', 'effectId', 'category', 'kind', 'includePossible', 'phase', 'waypoints', 'target', 'exclusions', 'budgets', 'from', 'to', 'snapshot', 'packageId',
          'raw', 'maxCaptureBytes', 'input', 'before', 'after', 'mappings', 'packageMappings', 'equivalences',
          'queryKey', 'witnessSha256', 'revision', 'callable', 'oracle', 'cases', 'fuzz', 'subjectMappings',
          'repositoryScope','index','previous','vectors','vectorProvenance','query','queryVector','queryProvenance','texts','nodeId','occurrenceId','kinds','limit'],
          scope: { packageIds: 'string[]', dependencies: ['none', 'direct', 'transitive'] },
          page: { offset: 'integer >= 0', limit: `integer 1..${MAX_PAGE}`, perListOverrides: true },
          operations: { capabilities: [], schema: [], packages: [], functions: [],
            exportRevision: [], compareRevisions: ['before','after'], registerRevisionCapture: ['raw'],
            programQuery: ['version:1','steps','return'], testCandidates: ['target','queryKey','callable','oracle','cases or fuzz'],
            indexComments:['repositoryScope'],loadCommentIndex:['repositoryScope','index'],searchComments:['repositoryScope','index','query'],commentDetails:['nodeId or occurrenceId'],embedComments:['repositoryScope','texts'],
            importMeasurements: ['input'], loadMeasurements: ['snapshot'], compareMeasurements: ['before','after'],
            callPaths: ['from', 'to'], advisoryExposure: ['snapshot'], neighbors: ['function'], cfg: ['function'], reachability: ['pins'], replay: ['replay'],
            buildInventory: [], entrypoints: [], effects: [], effectPaths: ['entryId, effectId or function'],
            orderedPath: ['function or entryId', 'waypoints and/or target'], valueFlow: ['function', 'model'], guardObligations: ['function', 'model'], failureObligations: ['function', 'model'], resourceRisks: ['function', 'model'] } },
        response: { envelope: ['schemaVersion', 'operation', 'graph', 'semantics', 'provenance', 'versions', 'request', 'replay', 'assumptions'],
          error: ['schemaVersion', 'graph', 'error.code', 'error.message'],
          pagedList: ['total', 'offset', 'limit', 'items', 'nextOffset', 'truncated'] },
        analysisTimeoutMs: { default: DEFAULT_ANALYSIS_MS, max: MAX_ANALYSIS_MS },
        revisionComparison: revisionComparisonContract(),
        testCandidates: TestCandidates.capability(),
        performanceMeasurements: PerformanceMeasurements.capability(),
        comments: CommentSearch.capability(),
        registerRevisionCapture: { raw: 'JSON capture text', maxCaptureBytes: { default: 536870912, min: 1, max: 1073741824 },
          reference: 'contentSha256; identical current content retains its admitted byte/source pins', replayable: false },
        buildExecution: { version: 'cargo-build-execution-v1', phases: ['build', 'application', 'dev-test', 'unknown'],
          evidenceKinds: ['declaration', 'modeled-capability', 'observed-build-evidence', 'unknown'],
          operation: 'buildInventory', identity: 'exact packageId + buildUnitId; unmatched correlation stays unknown',
          executionObserved: false, absenceProven: false },
        entryEffects: { schemaVersion: EntryEffects.VERSION, storage: 'nodes[].attributes.entry_effects (JSON string)',
          manifest: { schemaVersion: 1, adapters: 'array of {id, version, entries?, registrations?, summaries?}' },
          selector: 'exact {id} or {path, packageId}; all fields conjunctive; ambiguous matches rejected',
          entry: '{id, selector, kind, certainty?: modeled|possible}',
          registration: '{id, caller: selector, target: selector, kind?}; nonexecution reference',
          summary: '{id, selector, effects: [{category, operation}]}',
          categories: EntryEffects.CATEGORIES, witnessLimit: 100,
          limits: { adaptersPerManifest: 100, rulesPerList: 1000, effectsPerSummary: 20, callsitesPerRow: 20 } },
        orderedPath: { version: 'structural-ordered-v1', selector: '{kind: procedure|node|call, id: exact captured identity}',
          maxWaypoints: 16, maxExclusions: 100, repeatedWaypoints: 'distinct event visits',
          exclusions: 'prefix through final waypoint', rootEntryCounts: true,
          budgets: { maxWork: 2000000, maxStates: 50000, maxEvidence: 1000 }, defaultEvidence: 200 },
        valueFlow: { version: 'mir-values-v1', factVersion: 1, modelVersion: 1,
          request: '{op:valueFlow,function:exact procedure ID,model:{version:1,sources:[{id,at}],sinks:[{id,at}],summaries:[]}}',
          endpoint: '{call:exact callsite ID,port:argument|result,index?,fields?:field indices} or {procedure:exact procedure ID,port:parameter|return,index?,fields?}',
          summary: '{id,version:1,call:exact callsite ID,kind:transfer|sanitize,from:argument indices,to:result,referenceEffects:none|unknown}',
          limits: { rulesPerList: 100, modelBytes: 262144, fieldDepth: 16 }, replayIncludesCompleteModel: true },
        guardObligations: { version: 'guard-obligations-v1', factVersion: 1, modelVersion: 1,
          request: '{op:guardObligations,function:exact procedure ID,model:{version:1,rules:[{id,operation:{call,bindings},requires:[{id,at:{call,bindings},success:boolean}]}],summaries:[]}}',
          binding: '{name:{index:argument index,fields?:typed field indices}}; all subjects/values match by exact per-path identity',
          summary: '{id,version:1,call:exact callsite ID,returns:fresh|argument,argument?:index,effects:none}',
          scope: 'supported acyclic captured prefixes; loops/recursion/alias effects remain indeterminate', replayIncludesCompleteModel: true },
        resourceRisks: { version: 'resource-risks-v1', modelVersion: 1,
          request: '{op:resourceRisks,function:exact procedure ID,actors:[],model:{version:1,provenance,sources:[],operations:[],guardBounds:[],loopBounds:[],summaries:[]}}',
          semantics: 'Explicit typed resource/cost/bound/shared-lock assumptions over bounded representative paths; static candidates, never measured hotspots or deadlock proof' },
        failureObligations: { version: 'failure-obligations-v1', modelVersion: 1,
          model: '{version:1,provenance,rules:[{id,states,initial,terminal:{normal,error,unwind,cancel,drop},transitions:[{id,call,outcome:normal|unwind,subject:{port:argument|result,index?,fields?},from,to}]}],summaries:[],outcomes:[]}',
          summary: '{id,version:1,call,outcomes:[normal|unwind],returns:fresh|argument|unknown,argument?,effects:declared-protocol-only}',
          outcome: '{id,node:exact accepted node ID|edge:exact accepted edge ID,outcome:normal|error|unwind|cancel|drop}; edge outcomes normal/error only',
          scope: 'declared finite protocols; bounded loops and opaque paths remain unknown', replayIncludesCompleteModel: true },
        reachability: { pinsOrdered: false,
          mode: 'unordered AND co-occurrence in captured structural execution' } } });
      if (op === 'capabilities') return response(op, {
        programQuery: evidenceCore.programCapability(),
        revisionComparison: revisionComparisonContract(),
        testCandidates: TestCandidates.capability(),
        performanceMeasurements: PerformanceMeasurements.capability(),
        comments: CommentSearch.capability(),
        operations: [...CommentSearch.operations, 'programQuery', 'importMeasurements', 'loadMeasurements', 'compareMeasurements', 'testCandidates', 'exportRevision', 'compareRevisions', 'registerRevisionCapture', 'capabilities', 'schema', 'packages', 'functions', 'neighbors', 'cfg', 'reachability', 'replay',
          'buildInventory', 'entrypoints', 'effects', 'effectPaths', 'orderedPath', 'callPaths', 'advisoryExposure', 'valueFlow', 'guardObligations', 'failureObligations', 'resourceRisks'],
        callPaths: { version: CallPaths.VERSION, endpoints: 'exact functions[].id', completeFiniteSubgraph: true, defaultIncludePossible: true, globalBindingsInvocationExact: false },
        advisoryExposure: { version: Advisories.VERSION, localSnapshotsOnly: true, snapshotInReplay: true, maxSnapshotCharacters: 1048576 },
        entryEffects: { version: EntryEffects.VERSION, summaryVersion: EntryEffects.SUMMARY_VERSION,
          categories: EntryEffects.CATEGORIES, coverage: JSON.parse(JSON.stringify(entryEffects.coverage)),
          adapters: entryEffects.adapters, orderedExecution: false, externalActivationProven: false },
        buildExecution: { version: 'cargo-build-execution-v1', coverage: JSON.parse(JSON.stringify(entryEffects.buildExecution.coverage)),
          phases: ['build', 'application', 'dev-test', 'unknown'], executionObserved: false },
        valueFlow: evidenceCore.valueCapability, guardObligations: evidenceCore.guardCapability, failureObligations: JSON.parse(JSON.stringify(evidenceCore.failureCapability)), resourceRisks: JSON.parse(JSON.stringify(evidenceCore.resourceCapability)),
        orderedPath: { version: 'structural-ordered-v1', basis: 'STRUCTURAL reachability',
          explicitRootRequired: true, waypointOrderPreserved: true, exclusions: true },
        evidence: { version: Evidence.VERSION, captureReplay: true, orderedPaths: true,
          branchFeasibility: false, sourceRevision: evidenceCore.provenance.sourceRevision.status,
          target: evidenceCore.provenance.target.status, features: evidenceCore.provenance.features.status,
          toolchain: evidenceCore.provenance.toolchain.status },
        limits: { maxPage: MAX_PAGE, maxPins: 16, defaultAnalysisMs: DEFAULT_ANALYSIS_MS,
          maxAnalysisMs: MAX_ANALYSIS_MS },
        reachability: { pinsOrdered: false,
          mode: 'unordered AND co-occurrence in captured structural execution' }, coverage,
        scope: scopeCoverage(selected) });
      if (op === 'packages') {
        const packages = selected ? catalog.packages.filter(p => selected.packageIdSet.has(p.id)) : catalog.packages;
        const dependencies = selected ? catalog.dependencies.filter(d => selected.packageIdSet.has(d.source)) : catalog.dependencies;
        return response(op, { packages: page(packages, request, 'packages'),
          dependencies: page(dependencies, request, 'dependencies'),
          scope: scopeCoverage(selected), coverage });
      }
      if (op === 'functions') {
        const rows = callGraph.nodes.filter(n => inScope(n, selected))
          .map(n => functionRow(n, selected)).sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
        return response(op, { functions: page(rows, request, 'functions'),
          scope: scopeCoverage(selected), coverage });
      }
      if (op === 'callPaths') return await callPaths.query(prepared.replayed ? { op: 'replay', replay: evidenceCore.envelope(prepared).replay } : request, evidenceCore);
      if (op === 'advisoryExposure') return await advisories.query(prepared.replayed ? { op: 'replay', replay: evidenceCore.envelope(prepared).replay } : request, evidenceCore);
      if (op === 'entrypoints' || op === 'effects' || op === 'effectPaths' || op === 'buildInventory') {
        const result = entryEffects.query(prepared.replayed ? { op: 'replay', replay: evidenceCore.envelope(prepared).replay } : request,
          evidenceCore, { packageIds: selected && selected.packageIds });
        return { ...result,
          scope: selected ? { role: 'view context; full captured graph traversed including cross-package intermediaries',
            packageIds: limited(selected.packageIds), coverage: scopeCoverage(selected) } : null };
      }
      if (op === 'resourceRisks') { return await evidenceCore.analyzeResources(prepared); }
      if (op === 'failureObligations') {
        return await evidenceCore.analyzeFailures(prepared);
      }
      if (op === 'guardObligations') {
        const result = await evidenceCore.analyzeGuards(prepared);
        return { ...result, scope: selected ? { role: 'view context; full captured guard prefixes traversed', packageIds: limited(selected.packageIds) } : null };
      }
      if (op === 'valueFlow') {
        const result = await evidenceCore.analyzeValues(prepared);
        return { ...result, scope: selected ? { role: 'view context; complete captured value graph traversed', packageIds: limited(selected.packageIds) } : null };
      }
      if (op === 'orderedPath') {
        const result = await evidenceCore.analyzeOrdered(prepared, { entries: entryEffects.entries });
        return { ...result, coverage,
          scope: selected ? { role: 'view context; full captured model traversed including cross-package intermediaries',
            packageIds: limited(selected.packageIds), coverage: scopeCoverage(selected) } : null };
      }
      if (op === 'neighbors') {
        const key = string(request.function, 'function');
        const id = byProjectionId.has(key) ? key : aliases.get(key);
        const center = byProjectionId.get(id);
        if (!center) throw bad('UNKNOWN_FUNCTION', `unknown function ${key}`);
        const outgoing = callGraph.edges.filter(e => e.source === id).map(e => edgeRow(e, selected))
          .sort((a, b) => a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
        const incoming = callGraph.edges.filter(e => e.target === id).map(e => edgeRow(e, selected))
          .sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
        return response(op, { center: functionRow(center, selected),
          outgoing: page(outgoing, request, 'outgoing'), incoming: page(incoming, request, 'incoming'),
          scope: scopeCoverage(selected), coverage });
      }
      if (op === 'cfg') {
        const id = string(request.function, 'function');
        const procedure = byProcedure.get(id);
        if (!procedure) {
          const projected = byProjectionId.get(id) || byProjectionId.get(aliases.get(id));
          if (!projected) throw bad('UNKNOWN_PROCEDURE', `no captured MIR procedure ${id}`);
          const boundary = functionRow(projected, selected);
          return response(op, { procedure: null, boundary,
            diagnostics: [boundary.body.procedure ? `Captured MIR is available under procedure ID ${boundary.body.procedure}.` :
              'No unique captured MIR procedure is available for this callable.'],
            nodes: page([], request, 'nodes'), edges: page([], request, 'edges'),
            calls: page([], request, 'calls'), coverage });
        }
        const nodes = procedure.nodeIds.map(id => byModelNode.get(id)).filter(Boolean).map(n => modelNode(n, selected));
        const edges = model.edges.filter(e => e.procedure === id).map(e => modelEdge(e, selected));
        const calls = model.calls.filter(c => c.procedure === id).map(c => modelCall(c, selected));
        return response(op, { procedure: { id, displayPath: procedure.display_path || id,
          entry: procedure.entry, exits: {
          normal: procedure.normalExit, unwind: procedure.unwindExit,
          terminate: procedure.terminateExit, unreachable: procedure.unreachableExit },
          source: source(procedure), packageId: procedure.package_id, identity: procedureIdentity(id),
          captureScope: procedure.capture_scope, bodyStatus: procedure.body_status,
          ownership: ownership((rawFlowByProcedure.get(id) || {}).id),
          outsideScope: selected ? !catalog.matches((rawFlowByProcedure.get(id) || {}).id,
            selected.packageIds) : false },
          nodes: page(nodes, request, 'nodes'), edges: page(edges, request, 'edges'),
          calls: page(calls, request, 'calls'), coverage });
      }
      if (op === 'reachability') {
        const pins = request.pins;
        if (!Array.isArray(pins) || !pins.length || pins.length > 16 || !pins.every(p => typeof p === 'string' && p))
          throw bad('INVALID_PINS', 'pins requires 1..16 procedure IDs');
        const roots = request.roots;
        if (roots != null && !(typeof roots === 'string' || Array.isArray(roots) && roots.every(r => typeof r === 'string')))
          throw bad('INVALID_ROOTS', 'roots must be a procedure ID or array');
        const explicitRoots = roots == null ? [] : typeof roots === 'string' ? [roots] : roots;
        if (roots != null && !explicitRoots.length) throw bad('INVALID_ROOTS', 'roots must contain at least one procedure');
        if (explicitRoots.length > 100) throw bad('INVALID_ROOTS', 'roots accepts at most 100 procedures');
        const unknownRoots = explicitRoots.filter(r => !byProcedure.has(r));
        if (unknownRoots.length) throw bad('UNKNOWN_PROCEDURE', `unknown root procedure ${unknownRoots[0]}`);
        const timeoutMs = request.timeoutMs == null ? DEFAULT_ANALYSIS_MS : request.timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_ANALYSIS_MS)
          throw bad('INVALID_TIMEOUT', `timeoutMs must be an integer 1..${MAX_ANALYSIS_MS}`);
        const missing = pins.filter(p => !byProcedure.has(p));
        const missingPinDetails = missing.map(pin => {
          const projected = byProjectionId.get(pin) || byProjectionId.get(aliases.get(pin));
          return projected ? functionRow(projected, selected) :
            { id: null, path: pin, boundaryKind: 'uncaptured_callee',
              body: { status: 'unavailable', procedure: null, blocks: 0 },
              ownership: { status: 'unknown', packageIds: [] } };
        });
        const result = await evidenceCore.analyze(prepared);
        const nodeIds = result.activeNodeIds.slice().sort(), edgeIds = result.activeEdgeIds.slice().sort();
        const callIds = result.activeCallIds.slice().sort(), targets = result.activeCallTargets.slice().sort();
        const outsideNodeCount = selected ? nodeIds.filter(id => {
          const n = byModelNode.get(id); return n && context(n.procedure, selected).outsideScope;
        }).length : 0;
        return response(op, { pins, pinsOrdered: false,
          reachabilityMode: 'unordered AND co-occurrence in captured structural execution',
          roots: limited(result.roots), status: result.status,
          partialCoverage: result.partialCoverage,
          queryCoverage: result.queryCoverage, completion: result.completion, finding: result.finding,
          evidenceLinks: result.evidenceLinks,
          diagnostics: result.diagnostics.slice(0, 30), diagnosticsTotal: result.diagnostics.length,
          missingPins: missing, missingPinDetails, branchFeasibilitySolved: false,
          scope: selected ? { role: 'evidence context only; full captured graph analyzed',
            packageIds: limited(selected.packageIds), outsideScopeEvidenceNodes: outsideNodeCount,
            outsideScopePins: pins.filter(id => context(id, selected).outsideScope),
            coverage: scopeCoverage(selected) } : null,
          evidence: { nodes: page(nodeIds.map(id => byModelNode.get(id)).filter(Boolean).map(n => modelNode(n, selected)), request, 'nodes'),
            edges: page(edgeIds.map(id => byModelEdge.get(id)).filter(Boolean).map(e => modelEdge(e, selected)), request, 'edges'),
            calls: page(callIds.map(id => byCall.get(id)).filter(Boolean).map(c => modelCall(c, selected)), request, 'calls'),
            callTargets: page(targets, request, 'callTargets') }, coverage });
      }
      throw bad('UNKNOWN_OPERATION', `unknown operation ${op}`);
    } catch (error) {
      return { schemaVersion: SCHEMA_VERSION, graph: identity,
        error: { code: error.code || 'INTERNAL_ERROR', message: error.message } };
    }
  }
  return { schemaVersion: SCHEMA_VERSION, graph: { ...identity }, catalog, query };
}
module.exports = { SCHEMA_VERSION, create };
