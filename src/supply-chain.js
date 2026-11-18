/* Captured Cargo package catalog and conservative node ownership. Browser and CommonJS. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SupplyChain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function sorted(values) { return Array.from(new Set(values)).sort(); }
  function norm(name) { return Array.from(String(name || '')).map(function (c) {
    return /^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : '_';
  }).join(''); }
  function flag(value) { return value === true || value === 'true'; }
  function captureSummary(value) {
    var parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
    catch (_) { return null; }
    if (!parsed || parsed.policy !== 'workspace_and_compiler_reachable_dependencies' ||
        !Array.isArray(parsed.scopes)) return null;
    var seen = new Set(), scopes = [];
    for (var entry of parsed.scopes) {
      if (!entry || !['workspace', 'runtime_dependency', 'build_dependency'].includes(entry.capture_scope) ||
          seen.has(entry.capture_scope) ||
          !['captured', 'validated', 'imported'].every(function (key) {
            return Number.isSafeInteger(entry[key]) && entry[key] >= 0;
          }) || entry.validated > entry.captured || entry.imported > entry.validated) return null;
      seen.add(entry.capture_scope);
      scopes.push({ captureScope: entry.capture_scope, captured: entry.captured,
        validated: entry.validated, imported: entry.imported });
    }
    scopes.sort(function (a, b) { return a.captureScope.localeCompare(b.captureScope); });
    return { policy: parsed.policy, scopes: scopes };
  }
  function build(rawDoc) {
    var nodes = Array.isArray(rawDoc && rawDoc.nodes) ? rawDoc.nodes : [];
    var edges = Array.isArray(rawDoc && rawDoc.edges) ? rawDoc.edges : [];
    var byNode = new Map(nodes.map(function (n) { return [n.id, n]; }));
    var packagesById = new Map(), crateNodeToId = new Map(), workspaceNames = new Map();
    var incomplete = false, invalidDependencies = 0, invalidCaptureSummaries = 0;
    nodes.forEach(function (node) {
      var a = node && node.attributes || {};
      if (a.kind !== 'crate') return;
      var name = a.crate || a.name || String(node.id).replace(/^crate__/, '');
      var exact = typeof a.package_id === 'string' && a.package_id.length > 0;
      var id = exact ? a.package_id : 'legacy:workspace:' + norm(name);
      if (!exact) incomplete = true;
      var workspace = exact ? flag(a.workspace_member) : true;
      var summary = exact && a.capture_summary != null ? captureSummary(a.capture_summary) : null;
      var captureStatus = a.capture_summary == null ? 'unknown' : summary ? 'captured' : 'invalid';
      if (captureStatus === 'invalid') { invalidCaptureSummaries++; incomplete = true; }
      var descriptor = { id: id, name: name, version: a.version || null,
        workspaceMember: workspace, identity: exact ? 'exact' : 'legacy',
        source: a.package_source || null, license: a.license || null,
        repository: a.repository || null, nodeId: node.id,
        captureStatus: captureStatus, captureSummary: summary };
      if (!packagesById.has(id)) packagesById.set(id, descriptor);
      crateNodeToId.set(node.id, id);
      if (workspace) {
        var key = norm(name);
        if (!workspaceNames.has(key)) workspaceNames.set(key, new Set());
        workspaceNames.get(key).add(id);
      }
    });
    var packages = Array.from(packagesById.values()).sort(function (a, b) { return a.id.localeCompare(b.id); });
    var links = new Map(), linkedPairs = new Set();
    function add(source, target, kind, targetCondition, name) {
      if (!source || !target) return;
      var link = { source: source, target: target, kind: kind || 'unknown',
        targetCondition: targetCondition == null ? null : String(targetCondition),
        name: name || null };
      links.set(JSON.stringify(link), link);
      linkedPairs.add(source + '\u0000' + target);
    }
    nodes.forEach(function (node) {
      var a = node && node.attributes || {}, source = crateNodeToId.get(node.id);
      if (!source || a.supply_chain_dependencies == null) return;
      var dependencies;
      try { dependencies = typeof a.supply_chain_dependencies === 'string' ?
        JSON.parse(a.supply_chain_dependencies) : a.supply_chain_dependencies; }
      catch (_) { invalidDependencies++; return; }
      if (!Array.isArray(dependencies)) { invalidDependencies++; return; }
      dependencies.forEach(function (dep) {
        if (!dep || typeof dep.package_id !== 'string') { invalidDependencies++; return; }
        add(source, dep.package_id, dep.kind, dep.target, dep.name);
      });
    });
    edges.forEach(function (edge) {
      if (edge.relation !== 'depends_on') return;
      var source = crateNodeToId.get(edge.source), target = crateNodeToId.get(edge.target);
      if (!source || !target) { incomplete = true; return; }
      if (!linkedPairs.has(source + '\u0000' + target)) add(source, target, 'unknown', null, null);
    });
    var dependencies = Array.from(links.values()).sort(function (a, b) {
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
    if (dependencies.some(function (link) { return !packagesById.has(link.target); })) incomplete = true;
    var adjacency = new Map();
    dependencies.forEach(function (link) {
      if (!adjacency.has(link.source)) adjacency.set(link.source, []);
      adjacency.get(link.source).push(link.target);
    });
    function ownership(nodeOrId) {
      var node = typeof nodeOrId === 'string' ? byNode.get(nodeOrId) : nodeOrId;
      if (!node) return { status: 'unknown', packageIds: [] };
      var a = node.attributes || {};
      // Projected function and boundary nodes carry exact owner IDs directly.
      // An explicit projected ownership result is also safe to reuse.
      if (node.ownership && ['exact', 'legacy', 'ambiguous', 'unknown'].includes(node.ownership.status) &&
          Array.isArray(node.ownership.packageIds)) return node.ownership;
      var boundaryKind = node.native_boundary_kind || a.native_boundary_kind;
      if (boundaryKind === 'ffi_symbol') return { status: 'unknown', packageIds: [] };
      if (typeof node.package_id === 'string' && node.package_id) {
        return { status: 'exact', packageIds: [node.package_id] };
      }
      if (typeof a.package_id === 'string' && a.package_id) {
        return { status: 'exact', packageIds: [a.package_id] };
      }
      if (!node.attributes && byNode.has(node.id)) return ownership(byNode.get(node.id));
      if (crateNodeToId.has(node.id)) {
        return { status: 'legacy', packageIds: [crateNodeToId.get(node.id)] };
      }
      var name = a.crate;
      if (typeof name !== 'string' || !name) return { status: 'unknown', packageIds: [] };
      var possible = sorted(workspaceNames.get(norm(name)) || []);
      if (!possible.length) return { status: 'unknown', packageIds: [] };
      return { status: possible.length === 1 ? 'legacy' : 'ambiguous', packageIds: possible };
    }
    function association(nodeOrId) {
      var node = typeof nodeOrId === 'string' ? byNode.get(nodeOrId) : nodeOrId;
      var a = node && node.attributes || {};
      var kind = node && node.native_boundary_kind || a.native_boundary_kind;
      if (kind === 'ffi_symbol') {
        var declaration = node && node.native_declaration_package_id || a.native_declaration_package_id ||
          node && node.package_id || a.package_id;
        if (typeof declaration === 'string' && declaration)
          return { role: 'ffi_declaration', status: 'exact', packageIds: [declaration] };
      }
      return Object.assign({ role: 'owner' }, ownership(nodeOrId));
    }
    function matches(nodeOrId, packageIds) {
      var ids = packageIds instanceof Set ? packageIds : new Set(Array.isArray(packageIds) ? packageIds : []);
      return association(nodeOrId).packageIds.some(function (id) { return ids.has(id); });
    }
    function select(nodesToSelect, packageIds) {
      var ids = packageIds instanceof Set ? packageIds : new Set(Array.isArray(packageIds) ? packageIds : []);
      return (nodesToSelect || []).filter(function (node) { return matches(node, ids); });
    }
    function scope(options) {
      options = options || {};
      var mode = options.dependencies || 'none';
      if (!['none', 'direct', 'transitive'].includes(mode)) throw new Error('Invalid dependency scope');
      var selected = new Set(Array.isArray(options.packageIds) ? options.packageIds : []);
      var unknownPackageIds = sorted(Array.from(selected).filter(function (id) { return !packagesById.has(id); }));
      var frontier = Array.from(selected), initialCount = frontier.length;
      for (var head = 0; head < frontier.length && mode !== 'none'; head++) {
        if (mode === 'direct' && head >= initialCount) break;
        (adjacency.get(frontier[head]) || []).forEach(function (target) {
          if (selected.has(target)) return;
          selected.add(target); frontier.push(target);
        });
      }
      var nodeIds = [], ambiguousNodeIds = [], unknownOwnershipCount = 0;
      nodes.forEach(function (node) {
        var owner = ownership(node);
        var associated = association(node);
        if (owner.status === 'unknown') unknownOwnershipCount++;
        if (associated.packageIds.some(function (id) { return selected.has(id); })) {
          nodeIds.push(node.id);
          if (owner.status === 'ambiguous') ambiguousNodeIds.push(node.id);
        }
      });
      return { packageIds: sorted(selected), nodeIds: sorted(nodeIds), coverage: {
        catalogIncomplete: incomplete || invalidDependencies > 0,
        invalidDependencies: invalidDependencies, invalidCaptureSummaries: invalidCaptureSummaries,
        unknownPackageIds: unknownPackageIds,
        ambiguousNodeIds: sorted(ambiguousNodeIds), unknownOwnershipCount: unknownOwnershipCount } };
    }
    return { packages: packages, dependencies: dependencies, ownership: ownership,
      association: association,
      scope: scope, matches: matches, select: select, coverage: { catalogIncomplete: incomplete || invalidDependencies > 0,
        invalidDependencies: invalidDependencies, invalidCaptureSummaries: invalidCaptureSummaries } };
  }
  // Build execution is a projection of the same exact package catalog. Cargo
  // declarations and compiler reports are not observed process/syscall traces.
  function buildExecution(raw, catalog) {
    catalog = catalog || build(raw);
    var inventory = [], units = [], relationships = [], diagnostics = [], unitByKey = new Map();
    var packages = new Map(catalog.packages.map(function (p) { return [p.id, p]; }));
    function source(path) { return { source_file: path || null, source_location: null,
      absolute_file: typeof path === 'string' && path.startsWith('/') ? path : null }; }
    function strings(xs) { return Array.isArray(xs) && xs.every(function (x) { return typeof x === 'string' && x; }); }
    function envelope(node, name, field) {
      var value = node.attributes[name];
      if (value == null) return null;
      try { value = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { value = null; }
      if (!value || value.schemaVersion !== 1 || !Array.isArray(value[field])) {
        diagnostics.push(node.id + ': invalid ' + name); return null;
      }
      return value;
    }
    function row(id, kind, packageId, phase, evidence, path, extra) {
      var owner = packages.get(packageId);
      return Object.assign({ id: id, kind: kind, packageId: packageId, ownerPackageId: packageId,
        packageVersion: owner && owner.version || null, packageSource: owner && owner.source || null,
        buildUnitId: null, phases: [phase], phaseEvidence: 'declaration role; unit activation unproven',
        evidenceKind: evidence, source: source(path), executionObserved: false,
        unknowns: ['activation', 'effects outside captured bodies'] }, extra || {});
    }
    (raw.nodes || []).forEach(function (node) {
      var a = node.attributes || {};
      if (a.kind !== 'crate' || !packages.has(a.package_id)) return;
      var declared = envelope(node, 'cargo_targets', 'targets');
      (declared && declared.targets || []).forEach(function (t) {
        if (!t || typeof t.name !== 'string' || !t.name || !strings(t.kind) || !t.kind.length ||
            typeof t.src_path !== 'string' || !strings(t.required_features || [])) {
          diagnostics.push(node.id + ': invalid Cargo target'); return;
        }
        var kind = t.kind.includes('custom-build') ? 'build-script' : t.kind.includes('proc-macro') ? 'proc-macro' :
          t.kind.some(function (k) { return ['test', 'bench', 'example'].includes(k); }) ? 'dev-test-target' : 'application-target';
        var phase = ['build-script', 'proc-macro'].includes(kind) ? 'build' : kind === 'dev-test-target' ? 'dev-test' : 'application';
        inventory.push(row('cargo-target:' + JSON.stringify([a.package_id, t.name, t.kind, t.src_path]), kind,
          a.package_id, phase, 'declaration', t.src_path, { targetName: t.name, targetKind: t.kind,
            requiredFeatures: t.required_features || [], canExecute: true,
            selectionStatus: 'declared; selected compile unit unknown', targetCondition: null }));
      });
      var captured = envelope(node, 'build_units', 'units');
      (captured && captured.units || []).forEach(function (u) {
        if (!u || typeof u.unit_key !== 'string' || !u.unit_key || typeof u.target_name !== 'string' ||
            typeof u.target_src_path !== 'string' || !strings(u.target_kind) || !u.target_kind.length) {
          diagnostics.push(node.id + ': invalid compiler unit'); return;
        }
        var context = u.context, valid = context && context.schemaVersion === 1 &&
          typeof context.target_triple === 'string' && strings(context.features) &&
          typeof context.test === 'boolean' && context.profile && typeof context.profile === 'object' && !Array.isArray(context.profile) &&
          Object.values(context.profile).every(function (v) { return typeof v === 'string'; });
        if (context != null && !valid) diagnostics.push(node.id + ': invalid build context for ' + u.unit_key);
        var id = JSON.stringify([a.package_id, u.unit_key]);
        var unit = row('build-unit:' + id, 'compiler-unit', a.package_id, 'unknown', 'observed-build-evidence', u.target_src_path,
          { buildUnitId: u.unit_key, targetName: u.target_name, targetKind: u.target_kind, phases: [],
            targetTriple: valid ? context.target_triple : null, features: valid ? context.features : null,
            profile: valid ? context.profile : null, test: valid ? context.test : null,
            contextStatus: valid ? 'captured' : context == null ? 'legacy-missing' : 'invalid',
            selectionStatus: 'compiler unit captured; logical roles require entry/call evidence',
            phaseEvidence: 'not inferred from target triple or package name',
            unknowns: ['logical roles without resolved entry/call evidence', 'Cargo profile name and unspecified codegen defaults', 'actual execution'] });
        if (unitByKey.has(id)) {
          unitByKey.get(id).contextStatus = 'ambiguous'; if (!unitByKey.get(id).unknowns.includes('conflicting unit records')) unitByKey.get(id).unknowns.push('conflicting unit records');
          diagnostics.push(node.id + ': duplicate compiler unit ' + u.unit_key); return;
        }
        units.push(unit); unitByKey.set(id, unit);
      });
      var observed = envelope(node, 'cargo_build_evidence', 'artifacts');
      (observed && observed.artifacts || []).forEach(function (artifact, i) {
        if (!artifact || artifact.package_id !== a.package_id || typeof artifact.target_name !== 'string' ||
            !strings(artifact.target_kind) || !strings(artifact.filenames) || typeof artifact.target_src_path !== 'string') {
          diagnostics.push(node.id + ': invalid compiler-artifact'); return;
        }
        artifact.filenames.forEach(function (path) { relationships.push(row('compiler-output:' + JSON.stringify([node.id, i, path]),
          'compiler-output', a.package_id, artifact.target_kind.some(function (kind) { return ['custom-build', 'proc-macro'].includes(kind); }) ? 'build' :
            artifact.profile && artifact.profile.test ? 'dev-test' : artifact.target_kind.includes('bin') ? 'application' : 'unknown',
          'observed-build-evidence', artifact.target_src_path, { artifact: path,
            targetName: artifact.target_name, targetKind: artifact.target_kind,
            features: artifact.features || null, profile: artifact.profile || null, fresh: artifact.fresh,
            relationship: 'Cargo compiler-artifact reports this package/target output',
            producer: { packageId: a.package_id, targetName: artifact.target_name, source: artifact.target_src_path },
            producerBuildUnitId: null, producerStatus: 'reported-compiler-target',
            unknowns: ['exact compiler-unit/output correlation', 'script execution', 'syscall effects'] })); });
      });
      if (observed && !Array.isArray(observed.scripts)) diagnostics.push(node.id + ': invalid build-script reports');
      (observed && Array.isArray(observed.scripts) ? observed.scripts : []).forEach(function (script, i) {
        if (!script || script.package_id !== a.package_id || !strings(script.linked_libs) || !strings(script.linked_paths) ||
            typeof script.out_dir !== 'string' || !strings(script.environment_names || [])) {
          diagnostics.push(node.id + ': invalid build-script report'); return;
        }
        relationships.push(row('script-report:' + JSON.stringify([a.package_id, i]), 'build-script-output-report', a.package_id,
          'build', 'observed-build-evidence', null, { outDir: script.out_dir, linkedLibraries: script.linked_libs,
            linkedPaths: script.linked_paths, environmentNames: script.environment_names || [],
            relationship: 'Cargo build-script-executed output report; may report cached outputs',
            producer: null, producerStatus: 'unknown', consumerPhase: 'unknown',
            unknowns: ['fresh build-script execution', 'file writers', 'native compiler/process/syscall execution', 'exact build unit'] }));
      });
    });
    catalog.dependencies.forEach(function (dep) {
      inventory.push(row('cargo-dependency:' + JSON.stringify(dep), dep.kind === 'build' ? 'build-dependency' :
        dep.kind === 'dev' ? 'dev-dependency' : 'dependency', dep.target,
        dep.kind === 'build' ? 'build' : dep.kind === 'dev' ? 'dev-test' : 'unknown', 'declaration', null,
        { ownerPackageId: dep.source, targetCondition: dep.targetCondition, dependencyKind: dep.kind, alias: dep.name,
          canExecute: true, selectionStatus: 'resolved package edge; target condition retained, not evaluated',
          unknowns: ['selected build unit', 'condition activation', 'execution phase for transitive normal dependencies', 'effects'] }));
    });
    (raw.nodes || []).forEach(function (node) {
      var a = node.attributes || {};
      if (a.kind === 'native_library') relationships.push(row('native-link:' + node.id, 'native-link', a.linking_package_id || null,
        'unknown', 'observed-build-evidence', null, { artifact: a.native_artifact || null, linkedLibrary: a.native_link_name || null,
          relationship: 'recorded Cargo linker directive and artifact lookup; writer unproven',
          producer: null, producerStatus: 'unknown', consumerPhase: 'unknown',
          unknowns: ['native artifact writer', 'native compilation', 'exact consuming compiler unit'] }));
      if (a.kind === 'flow_function' && a.generated_source_reference != null) {
        var origin;
        try { origin = typeof a.generated_source_reference === 'string' ? JSON.parse(a.generated_source_reference) : a.generated_source_reference; } catch (_) { origin = null; }
        if (!origin || typeof origin.source_file !== 'string' || !/^[0-9a-f]{16}$/.test(origin.source_digest || '') || typeof origin.evidence !== 'string')
          diagnostics.push(node.id + ': invalid generated source reference');
        else relationships.push(row('definition-source:' + node.id, 'generated-source-reference', a.package_id || null, 'unknown',
          'observed-build-evidence', origin.source_file, { buildUnitId: a.unit_key || null, sourceDigest: origin.source_digest,
            relationship: origin.evidence, producer: null, producerStatus: 'unknown', consumerBuildUnitId: a.unit_key || null,
            unknowns: ['source writer; compiler definition reference and OUT_DIR scope do not prove producer'] }));
      }
      if (a.kind === 'flow_function' && a.source_reference_kind === 'cargo-out-dir-reference')
        relationships.push(row('source-reference:' + node.id, 'generated-source-reference', a.package_id || null, 'unknown',
          'observed-build-evidence', node.source_file, { buildUnitId: a.unit_key || null,
            relationship: 'compiler body source reference validated against source digest in reported Cargo OUT_DIR scope',
            producer: null, producerStatus: 'unknown', consumerBuildUnitId: a.unit_key || null,
            unknowns: ['source writer; OUT_DIR containment does not prove producer'] }));
    });
    function setUnitPhases(memberships) {
      units.forEach(function (unit) {
        unit.phases = Array.from(memberships.get(JSON.stringify([unit.packageId, unit.buildUnitId])) || []).sort();
        if (!unit.phases.length) unit.phases = unit.test === true ? ['dev-test'] : ['unknown'];
        unit.phaseEvidence = unit.test === true ? 'compiler test context' : 'compiler entry/declaration and resolved-call reachability; not observed execution';
      });
      relationships.forEach(function (relationship) {
        if (!relationship.consumerBuildUnitId) return;
        relationship.phases = Array.from(memberships.get(JSON.stringify([relationship.packageId, relationship.consumerBuildUnitId])) || []).sort();
        if (!relationship.phases.length) relationship.phases = ['unknown'];
        relationship.phaseEvidence = 'consumer unit entry/resolved-call membership; writer phase unknown';
      });
    }
    inventory.forEach(function (item) {
      var matches = units.filter(function (u) { return u.packageId === item.packageId && u.targetName === item.targetName &&
        u.source.source_file === item.source.source_file && JSON.stringify(u.targetKind) === JSON.stringify(item.targetKind); });
      item.buildUnitCandidates = matches.slice(0, 100).map(function (u) { return u.buildUnitId; });
      item.buildUnitCandidatesTotal = matches.length; item.buildUnitCandidatesTruncated = matches.length > 100;
      item.captureStatus = matches.length ? 'unit-captured; body coverage partial' : 'missing-or-unmatched';
      if (!matches.length) item.unknowns.push('missing build body never proves no effects or inability to execute');
    });
    function order(xs) { return xs.sort(function (a, b) { return a.id.localeCompare(b.id); }); }
    return { version: 'cargo-build-execution-v1', inventory: order(inventory), units: order(units), relationships: order(relationships),
      setUnitPhases: setUnitPhases, coverage: { partial: true, diagnostics: diagnostics.slice(0, 100), diagnosticsTotal: diagnostics.length, diagnosticsTruncated: diagnostics.length > 100, unitCorrelationComplete: false,
        effectAbsenceProven: false, executionObserved: false,
        note: 'Declarations, modeled reachable capabilities and Cargo/compiler reports are separate evidence. Missing host bodies remain unknown.' } };
  }
  return { build: build, buildExecution: buildExecution };
});
