#!/usr/bin/env node
// Audit the exact unlaid-out Function graph built by the viewer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExecutionFlow = require('../src/execution-flow.js');
const CallGraph = require('../src/call-graph.js');
const ExecutionModel = require('../src/execution-model.js');
const ArchitectureOrganization = require('../src/architecture-organization.js');

const SAMPLE_LIMIT = 5;
function sorted(values) { return [...values].sort((a, b) => String(a).localeCompare(String(b))); }
function sample(values) { return { count: values.length, sample: values.slice(0, SAMPLE_LIMIT),
  sampleLimit: SAMPLE_LIMIT, omitted: Math.max(0, values.length - SAMPLE_LIMIT) }; }
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--graph', '--source-root', '--out'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error('Usage: node scripts/audit-call-graph.cjs --graph <graph.json> [--source-root <root>] --out <directory>');
    args[key.slice(2)] = argv[++i];
  }
  if (!args.graph || !args.out) throw new Error('Both --graph and --out are required.');
  return args;
}
function sourceIndex(root, wanted) {
  if (!root) return null;
  const base = path.resolve(root), names = [], errors = [], excluded = new Set(['.git', 'target', 'node_modules']);
  if (!fs.statSync(base).isDirectory()) throw new Error(`Source root is not a directory: ${base}`);
  function visit(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { errors.push({ path: path.relative(base, dir), error: error.message }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.rs')) names.push(full);
    }
  }
  visit(base);
  const tokens = new Map(), digest = crypto.createHash('sha256');
  for (const file of names) {
    let data;
    try { data = fs.readFileSync(file); }
    catch (error) { errors.push({ path: path.relative(base, file), error: error.message }); continue; }
    const relative = path.relative(base, file).split(path.sep).join('/');
    digest.update(relative).update('\0').update(data).update('\0');
    const lines = data.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const namesOnLine = new Set(line.match(/[A-Za-z_][A-Za-z_0-9]*/g) || []);
      namesOnLine.forEach(name => {
        if (!wanted.has(name)) return;
        if (!tokens.has(name)) tokens.set(name, { count: 0, sample: [], sampleLimit: SAMPLE_LIMIT });
        const evidence = tokens.get(name);
        evidence.count++;
        if (evidence.sample.length < SAMPLE_LIMIT) evidence.sample.push({ file: relative, line: i + 1 });
      });
    });
  }
  return { root: base, filesScanned: names.length, treeSha256: digest.digest('hex'), errors,
    tokens, scope: 'All readable .rs files recursively, excluding .git, target, and node_modules. Counts are identifier-containing lines (repetitions on one line count once); tokens include declarations, comments, strings, and unrelated owners.' };
}
function auditGraph(graph, input, sourceRoot) {
  const index = ExecutionFlow.catalog(graph);
  const overview = CallGraph.build(graph, index);
  const model = ExecutionModel.build(graph);
  const projection = ArchitectureOrganization.project(overview, model);
  const aliases = projection.aliases;
  const callables = projection.nodes.filter(node => ['function', 'method', 'closure'].includes(node.kind))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rawFlows = new Map(), rawCallable = new Map();
  for (const node of graph.nodes || []) {
    const attrs = node.attributes || {};
    if (attrs.kind === 'flow_function' && typeof attrs.path === 'string') {
      if (!rawFlows.has(attrs.path)) rawFlows.set(attrs.path, []);
      rawFlows.get(attrs.path).push(node);
    }
    if (attrs.kind === 'function' || attrs.kind === 'method') rawCallable.set(node.id, node);
  }
  const pathNodes = new Map(), idNodes = new Map();
  function add(map, key, value) {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  }
  for (const node of callables) {
    add(pathNodes, node.path, node.id);
    for (const flowPath of node.flowPaths || []) {
      add(pathNodes, flowPath, node.id);
      for (const raw of rawFlows.get(flowPath) || []) {
        let flowId = raw.attributes.function_id;
        if (!flowId) {
          try {
            const flow = typeof raw.attributes.flow === 'string' ?
              JSON.parse(raw.attributes.flow) : raw.attributes.flow;
            flowId = flow && flow.function_id;
          } catch (_) { /* separately reported */ }
        }
        if (typeof flowId === 'string') add(idNodes, flowId, node.id);
      }
    }
  }
  const evidence = new Map(callables.map(node => [node.id, {
    outgoing: [], incomingId: [], incomingPath: [], incomingAmbiguousId: [],
    incomingTextConflict: [], incomingCallbackReference: [], rawCallEdges: []
  }]));
  const rawNodeKinds = new Map((graph.nodes || []).map(node => [node.id,
    node.attributes && node.attributes.kind || null]));
  const rawCallEdges = (graph.edges || []).filter(edge => edge.relation === 'calls' || edge.relation === 'member_calls');
  rawCallEdges.forEach(edge => {
    for (const id of [edge.source, edge.target]) {
      if (evidence.has(id)) evidence.get(id).rawCallEdges.push({ source: edge.source, target: edge.target,
        sourceKind: rawNodeKinds.get(edge.source) || null, targetKind: rawNodeKinds.get(edge.target) || null,
        sourceProjectedCallable: evidence.has(edge.source), targetProjectedCallable: evidence.has(edge.target),
        relation: edge.relation });
    }
  });
  let rawCallsites = 0;
  index.functions.forEach(fn => {
    const sourceId = aliases.get(fn.path);
    fn.blocks.forEach(block => {
      if (block.kind !== 'call' && block.kind !== 'tail_call') return;
      rawCallsites++;
      const site = { caller: fn.path, block: block.id,
        source_file: block.source_file || null, source_location: block.source_location || null,
        callee: typeof block.callee === 'string' ? block.callee : null,
        callee_id: typeof block.callee_id === 'string' ? block.callee_id : null };
      if (sourceId && evidence.has(sourceId)) evidence.get(sourceId).outgoing.push(site);
      const ids = block.callee_id ? idNodes.get(block.callee_id) : null;
      if (ids && ids.size === 1) {
        const target = ids.values().next().value;
        if (target !== sourceId) evidence.get(target).incomingId.push(site);
      } else if (ids) {
        ids.forEach(target => { if (target !== sourceId) evidence.get(target).incomingAmbiguousId.push(site); });
      }
      const textIds = block.callee ? pathNodes.get(block.callee) : null;
      if (textIds) textIds.forEach(target => {
        if (target === sourceId) return;
        if (block.callee_id) {
          if (!ids || !ids.has(target)) evidence.get(target).incomingTextConflict.push(site);
        } else if (textIds.size === 1) evidence.get(target).incomingPath.push(site);
      });
      for (const arg of block.callback_args || []) for (const targetPath of arg.targets || []) {
        for (const target of pathNodes.get(targetPath) || []) if (target !== sourceId)
          evidence.get(target).incomingCallbackReference.push({ ...site, argument_index: arg.index, kind: 'fn_reference' });
      }
      for (const ref of block.callback_references || []) for (const target of ref.targets || []) {
        const targets = target.function_id ? idNodes.get(target.function_id) : pathNodes.get(target.function);
        for (const targetId of targets || []) if (targetId !== sourceId)
          evidence.get(targetId).incomingCallbackReference.push({ ...site, argument_index: ref.index,
            kind: ref.kind || 'trait_reference', trait_id: ref.trait_id || null,
            target_function_id: target.function_id || null });
      }
    });
  });
  const incidents = new Map(callables.map(node => [node.id, []]));
  projection.edges.forEach(edge => {
    if (incidents.has(edge.source)) incidents.get(edge.source).push(edge);
    if (edge.target !== edge.source && incidents.has(edge.target)) incidents.get(edge.target).push(edge);
  });
  const overviewLoops = new Map();
  overview.edges.filter(edge => edge.kind === 'loop').forEach(edge => {
    overviewLoops.set(edge.source, (overviewLoops.get(edge.source) || 0) + 1);
  });
  const wanted = new Set(callables.filter(node => incidents.get(node.id).length === 0)
    .map(node => String(node.path || '').split('::').pop())
    .filter(name => /^[A-Za-z_][A-Za-z_0-9]*$/.test(name)));
  const scan = sourceIndex(sourceRoot, wanted);
  const isolated = [], counts = { totalCallables: callables.length,
    noCapturedCaller: 0, noCapturedDirectMirCaller: 0, isolated: 0,
    withReferenceOnly: 0, overviewLoopOnlyIsolated: 0, rawCallsites,
    overviewEdges: overview.edges.length, projectedEdges: projection.edges.length };
  for (const node of callables) {
    const ev = evidence.get(node.id), incident = incidents.get(node.id);
    if (!ev.incomingId.length) counts.noCapturedDirectMirCaller++;
    if (!incident.some(edge => edge.target === node.id && edge.execution)) counts.noCapturedCaller++;
    if (incident.length && incident.every(edge => edge.kind === 'reference')) counts.withReferenceOnly++;
    if (incident.length) continue;
    if (overviewLoops.has(node.id)) counts.overviewLoopOnlyIsolated++;
    const validFlows = (node.flowPaths || []).filter(p => index.functions.has(p));
    const rawFlowPaths = node.flowPaths || [];
    const rich = rawCallable.get(node.id), bodyFlag = rich && rich.attributes && rich.attributes.has_body;
    const kinds = {}, callsites = [];
    for (const p of validFlows) index.functions.get(p).blocks.forEach(block => {
      kinds[block.kind || 'opaque'] = (kinds[block.kind || 'opaque'] || 0) + 1;
      if (block.kind === 'call' || block.kind === 'tail_call') callsites.push(block);
    });
    const opaque = validFlows.length && Object.keys(kinds).length === 1 && kinds.opaque;
    const availability = validFlows.length ? opaque ? 'opaque_body' : 'captured_body' :
      rawFlowPaths.length ? 'invalid_or_uncataloged_body' : bodyFlag === 'false' ? 'declaration_no_body' : 'missing_body';
    let reason = availability;
    if (ev.incomingId.length) reason = 'projection_gap_incoming_id';
    else if (ev.incomingTextConflict.length) reason = 'identity_conflict_text_evidence';
    else if (ev.rawCallEdges.some(edge => edge.sourceProjectedCallable && edge.targetProjectedCallable))
      reason = 'callable_raw_edge_discrepancy';
    else if (ev.rawCallEdges.length && ev.rawCallEdges.every(edge =>
      edge.target === node.id && !edge.sourceProjectedCallable)) reason = 'noncallable_caller_context';
    else if (ev.rawCallEdges.length) reason = 'noncallable_endpoint_context';
    else if (callsites.some(b => typeof b.callee === 'string' && b.callee)) reason = 'projection_gap_named_outgoing';
    else if (overviewLoops.has(node.id)) reason = 'control_flow_loop_only';
    else if (availability === 'captured_body' && callsites.length) reason = 'captured_dynamic_calls_no_visible_target';
    else if (availability === 'captured_body') reason = 'captured_leaf_no_captured_caller';
    const leaf = String(node.path || '').split('::').pop();
    const lexical = scan && /^[A-Za-z_][A-Za-z_0-9]*$/.test(leaf) ?
      scan.tokens.get(leaf) || { count: 0, sample: [], sampleLimit: SAMPLE_LIMIT } : null;
    if (lexical) lexical.omitted = Math.max(0, lexical.count - lexical.sample.length);
    isolated.push({ id: node.id, kind: node.kind, path: node.path,
      source_file: node.source_file || null, source_location: node.source_location || null,
      reason, body: { availability, declaredHasBody: bodyFlag === 'true' ? true : bodyFlag === 'false' ? false : null,
        flowPaths: rawFlowPaths, validFlowPaths: validFlows, blockCount: Object.values(kinds).reduce((a, b) => a + b, 0),
        blockKinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => a[0].localeCompare(b[0]))) },
      evidence: { rawOutgoingCallsites: { ...sample(ev.outgoing),
        observedInValidBodies: validFlows.length > 0 }, incomingId: sample(ev.incomingId),
        incomingLegacyPath: sample(ev.incomingPath), incomingAmbiguousId: sample(ev.incomingAmbiguousId),
        incomingConflictingText: sample(ev.incomingTextConflict),
        incomingCallbackReferences: sample(ev.incomingCallbackReference),
        rawCallEdges: sample(ev.rawCallEdges), overviewLoopEdges: overviewLoops.get(node.id) || 0,
        lexicalIdentifier: lexical },
      uncertainty: ['Isolation is not proof of unused code.',
        'External dependencies, dynamic dispatch, build configuration, and macro expansion can hide callers.',
        ...(lexical ? ['Identifier-containing lines are lexical and do not establish owner or caller identity.'] : [])] });
  }
  counts.isolated = isolated.length;
  const reasonCounts = {};
  isolated.forEach(item => { reasonCounts[item.reason] = (reasonCounts[item.reason] || 0) + 1; });
  return { version: 1, input, scope: {
    projection: 'ExecutionFlow.catalog + CallGraph.build + ExecutionModel.build + ArchitectureOrganization.project, without layout; zero-edge means no incident final Function-view edge of any kind. MIR control-flow loop self-edges are overview evidence and are not final Function-view edges.',
    noCapturedCaller: 'Matches the viewer: no incoming final projected edge with execution=true, including recursion self-calls and uncertain possible dispatch; references and MIR control-flow loops are excluded.',
    noCapturedDirectMirCaller: 'No non-self raw MIR callsite with a unique authoritative compiler ID match. Legacy path text is separate triage evidence.',
    missingBody: 'No valid compiler body is linked to this displayed symbol; capture, mapping, or build-scope gaps remain possible.',
    sourceScan: scan ? { root: scan.root, filesScanned: scan.filesScanned, treeSha256: scan.treeSha256,
      scope: scan.scope, errors: scan.errors } : null,
    evidenceSamples: `All isolated callables are reported. Each evidence list has an exact count and at most ${SAMPLE_LIMIT} sample locations.` },
    counts, reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort((a, b) => a[0].localeCompare(b[0]))),
    catalogErrors: index.errors, modelErrors: model.coverage.errors,
    modelUnavailableBodies: model.coverage.unavailable, isolated };
}
function markdown(report) {
  const { counts } = report;
  const rows = report.isolated.map(item => `| ${item.reason} | \`${item.path.replace(/\|/g, '\\|')}\` | ${item.body.availability} | ${item.body.blockCount} | ${item.evidence.rawOutgoingCallsites.count} | ${item.evidence.incomingId.count}/${item.evidence.incomingLegacyPath.count} | ${item.source_file || '—'}:${item.source_location || '—'} |`);
  return `# Function graph zero-edge audit\n\nInput: \`${report.input.path}\`  \nSHA-256: \`${report.input.sha256}\`\n\n` +
    `Callables: **${counts.totalCallables}**; no captured caller in the final Function view: **${counts.noCapturedCaller}**; zero incident edges: **${counts.isolated}**. ` +
    `No direct MIR caller confirmed by compiler ID: **${counts.noCapturedDirectMirCaller}**. ` +
    `Reference-only: ${counts.withReferenceOnly}; isolated with overview MIR loop evidence: ${counts.overviewLoopOnlyIsolated}.\n\n` +
    `A zero-edge node is not necessarily unused. Missing body means no valid compiler body is linked to the displayed symbol; capture, mapping, or build-scope gaps remain possible. Compiler IDs establish direct target identity; path text and source identifiers are triage evidence only. ` +
    `External bodies, dynamic dispatch, macros, and build configuration can hide callers. ` +
    (report.scope.sourceScan ? `Source scan: ${report.scope.sourceScan.filesScanned} Rust files under \`${report.scope.sourceScan.root}\`; tree SHA-256 \`${report.scope.sourceScan.treeSha256}\`. It is lexical and may not match the captured revision.\n\n` : '\n\n') +
    `## Reasons\n\n` + Object.entries(report.reasonCounts).map(([name, count]) => `- ${name}: ${count}`).join('\n') +
    `\n\n## Every isolated callable\n\n| Reason | Callable | Body | Blocks | Outgoing MIR calls | Incoming ID/path | Source |\n| --- | --- | --- | ---: | ---: | ---: | --- |\n` +
    rows.join('\n') + '\n\nDetailed evidence, uncertainty, catalog errors, and uncapped counts are in the JSON file.\n';
}
function main(argv) {
  const args = parseArgs(argv);
  const graphPath = path.resolve(args.graph), data = fs.readFileSync(graphPath);
  const report = auditGraph(JSON.parse(data), { path: graphPath,
    sha256: crypto.createHash('sha256').update(data).digest('hex') }, args['source-root']);
  fs.mkdirSync(args.out, { recursive: true });
  const base = path.resolve(args.out);
  fs.writeFileSync(path.join(base, 'call-graph-audit.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(base, 'call-graph-audit.md'), markdown(report));
  process.stdout.write(`${path.join(base, 'call-graph-audit.json')}\n${path.join(base, 'call-graph-audit.md')}\n`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Call graph audit failed: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { auditGraph, markdown, main };
