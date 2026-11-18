/* Local OSV evidence and captured exposure, shared by API, worker and fallback. */
(function (root, factory) {
  var common = typeof module === 'object' && module.exports;
  var api = factory(common ? require('./supply-chain.js') : root.SupplyChain, common ? require('./call-paths.js') : root.CallPaths);
  if (common) module.exports = api;
  root.AdvisoryExposure = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SupplyChain, CallPaths) {
  'use strict';
  var VERSION = 'local-osv-exposure-v2', MAX_BYTES = 1048576;
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function text(v) { return typeof v === 'string' && v.length > 0 && v.length <= 16384; }
  function date(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)); }
  function normalize(q) {
    var s = q.snapshot;
    if (!s || s.schemaVersion !== 1 || !s.source || !text(s.source.name) || !text(s.source.uri) ||
        !date(s.retrievedAt) || !date(s.asOf) || !Array.isArray(s.advisories) || s.advisories.length > 1000)
      fail('INVALID_SNAPSHOT', 'snapshot requires schemaVersion 1, source {name,uri}, retrievedAt, pinned asOf, and <=1000 local OSV advisories');
    if (JSON.stringify(s).length > MAX_BYTES) fail('INVALID_SNAPSHOT', 'snapshot exceeds 1 MiB JSON characters');
    ['coordinateMappings', 'functionMappings'].forEach(function (key) {
      if (s[key] == null) s[key] = [];
      if (!Array.isArray(s[key]) || s[key].length > 1000) fail('INVALID_SNAPSHOT', key + ' requires <=1000 structured records');
    });
    if (q.phase != null && !['build', 'application', 'dev-test', 'unknown'].includes(q.phase)) fail('INVALID_PHASE', 'invalid advisory entry phase');
    if (q.packageId != null && !text(q.packageId)) fail('INVALID_REQUEST', 'packageId requires an exact package ID');
    q.timeoutMs = q.timeoutMs == null ? 2000 : q.timeoutMs;
    if (!Number.isSafeInteger(q.timeoutMs) || q.timeoutMs < 1 || q.timeoutMs > 5000) fail('INVALID_TIMEOUT', 'timeoutMs requires 1..5000');
    if (q.includePossible == null) q.includePossible = true;
    if (typeof q.includePossible !== 'boolean') fail('INVALID_REQUEST', 'includePossible must be boolean');
    var ceiling = { maxWork: 2000000, maxRoutes: 200, maxFindings: 1000, maxEvidenceBytes: 16777216 };
    if (q.budgets != null && (!q.budgets || typeof q.budgets !== 'object' || Array.isArray(q.budgets))) fail('INVALID_BUDGET', 'budgets must be an object');
    q.budgets = Object.assign({}, ceiling, q.budgets || {});
    Object.keys(q.budgets).forEach(function (key) {
      if (!ceiling[key] || !Number.isSafeInteger(q.budgets[key]) || q.budgets[key] < 1 || q.budgets[key] > ceiling[key])
        fail('INVALID_BUDGET', key + ' exceeds supported advisory budget');
    });
    return q;
  }
  // SemVer ordering uses decimal strings, avoiding numeric precision loss.
  function semver(v) {
    if (typeof v !== 'string') return null;
    var m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(v);
    if (!m) return null;
    var pre = m[4] ? m[4].split('.') : [];
    if (pre.some(function (x) { return /^\d+$/.test(x) && x.length > 1 && x[0] === '0'; })) return null;
    return [m[1], m[2], m[3], pre];
  }
  function decimal(a, b) { return a.length !== b.length ? Math.sign(a.length - b.length) : a === b ? 0 : a < b ? -1 : 1; }
  // One generator owns the pure semantics and cooperative query evaluation.
  // Charge string processing before parsing/comparing, and every collection step.
  function* parsedVersion(value) {
    yield;
    if (typeof value === 'string') for (var i = 0; i < value.length; i += 128) yield;
    return semver(value);
  }
  function* comparedVersions(a, b) {
    for (var i = 0; i < 3; i++) {
      for (var k = 0; k < a[i].length + b[i].length; k += 128) yield;
      var c = decimal(a[i], b[i]); if (c) return c;
    }
    var ap = a[3], bp = b[3];
    if (!ap.length || !bp.length) return !ap.length && !bp.length ? 0 : !ap.length ? 1 : -1;
    for (var j = 0; j < Math.max(ap.length, bp.length); j++) {
      yield;
      if (j >= ap.length || j >= bp.length) return j >= ap.length ? -1 : 1;
      for (var k = 0; k < ap[j].length + bp[j].length; k += 128) yield;
      if (ap[j] === bp[j]) continue;
      var an = /^\d+$/.test(ap[j]), bn = /^\d+$/.test(bp[j]);
      return an && bn ? decimal(ap[j], bp[j]) : an !== bn ? an ? -1 : 1 : ap[j] < bp[j] ? -1 : 1;
    }
    return 0;
  }
  function* sortedTimeline(values) {
    // Bottom-up merge sort yields during both comparisons and retained copies.
    for (var width = 1; width < values.length; width *= 2) {
      var sorted = [];
      for (var lo = 0; lo < values.length; lo += width * 2) {
        var left = lo, mid = Math.min(lo + width, values.length), right = mid, hi = Math.min(lo + width * 2, values.length);
        while (left < mid || right < hi) {
          yield;
          var order = left >= mid ? 1 : right >= hi ? -1 : values[left].version === 'zero' ? values[right].version === 'zero' ? 0 : -1 :
            values[right].version === 'zero' ? 1 : yield* comparedVersions(values[left].version, values[right].version);
          sorted.push(values[order <= 0 ? left++ : right++]);
        }
      }
      values = sorted;
    }
    return values;
  }
  function* versionSteps(affected, version) {
    var v = yield* parsedVersion(version), unknown = false, found = false, evidence = [];
    if (!v) return { status: 'unknown', reason: 'captured version is not supported SemVer' };
    if (affected.package && affected.package.purl != null || affected.ecosystem_specific && Object.keys(affected.ecosystem_specific).length ||
        affected.database_specific && Object.keys(affected.database_specific).length)
      return { status: 'unknown', reason: 'unsupported purl or affected-level ecosystem/database conditions' };
    if (affected.versions != null) {
      if (!Array.isArray(affected.versions)) unknown = true;
      else {
        var validVersions = true, exact = false;
        for (var listed of affected.versions) { yield; if (!(yield* parsedVersion(listed))) validVersions = false; if (listed === version) exact = true; }
        if (!validVersions) unknown = true;
        else if (exact) { yield { evidence: 'exact listed version' }; found = true; evidence.push('exact listed version'); }
      }
    }
    if (affected.ranges != null && !Array.isArray(affected.ranges)) unknown = true;
    for (var range of Array.isArray(affected.ranges) ? affected.ranges : []) {
      yield;
      if (!range || range.type !== 'SEMVER' || range.repo != null || range.database_specific != null ||
          !Array.isArray(range.events) || !range.events.length) { unknown = true; continue; }
      var timeline = [], limits = [], valid = true, hasIntroduced = false, hasFixed = false, hasLast = false;
      for (var event of range.events) {
        yield;
        if (!event || Object.keys(event).length !== 1) { valid = false; break; }
        var key = Object.keys(event)[0], value = event[key];
        var parsed = value === '0' && key === 'introduced' ? 'zero' : value === '*' && key === 'limit' ? 'infinity' : yield* parsedVersion(value);
        if (!['introduced', 'fixed', 'last_affected', 'limit'].includes(key) || !parsed) { valid = false; break; }
        hasIntroduced = hasIntroduced || key === 'introduced'; hasFixed = hasFixed || key === 'fixed'; hasLast = hasLast || key === 'last_affected';
        yield;
        if (key === 'limit') limits.push(parsed); else timeline.push({ kind: key, version: parsed });
      }
      if (!valid || !hasIntroduced || hasFixed && hasLast) { unknown = true; continue; }
      timeline = yield* sortedTimeline(timeline);
      var vulnerable = false, duplicateBoundary = false;
      for (var i = 0; i < timeline.length; i++) {
        yield;
        var evt = timeline[i];
        if (i && evt.version !== 'zero' && timeline[i - 1].version !== 'zero' &&
            (yield* comparedVersions(evt.version, timeline[i - 1].version)) === 0 && evt.kind !== timeline[i - 1].kind) duplicateBoundary = true;
        var order = evt.version === 'zero' ? 1 : yield* comparedVersions(v, evt.version);
        if (evt.kind === 'introduced' && order >= 0) vulnerable = true;
        else if (evt.kind === 'fixed' && order >= 0 || evt.kind === 'last_affected' && order > 0) vulnerable = false;
      }
      if (duplicateBoundary) { unknown = true; continue; }
      var beforeLimits = !limits.length;
      for (var limit of limits) { yield; if (limit === 'infinity' || (yield* comparedVersions(v, limit)) < 0) beforeLimits = true; }
      if (vulnerable && beforeLimits) { yield { evidence: range }; found = true; evidence.push(range); }
    }
    if (!affected.versions && !affected.ranges || !found && !(affected.versions || []).length && !(affected.ranges || []).length) unknown = true;
    return { status: found ? 'affected' : unknown ? 'unknown' : 'not-affected', evidence: evidence,
      reason: unknown ? 'unsupported or malformed range/version evidence retained' : null };
  }
  function affectedVersion(affected, version) {
    var steps = versionSteps(affected, version), next;
    do { next = steps.next(); } while (!next.done);
    return clone(next.value);
  }
  function cratesIo(source) {
    return source === 'registry+https://github.com/rust-lang/crates.io-index' || source === 'sparse+https://index.crates.io/';
  }
  function coordinate(p, mappings) {
    if (p.identity !== 'exact') return { status: 'unknown', reason: 'package identity has missing or conflicting catalog evidence' };
    if (mappings.length) {
      if (mappings.length !== 1) return { status: 'unknown', reason: 'ambiguous declared coordinate mappings' };
      var m = mappings[0];
      if (m.schemaVersion !== 1 || m.version !== p.version || m.source !== p.source || !text(m.provenance) ||
          !text(m.name) || !text(m.ecosystem)) return { status: 'unknown', reason: 'invalid/unbound declared coordinate mapping' };
      return { status: 'declared', ecosystem: m.ecosystem, name: m.name, version: m.version, provenance: m.provenance };
    }
    return p.identity === 'exact' && cratesIo(p.source) ? { status: 'verified-source', ecosystem: 'crates.io', name: p.name, version: p.version } :
      { status: 'unknown', reason: 'source identity is not verified crates.io; local and git forks are not implicitly mapped' };
  }
  function create(raw, inputs) {
    var catalog = SupplyChain.build(clone(raw)), functions = inputs.paths.functions(), entries = clone(inputs.entries || []);
    var packageClaims = new Map();
    raw.nodes.forEach(function (n) { var a = n.attributes || {}; if (a.kind !== 'crate' || !a.package_id) return;
      if (!packageClaims.has(a.package_id)) packageClaims.set(a.package_id, new Set());
      packageClaims.get(a.package_id).add(JSON.stringify([a.crate || a.name, a.version || null, a.package_source || null])); });
    catalog.packages.forEach(function (p) { if ((packageClaims.get(p.id) || new Set()).size > 1) p.identity = 'ambiguous'; });
    var build = clone(inputs.buildExecution || {}), entryCoverage = clone(inputs.entryCoverage || {});
    async function query(request, evidence, control) {
      var prepared = evidence.prepare(request), q = prepared.request;
      if (q.op !== 'advisoryExposure') fail('INVALID_REQUEST', 'Expected advisoryExposure');
      var s = q.snapshot, findings = [], unmatched = [], diagnostics = [], work = 0, evidenceBytes = 0, routes = 0, stopped = null, started = Date.now();
      var selectedPackages = catalog.packages.filter(function (p) { return !q.packageId || q.packageId === p.id; });
      if (q.packageId && !selectedPackages.length) fail('UNKNOWN_PACKAGE', 'Unknown exact package ID');
      var chosenEntries = entries.filter(function (e) { return !q.phase || e.phases.includes(q.phase); });
      control = control || {};
      function retain(value) {
        var bytes = JSON.stringify(value).length * 2;
        if (bytes > q.budgets.maxEvidenceBytes - evidenceBytes) { stopped = 'evidence-byte-budget'; throw stopped; }
        evidenceBytes += bytes;
        return value;
      }
      async function spend() {
        work++;
        if (control.cancelled && control.cancelled()) stopped = 'cancelled';
        else if (work > q.budgets.maxWork) stopped = 'work-budget';
        else if (Date.now() - started >= q.timeoutMs) stopped = 'timeout';
        if (stopped) throw stopped;
        if (work % 256 === 0) { await new Promise(function (resolve) { setTimeout(resolve, 0); });
          if (control.cancelled && control.cancelled()) { stopped = 'cancelled'; throw stopped; } }
      }
      function append(list, value) { retain(value); list.push(clone(value)); }
      async function evaluate(affected, version) {
        var steps = versionSteps(affected, version), next;
        do { await spend(); next = steps.next(); if (!next.done && next.value) retain(next.value.evidence); } while (!next.done);
        return next.value;
      }
      var advisoryIds = new Map();
      var freshDelta = Date.parse(s.asOf) - Date.parse(s.retrievedAt), freshness = freshDelta < 0 ? 'future-retrieval' : freshDelta > 30 * 86400000 ? 'stale' : 'within-30-days';
      try {
        for (var record of s.advisories) { await spend(); if (record && text(record.id)) advisoryIds.set(record.id, (advisoryIds.get(record.id) || 0) + 1); }
        for (var index = 0; index < s.advisories.length; index++) {
          await spend();
          var advisory = s.advisories[index], matches = 0;
          var valid = advisory && text(advisory.id) && /^[a-zA-Z0-9:_.-]+$/.test(advisory.id) && date(advisory.modified) &&
            /^1\.(?:[0-8]\.\d+|9\.[0-2])$/.test(advisory.schema_version || '1.0.0') && Array.isArray(advisory.affected);
          if (!valid) { append(diagnostics, { index: index, status: 'malformed-or-unsupported', advisory: advisory == null ? null : advisory }); continue; }
          for (var affectedIndex = 0; affectedIndex < advisory.affected.length; affectedIndex++) {
            await spend(); var a = advisory.affected[affectedIndex];
            if (!a || !a.package || !text(a.package.name) || !text(a.package.ecosystem)) append(diagnostics, { index: index, affectedIndex: affectedIndex, advisoryId: advisory.id, status: 'malformed-affected-coordinate' });
          }
          if (advisoryIds.get(advisory.id) > 1) { append(diagnostics, { index: index, advisoryId: advisory.id, status: 'ambiguous-advisory-id' }); continue; }
          var withdrawn = advisory.withdrawn != null;
          if (withdrawn && !date(advisory.withdrawn)) append(diagnostics, { index: index, advisoryId: advisory.id, status: 'malformed-withdrawal' });
          for (var p of selectedPackages) {
            await spend();
            var mappings = [], candidates = [];
            for (var cm of s.coordinateMappings) { await spend(); if (cm && cm.packageId === p.id) mappings.push(cm); }
            var coord = coordinate(p, mappings);
            for (var affected of advisory.affected) { await spend();
              if (affected && affected.package && affected.package.name === (coord.name || p.name) &&
                  affected.package.ecosystem === (coord.ecosystem || 'crates.io')) candidates.push(affected);
            }
            if (!candidates.length) continue;
            matches++;
            if (findings.length >= q.budgets.maxFindings) { stopped = 'finding-budget'; throw stopped; }
            var versions = [], hasAffected = false, hasUnknown = false;
            for (var candidate of candidates) { await spend(); var versionResult = advisory.database_specific && Object.keys(advisory.database_specific).length || advisory.ecosystem_specific != null ?
              { status: 'unknown', reason: 'unsupported advisory-specific applicability metadata' } : await evaluate(candidate, p.version);
              hasAffected = hasAffected || versionResult.status === 'affected'; hasUnknown = hasUnknown || versionResult.status === 'unknown'; versions.push(versionResult); }
            var match = coord.status === 'unknown' || coord.ecosystem !== 'crates.io' ? 'unknown' : hasAffected ? 'affected' : hasUnknown ? 'unknown' : 'not-affected';
            var row = { id: 'advisory-finding:' + index + ':' + p.id, advisoryId: advisory.id, advisoryIndex: index,
              aliases: advisory.aliases || [], references: advisory.references || [], package: p, coordinate: coord,
              presence: 'present', versionMatch: { status: match, evidence: versions }, withdrawn: withdrawn,
              freshness: freshness, summary: advisory.summary || null,
              exposure: match === 'affected' && !withdrawn ? 'present-affected-package' : 'indeterminate',
              functionEvidence: { status: 'unidentified', items: [], diagnostics: [] },
              routes: [], inclusion: { status: 'captured-package-catalog', dependencies: [] },
              queryCoverage: { partial: true, noExposureProven: false, entryCoverage: entryCoverage } };
            retain(row); row = clone(row);
            // Explain inclusion using the complete finite dependency subgraph from
            // workspace packages to this exact package, not a name-based tree.
            var back = new Set([p.id]), frontier = [p.id];
            for (var h = 0; h < frontier.length; h++) for (var d of catalog.dependencies) {
              await spend(); if (d.target === frontier[h] && !back.has(d.source)) { back.add(d.source); frontier.push(d.source); }
            }
            var roots = [], rootReachable = new Set(), rootQueue = [];
            for (var pkg of catalog.packages) { await spend(); if (pkg.workspaceMember) { roots.push(pkg.id); rootReachable.add(pkg.id); rootQueue.push(pkg.id); } }
            for (var ri = 0; ri < rootQueue.length; ri++) for (var dep of catalog.dependencies) {
              await spend(); if (dep.source === rootQueue[ri] && !rootReachable.has(dep.target)) { rootReachable.add(dep.target); rootQueue.push(dep.target); }
            }
            for (var dependency of catalog.dependencies) { await spend();
              if (back.has(dependency.source) && back.has(dependency.target) && rootReachable.has(dependency.source) && rootReachable.has(dependency.target)) append(row.inclusion.dependencies, dependency);
            }
            row.inclusion.roots = [];
            for (var rootId of roots) { await spend(); if (back.has(rootId)) append(row.inclusion.roots, rootId); }
            row.inclusion.status = row.inclusion.roots.length ? 'captured-root-connecting-subgraph' : 'unknown-no-established-workspace-route';
            row.inclusion.note = 'Resolved package declarations; target conditions retained and activation unknown.';
            retain({ status: row.inclusion.status, note: row.inclusion.note });
            var targets = [];
            for (var f of functions) { await spend(); if (f.packageId === p.id && f.bodyStatus === 'captured') targets.push(f); }
            for (var mapping of s.functionMappings) {
              await spend();
              if (!mapping || mapping.advisoryId !== advisory.id || mapping.packageId !== p.id) continue;
              var allowed = ['schemaVersion', 'advisoryId', 'packageId', 'functionId', 'procedureId', 'nodeId', 'buildUnitId', 'provenance'];
              var mappingValid = mapping.schemaVersion === 1 && text(mapping.functionId) && text(mapping.provenance) &&
                ['procedureId', 'nodeId', 'buildUnitId'].every(function (k) { return mapping[k] == null || text(mapping[k]); });
              for (var key in mapping) { await spend(); if (!allowed.includes(key)) mappingValid = false; }
              var fs = [];
              if (mappingValid) for (var f of targets) { await spend(); if (f.functionId === mapping.functionId &&
                (!mapping.procedureId || f.procedureId === mapping.procedureId) && (!mapping.nodeId || f.id === mapping.nodeId) &&
                (!mapping.buildUnitId || f.buildUnitId === mapping.buildUnitId)) fs.push(f); }
              if (fs.length === 1 && match === 'affected' && !withdrawn) append(row.functionEvidence.items, { function: fs[0], mapping: mapping, evidenceKind: 'declared-structured-package-bound' });
              else append(row.functionEvidence.diagnostics, { mapping: mapping, status: fs.length > 1 ? 'ambiguous' : 'unknown' });
            }
            if (row.functionEvidence.items.length) { retain('identified-by-structured-evidence'); row.functionEvidence.status = 'identified-by-structured-evidence'; }
            var routePartial = false, routeQueriesComplete = true, anyRoute = false, possibleRoute = false;
            if (match === 'affected' && !withdrawn) for (var entry of chosenEntries) for (var target of targets) {
              await spend();
              if (routes >= q.budgets.maxRoutes) { stopped = 'route-budget'; throw stopped; }
              var remaining = q.timeoutMs - (Date.now() - started);
              if (remaining < 1) { stopped = 'timeout'; throw stopped; }
              var requestPath = { op: 'callPaths', from: entry.nodeId, to: target.id, includePossible: q.includePossible,
                timeoutMs: q.timeoutMs, budgets: { maxWork: Math.max(1, q.budgets.maxWork - work) }, page: { limit: 100 } };
              routes++;
              var route = await inputs.paths.query(requestPath, evidence, { cancelled: function () {
                if (control.cancelled && control.cancelled()) { stopped = 'cancelled'; return true; }
                if (Date.now() - started >= q.timeoutMs) { stopped = 'timeout'; return true; }
                return false;
              } });
              work += route.completion.work;
              routeQueriesComplete = routeQueriesComplete && route.completion.complete;
              routePartial = routePartial || route.queryCoverage.partial || !route.completion.complete;
              if (route.status === 'captured-route') {
                anyRoute = true; possibleRoute = possibleRoute || route.queryCoverage.possibleEdgeCount > 0;
                var routeEvidence = { entry: entry, target: target, request: route.request, replay: route.replay,
                  status: route.status, completion: route.completion, queryCoverage: route.queryCoverage,
                  identifiedFunction: row.functionEvidence.items.some(function (f) { return f.function.id === target.id; }) };
                append(row.routes, routeEvidence);
              }
            }
            var units = [], missingBodies = 0;
            for (var unit of build.units || []) { await spend(); if (unit.packageId === p.id) append(units, unit); }
            for (var func of functions) { await spend(); if (func.packageId === p.id && func.bodyStatus !== 'captured') missingBodies++; }
            var finalFields = { exposure: match !== 'affected' || withdrawn ? 'indeterminate' : anyRoute ? 'reachable-affected-package-code' : routePartial || missingBodies > 0 || !chosenEntries.length || !targets.length ? 'indeterminate' : 'no-captured-route',
              capturedReachability: anyRoute ? 'reachable' : !routeQueriesComplete || missingBodies > 0 || !chosenEntries.length || !targets.length ? 'indeterminate' : 'no-captured-route',
              reachableIdentifiedFunction: row.routes.some(function (r) { return r.identifiedFunction; }),
              queryCoverage: { partial: routePartial || missingBodies > 0 || !chosenEntries.length || !targets.length || catalog.coverage.catalogIncomplete || !!entryCoverage.partial || !!(entryCoverage.phaseMembership || {}).partial,
                noExposureProven: false, possibleRoutes: possibleRoute, capturedBodies: targets.length, entries: chosenEntries.length,
                entryCoverage: row.queryCoverage.entryCoverage, buildUnits: CallPaths.page(units, q, 'units'), missingBodies: missingBodies } };
            retain(finalFields); Object.assign(row, finalFields);
            findings.push(row);
          }
          if (!matches) append(unmatched, { index: index, advisoryId: advisory.id, status: 'unmatched', reason: 'No supported package coordinate candidate in captured catalog; native/other ecosystems remain unknown.' });
        }
      } catch (error) { if (!stopped) throw error; }
      var findingPage = CallPaths.page(findings, q, 'findings'), unmatchedPage = CallPaths.page(unmatched, q, 'unmatched'), diagnosticPage = CallPaths.page(diagnostics, q, 'diagnostics');
      return Object.assign({ schemaVersion: 1, operation: 'advisoryExposure' }, evidence.envelope(prepared), {
        snapshot: { source: clone(s.source), retrievedAt: s.retrievedAt, asOf: s.asOf, freshness: freshness,
          contentSha256: inputs.digest(s), records: s.advisories.length, export: clone(s) },
        findings: findingPage, unmatched: unmatchedPage, diagnostics: diagnosticPage,
        completion: { complete: !stopped, reason: stopped, work: work, evidenceBytes: evidenceBytes, routes: routes,
          evidenceComplete: !stopped && !findingPage.truncated && !unmatchedPage.truncated && !diagnosticPage.truncated,
          evidenceAccounting: 'Conservative UTF-16 JSON bytes charged before generated evidence retention; immutable normalized request/replay/snapshot export and fixed response envelope excluded.' },
        semantics: { basis: 'local advisory version/source evidence and directed captured call connectivity',
          vulnerabilityAbsenceProven: false, executionObserved: false, invocationExact: false,
          functionIdentification: 'Only structured conjunctive exact package-bound symbol mappings; no prose/name heuristics.',
          supported: 'OSV 1.0.0 through 1.9.2; crates.io exact versions and SEMVER introduced/fixed/last_affected/limit. Other conditions/ranges/ecosystems unknown.' },
        nativeCoverage: { status: 'unknown', reason: 'Native library versions and package coordinates are not inferred from filenames, declarations or links.' }
      });
    }
    return { query: query };
  }
  return { VERSION: VERSION, normalize: normalize, affectedVersion: affectedVersion, create: create };
});
