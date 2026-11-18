/* Versioned entry discovery and structural effect routes. Browser + CommonJS. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./call-graph.js') : root.CallGraph,
    common ? require('./execution-flow.js') : root.ExecutionFlow,
    common ? require('./execution-model.js') : root.ExecutionModel,
    common ? require('./architecture-organization.js') : root.ArchitectureOrganization,
    common ? require('./supply-chain.js') : root.SupplyChain);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EntryEffects = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CallGraph, Flow, Model, Organization, SupplyChain) {
  'use strict';
  var VERSION = 1, SUMMARY_VERSION = 'rust-standard-effects-v1';
  var CATEGORIES = ['filesystem', 'network', 'process', 'sensitive-data', 'native', 'unknown'];
  // Exact compiler-qualified APIs, never bare user method names. Summaries model
  // a capability at a call boundary; neither execution nor sensitive values are proven.
  var STANDARD = [
    ['std::fs::read', 'filesystem', 'read'], ['std::fs::read_to_string', 'filesystem', 'read'],
    ['std::fs::write', 'filesystem', 'write'], ['std::fs::remove_file', 'filesystem', 'remove'],
    ['std::fs::File::open', 'filesystem', 'open'], ['std::fs::File::create', 'filesystem', 'create'],
    ['std::fs::OpenOptions::open', 'filesystem', 'open'],
    ['std::net::TcpStream::connect', 'network', 'connect'], ['std::net::TcpListener::bind', 'network', 'listen'],
    ['std::net::UdpSocket::bind', 'network', 'bind'], ['std::net::UdpSocket::send_to', 'network', 'send'],
    ['std::process::Command::spawn', 'process', 'spawn'], ['std::process::Command::output', 'process', 'spawn'],
    ['std::process::Command::status', 'process', 'spawn'], ['std::process::exit', 'process', 'exit'],
    ['std::env::var', 'sensitive-data', 'environment-read'], ['std::env::var_os', 'sensitive-data', 'environment-read']
  ];
  function fail(message) { var e = new Error(message); e.code = 'INVALID_ENTRY_EFFECTS'; throw e; }
  function parsed(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value == null ? fallback : value; } catch (_) { return fallback; } }
  function text(value) { return typeof value === 'string' && value || null; }
  function snapshot(value) { return JSON.parse(JSON.stringify(value)); }
  function src(n) { return { source_file: n && n.source_file || null, source_location: n && n.source_location || null }; }
  function sorted(xs) { return xs.sort(function (a, b) { return a.id.localeCompare(b.id); }); }
  function selector(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(function (key) { return !['id', 'path', 'packageId'].includes(key); }) ||
        !Object.values(value).every(function (v) { return typeof v === 'string' && v; }) ||
        !(value.id || value.path && value.packageId)) fail('selector requires an exact id or path + packageId');
    return value;
  }
  function validateManifest(manifest) {
    if (manifest == null) return [];
    if (!manifest || manifest.schemaVersion !== VERSION || !Array.isArray(manifest.adapters) || manifest.adapters.length > 100)
      fail('entry_effects requires schemaVersion 1 and at most 100 adapters');
    var ids = new Set();
    manifest.adapters.forEach(function (a) {
      if (!a || !text(a.id) || !text(a.version) || ids.has(a.id)) fail('adapter needs unique id and explicit version');
      ids.add(a.id);
      ['entries', 'registrations', 'summaries'].forEach(function (kind) {
        if (a[kind] != null && (!Array.isArray(a[kind]) || a[kind].length > 1000)) fail('adapter rule lists accept at most 1000 rules');
        var rules = new Set();
        (a[kind] || []).forEach(function (r) {
          if (!r || !text(r.id) || rules.has(r.id)) fail('rule needs unique id'); rules.add(r.id);
          if (kind === 'registrations') { selector(r.caller); selector(r.target); }
          else selector(r.selector);
          if (kind === 'entries' && (!text(r.kind) || r.certainty != null && !['modeled', 'possible'].includes(r.certainty)))
            fail('entry needs kind; annotation certainty is modeled or possible');
          if (kind === 'summaries' && (!Array.isArray(r.effects) || !r.effects.length || r.effects.length > 20 ||
              r.effects.some(function (e) { return !e || !CATEGORIES.includes(e.category) || !text(e.operation); })))
            fail('summary needs 1..20 categorized effects');
        });
      });
    });
    return manifest.adapters;
  }
  function build(raw, options) {
    options = options || {};
    var buildExecution = SupplyChain.buildExecution(raw, options.catalog);
    var flow = options.flow || Flow.catalog(raw), model = options.model || Model.build(raw);
    if (!options.callGraph) Flow.applyModelTargets(flow, model);
    var overview = options.callGraph || CallGraph.build(raw, flow);
    // Share the canonical identity rejection policy, including redirected and
    // unmatched compiler IDs. Raw architecture relations remain possible only.
    var graph = Organization.project(overview, model), aliases = new Map(overview.aliases || []);
    var modeledPairs = new Map();
    (model.calls || []).forEach(function (call) {
      var source = aliases.get(call.procedure);
      new Set([].concat(call.targets || [], call.possibleTargets || [], call.dispatchTargets || [])).forEach(function (path) {
        var target = aliases.get(path), key = source + '\t' + target;
        if (!modeledPairs.has(key)) modeledPairs.set(key, []);
        modeledPairs.get(key).push(call.id);
      });
    });
    var pairSites = new Map();
    overview.edges.forEach(function (edge) {
      var key = edge.source + '\t' + edge.target;
      if (!pairSites.has(key)) pairSites.set(key, []);
      pairSites.get(key).push.apply(pairSites.get(key), edge.callsites || []);
    });
    graph.edges = graph.edges.map(function (edge) {
      var ids = modeledPairs.get(edge.source + '\t' + edge.target);
      var sites = new Map((edge.callsites || []).map(function (site) { return [site.id, site]; }));
      if (ids) (pairSites.get(edge.source + '\t' + edge.target) || []).forEach(function (site) {
        if (ids.includes(site.id)) sites.set(site.id, site);
      });
      return Object.assign({}, edge, { callsites: Array.from(sites.values()),
        execution: !!edge.execution && (!!ids || ['boundary', 'native_call'].includes(edge.kind)) });
    });
    overview.edges.filter(function (edge) { return edge.kind === 'loop'; }).forEach(function (edge) {
      graph.edges.push(Object.assign({}, edge, { execution: false }));
    });
    var nodes = graph.nodes, byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var metadata = new Map(), pathIndex = new Map();
    nodes.forEach(function (n) { new Set([n.path].concat(n.flowPaths || [])).forEach(function (path) {
      var key = JSON.stringify([n.package_id, path]);
      if (!pathIndex.has(key)) pathIndex.set(key, []); pathIndex.get(key).push(n);
    }); });
    var diagnostics = [], adapters = [], adapterIds = new Set();
    // Invalid models must never silently establish entries or negative results.
    // Node string attributes survive Rust graph read/write and cached layers.
    raw.nodes.forEach(function (n) {
      if (!n.attributes || n.attributes.entry_effects == null) return;
      try {
        var manifest = parsed(n.attributes.entry_effects, false);
        if (!manifest) fail('malformed entry_effects JSON');
        var validated = validateManifest(manifest);
        if (adapters.length + validated.length > 100) fail('capture accepts at most 100 adapters');
        validated.forEach(function (a) {
          if (adapterIds.has(a.id)) fail('duplicate adapter ' + a.id);
          adapterIds.add(a.id); adapters.push(a);
        });
      } catch (e) { diagnostics.push(n.id + ': ' + e.message); }
    });
    raw.nodes.forEach(function (n) {
      var a = n.attributes || {}, id = byId.has(n.id) ? n.id : a.symbol_id;
      if (!byId.has(id)) return;
      metadata.set(id, Object.assign({}, metadata.get(id), a));
    });
    function sourceFor(n) {
      var s = src(n), a = metadata.get(n.id) || {};
      var absolute = text(a.source_absolute) || (s.source_file && s.source_file.startsWith('/') ? s.source_file : null);
      // A matching captured target source is another exact source reference;
      // other relative paths remain unresolved instead of inventing a root.
      if (!absolute && text(a.target_src_path) && s.source_file &&
          (a.target_src_path === s.source_file || a.target_src_path.endsWith('/' + s.source_file))) absolute = a.target_src_path;
      return Object.assign(s, { absolute_file: absolute });
    }
    function matches(s) { return (s.id ? byId.has(s.id) ? [byId.get(s.id)] : [] : pathIndex.get(JSON.stringify([s.packageId, s.path])) || []).filter(function (n) {
      return (!s.id || n.id === s.id) && (!s.path || n.path === s.path || (n.flowPaths || []).includes(s.path)) &&
        (!s.packageId || n.package_id === s.packageId);
    }); }
    function resolve(s, rule) {
      var found = matches(s);
      if (found.length !== 1) { diagnostics.push(rule + ': selector resolved to ' + found.length + ' callables'); return null; }
      return found[0];
    }
    function provenance(adapter, rule, mechanism) { return { adapter: adapter, rule: rule,
      mechanism: mechanism, modelVersion: VERSION, summaryVersion: SUMMARY_VERSION }; }
    var entries = [], effects = [], entryKeys = new Set(), effectKeys = new Set();
    function entry(n, kind, certainty, external, mechanism, rule) {
      var key = n.id + '\t' + kind + '\t' + rule.adapter + '\t' + rule.rule;
      if (entryKeys.has(key)) return; entryKeys.add(key);
      var a = metadata.get(n.id) || {}, kinds = parsed(a.target_kind, []);
      entries.push({ id: 'entry:' + key, nodeId: n.id, path: n.display_path || n.path, kind: kind,
        packageId: n.package_id || null, ownerPackageId: n.package_id || null, buildPhase: a.capture_scope === 'build_dependency' ||
          Array.isArray(kinds) && (kinds.includes('custom-build') || kinds.includes('proc-macro')) ? 'build' :
          a.capture_scope === 'runtime_dependency' || Array.isArray(kinds) && kinds.some(function (kind) { return ['lib', 'rlib', 'bin', 'dylib', 'cdylib', 'staticlib'].includes(kind); }) ? 'runtime' : 'unknown',
        buildUnitId: text(a.unit_key), evidenceKind: a.compiler_entry ? 'observed-build-evidence' : 'declaration',
        phases: [], unknowns: ['actual execution', 'effects outside captured bodies'],
        targetName: text(a.target_name), targetKind: Array.isArray(kinds) ? kinds : [], source: sourceFor(n),
        certainty: certainty, externalEntry: external, discoveryMechanism: mechanism, provenance: rule,
        declarationVisibility: text(a.declaration_visibility), effectiveVisibility: text(a.external_visibility),
        bodyStatus: n.body_status || 'unknown', executionObserved: false });
    }
    var rootNodes = nodes.filter(function (n) { return n.kind !== 'boundary'; });
    var rootIds = new Set(rootNodes.map(function (n) { return n.id; }));
    var disconnected = new Set(Model.disconnectedRoots(rootNodes, graph.edges.filter(function (e) {
      return e.execution && rootIds.has(e.source) && rootIds.has(e.target);
    }).map(function (e) { return { procedure: e.source, targets: [e.target] }; }), []));
    nodes.forEach(function (n) {
      var a = metadata.get(n.id) || {}, kinds = parsed(a.target_kind, []), body = a.has_body === 'true' || n.body_status === 'captured_mir';
      var abi = parsed(a.function_abi, null), foreign = abi != null && abi !== 'Rust' && abi !== 'rust';
      var compilerEntry = text(a.package_id) && text(a.unit_key) && text(a.function_id) &&
        text(a.target_src_path) && Array.isArray(kinds) && buildExecution.units.some(function (unit) {
          return unit.contextStatus === 'captured' && unit.packageId === a.package_id && unit.buildUnitId === a.unit_key &&
            unit.targetName === a.target_name && unit.source.source_file === a.target_src_path &&
            JSON.stringify(unit.targetKind) === JSON.stringify(kinds);
        }) && text(a.compiler_entry);
      if (compilerEntry === 'compiler-main' && kinds.some(function (kind) { return ['bin', 'custom-build'].includes(kind); }))
        entry(n, kinds.includes('custom-build') ? 'build-script' : 'binary', 'observed', false, 'compiler-entry-identity',
          provenance('compiler-build-entry@1', 'compiler-main', 'compiler entry identity; observed invocation unproven'));
      if (compilerEntry === 'proc-macro-export' && kinds.includes('proc-macro'))
        entry(n, 'proc-macro', 'observed', false, 'compiler-proc-macro-export',
          provenance('compiler-build-entry@1', 'proc-macro-export', 'compiler typed proc-macro attribute/export; expansion execution unproven'));
      if (!compilerEntry && Array.isArray(kinds) && (kinds.includes('bin') || kinds.includes('custom-build')) &&
          (!kinds.includes('custom-build') || !a.build_context || a.rustdoc_root_function === 'true') &&
          /(?:^|::)main$/.test(a.display_path || n.path) && body && a.rustdoc_root_function !== 'false')
        entry(n, kinds.includes('custom-build') ? 'build-script' : 'binary', 'possible', false,
          a.rustdoc_root_function === 'true' ? 'captured-target-root-declaration' : 'unproven-target-entry',
          provenance('rust-declarations@1', 'target-main-candidate',
            a.rustdoc_root_function === 'true' ? 'target-root main declaration; compiler entry identity and activation unproven' :
              'main spelling without target-root identity; activation unproven'));
      var library = Array.isArray(kinds) && kinds.some(function (kind) { return ['lib', 'rlib', 'dylib', 'cdylib', 'staticlib'].includes(kind); });
      if ((a.declaration_visibility === 'public' || a.external_visibility === 'public') && !foreign && a.external_visibility !== 'private' &&
          (library || !Array.isArray(kinds) || !kinds.length))
        entry(n, 'library-api', library && a.external_visibility === 'public' ? 'observed' : 'possible', library && a.external_visibility === 'public',
          'declaration-visibility', provenance('rust-declarations@1', 'public-api', 'declaration accessibility; invocation unproven'));
      if (library && !foreign && a.impl_trait && a.external_visibility === 'unknown')
        entry(n, 'library-api', 'possible', false, 'unresolved-trait-accessibility',
          provenance('rust-declarations@1', 'trait-accessibility-gap',
            'trait and Self accessibility unresolved; external trait-object activation remains possible'));
      if (foreign)
        entry(n, 'ffi', body && a.export_symbol ? 'observed' : 'possible', !!(body && a.export_symbol),
          body && a.export_symbol ? 'exported-abi-body' : 'abi-declaration-candidate',
          provenance('rust-declarations@1', 'foreign-abi', 'ABI + body/export metadata; declaration is not incoming execution'));
      else if (body && a.export_symbol)
        entry(n, 'exported-symbol', 'observed', true, 'exported-body',
          provenance('rust-declarations@1', 'exported-symbol', 'body + export declaration; dynamic linkage and invocation unproven'));
      if (disconnected.has(n.id))
        entry(n, 'disconnected-root', 'possible', false, 'source-call-component',
          provenance('structural-roots@1', 'source-scc-representative', 'source SCC of resolved calls; external activation unproven'));
    });
    // Declared build entry targets survive missing host body captures. Synthetic
    // boundaries express unknown effects; they never become compiler identities.
    buildExecution.inventory.filter(function (item) { return ['build-script', 'proc-macro'].includes(item.kind); }).forEach(function (item) {
      var found = entries.some(function (e) { return e.kind === item.kind && e.packageId === item.packageId &&
        e.discoveryMechanism !== 'unproven-target-entry' &&
        e.targetName === item.targetName && e.source.absolute_file === item.source.absolute_file; });
      if (found) return;
      var id = 'missing-build-entry:' + item.id;
      var n = { id: id, path: item.targetName, package_id: item.packageId, kind: 'boundary', language: 'rust',
        body_status: 'unavailable', source_file: item.source.source_file, source_location: null, flowPaths: [] };
      nodes.push(n); byId.set(id, n);
      metadata.set(id, { package_id: item.packageId, target_name: item.targetName, target_kind: JSON.stringify(item.targetKind),
        target_src_path: item.source.absolute_file, capture_scope: 'build_dependency' });
      entry(n, item.kind, 'possible', false, 'cargo-target-declaration-missing-body',
        provenance('cargo-build-execution-v1', 'missing-build-entry', 'Cargo target can execute during compilation; missing body means effects unknown'));
    });
    var edges = graph.edges.map(function (e, i) {
      var candidate = !e.execution && e.kind !== 'loop', possible = candidate || e.uncertain || ['indirect', 'callback', 'dispatch'].includes(e.kind);
      return { id: 'route:' + i, source: e.source, target: e.target, kind: e.kind,
        certainty: candidate ? 'possible' : possible ? 'modeled' : e.callsites && e.callsites.length ? 'compiler-confirmed' : 'observed',
        execution: !!e.execution && e.kind !== 'loop', possible: possible, sourceLocation: src(e),
        callsites: (e.callsites || []).slice(0, 20).map(function (s) { return { id: s.id, source: src(s) }; }),
        callsitesTotal: (e.callsites || []).length,
        provenance: provenance('captured-calls@1', e.kind, candidate ? 'raw/reference relation; invocation unproven' : 'authoritative resolved structural CALL relation') };
    });
    adapters.forEach(function (a) {
      var aid = a.id + '@' + a.version;
      (a.entries || []).forEach(function (r) { var n = resolve(r.selector, aid + '/' + r.id);
        if (n) entry(n, r.kind, r.certainty || 'modeled', false, 'declarative-entry-annotation',
          provenance(aid, r.id, 'user/framework annotation; external activation unproven')); });
      (a.registrations || []).forEach(function (r) {
        var caller = resolve(r.caller, aid + '/' + r.id), target = resolve(r.target, aid + '/' + r.id);
        if (!caller || !target) return;
        var p = provenance(aid, r.id, 'declarative registration; reference does not prove callback invocation');
        entry(target, r.kind || 'registered-handler', 'possible', false, 'declarative-registration', p);
        edges.push({ id: 'registration:' + aid + '/' + r.id, source: caller.id, target: target.id,
          kind: 'registration', certainty: 'possible', execution: false, possible: true,
          sourceLocation: src(caller), callsites: [], provenance: p });
      });
    });
    var outgoing = new Map(), reverse = new Map();
    edges.forEach(function (e) {
      if (!outgoing.has(e.source)) outgoing.set(e.source, []); outgoing.get(e.source).push(e);
      if (!reverse.has(e.target)) reverse.set(e.target, []); reverse.get(e.target).push(e);
    });
    function effect(n, category, operation, certainty, p, index) {
      var key = n.id + '\t' + p.adapter + '\t' + p.rule + '\t' + index;
      if (effectKeys.has(key)) return; effectKeys.add(key);
      effects.push({ id: 'effect:' + key, nodeId: n.id, path: n.display_path || n.path,
        packageId: n.package_id || null, ownerPackageId: n.package_id || null, buildUnitId: text((metadata.get(n.id) || {}).unit_key),
        phases: [], evidenceKind: certainty === 'modeled' ? 'modeled-capability' : 'unknown',
        unknowns: ['actual execution', 'effects outside captured bodies'], category: category, operation: operation, certainty: certainty,
        packageRole: n.package_role || 'owner', implementationPackageId: n.package_role === 'ffi_declaration' ? null : n.package_id || null,
        source: sourceFor(n), callsites: (reverse.get(n.id) || []).flatMap(function (e) { return e.callsites; }).slice(0, 20),
        callsitesTotal: (reverse.get(n.id) || []).reduce(function (count, e) { return count + (e.callsitesTotal || e.callsites.length); }, 0),
        bodyStatus: n.body_status || 'unknown', provenance: p, executionObserved: false });
    }
    var standards = new Map(STANDARD.map(function (r) { return [r[0], r]; }));
    var standardProof = new Map(), boundarySites = new Map(overview.boundaryCallsites || []);
    (model.calls || []).forEach(function (call) {
      // These are compiler-produced crate, DefPathHash and extern-artifact facts.
      // An application namespace (or a dependency named std) is insufficient.
      if (call.calleeCrate !== 'std' || !call.calleeId ||
          !/\/lib\/rustlib\/[^/]+\/lib\/libstd-[a-f0-9]+\.(?:rlib|rmeta|so|dylib|dll)$/.test(call.calleeArtifact || '')) return;
      var targets = (call.resolvedTargets || []).map(function (path) { return aliases.get(path); });
      var boundary = boundarySites.get(call.id), boundaryNode = byId.get(boundary);
      if (boundaryNode && boundaryNode.calleeId === call.calleeId) targets.push(boundary);
      targets.forEach(function (id) {
        var target = byId.get(id); if (!target) return;
        // Imported bodies can have a canonical capture key; their display path
        // is considered only after the compiler identity/artifact gate above.
        var summary = standards.get((call.directKey || '').replace(/::<.*>$/, '')) ||
          standards.get((target.display_path || target.canonicalPath || target.path).replace(/::<.*>$/, ''));
        if (summary) standardProof.set(id, summary);
      });
    });
    nodes.forEach(function (n) {
      var standard = standardProof.get(n.id);
      if (standard) effect(n, standard[1], standard[2], 'modeled',
        provenance(SUMMARY_VERSION, standard[0], 'compiler std identity + sysroot artifact capability summary'), 0);
    });
    adapters.forEach(function (a) { (a.summaries || []).forEach(function (r) {
      var n = resolve(r.selector, a.id + '@' + a.version + '/' + r.id); if (!n) return;
      r.effects.forEach(function (e, i) { effect(n, e.category, e.operation, 'modeled',
        provenance(a.id + '@' + a.version, r.id, 'declarative exact-identity capability summary'), i); });
    }); });
    var summarized = new Set(effects.map(function (e) { return e.nodeId; }));
    var opaqueProcedures = new Set((model.nodes || []).filter(function (n) {
      return ['opaque', 'yield', 'drop'].includes(n.kind);
    }).map(function (n) { return n.procedure; }));
    var availableProcedures = new Set(model.procedures.map(function (p) { return p.id; }));
    nodes.forEach(function (n) {
      var a = metadata.get(n.id) || {}, abi = parsed(a.function_abi, null);
      var native = n.language === 'native' || abi != null && abi !== 'Rust' && abi !== 'rust';
      if (n.language === 'native' || n.kind === 'boundary' || n.unknownCalls > 0 ||
          native && a.has_body !== 'true' || !(n.flowPaths || []).length ||
          availableProcedures && (n.flowPaths || []).some(function (p) { return !availableProcedures.has(p); }) ||
          (n.flowPaths || []).some(function (p) { return opaqueProcedures.has(p); })) {
        // Known summaries do not imply that an uncaptured body has no other effects.
        effect(n, native ? 'native' : 'unknown', summarized.has(n.id) ? 'additional-effects-unavailable' : 'effects-unavailable',
          'unknown', provenance('capture-coverage@1', 'unavailable-effects', 'unknown calls/body/native boundary; absence cannot be proven'), 0);
      }
    });
    var nodePhases = new Map(), unitPhases = new Map(), phaseUnknown = new Set(), phaseTruncated = false;
    var phaseProcedures = new Map(), phaseCalls = new Map(), phaseRawCalls = new Map();
    var proceduresById = new Map(model.procedures.map(function (p) { return [p.id, p]; })), acceptedBodies = new Set();
    // Follow the model's first valid body ownership, including its raw node ID.
    // A same-spelling rejected/duplicate body cannot supply certainty facts.
    raw.nodes.forEach(function (node) {
      var a = node.attributes || {};
      if (a.kind !== 'flow_function') return;
      var body = parsed(a.flow, null), owner = body && proceduresById.get(body.function);
      if (!owner || owner.rawFlowNodeId !== node.id || acceptedBodies.has(owner.id) || body.version !== 1 ||
          !Array.isArray(body.blocks) || typeof body.entry !== 'string') return;
      var ids = new Set();
      if (body.blocks.some(function (b) {
        if (!b || typeof b.id !== 'string' || ids.has(b.id)) return true;
        ids.add(b.id); return false;
      }) || !ids.has(body.entry)) return;
      acceptedBodies.add(owner.id);
      body.blocks.forEach(function (b) { phaseRawCalls.set(owner.id + '#' + b.id + '@call', b); });
    });
    model.procedures.forEach(function (p) {
      var id = aliases.get(p.id);
      if (!id) return;
      if (!phaseProcedures.has(id)) phaseProcedures.set(id, []);
      phaseProcedures.get(id).push(p.id); phaseCalls.set(p.id, []);
    });
    model.calls.forEach(function (call) { if (phaseCalls.has(call.procedure)) phaseCalls.get(call.procedure).push(call); });
    function supplied(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function parameter(value) { return Number.isSafeInteger(value) && value >= 0; }
    function phaseBindings(facts, parent, spend) {
      var bindings = Object.create(null), unknown = false;
      if (!facts || supplied(facts, 'callback_args') && facts.callback_args !== null && !Array.isArray(facts.callback_args))
        return { bindings: bindings, unknown: true };
      var args = facts.callback_args || [];
      for (var i = 0; i < args.length; i++) {
        if (!spend(1)) break;
        var arg = args[i];
        if (!arg || !parameter(arg.index)) { unknown = true; continue; }
        if (supplied(bindings, arg.index)) {
          // Contradictory rows do not establish either target as an exact phase
          // invocation. Poison this index independent of row order.
          bindings[arg.index] = { targets: [], unknown: true }; unknown = true; continue;
        }
        var valid = (!supplied(arg, 'unknown') || typeof arg.unknown === 'boolean') &&
          (!supplied(arg, 'parameter') || arg.parameter === null || parameter(arg.parameter)) &&
          (!supplied(arg, 'targets') || Array.isArray(arg.targets));
        var targets = new Set(), own = Array.isArray(arg.targets) ? arg.targets : [];
        for (var j = 0; j < own.length; j++) {
          var target = own[j];
          if (!spend(typeof target === 'string' ? target.length + 1 : 1)) break;
          if (typeof target !== 'string' || !target) valid = false;
          else targets.add(target);
        }
        var inherited = parameter(arg.parameter) ? parent[arg.parameter] : null;
        if (inherited) for (var k = 0; k < inherited.targets.length; k++) {
          if (!spend(inherited.targets[k].length + 1)) break;
          targets.add(inherited.targets[k]);
        }
        if (!valid) {
          bindings[arg.index] = { targets: [], unknown: true }; unknown = true;
        } else bindings[arg.index] = { targets: Array.from(targets).sort(),
          unknown: arg.unknown === true || parameter(arg.parameter) && !inherited || !!(inherited && inherited.unknown) };
      }
      return { bindings: bindings, unknown: unknown };
    }
    function addPhase(id, phase) {
      if (!nodePhases.has(id)) nodePhases.set(id, new Set());
      nodePhases.get(id).add(phase);
    }
    ['build', 'application', 'dev-test'].forEach(function (phase) {
      var seeds = entries.filter(function (e) { return phase === 'build' ? ['build-script', 'proc-macro'].includes(e.kind) && e.discoveryMechanism !== 'unproven-target-entry' :
        phase === 'application' ? e.kind === 'binary' : e.targetKind.some(function (kind) { return ['test', 'bench', 'example'].includes(kind); }); });
      // Bound distinct environments AND their processing before growing keys or
      // queues. Memoization alone does not bound acyclic environment branching.
      var seen = new Set(), queue = [], work = 0, exhausted = false;
      function exhaust() {
        exhausted = true; phaseTruncated = true; phaseUnknown.add(phase + ':phase-inference-budget-exhausted');
        return false;
      }
      function spend(amount) {
        if (exhausted) return false;
        if (amount > 100000 - work) return exhaust();
        work += amount; return true;
      }
      function enqueue(id, procedure, bindings) {
        addPhase(id, phase); // This edge is already supported even if its body cannot be expanded.
        if (!spend(id.length + (procedure || '').length + 8)) return;
        if (seen.size >= 1024) { exhaust(); return; }
        for (var index in bindings) {
          if (!spend(index.length + 32)) return;
          var values = bindings[index].targets;
          for (var i = 0; i < values.length; i++) if (!spend(values[i].length + 4)) return;
        }
        var key = JSON.stringify([id, procedure, bindings]);
        if (!seen.has(key)) { seen.add(key); queue.push({ id: id, procedure: procedure, bindings: bindings }); }
      }
      function start(id) {
        addPhase(id, phase);
        var procedures = phaseProcedures.get(id) || [];
        if (!procedures.length) enqueue(id, null, {});
        for (var i = 0; i < procedures.length && !exhausted; i++) enqueue(id, procedures[i], {});
      }
      seeds.forEach(function (e) { start(e.nodeId); });
      for (var i = 0; i < queue.length && !exhausted; i++) {
        if (!spend(1)) break;
        var context = queue[i];
        // Preserve direct compiler/std/native capabilities without requiring a
        // captured callee body, including when later binding work is truncated.
        var boundaries = outgoing.get(context.id) || [];
        for (var b = 0; b < boundaries.length; b++) {
          if (!spend(1)) break;
          var edge = boundaries[b];
          if (edge.execution && ['boundary', 'native_call'].includes(edge.kind)) start(edge.target);
        }
        var calls = phaseCalls.get(context.procedure) || [];
        for (var c = 0; c < calls.length && !exhausted; c++) {
          if (!spend(1)) break;
          var call = calls[c], facts = phaseRawCalls.get(call.id), targets = new Set();
          var unresolved = call.unknown || !!(call.dispatchTargets || []).length || !facts ||
            supplied(facts, 'callback_unknown') && typeof facts.callback_unknown !== 'boolean' ||
            supplied(facts, 'callback_parameter') && facts.callback_parameter !== null && !parameter(facts.callback_parameter);
          var direct = call.targets || [], dispatch = new Set();
          for (var d = 0; d < (call.dispatchTargets || []).length; d++) {
            if (!spend(call.dispatchTargets[d].length + 1)) break;
            dispatch.add(call.dispatchTargets[d]);
          }
          var resolved = new Set();
          for (var r = 0; r < (call.resolvedTargets || []).length; r++) {
            if (!spend(call.resolvedTargets[r].length + 1)) break;
            resolved.add(call.resolvedTargets[r]);
          }
          for (var t = 0; t < direct.length; t++) {
            if (!spend(direct[t].length + 1)) break;
            if (!dispatch.has(direct[t]) || resolved.has(direct[t])) targets.add(direct[t]);
          }
          if (facts && parameter(facts.callback_parameter)) {
            var binding = context.bindings[facts.callback_parameter];
            if (!binding || !binding.targets.length) unresolved = true;
            if (binding) {
              unresolved = unresolved || binding.unknown;
              for (var v = 0; v < binding.targets.length; v++) {
                if (!spend(binding.targets[v].length + 1)) break;
                targets.add(binding.targets[v]);
              }
            }
          }
          var child = phaseBindings(facts, context.bindings, spend);
          unresolved = unresolved || child.unknown;
          if (!exhausted) for (var target of targets) {
            if (!spend(1)) break;
            var id = aliases.get(target);
            if (id && phaseCalls.has(target)) enqueue(id, target, child.bindings);
            else unresolved = true;
          }
          if (unresolved) phaseUnknown.add(phase + ':' + call.id);
        }
      }
    });
    function phases(id) { return Array.from(nodePhases.get(id) || ['unknown']).sort(); }
    nodes.forEach(function (n) {
      var a = metadata.get(n.id) || {};
      if (!text(a.package_id) || !text(a.unit_key)) return;
      var key = JSON.stringify([a.package_id, a.unit_key]);
      if (!unitPhases.has(key)) unitPhases.set(key, new Set());
      (nodePhases.get(n.id) || []).forEach(function (phase) { unitPhases.get(key).add(phase); });
    });
    entries.concat(effects).forEach(function (row) { row.phases = phases(row.nodeId);
      row.phaseEvidence = 'compiler/declaration entry and invocation-specific resolved calls; execution unproven'; });
    buildExecution.setUnitPhases(unitPhases);
    var phaseCoverage = { partial: phaseUnknown.size > 0, unresolvedCalls: phaseUnknown.size,
      items: Array.from(phaseUnknown).sort().slice(0, 100), truncated: phaseTruncated || phaseUnknown.size > 100,
      note: 'Global callback/dispatch alternatives do not establish phase membership; unsupported invocation bindings remain unknown. Phase inference stops at 1024 contexts or 100000 work units per phase; exhaustion is incomplete.' };
    buildExecution.coverage.phaseMembership = phaseCoverage;
    sorted(entries); sorted(effects);
    var entryById = new Map(entries.map(function (e) { return [e.id, e]; }));
    var effectById = new Map(effects.map(function (e) { return [e.id, e]; }));
    var missingMetadata = nodes.filter(function (n) { var a = metadata.get(n.id) || {};
      var kinds = parsed(a.target_kind, null);
      return n.language !== 'native' && n.kind !== 'boundary' &&
        (!['public', 'default', 'crate', 'restricted'].includes(a.declaration_visibility) ||
          !Array.isArray(kinds) || !kinds.length || !kinds.every(function (kind) { return typeof kind === 'string' && kind; })); }).length;
    var missingAbi = nodes.filter(function (n) { return n.language !== 'native' && n.kind !== 'boundary' &&
      parsed((metadata.get(n.id) || {}).function_abi, null) == null; }).length;
    var unresolvedAccessibility = nodes.filter(function (n) { return (metadata.get(n.id) || {}).external_visibility === 'unknown'; }).length;
    var coverage = { declarationMetadata: missingMetadata || unresolvedAccessibility ? 'partial-or-legacy' : 'captured',
      unresolvedAccessibility: unresolvedAccessibility,
      unprovenCompilerEntryIdentities: entries.filter(function (e) { return ['binary', 'build-script'].includes(e.kind); }).length,
      missingDeclarationMetadata: missingMetadata, adapterDiagnostics: { total: diagnostics.length,
        items: diagnostics.slice(0, 100), truncated: diagnostics.length > 100 },
      missingAbiMetadata: missingAbi,
      executionModelPartial: !!(model.coverage && model.coverage.partial),
      externalEntryInventoryComplete: false, effectCatalogComplete: false,
      buildExecution: buildExecution.coverage,
      phaseMembership: phaseCoverage,
      note: 'Only captured structural calls and declared models are known. Uncaptured sources or external activation can hide entries and effects.' };
    function walk(starts, backwards, includePossible) {
      var seen = new Set(starts), queue = starts.slice(), parent = new Map(), adjacency = backwards ? reverse : outgoing;
      for (var i = 0; i < queue.length; i++) (adjacency.get(queue[i]) || []).forEach(function (e) {
        if (!includePossible && !e.execution && e.kind !== 'loop') return;
        var next = backwards ? e.source : e.target;
        if (!seen.has(next)) { seen.add(next); queue.push(next); parent.set(next, e); }
      });
      return { seen: seen, parent: parent };
    }
    function selectedFunction(key) {
      var found = byId.has(key) ? [byId.get(key)] : nodes.filter(function (n) {
        return n.path === key || (n.flowPaths || []).includes(key);
      });
      if (found.length > 1) fail('ambiguous function; select an exact callable id');
      if (!found.length) return null;
      var n = found[0];
      return { id: 'selection:' + n.id, nodeId: n.id, path: n.display_path || n.path,
        kind: 'selected-function', packageId: n.package_id || null, buildUnitId: text((metadata.get(n.id) || {}).unit_key),
        phases: phases(n.id), evidenceKind: 'declaration', unknowns: ['entry status', 'actual execution'], source: sourceFor(n),
        certainty: 'possible', externalEntry: false, entryClassification: 'not-established-entry', entryStatus: 'unknown',
        discoveryMechanism: 'user-selected-callable', executionObserved: false,
        provenance: provenance('user-selection@1', 'function-origin',
          'selected callable origin; entry status and external activation unproven') };
    }
    function route(request) {
      var ent = request.entryId == null ? null : entryById.get(request.entryId);
      var eff = request.effectId == null ? null : effectById.get(request.effectId);
      if (request.function != null) {
        if (request.entryId != null) fail('select function or entryId, not both');
        ent = selectedFunction(request.function); if (!ent) fail('unknown function');
      }
      if (request.entryId != null && !ent) fail('unknown entryId');
      if (request.effectId != null && !eff) fail('unknown effectId');
      if (!ent && !eff) fail('effectPaths requires entryId, effectId or function');
      if (ent && request.phase && !ent.phases.includes(request.phase)) fail('entry/function has no recorded membership in requested phase');
      if (eff && request.phase && !eff.phases.includes(request.phase)) fail('effect has no recorded membership in requested phase');
      var possible = request.includePossible !== false, from = ent ? walk([ent.nodeId], false, possible) : null;
      var back = eff ? walk([eff.nodeId], true, possible) : null;
      var reachedEntries = ent ? [ent] : entries.filter(function (e) { return back.seen.has(e.nodeId) && (!request.kind || e.kind === request.kind) && (!request.phase || e.phases.includes(request.phase)); });
      var reachedEffects = effects.filter(function (e) { return (!eff || e.id === eff.id) && (!from || from.seen.has(e.nodeId)) &&
        (!request.phase || e.phases.includes(request.phase)) &&
        (!request.category || e.category === request.category); });
      if (!reachedEffects.length && !ent) reachedEntries = [];
      if (ent) {
        var executionReach = walk([ent.nodeId], false, false).seen;
        reachedEffects = reachedEffects.map(function (e) { return Object.assign({}, e, {
          routeCertainty: executionReach.has(e.nodeId) && ent.certainty !== 'possible' ? 'structural-call' : 'possible-reference-or-entry' }); });
      }
      // A reverse closure of effect nodes retains all cross-package intermediaries,
      // recursion and loops. No path enumeration or depth cutoff changes absence.
      var effectsBack = back && reachedEffects.length ? back : walk(reachedEffects.map(function (e) { return e.nodeId; }), true, possible);
      var entryForward = from || walk(reachedEntries.map(function (e) { return e.nodeId; }), false, possible);
      var ids = new Set(Array.from(entryForward.seen).filter(function (id) { return effectsBack.seen.has(id); }));
      var sliceEdges = edges.filter(function (e) { return ids.has(e.source) && ids.has(e.target) &&
        (possible || e.execution || e.kind === 'loop'); });
      var witnesses = [], maxWitnesses = 100;
      // One BFS tree in the selected direction provides representative witnesses.
      var candidates = ent ? reachedEffects : reachedEntries;
      candidates.slice(0, maxWitnesses).forEach(function (item) {
        var path = [], at = item.nodeId, parents = ent ? from.parent : back.parent, seen = new Set();
        while (parents.has(at) && !seen.has(at)) { seen.add(at); var edge = parents.get(at); path.push(edge); at = ent ? edge.source : edge.target; }
        if (ent) path.reverse();
        var sourceEntry = ent || item, targetEffect = eff || item;
        witnesses.push({ entryId: sourceEntry.id, effectId: targetEffect.id,
          nodeIds: [sourceEntry.nodeId].concat(path.map(function (e) { return e.target; })),
          edgeIds: path.map(function (e) { return e.id; }),
          certainty: path.some(function (e) { return !e.execution || e.possible; }) || sourceEntry.certainty === 'possible' ? 'possible' : targetEffect.certainty,
          includesReference: path.some(function (e) { return !e.execution; }), representative: true });
      });
      var unknown = effects.filter(function (e) { return e.certainty === 'unknown' && entryForward.seen.has(e.nodeId); }).length;
      return snapshot({ entries: reachedEntries, effects: reachedEffects, nodes: nodes.filter(function (n) { return ids.has(n.id); }).map(function (n) {
        return { id: n.id, path: n.display_path || n.path, packageId: n.package_id || null, source: sourceFor(n),
          buildUnitId: text((metadata.get(n.id) || {}).unit_key), phases: phases(n.id),
          evidenceKind: 'structural-call-reachability', executionObserved: false,
          language: n.language, bodyStatus: n.body_status || 'unknown' }; }), edges: sliceEdges, witnesses: witnesses,
        completion: { complete: !phaseTruncated, witnessTotal: candidates.length, witnessesTruncated: candidates.length > maxWitnesses },
        finding: { status: reachedEffects.length && reachedEntries.length ? 'structural-routes' : 'no-recorded-route',
          absenceProven: false, unknownReachableEffects: unknown },
        semantics: { orderedExecution: false, branchFeasibilitySolved: false, dataFlow: false,
          basis: 'structural CALL graph; representative witnesses and full route slice',
          referencesIncluded: possible, filtering: 'view only; full captured graph retained' }, coverage: coverage });
    }
    function query(request, evidence, options) {
      options = options || {};
      var prepared = evidence.prepare(request), q = prepared.request, selected = options.packageIds && new Set(options.packageIds);
      function contextual(row) { return Object.assign({}, row, { outsideScope: !!selected && !selected.has(row.packageId) }); }
      function page(rows, name) {
        var p = q.page && q.page[name] || q.page || {}, offset = p.offset || 0, limit = p.limit || 50;
        var items = rows.slice(offset, offset + limit);
        return { total: rows.length, offset: offset, limit: limit, items: items,
          nextOffset: offset + items.length < rows.length ? offset + items.length : null,
          truncated: offset + items.length < rows.length };
      }
      var result;
      if (q.op === 'buildInventory') {
        result = { buildExecutionVersion: buildExecution.version, buildExecutionCoverage: buildExecution.coverage };
        ['inventory', 'units', 'relationships'].forEach(function (name) {
          result[name] = page(buildExecution[name].filter(function (row) {
            return (!q.phase || row.phases.includes(q.phase)) && (!selected || selected.has(row.packageId) || selected.has(row.ownerPackageId));
          }).map(contextual), name);
        });
      } else if (q.op === 'entrypoints' || q.op === 'effects') {
        var name = q.op === 'entrypoints' ? 'entries' : 'effects';
        var rows = (name === 'entries' ? entries : effects).filter(function (row) {
          return (!q.phase || row.phases.includes(q.phase)) && (!q.kind || row.kind === q.kind) && (!q.category || row.category === q.category) &&
            (!q.entryId || row.id === q.entryId) && (!q.effectId || row.id === q.effectId) &&
            (!q.function || row.nodeId === q.function || row.path === q.function) &&
            (!selected || selected.has(row.packageId));
        }).map(contextual);
        result = { entryEffectCoverage: coverage, adapterVersions: adapters.map(function (a) { return { id: a.id, version: a.version }; }) };
        result[name] = page(rows, name);
        if (name === 'entries' && q.function) {
          var selection = selectedFunction(q.function);
          result.selection = selection && (!q.phase || selection.phases.includes(q.phase)) && (!selected || selected.has(selection.packageId)) ? contextual(selection) : null;
        }
      } else if (q.op === 'effectPaths') {
        result = route(q);
        if (options.highlight) {
          result.activeNodeIds = result.nodes.map(function (n) { return n.id; });
          result.activeEdgePairs = result.edges.map(function (e) { return e.source + '\t' + e.target; });
        }
        ['entries', 'effects', 'nodes', 'edges', 'witnesses'].forEach(function (name) {
          result[name] = page(result[name].map(function (row) { return name === 'edges' || name === 'witnesses' ? row : contextual(row); }), name);
        });
        result.completion.evidenceComplete = result.completion.complete && ['entries', 'effects', 'nodes', 'edges', 'witnesses'].every(function (name) {
          return result[name].offset === 0 && !result[name].truncated;
        }) && !result.completion.witnessesTruncated;
      } else fail('unsupported entry/effect operation');
      result = snapshot(result);
      return Object.assign({ schemaVersion: 1, operation: q.op }, evidence.envelope(prepared), {
        semantics: { basis: 'captured graph and imported MIR', branchFeasibilitySolved: false, vulnerabilityAbsenceProven: false }
      }, result);
    }
    return { version: VERSION, summaryVersion: SUMMARY_VERSION, entries: entries, effects: effects,
      buildExecution: buildExecution, coverage: coverage, diagnostics: diagnostics.slice(0, 100), adapters: adapters.map(function (a) { return { id: a.id, version: a.version }; }),
      route: route, query: query };
  }
  return { VERSION: VERSION, SUMMARY_VERSION: SUMMARY_VERSION, CATEGORIES: CATEGORIES, build: build, validateManifest: validateManifest };
});
