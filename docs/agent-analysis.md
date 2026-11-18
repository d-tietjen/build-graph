# Local agent analysis API

The JSON API exposes evidence in a captured build-graph document for security review. It does not detect vulnerabilities or prove their absence. It reads a local `graph.json` or `graph.json.gz` file; gzip is recognized by magic bytes. No network lookup or dependency install is needed.

```sh
node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"capabilities"}'
node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"schema"}'
```

For several queries against one loaded graph, use `--jsonl`. Send one JSON request per input line; receive one JSON response per line. Without `--request` or `--jsonl`, the CLI reads one JSON request from standard input. The CommonJS library exposes `require('./src/analysis-api.js').create(rawGraph, {sha256, source}).query(request)`, which returns a promise. CLI responses include a SHA-256 of the uncompressed graph bytes and its input path; library calls derive a SHA-256 from the supplied object unless one is provided.

Every response has `schemaVersion: 1`, graph identity, and captured-graph semantics. Each paged list has `{total,offset,limit,items,nextOffset,truncated}`. The default page has 50 items and the maximum is 100. `page: {offset,limit}` applies to each list, or set per-list options, such as `page: {edges: {offset: 100, limit: 100}}`. Continue until `nextOffset` is `null`. Invalid requests produce a structured `error.code` and `error.message`; a single-request CLI error exits nonzero. `schema` returns the machine-readable request and response envelope.

For the browser workflow, see the [viewer walkthrough](cli-reference.md#choose-an-analysis-tab).
Start with the tab that matches your question. Source links and expandable
evidence identify the captured symbols, coverage, and replay request.

## Reproducible evidence

The API, browser statechart worker, and browser main-thread fallback use `src/analysis-evidence.js` for identity, query normalization, coverage, completion, and replay. They reuse the existing execution model. The statechart's **Analysis evidence and replay** panel exposes the same metadata and a replay request. Existing active-node/call/continuation IDs remain available to the renderers.

`graph.sha256` retains the CLI contract: SHA-256 of uncompressed input bytes (or JSON serialization for object-only library calls). The browser hashes the loaded text. Inline HTML escapes and whitespace may change those bytes. `graph.contentSha256` therefore separately identifies the parsed capture with `digestFormat: "canonical-json-v1"`: SHA-256 of JSON with lexically sorted object keys and original array order; embedded JSON strings remain strings. This canonical digest is streamed once when the capture loads, without building another graph or a graph-sized canonical string. Replay compares this digest, so gzip, plain JSON, and inline/browser captures can share replay descriptors even when their transport bytes differ.

Every successful response includes the cloned, normalized `request`, `versions` (evidence, model, analysis, and digest format), `assumptions`, and `provenance`. Unordered pins, roots, and package IDs are deduplicated and sorted; a root string becomes an array and the actual default timeout is recorded. Caller mutations after query dispatch cannot change the request. Provenance reports explicit captured `source_revision`, `source_digest`, `target_triple`, `features`, `toolchain`/`rustc_version` fields when present on `provenance` or node attributes. Missing fields have `status: "unknown"`. No revision, target triple, enabled features, package ownership, or toolchain is inferred from a path or build-unit key. Source digests emitted by the current importer are **FNV-1a 64-bit**, not cryptographic hashes. The graph digests use SHA-256. Malformed provenance records remain visible with evidence paths and unknown classification.

Functions and CFG evidence carry `identity` references: raw node ID, procedure ID, exact captured package ID, build-unit `unit_key`, compiler function ID, source digest, source location, target name/source path, artifact paths, and a JSON Pointer `evidencePath` into the capture. `unknownFields` lists missing identity fields. Block/callsite IDs identify records inside a node's encoded `flow`; normal and unwind continuation IDs continue to identify the caller's own edges. Bounded `evidenceLinks` provides these references in browser results as well. Lists in provenance, query diagnostics, gaps, and links include `total`, at most 100 `items`, and `truncated`; they can be followed through the raw capture pointer or the paged API evidence.

Classifications describe evidence, without numeric confidence scores: `compiler-confirmed` marks imported MIR states/successors or compiler identity matches; `modeled` marks synthetic ports and structural analysis conclusions; `possible` marks dispatch/reference alternatives; `observed` marks captured inventories or native observations; `unknown` marks gaps and unresolved identities. Malformed or unsupported execution fields appear in bounded `captureDiagnostics` and make a query incomplete when their blocks are reachable. Malformed graph rows are rejected; malformed native evidence reports `status: "invalid"` rather than an observed empty list. A captured operation does not establish branch feasibility or an exploitable path.

Save a result's `replay` object and submit it against a loaded capture:

```json
{"op":"replay","replay":{"version":1,"capture":{"contentSha256":"<result graph contentSha256>","digestFormat":"canonical-json-v1"},"versions":{"evidence":1,"model":1,"analysis":"structural-and-v1","digest":"canonical-json-v1","entryEffects":1,"effectSummaries":"rust-standard-effects-v1"},"request":{"op":"reachability","pins":["crate::sink","crate::source"],"timeoutMs":2000}}}
```

Prefer copying the result's descriptor directly. Replay rejects another capture with `CAPTURE_MISMATCH`, incompatible analysis versions with `VERSION_MISMATCH`, and malformed descriptors with a structured error. Replay reruns the recorded structural query and budget; elapsed-time cancellation can differ between machines. It does not persist or certify a previous verdict.

## Operations

| `op` | Required fields | Evidence |
| --- | --- | --- |
| `capabilities`, `schema` | — | Version, limits, model coverage, request shape. |
| `packages` | — | Cargo package inventory and typed dependency links, paged separately. |
| `functions` | — | Callable paths, source location, captured MIR body status, package ownership. |
| `neighbors` | `function` (path or projection ID) | Incoming and outgoing execution edges, nonexecution candidate references, unknown boundaries, callsites, and cross-scope flags. |
| `cfg` | `function` (captured procedure path) | Procedure ports, MIR blocks, every recorded successor, loops, callsites, and each callsite's normal and unwind continuation edge IDs. Page nodes, edges, and calls separately. |
| `reachability` | `pins` (1–16 procedure paths) | Existing execution model's AND-pin structural result and paged active nodes, edges, calls, and call targets. Optional `roots` and `timeoutMs` (default 2000, maximum 5000). |
| `entrypoints` | — | Entry inventory: kind, exact declaration package, build phase, source, mechanism, certainty, and versioned rule provenance. Optional `kind` or `function` filters. |
| `effects` | — | Reusable capability summaries and unknown effect boundaries. Optional `category` filter. |
| `effectPaths` | `entryId` or `effectId` | Forward effects or reverse entry routes, representative witnesses and structural route slices. Optional both IDs, `category`, `kind`, and `includePossible` (default true). Page `entries`, `effects`, `nodes`, `edges`, and `witnesses` separately. |
| `replay` | `replay` (a result's descriptor) | Check capture and analysis versions, then rerun the normalized original operation. |

`scope: {packageIds: ["<exact Cargo package ID>"], dependencies: "none" | "direct" | "transitive"}` is available on all operations. `packages` and `functions` filter listings. `neighbors` keeps its caller and callee even across a scope boundary and marks `crossesScope`. `cfg` reports whether its procedure is outside scope. **Reachability always analyzes the full captured graph** and uses scope only to label evidence: `scope.role`, `outsideScopeEvidenceNodes`, and per-evidence `outsideScope` retain cross-package intermediaries. Scope is not an isolation or proof boundary.

Package IDs come from captured Cargo metadata. Current captures distinguish exact package IDs, including multiple versions of one package. Legacy captures without `package_id` use explicit `legacy:workspace:<normalized crate>` IDs for workspace crates. The catalog reports incomplete metadata. Nodes without an exact ID can be `legacy`, `ambiguous`, or `unknown`; normalization collisions among workspace crate names remain ambiguous even if a displayed name matches one package. An unowned external function is never silently assigned from its path. Dependency links contain source and target package IDs, Cargo dependency alias `name`, `kind` (`normal`, `build`, `dev`, or `unknown`), and `targetCondition`.

Each exact package may have `captureStatus` and a `captureSummary` with policy `workspace_and_compiler_reachable_dependencies`. Scope rows report `captured`, `validated`, and `imported` v2 body counts for workspace, runtime dependency, or build dependency units. A missing summary has status `unknown` and `captureSummary: null`; it does not imply zero imported bodies. Invalid counts are rejected and counted in catalog coverage. A valid `imported: 0` is an observed zero for that scope.

Captured dependency procedures use canonical paths that include the exact Cargo package, compiler unit, and function identity. Their `display_path` keeps the human Rust spelling; two versions with the same spelling remain separate procedures. `callee_id` is authoritative when present. An unresolved compiler identity does not bind to a different dependency body by matching displayed text. Package ownership comes from captured `package_id`, not a path prefix. Scoped function listings include exact-owned uncaptured boundaries as well as captured bodies.

Native function rows have `language: "native"`, optional `nativeSymbol`, `nativeArtifact`, and `nativeLibraryId`, and body status `native_disassembly` or `unavailable`. A native disassembly is evidence about native code, not a MIR CFG. A proven direct Rust-to-native or native-to-native function edge has `kind: "native_call"`; an unresolved FFI call remains a `boundary` with `boundaryKind: "native_symbol"`. `nativeCall` records compiler-proven symbol, ABI, and actual link-library names. `nativeTargetIds` contains exact raw function IDs only when a compiled artifact proves a definition. Undefined symbols, library dependencies, and indirect calls do not create function execution edges. System or sysroot native code without an exact Cargo producer has unknown package ownership.

Function rows expose the canonical `path` and human `displayPath` separately. Native rows also expose `nativeCallCoverage`, `nativeAnalysisScope`, and bounded `nativeDirectCalls` and `nativeCallDiagnostics` lists. Each evidence list reports its total count, at most 100 items, and whether it was truncated. A direct native call item identifies its proven target node and disassembly or relocation evidence; diagnostics describe unresolved or indirect sites. These are native analysis observations, not MIR execution paths.

Native callable paths use their unique raw node IDs, so identical symbols in different artifacts stay distinct. Evidence `targetId` values and artifact paths are preserved exactly for follow-up lookup; only the number of returned evidence entries is bounded. An unresolved symbol or indirect native call may appear as a native callable boundary with body status `unavailable` and `boundaryKind` such as `unresolved_symbol` or `indirect_call`. Its package owner remains unknown unless capture proves one. Partial native analysis or any unavailable native boundary makes negative structural reachability indeterminate.

An unresolved Rust FFI symbol can have `boundaryKind: "ffi_symbol"` and `packageAssociation.role: "ffi_declaration"`. The association identifies the Cargo package containing the Rust foreign declaration, if known. `ownership` and `implementationOwnership` remain unknown because the native implementation has not been identified. Package scope can include this declaration association. A recorded `nativeTargetIds` entry can name this symbol endpoint without claiming a native body or C library version. The API also exposes its ABI, link libraries, callsite origin, and resolution status.

`cfg` for a callable without MIR returns an empty CFG and a `boundary` descriptor; its callsite may still appear in the caller's CFG with `nativeCall`, `boundaryKind`, and matched normal and unwind continuation IDs. `reachability` pins require captured MIR procedures. A native or uncaptured pin returns `indeterminate` with `missingPinDetails`; a native call inside a selected MIR route also leaves coverage partial. These results do not prove a route through the native body's internal control flow. `neighbors` reports `sourceOwnership`, `targetOwnership`, `crossesPackage` (`null` if either owner is not exact), and `crossesScope`. Callback registrations remain `execution: false` references.

## Entry discovery and effect routes

`src/entry-effects.js` is a portable version 1 model shared by the agent API, the actual browser worker, and its main-thread fallback. It indexes the existing callable projection once per capture. Capture digests are computed by the existing evidence core once; queries traverse indexed calls and do not rehash or clone the raw graph.

```json
{"op":"entrypoints","kind":"binary","page":{"limit":100}}
{"op":"effects","category":"filesystem","page":{"limit":100}}
{"op":"effectPaths","entryId":"<entry inventory id>","includePossible":false}
{"op":"effectPaths","function":"<exact callable id>","includePossible":false}
{"op":"effectPaths","effectId":"<effect inventory id>","scope":{"packageIds":["<exact package id>"]}}
```

The **Entry points and effects** tab provides the same inventories without function search. Select an entry for forward effects, an effect for reverse entry routes, or use **Explore entry effects** on a graph function. Category and inventory paging controls change the view. Source evidence is paged and links to the local editor. Selecting a route ghosts other graph nodes and links; clearing it restores their colors. Tree eyes, positions, layout, package scope, and shared AND pins retain their own state. Filter, graph selection and capture changes clear old route/replay/highlight evidence synchronously; inventory paging retains the current route request. Selecting a captured callable without a discovered entry still supports effects from that function through a `selected-function` origin, labeled `not-established-entry`, possible and nonexternal. It does not add that callable to the discovered entry inventory. The evidence disclosure contains witnesses, certainty, coverage, rule versions, and a replay request.

Entry rows distinguish target `main` bodies, accessible public library declarations, exported ABI bodies, modeled handler/CLI entries, and disconnected roots. Target kind and captured root membership retain possible `main` candidates; compiler entry identity remains an explicit gap. Custom-build and proc-macro targets and build-dependency captures have build phase `build`; absent target/role information stays `unknown`. A public declaration inside a private module is not an established API. Captured named public reexports can establish declaration accessibility; glob reexports and complex trait accessibility remain uncertain. A non-Rust ABI declaration without a body/export is only a possible FFI entry. Export evidence establishes a declaration, not runtime activation or final dynamic linkage. Unused public APIs remain in inventory. Disconnected roots always have `externalEntry: false`.

`rust-standard-effects-v1` models exact compiler-qualified `std::fs` read/write/open/create/remove APIs, selected `std::net` connect/listen/bind/send APIs, actual `Command::spawn/output/status` and `process::exit`, and environment reads as potential sensitive-data access. Compiler std identity and a sysroot artifact are required; application paths alone never establish a summary. `Command::new` and `arg` are configuration, not launches. Summaries describe capabilities; no argument taint or actual sensitive value is inferred. The catalog is intentionally finite. Uncaptured Rust bodies, unknown calls, opaque/yield/drop regions, and native boundaries retain explicit unknown effects, including possible additional effects behind a known summary. FFI declaration package association is separate from `implementationPackageId`, which remains null for an unidentified native implementation.

Routes are structural CALL paths, with cross-package intermediary nodes, callback invocation edges, recursion, loops, unknown boundaries, source locations, and versioned model provenance. They do not establish call order, branch feasibility, or data flow. Registration/reference edges have `execution: false`; `includePossible: false` excludes them. The default includes them with possible route/witness certainty and `includesReference: true`. Captured callback invocation is distinct from merely passing a callback. `routeCertainty` labels forward effects that depend on a possible reference or entry.

Traversal visits graph nodes/edges without enumerating all execution paths. The slice retains all recorded routes and cycles between the selection and its matching effects. At most 100 representative shortest structural witnesses are returned; `completion.witnessTotal` and `witnessesTruncated` expose omitted representatives. Each list is independently paged, and each row has at most 20 callsites plus `callsitesTotal`. `completion.complete` describes the structural query; `completion.evidenceComplete` is false for omitted pages or witnesses. `finding.absenceProven`, `externalEntryInventoryComplete`, and `effectCatalogComplete` remain false: unknown code or external activation can hide entries and effects, even for `no-recorded-route`. Scoped route queries label outside-scope nodes while traversing the full graph. Legacy captures missing declaration/target metadata report partial or legacy coverage.

### Declarative adapters and summaries

Store a JSON string in any persistent node's `attributes.entry_effects`. String attributes survive the Rust graph read/write and cached-layer format. The manifest is part of the capture SHA-256, so changing an annotation, summary, rule ID, or adapter version invalidates replay against the old capture. `schema` describes this interface. Every adapter and rule needs an explicit ID; adapters also need a version. Selectors accept an exact raw callable `id`, or exact `path` plus exact `packageId`. Additional selector fields are conjunctive. Ambiguous/unmatched selectors and malformed/unsupported manifests produce bounded coverage diagnostics; they do not fall back to names or source-path ownership.

For example, encode this object as a node attribute string:

```json
{
  "schemaVersion": 1,
  "adapters": [{
    "id": "my-framework",
    "version": "1.0.0",
    "entries": [{"id":"cli-command","selector":{"id":"<handler callable id>"},"kind":"cli-command","certainty":"modeled"}],
    "registrations": [{"id":"http-handler","caller":{"id":"<registration caller id>"},"target":{"id":"<handler callable id>"},"kind":"http-handler"}],
    "summaries": [{"id":"transport-send","selector":{"path":"<exact callable path>","packageId":"<exact Cargo package id>"},"effects":[{"category":"network","operation":"send"}]}]
  }]
}
```

Annotations cannot claim compiler certainty or observed activation. Entry annotations are modeled/possible; registrations are possible nonexecution references; effect summaries are modeled. Categories are `filesystem`, `network`, `process`, `sensitive-data`, `native`, and `unknown`. This supports frameworks and languages independently of repository-specific names. The separate `tests/fixtures/entry-effects/adapter-example` host fixture supplies a template with `$host_callback` and `$transport_emit` placeholders. Bind each placeholder deterministically to exactly one inventoried callable before using the manifest. Template placeholders are not Rust capture IDs.

### Offline fixture validation

Run this complete recipe only after independent source review. Keep source and artifacts local, use existing offline dependencies, and record the candidate SHA, each command/exit status, toolchain, producer CLI/driver path and SHA-256, and the resulting artifact identities. An unchanged compatible pinned driver can produce these fresh tiny captures; that records producer use, not a fresh driver build pass or reuse of an old capture result.

First run the focused contracts and candidate exporter/CLI gates from the reviewed checkout:

```sh
node --test scripts/test-entry-effects.cjs scripts/test-viewer-effects.cjs scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-viewer-evidence.cjs
node scripts/test-viewer-renderer.cjs
CARGO_NET_OFFLINE=true cargo test --locked --offline --bin cargo-build-graph rustdoc::tests
CARGO_NET_OFFLINE=true cargo build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
```

Set `$validation_root`, `$tool_target`, `$compatible_driver`, `$fixture_target`, `$capture_out`, `$adapter_target`, `$adapter_capture_out` and `$adapter_bound_out` to executor-owned local paths. Both source copies and all outputs must be outside the reviewed checkout. The two fixture source directories below must not already exist. Cargo may generate fixture lockfiles only in these copies. Never execute either fixture application.

```sh
mkdir -p "$validation_root/sources"
cp -R tests/fixtures/entry-effects/workspace "$validation_root/sources/workspace"
cp -R tests/fixtures/entry-effects/adapter-example "$validation_root/sources/adapter-example"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$fixture_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/workspace/Cargo.toml" --target-dir "$fixture_target" --out "$capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$compatible_driver" --no-compress -- --offline
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$adapter_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/adapter-example/Cargo.toml" --target-dir "$adapter_target" --out "$adapter_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$compatible_driver" --no-compress -- --offline
```

The workspace includes target-root/nested/associated `main` controls, a full application `std::fs::read_to_string` namespace collision beside genuine compiler-proven standard calls, private/public-reexport controls, an unused public method, a public trait object with private implementation and internal caller, cross-package effects, callback registration/invocation and FFI. Root membership is captured rustdoc structure. Without a compiler entry-function fact, a target-root `main` remains a possible entry with `externalEntry:false`; `coverage.unprovenCompilerEntryIdentities` reports the gap. Workspace membership alone leaves an unknown phase when target kind is absent. Unknown trait accessibility yields a possible API candidate and `coverage.unresolvedAccessibility`, never captured-complete accessibility.

Builtin standard summaries require compiler `callee_crate:std`, a nonempty compiler function ID, an external std artifact under a sysroot `lib/rustlib/<target>/lib/libstd-<hash>` path, and authoritative resolved target/boundary association. Legacy or unsupported identities stay unknown and can use explicit exact-ID custom summaries. Raw relations remain possible evidence; contradicted literal targets are suppressed by the shared authoritative projection. Executable model dispatch, callbacks, native boundaries and loops remain represented. A disconnected root is a deterministic representative of a source call SCC and never a confirmed external entry.

The second capture proves the independent adapter with real Rust identities. Inventory it before binding; the captured flow paths use underscore crate spelling:

```sh
node scripts/query-analysis.cjs --graph "$adapter_capture_out/graph.json" --request '{"op":"functions","page":{"limit":100}}'
cat > "$validation_root/adapter-bindings.json" <<'JSON'
{
  "$host_callback": { "path": "independent_host::host_callback" },
  "$transport_emit": { "path": "independent_host::custom_transport::emit" }
}
JSON
node scripts/bind-entry-effects-adapter.cjs "$adapter_capture_out/graph.json" "$adapter_capture_out/graph.html" "$validation_root/sources/adapter-example/adapter.json" "$validation_root/adapter-bindings.json" "$adapter_bound_out"
ENTRY_EFFECT_CAPTURE="$capture_out/graph.json" ENTRY_EFFECT_HTML="$capture_out/graph.html" ENTRY_EFFECT_ADAPTER_CAPTURE="$adapter_bound_out/graph.json" ENTRY_EFFECT_ADAPTER_HTML="$adapter_bound_out/graph.html" node --test scripts/test-entry-effects.cjs scripts/test-viewer-effects.cjs
```

Each binding resolves through the captured callable inventory to exactly one raw callable ID; an explicit `id` and optional exact `packageId` may replace or constrain a path binding. Missing, ambiguous, unused and unmatched bindings fail. The binder writes a new `graph.json`, `graph.html` and `entry-effects.bound.json` into a separate directory, retaining the original producer capture unchanged. It persists the bound manifest as a node string attribute, safely replaces only the emitted inline JSON data and preserves emitted module bytes. The bound manifest therefore participates in capture identity; changing its version invalidates replay.

The conditional suites assert actual exported metadata, the standard-namespace negative/stdlib positive controls, target-root candidacy, trait accessibility, cross-package filesystem routes, reference-only registration and no process launch from configuration. They assert the independent host entry/custom transport effect with API and browser replay. The browser harness reads each generated `graph.html`, proves its embedded graph matches the selected capture, checks shared module byte equivalence and placeholder replacement, and executes those emitted modules and emitted worker/fallback wiring. The noncapture lifecycle tests defer real worker/fallback results to cover current/stale success and errors, category changes, empty node lookup, inventory paging during a pending route, and capture/model replacement. Rust tests check declaration/root metadata and persistent adapter serialization. No historical large-capture runtime result is treated as a current pass.

## Source/sink triage

**Reachability pins are unordered.** A route that visits the sink before the source can satisfy the query. The result does not establish ordered source-to-sink data flow or taint propagation.

1. List packages and select exact package IDs. Expand dependency closure if the review includes dependencies.

   ```sh
   node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"packages","page":{"limit":100}}'
   node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"functions","scope":{"packageIds":["<package-id>"],"dependencies":"transitive"},"page":{"limit":100}}'
   ```

2. Identify a source and sink procedure from the function list. Inspect each neighborhood. `execution: false` and `kind: "candidate"` mean a reference or registration, not a demonstrated call. An `unknown` boundary or unresolved call can hide additional routes.

   ```sh
   node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"neighbors","function":"crate::source"}'
   node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"cfg","function":"crate::source","page":{"edges":{"limit":100},"calls":{"limit":100}}}'
   ```

3. Ask whether one captured structural execution route visits both procedures in either order, optionally fixing a known entry root. Inspect the active callsite and continuation IDs, then follow the cited source locations in the repository.

   ```sh
   node scripts/query-analysis.cjs --graph ./graph.json.gz --request '{"op":"reachability","pins":["crate::source","crate::sink"],"roots":"crate::entry","scope":{"packageIds":["<package-id>"]}}'
   ```

`status: "exact"` means the model found a route in the captured structural CFG. It does not solve branch feasibility, validate input control, or establish exploitability. `status: "impossible"` means no route was found in the captured structural CFG under the selected roots; it is not a security guarantee. A result exposes `finding.definitiveNegative` only for a completed, coverage-complete negative **within that captured structural model**. Missing bodies, dispatch uncertainty, native boundaries, malformed reachable successors, opaque/yield/drop operations, cancellation, timeout, or a summary-work budget prevent that field from becoming true. There is no vulnerability-absence claim.

`queryCoverage` follows structural entry reachability from explicit roots, including known and possible callees and cross-package intermediaries. It reports reachable gaps even when no successful witness exists. Global model diagnostics and unavailable-body counts remain under `queryCoverage.global` and the existing `coverage`. Gaps disconnected through recorded calls are counted separately: they do not taint an explicit-root query, but reachable unknown effects may connect unrecorded regions. With roots omitted, all inferred application/disconnected roots remain possible entries for coverage; uncertainty in any such entry can hide another route. Coverage is conservative and does not solve branch feasibility.

`completion.complete` concerns execution of the analysis; `completion.evidenceComplete` concerns returned pages. `completion` also records cancellation, elapsed-time and work-budget limits. `queryCoverage.pagination` gives totals, offsets, limits, omitted counts, and next offsets for every evidence list. Paging changes the evidence view, never the analysis verdict. `indeterminate`, `cancelled`, `partialCoverage: true`, unknown identities, or omitted evidence require further inspection. A timeout returns `cancelled` with a diagnostic. Raw MIR attributes are never returned wholesale. Data-flow analysis, source revisions, and build provenance absent from older captures remain explicit capability limits.

## Ordered structural execution prefixes

`orderedPath` is an additive operation. Existing `reachability` AND pins and `effectPaths` routes retain their unordered semantics. Select exactly one explicit `function` root or an `entryId` from the existing entry inventory. No implicit root or external activation is invented.

```json
{"op":"orderedPath","function":"<exact callable or procedure ID>","waypoints":[{"kind":"procedure","id":"<source ID>"},{"kind":"procedure","id":"<sink ID>"}],"exclusions":[{"kind":"call","id":"<procedure>#bb4@call"}]}
{"op":"orderedPath","entryId":"<entry inventory ID>","waypoints":[{"kind":"node","id":"<procedure>#bb2"}],"target":{"kind":"procedure","id":"<target ID>"},"budgets":{"maxWork":2000000,"maxStates":50000,"maxEvidence":200},"timeoutMs":2000}
```

`waypoints` preserves order and repetitions; optional `target` is appended as the final waypoint. There must be 1–16 events in total. Exclusions are a deduplicated set of at most 100 selectors. Selector kinds are explicit:

- `procedure` matches entry to one invocation, including root entry once before its first node. Exact procedure IDs, raw callable/flow IDs, and compiler function IDs resolve through captured identity mappings. A display path resolves only when it identifies one captured procedure. A symbol shared by several bodies is ambiguous; select the exact body ID.
- `node` matches arrival at one exact model node (`procedure#block` or an explicit model port). A loop can revisit the same node.
- `call` matches execution of one exact callsite (`procedure#block@call`), after arriving at its node and before entering its callee. A callback reference alone is not a call event.

The event order at an invocation is procedure entry, start-node arrival, entry-block arrival, then recorded node/edge traversal; a callsite event precedes callee entry. Every event consumes **at most one** next waypoint. Thus `[procedure A, procedure A]` requires two invocations, and repeated node/call selectors require another visit. Different selector kinds describe different events even when their source span is shared. A root that is also the first procedure waypoint counts once at entry. Reversing source and sink can change the verdict.

Exclusions reject any matching event **through and including the final waypoint** and take precedence over a waypoint match. Execution after that prefix is outside the query; an excluded later operation does not invalidate an already reached target. No empty prefix is accepted. An unavailable or ambiguous root, waypoint, or exclusion is `indeterminate` with `queryCoverage.selections`, rather than an invented executable identity.

The shared execution model composes finite summaries keyed by procedure, exact callback bindings, and input waypoint index. Normal, unwind, and tail-call outcomes propagate only to their exact callsite continuations. Loops and recursion converge over these progress states; the analyzer does not enumerate execution permutations or increase the ordinary bounded-trace visit limit. Supported callback forwarding retains each invocation's bindings. Missing bodies, unresolved/native/possible-dispatch calls, opaque/yield/drop operations, and unsupported or malformed reachable continuations remain unknown. Unknown calls acquire no invented return edges. Coverage conservatively includes structurally reachable gaps, even if a representative successful prefix avoids them; context-resolved callback parameters are checked by the ordered summaries.

`witness.steps` is one representative derivation in execution order, separate from the old unordered union slice. Steps retain exact model nodes, branch labels and available conditions/predicates, callsites, normal/unwind continuation IDs, targets, source identities, and fixed-point summary references. Reused invocation summaries retain the invoking caller, callsite, target, proven outcome and continuation; the views label the known summarized invocation and its proven return/continuation. Evidence-budget omissions remain explicitly partial. The capture and normalized request can replay the derivation. In both steps and summaries, `sourceProcedure`/`sourceIdentity` identify the span's owner independently of the summary target. Source links resolve relative spans only through that owner's captured absolute source facts; relative references remain labeled relative. No workspace root is inferred from a relative path.

The **Ordered paths** tab runs this query through the actual worker or its shared main-thread fallback. Use **Query ordered paths** on an Architecture callable, **Use as ordered root** on an entry, or enter an exact root ID. Each waypoint/exclusion line is `procedure <ID>`, `node <ID>`, or `call <ID>`. The witness offers **Open execution flow**, **Open flamegraph**, and **Open UML sequence**. Flow highlights its exact IDs in the full CFG and retains its proof disclosure. Flamegraph/UML load one trace projected directly from those proof steps, force call-order layout, and retain the exact source/proof/replay disclosure; they do not recompute unrelated bounded examples. Returning to the top-level trace tab, or clicking it while active, retains the selected proof. Explicit ordinary entry, pin, or reset actions still request bounded exploration. Pending ordinary trace work is cancelled and stale successes/errors are fenced. Changing the ordered request, cancelling, or replacing a capture clears its old proof context.

The verdict is **STRUCTURAL reachability**. Branch feasibility, data flow/taint, runtime timing, and vulnerability absence remain unsolved. `finding.definitiveNegative` applies only to a completed, coverage-complete negative inside the captured structural model. Budgets or cancellation never establish absence:

- Work defaults to and is capped at 2,000,000 operations, shared between query coverage and summary analysis. State count defaults to and is capped at 50,000 procedure contexts plus node/progress states. Hitting either returns `indeterminate` and `completion.budgetExceeded: true`.
- Timeout defaults to 2,000 ms and is capped at 5,000 ms, including coverage traversal. Traversal yields for cancellation. Timeouts/cancellation return `cancelled`, incomplete completion, and no definitive negative.
- `maxEvidence` defaults to 200 and is capped at 1,000 rows per witness step/summary list. Evidence extraction is also bounded to 16 times that many proof visits. Omitted proof detail becomes an explicit replayable summary reference; `completion.evidenceComplete` and `witness.truncated` expose the omission. Evidence truncation does not change an otherwise completed verdict.

The replay envelope adds `versions.orderedExecution: "structural-ordered-v1"`; capture/request/provenance guarantees remain the same. Replay rejects a changed capture or mismatched version. The API, browser worker and fallback share normalization, identity resolution, coverage, summaries and witness generation.

### Ordered-path validation (after independent source review)

These are frozen pending checks for EDEN-3847, not claimed passes. Run locally on the reviewed commit, retain exact SHA/commands/statuses and output artifact identities, and keep all source/capture data local. The generic fixture must only be compiled/captured, never executed.

```sh
node --test scripts/test-ordered-execution.cjs scripts/test-viewer-ordered.cjs
node --test scripts/test-execution-model.cjs scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-entry-effects.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-effects.cjs scripts/test-trace-waterfall.cjs
node scripts/test-viewer-renderer.cjs
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
```

Record the Node.js, stable Rust, and pinned nightly versions along with the CLI and driver SHA-256 digests. Build the driver from this checkout with the pinned nightly into a local target directory, then set `compatible_driver` to that binary. Use a separate target directory for the CLI build.

Set `$validation_root`, `$tool_target`, `$compatible_driver`, `$ordered_target`, and `$ordered_capture_out` to executor-owned local paths outside the reviewed checkout. The copied source directory must not already exist; Cargo may create a lockfile only in that copy.

```sh
mkdir -p "$validation_root/sources"
cp -R tests/fixtures/ordered-execution/workspace "$validation_root/sources/ordered-workspace"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$ordered_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/ordered-workspace/Cargo.toml" --target-dir "$ordered_target" --out "$ordered_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$compatible_driver" --no-compress -- --offline
ORDERED_CAPTURE="$ordered_capture_out/graph.json" ORDERED_HTML="$ordered_capture_out/graph.html" node --test scripts/test-ordered-execution.cjs scripts/test-viewer-ordered.cjs
```

The raw generic model helper covers reversed siblings, mutually exclusive branches, nested forwarded callbacks, three repeated loop/recursion visits (beyond the ordinary two-visit trace bound), shared callees/multiple callers, cross-package relative source ownership in both witness lists, same-context summary reuse, exclusions, exact normal/unwind continuations, missing/ambiguous identities, malformed continuations, work/state/time/evidence limits, cancellation and replay snapshots/mismatches. The browser harness executes the actual Blob module construction and fallback, form controls, current/stale results/errors, source links, proof-preserving view buttons and the top-level trace-tab handler. It mounts the existing trace renderer and asserts separate known helper invocations, proven summary returns and exact callsite/continuation IDs for sibling and three-visit loop proofs, while evidence truncation stays visibly partial. Fresh capture checks verify generic producer output and execute emitted module bytes plus emitted worker/fallback wiring with the same capture digest. No prior large-capture result substitutes for this fresh tiny capture.

## Configured value influence (optional MIR capability)

`valueFlow` adds a separate value model. A source function preceding a sensitive function is insufficient: a supported operand/assignment/parameter/return/field chain must carry the configured source value into the selected sink endpoint. The browser's **Value flow** tab accepts the same JSON request as the API, executes it through the actual worker or shared fallback, and displays the value witness, coverage, budgets and replay. **Open execution flow** highlights the exact witness nodes/calls in the existing full CFG and retains the value disclosure. Source actions use the captured source owner; a relative path without owner-owned absolute evidence stays relative. Architecture, unordered pins, ordered structural prefixes, flamegraphs and UML keep their existing semantics. Value witnesses do not turn those control views into value proofs.

```json
{"op":"valueFlow","function":"<exact captured procedure ID>","model":{"version":1,"sources":[{"id":"untrusted","at":{"call":"<procedure>#bb0@call","port":"result"}}],"sinks":[{"id":"sensitive","at":{"call":"<procedure>#bb2@call","port":"argument","index":0}}],"summaries":[{"id":"declared-transform","version":1,"call":"<procedure>#bb1@call","kind":"transfer","from":[0],"to":"result","referenceEffects":"none"}]}}
```

An endpoint selects exactly one `call` (ports `argument` with zero-based `index`, or `result`) or `procedure` (ports `parameter` with zero-based `index`, or `return`). Optional `fields` is a list of typed numeric field indices. Select the exact imported procedure ID or exact callsite ID from `cfg`; display names, method suffixes, missing IDs and ambiguous body claims acquire no invented binding. Rule IDs are unique across sources, sinks and summaries. Each list accepts at most 100 rules; the complete normalized request is limited to 256 KiB. Full declarative models live in the replayable request, so GraphJson's removal of arbitrary top-level metadata cannot discard the configuration. No built-in vulnerability or sanitizer names are inferred.

A version 1 summary selects one exact callsite. `transfer` moves the specified argument values into its result; `sanitize` requires `from:[]` and produces a result with no incoming labels. Both require `to:"result"` and explicit `referenceEffects:"none"` or `"unknown"`. These declarations replace value behavior at that call only. They do not establish runtime safety or clear labels from another value, another invocation, an input reference, a bypass or a caller. `referenceEffects:"unknown"` retains unknown effects on reference arguments. This boundary supports configured string transformations without parsing type display strings or matching names. The user is responsible for the declared summary's applicability.

For a precise reference, the existing argument packet carries the known referent's separate field payloads. When a reborrow has no captured referent, it retains the base reference's incoming source facts as possible influence with an explicit unknown boundary. Copying that unresolved reference likewise retains its evaluated incoming facts. Both read those facts before clearing the destination, including same-local assignments; neither creates a referent or a precise alias. An exact declared transfer can therefore retain a source-bearing unknown input in its result while coverage remains partial. A clean unresolved input stays unknown without acquiring labels from an unrelated source. This does not change summary fields, applicability, or reference effects.

Capture compatibility is additive. Control `flow.version` remains **1** and unit version remains **2**. A new producer adds `flow.value_facts` with `{version:1,capability:"rustc-mir-values-v1",status:"captured",parameter_locals,return_local,locals,blocks}`. Local IDs, parameter positions, return local 0 and field projections are body-relative under the accepted parent function/compiler identity. A block carries ordered statement IDs, typed copy/move/constant operands, assignments, reference places, aggregate operands, call arguments, destination and source spans. The driver matches rustc's `Operand`, `Place`, `ProjectionElem`, `Rvalue`, statement and call variants directly. Type strings are display metadata; debug strings are not the data model. Constants retain their compiler type, not a feasibility solver's interpretation of their contents. Unsupported projections/rvalues/statements have explicit records. The importer preserves the optional JSON; `procedure.rawFlowNodeId` points only to the raw body actually imported by Model. New producer-policy directories (`driver-flows-v8`, `driver-check-v10`) and cache version 16 force new facts rather than reusing old fragments. Old consumers can ignore the optional field. Legacy/missing/version-mismatched/malformed facts advertise unavailable/invalid capability and produce query-reachable unknown gaps, never an empty safe answer.

The analyzer uses a finite may-analysis over CFG block states and interprocedural fixed points. Contexts retain exact callsites, argument positions and source/unknown label sets, field payloads and callback bindings; only a child's return and reference-parameter memory are exported to its caller. Unrelated callers cannot exchange local values or continuations. Whole aggregates join fields when read as a whole; field reads preserve separate payloads. Strong writes apply to known local/field places or precise reference referents. Local/field references, copied references and synchronous by-reference argument effects are supported. Overlapping reference arguments, joined/conflicting aliases, references returned across a call, raw pointers, union/variant/index/subslice/opaque projections and representation casts remain unknown. Unsupported memory effects retain ambient unknown propagation. Integer/float computations carry operand influence. Implicit control taint and feasible path conditions are not modeled; CFG joins can combine mutually exclusive branch information and overapproximate influence.

Direct function-pointer callbacks use existing captured callback target/parameter bindings, including forwarded bindings. The compiler explicitly tags Fn/FnMut/FnOnce receiver/tuple calls as `argument_convention:"fn-trait-tuple"`; this first version reports that ABI unknown instead of confusing the receiver and tuple with user parameter positions. Unresolved/dynamic/native calls, missing dependency bodies, drops, yields, unsupported memory effects and reachable unwind cleanup remain explicit coverage gaps. Unknown results and reference effects retain unknown value labels and possible incoming influence. Loops and recursion converge over finite abstract labels and contexts, subject to work/state/time limits; this is not unbounded call-stack enumeration.

`witnesses.items` links configured source IDs and sink IDs to compiler places, statement IDs, argument/parameter indices, return destinations, field paths, reference effects, callsite IDs and source-owner identities. A finding is **candidate influence in the configured captured value model**, not a vulnerability, feasible exploit or vulnerability absence claim. `status:"not-found"` means only that this supported may-analysis found no configured label at the selected endpoint. `finding.definitiveNegative` and `vulnerabilityAbsenceProven` are always false. Any reachable unknown effect yields `indeterminate`, even when a candidate witness exists. Root/query coverage is computed by the same value traversal, not a union of disconnected whole-capture errors.

The shared work budget defaults to/caps at 2,000,000; state allocations default to/cap at 50,000. These bound context creation, CFG/fixed-point evaluation, place/alias processing, label propagation and evidence work. The timeout defaults to 2,000 ms and caps at 5,000 ms. Evaluation yields between contexts and within long CFG walks for cancellation. Budget exhaustion gives `indeterminate`; timeout/cancellation gives `cancelled`. The total returned witness steps and witness rows are each bounded by `maxEvidence` (default 200, cap 1,000). Omitted evidence remains explicit through `truncated` and `completion.evidenceComplete`. Graph/canonical capture identity and immutable body snapshots are prepared once; query requests/models are snapshotted before asynchronous work. Replay includes the complete normalized model and `versions.valueFlow:"mir-values-v1"`, and rejects changed capture or analysis versions. The API, worker and fallback share normalization, capability validation, solver, coverage, witness enrichment and replay.

For a captured body, `parameter_locals` must list exactly the declared `parameter` locals in declaration order as `1..N`; an empty list is valid only when no locals have that role. Local 0 is the sole `return` local and must agree with `return_local`. Contradictory declarations invalidate the body's value capability. A supported direct call must supply exactly N arguments; a mismatch uses unknown call effects and retains possible incoming influence. The query root receives external parameters from its configured model and has no caller argument-count requirement.

### Value-flow validation (frozen; execute after independent source review)

These commands are pending EDEN-3848 checks, not claimed passes. Keep the reviewed source, compiler fragments, fixture and artifacts local. Never execute a fixture application. Record the exact reviewed commit, Node/Rust versions, complete commands/statuses and artifact SHA-256s. First build a **new driver from the reviewed changed source** in a new issue-owned target directory. The old pinned producer documented for ordered-path validation does not emit this capability and cannot validate it; leave its binary and target untouched.

Set `validation_root` to a new local evidence directory, `value_driver_target` to a new issue-owned directory, `tool_target` to the existing shared CLI build cache or an owned directory, `value_target` and `value_capture_out` to new owned directories outside this checkout. The fixture copy must not already exist. Resolve the actual nightly sysroot, then build in this order on macOS:

```sh
node --version
rustc +stable --version
rustc +nightly-2026-02-27 --version
value_sysroot="$(rustc +nightly-2026-02-27 --print sysroot)"
CARGO_NET_OFFLINE=true DYLD_FALLBACK_LIBRARY_PATH="$value_sysroot/lib" RUSTFLAGS="-C link-arg=-Wl,-rpath,$value_sysroot/lib" cargo +nightly-2026-02-27 build --manifest-path crates/bg-driver/Cargo.toml --locked --offline --target-dir "$value_driver_target"
shasum -a 256 "$value_driver_target/debug/bg-driver"
CARGO_NET_OFFLINE=true DYLD_FALLBACK_LIBRARY_PATH="$value_sysroot/lib" RUSTFLAGS="-C link-arg=-Wl,-rpath,$value_sysroot/lib" cargo +nightly-2026-02-27 test --manifest-path crates/bg-driver/Cargo.toml --locked --offline --bin bg-driver --target-dir "$value_driver_target" flow::value_shape_budget_tests::value_shape_budget_counts_serialized_nodes_and_reserved_tails -- --exact
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
shasum -a 256 "$tool_target/debug/cargo-build-graph"
node --test scripts/test-value-flow.cjs scripts/test-viewer-values.cjs
mkdir -p "$validation_root/sources"
cp -R tests/fixtures/value-flow/workspace "$validation_root/sources/value-workspace"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$value_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/value-workspace/Cargo.toml" --target-dir "$value_target" --out "$value_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$value_driver_target/debug/bg-driver" --no-compress -- --offline
shasum -a 256 "$value_capture_out/graph.json" "$value_capture_out/graph.html"
VALUE_CAPTURE="$value_capture_out/graph.json" VALUE_HTML="$value_capture_out/graph.html" node --test scripts/test-value-flow.cjs scripts/test-viewer-values.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --target-dir "$tool_target"
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-execution-model.cjs scripts/test-execution-model-view.cjs scripts/test-execution-flow.cjs scripts/test-flow-map.cjs scripts/test-call-graph.cjs scripts/test-architecture-organization.cjs scripts/test-architecture-minimap.cjs scripts/test-supply-chain.cjs scripts/test-audit-call-graph.cjs scripts/test-entry-effects.cjs scripts/test-ordered-execution.cjs scripts/test-trace-waterfall.cjs scripts/test-viewer-loader.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-effects.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-supply-chain.cjs
node scripts/test-viewer-renderer.cjs
```

The fixture's local path dependency has no network packages. `capture-model.cjs` binds its explicit fixture declarations to unique imported IDs, then uses only those captured procedure/callsite IDs in real requests. Capture checks require actual typed facts and sources, value paths through the independent dependency, argument swap and unrelated-call negatives, field separation, precise reference read/write, supported function-pointer callbacks, configured sanitization/bypass, configured string transformation, finite loop/recursion processing and native/raw/tuple-ABI unknown coverage. Browser checks execute every current embedded module byte from emitted HTML and its actual Blob worker/fallback wiring; they compare API/value witnesses/capture identity/replay and operate real form, cancellation, stale-message, source-link and exact-flow buttons. Synthetic regressions cover malformed/missing/versioned facts, duplicate ownership, model mutation, replay mismatch and work/state/evidence/time/cancellation limits. A synthetic graph or source-text hook alone is insufficient proof of compiler capture or browser behavior.

EDEN-3848 review corrections keep the preceding validation recipe **frozen and deferred until independent clean-source review**, including the focused producer unit command added for VF-15. The optional `rustc-mir-values-v1` capability now includes compiler-derived `shape` descriptors on local declarations, places and field projections: `scalar`, `fields` (ordered child shapes), `reference` (target shape), or explicit `unknown`. The producer bounds a descriptor to depth 12 and 4096 nodes, including unknown/depth leaves. Each child receives a positive capacity after reserving one node for every remaining sibling; a layout that cannot fit its immediate children becomes one unknown node before allocating children. The Rust property regression invokes these same emitter helpers and independently counts serialized nodes for small capacities, nested wide fields, the 4095/4094 sibling-tail reproducer and depth-limited references. Enum/union/index/opaque layouts remain unknown; no display type string supplies semantics. Known shapes validate projection bases, field bounds, aggregate arity and descriptor agreement. Missing layouts only permit unprojected scalar operations; projections and configured field endpoints with unavailable layouts disclose unknown. Unsupported/no-normal-continuation calls remain a conservative body boundary. Control-flow v1, unit v2, fact version 1, cache 16, flow directory v8 and check directory v10 are unchanged.

Value packets preserve nested field suffixes and local aliases. Caller argument sinks consume the conservatively evaluated operand packet, including source-bearing unknown labels for unresolved valid operands; configured field selectors are separately checked and invalid selectors never invent a source binding. Precise field writes mask inherited whole-aggregate labels; may-joins intersect these masks only across present states. A pending/no-return export is bottom, while an actual clean or unit return is present. Thus wrapper readiness cannot remove strong masks, and a write on one actual branch cannot erase the other branch's influence. Normal returns and unwind cleanup stay separate. Scalar by-reference effects retain their supported contract. Reference-valued memory writes/returned aliases invalidate stale caller aliases, disclose `reference-memory-escape`/returned-reference uncertainty and retain possible source-bearing inputs/referents. Known and unknown alternatives join structured returns and reference memory from the same pre-call packets before one caller writeback; unknown alternatives remove unsupported strong masks and retain alias uncertainty. When a source token occurs in both alternatives, its possible incoming proof is retained; known-only internal sources and their invocation proofs still join. Callback environments validate unique argument/forwarded bindings, exact target identities and boolean types for supplied `unknown` flags. Raw `callback_unknown` must also be boolean, and valid true remains unknown even with a resolved callback parameter. Contradictory bindings join their candidates with an explicit gap rather than selecting a row.

Finite semantic summary keys contain argument positions, structured labels/masks, callsite and callback bindings, never recursive proof IDs. Summary parameter steps are symbolic input dependencies. Each caller instantiates exported proofs against its current argument proof and records invocation context, exact target, caller context and target context on call-boundary evidence. Parameter/source endpoints use the accepted local declaration span (`local:N`), without substituting another raw body's source. A nonempty compiler identity must agree with every supplied compiler/procedure owner claim on the actual `Model.rawFlowNodeId`; missing, conflicting or duplicate claims are unavailable. The viewer separately records operation, generation and capture ownership of the displayed proof, so cancelling an older panel cannot erase a newer ordered/value/pin analysis.

| Finding | Source correction | Regression gate (all runtime gates deferred) |
| --- | --- | --- |
| VF-2 | Structured aggregate packet/field/alias installation | `reviewCases()` nested positive/clean, direct and callee-return; fresh `nested_*` tuple cases |
| VF-3 | Reference-memory escape export, stale alias invalidation, retained inputs, sink consumes evaluated argument packet | Shared exact/field retarget positive/clean require possible source at selected caller sink in API/replay/both transports; fresh `retarget_*`; scalar reference-write and exact owner controls |
| VF-4 | Symbolic input-proof substitution and invocation/target lineage | Shared second-result-only nested swap proof, API replay and actual form/open-flow; existing recursion/loop/callback controls; fresh `reused_proof` |
| VF-5 | Compiler shape emission and typed place/endpoint validation; unresolved valid operand packet consumed at sink | Shared missing layout requires source-bearing possible caller sink; scalar/out-of-range/conflicting descriptor and invalid selector controls; valid nested/flat fields; fresh shape assertions |
| VF-6 | Accepted-body control/value successor/kind/action/target/continuation checks | Shared malformed reachable controls and disconnected malformed-body positive control |
| VF-7 | Per-invocation callback validation, joined duplicate candidates plus unknown; typed certainty flags and raw unknown preserved | Shared zero/string/null and valid false/true, clean/identity, forwarding/raw-flag cases; both duplicate orders, known+unknown and valid forwarding controls |
| VF-8 | Strong-write inherited-field masks with bottom excluded from actual alternative joins | Whole-aggregate source overwritten/untouched siblings; pending return/ref-writer wrappers, real one-branch write and separate unwind, bounded fixed point and replay; fresh `overwrite_wrapper_*`; retained direct/nested/reference/summary controls |
| VF-9 | Monotone known/unknown structured return and pre-call reference-memory union | Exact input→mixed clear/unknown→zero-argument gate→sink, clean and aggregate-field controls require possible source at selected sink through API/replay/both transports; fresh `mixed_reference*`; internal-source and multiple-known return controls retained |
| VF-10 | Charged sorted alias comparisons, compact per-step proof references and work-interval yields inside statements/arguments/aggregates/proof instantiation | Focused reference/proof cardinality work/time exhaustion, actual in-flight worker/fallback cancellation |
| VF-11 | Actual accepted raw-body compiler/procedure claims | Shared null/empty/mismatch/duplicate ownership, rejected-first accepted-second source owner and replay |
| VF-12 | Operation/generation/capture ownership of displayed analysis | Actual value→ordered→value-edit, ordered→value→ordered-edit, value→pins→cancel in both transports, retained disclosure/pins |
| VF-13 | Accepted declaration source/parameter witness span | Shared parameter source action, relative source/rejected owner controls; fresh `parameter_source` |
| VF-14 | Exact callee target and invocation on by-reference evidence | Both transports call the renderer's actual `callEdgeActive` contract after real open-flow; renderer boundary test and fresh reference write |
| VF-15 | Shared producer node accounting with sibling reservations before child construction | Focused nightly Rust serialized-node property filter above; small budgets, unknown/depth leaves and nested 4095/4094 sibling tails; mandatory new reviewed driver build and fresh capture |

Run the frozen commands above without substituting the old pinned driver/capture. `node --test scripts/test-value-flow.cjs scripts/test-viewer-values.cjs` contains the shared review matrix plus real cancellation and mode-ownership checks. The capture-backed invocation with `VALUE_CAPTURE` and `VALUE_HTML` additionally checks every `capture.reviewedCases` declaration through the independent local dependency and both emitted transports. `scripts/test-execution-model-view.cjs` is already in the existing affected-boundary command. No application execution, release qualification, Adam transfer or external publication is part of this local recipe. Parser/whitespace checks alone do not establish any of these behavioral gates.

## Declared authorization and validation obligations

`guardObligations` asks whether a **supported captured execution prefix** reaches an explicitly declared sensitive call without all declared successful checks on the same principal/tenant/object/value identities. Policy comes entirely from the request. Names, call co-occurrence, call reachability and may-taint label overlap never supply a guard or a binding.

```json
{"op":"guardObligations","function":"<exact procedure ID>","model":{"version":1,"rules":[{"id":"declared-policy","operation":{"call":"<procedure>#bb2@call","bindings":{"principal":{"index":0},"tenant":{"index":1},"object":{"index":2},"value":{"index":3}}},"requires":[{"id":"required-check","at":{"call":"<procedure>#bb0@call","bindings":{"principal":{"index":0},"tenant":{"index":1},"object":{"index":2},"value":{"index":3}}},"success":true}]}],"summaries":[]}}
```

A rule identifies one exact callsite as the operation. Each conjunctive requirement identifies an exact guard callsite, its required boolean result, and argument bindings with the same named keys as the operation. Binding names are user-defined; include every subject and value relevant to the policy. An optional `fields:[0,1]` selects compiler-described fields of an argument. Guard results are correlated to typed boolean branches for that invocation. A check that ran without a tested successful result grants nothing. A check after the effect is outside the inspected prefix. Alternate branches retain separate values and checks. Witness requirements distinguish missing checks, ignored/unchecked results, failed outcomes and unproven subject/value bindings.

`status:"bypass"` exposes candidate obligation violations in the configured structural model. `supported-compliant` means the inspected, supported prefixes reaching the operation have matching successful checks; each witness is scoped to its path, declared policy and captured model. `not-reached` means no supported inspected prefix reached the operation. None establishes universal compliance, authorization correctness, runtime exploitability, vulnerability absence or feasible execution. `finding.definitiveNegative` and `vulnerabilityAbsenceProven` are always false. A reachable unknown frontier or exhausted bound makes the query `indeterminate`; timeout/cancellation makes it `cancelled`. Supported prefix rows can remain visible alongside unknown coverage. Missing data is never a compliant or safe conclusion.

The engine reuses the accepted shared body/value validation and model call identities. Copies, fields, exact argument/parameter/return transfers and separate sequential invocations retain immutable value identities. Writes and scalar computations replace identities; a transformed result is not credited by a check on its input. Constants lack a typed literal-value equality model and cannot establish a named subject/value binding. References, reference-containing bindings, raw pointers, unsupported projections or memory operations, possible dispatch, Fn-trait tuple ABI, missing bodies, malformed facts and reachable unwind cleanup stay unknown. Direct function-pointer calls use exact per-invocation callback forwarding. Repeated blocks within an invocation and recursive calls stop at an explicit loop/recursion frontier; this first version does not claim complete loop analysis. Conditions other than captured boolean identity constraints and the declared successful outcomes are not solved for feasibility.

An exact pure helper boundary may be declared in `model.summaries` as `{id,version:1,call,returns:"fresh"|"argument",argument?:index,effects:"none"}`. `argument` preserves only that argument's exact identity; `fresh` creates a new identity with the captured destination shape. This is an explicit, replayed policy assumption about one callsite, including an otherwise unavailable dependency/native helper. It does not infer a helper contract or discharge a failed/unchecked guard. Summaries cannot replace the sensitive operation itself. Without a sufficient declared summary, unsupported helper/dispatch/native behavior remains indeterminate.

The producer adds **optional** `flow.guard_facts:{version:1,capability:"rustc-mir-guards-v1",status:"captured",branches,function_values}`. Each branch record owns one accepted-body block and either records a compiler boolean `SwitchInt` discriminant with explicit false/true target IDs or marks it unsupported. No outcome comes from display labels. `function_values` certifies only nongeneric compiler `FnDef`→`FnPtr` reification at one exact statement, with compiler function ID, source operand, destination and source span. Contradictory/unavailable rows do not license arbitrary pointer casts. The pointer must agree with the existing exact callback target binding. Control v1, unit v2 and optional value-facts v1 retain their formats and semantics. Producer flow/check directories advance to `driver-flows-v9`/`driver-check-v11`, cache version 17, so an older cached producer cannot supply this capability.

The browser's **Required guards** tab accepts this JSON, shows rule/path/source/assumptions and replay, and opens exact witness nodes/calls in the existing full execution-flow view. It uses the same engine as the API through the actual worker or fallback, with independent cancellation and capture/generation ownership. Existing pins, layouts, minimaps, ordinary queries and value/ordered views keep their semantics. Replay records the complete normalized policy and `versions.guardObligations:"guard-obligations-v1"`, and rejects changed capture or analysis versions. Limits are 32 rules, 16 conjunctive requirements and 16 bindings per rule, 100 summaries, 256 KiB request, 2,000,000 work, 50,000 states, 2,000 ms default/5,000 ms maximum, and 200 evidence rows/steps default (1,000 cap). Omitted evidence is explicit and does not clear unknown coverage.

### Guard-obligation validation (frozen; execute after independent source review)

These are **pending EDEN-3849 checks**, not passes. Execute locally on the independently reviewed exact commit; stop at the first nonzero status and retain command/output/SHA evidence. No source or capture upload, Adam transfer, publication or fixture-application execution is part of this recipe. Use a fresh issue-owned driver target; the EDEN-3848 driver and old pinned c288 driver lack this capability and must remain untouched. The CLI embeds changed JavaScript and must be rebuilt.

Set `validation_root` to a new local evidence run directory outside the checkout. Set `guard_driver_target="$validation_root/driver-target"`, `guard_target="$validation_root/fixture-target"`, `guard_capture_out="$validation_root/capture"`; none may contain a prior run. Set `tool_target` to your CLI build target directory. The copied fixture source must not already exist. Cargo may create fixture lockfiles only in this copy. Record the reviewed `git rev-parse HEAD` and all resulting SHA-256s.

```sh
set -e
node --version
rustc +stable --version
rustc +nightly-2026-02-27 --version
guard_sysroot="$(rustc +nightly-2026-02-27 --print sysroot)"
CARGO_NET_OFFLINE=true DYLD_FALLBACK_LIBRARY_PATH="$guard_sysroot/lib" RUSTFLAGS="-C link-arg=-Wl,-rpath,$guard_sysroot/lib" cargo +nightly-2026-02-27 build --manifest-path crates/bg-driver/Cargo.toml --locked --offline --target-dir "$guard_driver_target"
shasum -a 256 "$guard_driver_target/debug/bg-driver"
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
shasum -a 256 "$tool_target/debug/cargo-build-graph"
node --test scripts/test-guard-obligations.cjs scripts/test-viewer-guards.cjs
mkdir -p "$validation_root/sources"
cp -R tests/fixtures/guard-obligations/workspace "$validation_root/sources/guard-workspace"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$guard_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/guard-workspace/Cargo.toml" --target-dir "$guard_target" --out "$guard_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$guard_driver_target/debug/bg-driver" --no-compress -- --offline
shasum -a 256 "$guard_capture_out/graph.json" "$guard_capture_out/graph.html"
GUARD_CAPTURE="$guard_capture_out/graph.json" GUARD_HTML="$guard_capture_out/graph.html" node --test scripts/test-guard-obligations.cjs scripts/test-viewer-guards.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --target-dir "$tool_target"
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-execution-model.cjs scripts/test-execution-model-view.cjs scripts/test-execution-flow.cjs scripts/test-flow-map.cjs scripts/test-call-graph.cjs scripts/test-architecture-organization.cjs scripts/test-architecture-minimap.cjs scripts/test-supply-chain.cjs scripts/test-audit-call-graph.cjs scripts/test-entry-effects.cjs scripts/test-ordered-execution.cjs scripts/test-value-flow.cjs scripts/test-trace-waterfall.cjs scripts/test-viewer-loader.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-effects.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-values.cjs scripts/test-viewer-supply-chain.cjs
node scripts/test-viewer-renderer.cjs
```

The paired fixtures cover fail-open, early return, ignored and failed results, checks after effects, alternate branches, principal/tenant/object mismatch, transformed versus rechecked values, field identity, middleware/dependency calls, repeated invocations, exact pointer callbacks, pure declared dependency/native summaries, legacy/malformed capabilities and unknown loops/recursion/aliases. The fixture application is never invoked. `capture-model.cjs` binds only explicit fixture declarations to unique imported IDs. The capture gate requires actual typed boolean outcomes, the independent local dependency and pointer reification. Browser tests verify current emitted module bytes, actual Blob-worker construction and fallback, API/replay parity, real JSON forms, source links, exact flow IDs, capture replacement, cancellation, stale results/errors and operation-owned evidence. Synthetic-only tests or an ad-hoc patched HTML file cannot satisfy the fresh producer/browser gate. All behavior, build and capture commands remain deferred until independent clean source review.

## Build-time dependency execution (EDEN-3850)

`buildInventory` uses the existing Cargo package catalog and entry/effect engine. It returns paged `inventory`, `units`, and `relationships` lists with `versions.buildExecution:"cargo-build-execution-v1"`. The same operation works through the viewer's actual worker and fallback. `entrypoints`, `effects`, `effectPaths`, and `buildInventory` accept `phase:"build"|"application"|"dev-test"|"unknown"`; omission selects all phases. The **Entry points and effects** tab exposes the filter and a paged build evidence disclosure. Replay preserves the phase and rejects different analysis versions or captures.

Inventory records retain exact Cargo package IDs, target/source declarations, build dependency kinds, aliases, conditional expressions and required features. A resolved package edge is a declaration; its condition is retained without evaluating it. A reported unit carries an exact `buildUnitId` (the existing unit-v2 key), target/source, selected compiler features, target triple and explicit rustc profile flags. Cargo profile names and unspecified codegen defaults remain unknown. Duplicate versions and multiple units of one package remain separate. Compiler entry identities and typed proc-macro export attributes establish entry declarations. Resolved call reachability establishes logical unit memberships; identical host and target triples never collapse build/application roles. A reused unit can belong to both. Dev/test declarations and Cargo test-profile outputs remain visible even when test-harness bodies are omitted by the existing producer.

Three evidence kinds have distinct meanings:

- `declaration`: Cargo targets/dependencies or entry declarations that can execute under their activation conditions. Missing build bodies stay in inventory and expose unknown effects.
- `modeled-capability`: the existing exact compiler/std-artifact effect registry or an explicit versioned adapter, reachable over recorded structural calls. Filesystem, process, environment-read (`sensitive-data`) and network summaries are capabilities. Reachability never proves observed execution or syscalls.
- `observed-build-evidence`: literal Cargo/compiler reports. `compiler-artifact` proves a reported package/target output association; exact output-to-unit correlation can remain unknown. `build-script-executed` can report cached outputs and does not prove a script newly ran. Environment reports retain names only, never values.

Source relationships retain validated compiler body/definition source references and consuming units. Native relationships retain linker directives, artifact lookup and linking packages. Neither `OUT_DIR` containment nor a filename establishes a source/native writer. Without an explicit writer fact, `producerStatus:"unknown"` remains visible. Proc-macro export capture establishes code that can run during expansion; a macro invocation-to-generated-item producer mapping is not claimed. Static calls, Cargo reports and output files are not filesystem/process/network observations. All rows keep source/owner/phase/evidence and unknowns; partial coverage and absence of effects never imply safety.

Optional unit-v2 `build_context`, `compiler_entry`, and definition-source facts leave MIR/value/guard formats unchanged. Capture caches use graph policy 19, `driver-flows-v11`, and `driver-check-v13`; producer and consumer paths advance together. Unchanged valid captures preserve build-unit and Cargo-report attributes when the package catalog refreshes. Older or malformed context stays unknown; duplicate unit records are diagnosed as ambiguous. Existing adapters, graph pins and ordered/value/guard queries retain their models.

### Frozen local validation recipe

These checks are **pending**, and run only after independent clean source review. Use a fresh issue-owned local run directory, driver target, fixture copy/target and output. Keep all source and captures local. The controlled fixture build necessarily executes its `build.rs`, proc-macro expansion, `cc` and `ar`; it never invokes the fixture application and makes no network requests. All fixture dependencies are local paths. Cargo may create lockfiles in the fresh copy only. Record the reviewed SHA, command statuses, compiler versions and SHA-256s of driver, CLI and captures. Stop on a nonzero result and retain it.

Set `validation_root` to an unused local evidence directory; set `build_driver_target="$validation_root/driver-target"`, `build_target="$validation_root/fixture-target"`, `build_capture_out="$validation_root/capture"`, and `tool_target` to the permitted existing stable Cargo cache (or a new executor-owned target). Do not overwrite archived binaries or old run directories.

```sh
set -e
node --version
rustc +stable --version
rustc +nightly-2026-02-27 --version
node --test scripts/test-build-supply-chain.cjs scripts/test-viewer-build-supply-chain.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --bin cargo-build-graph --target-dir "$tool_target"
build_sysroot="$(rustc +nightly-2026-02-27 --print sysroot)"
CARGO_NET_OFFLINE=true DYLD_FALLBACK_LIBRARY_PATH="$build_sysroot/lib" RUSTFLAGS="-C link-arg=-Wl,-rpath,$build_sysroot/lib" cargo +nightly-2026-02-27 build --manifest-path crates/bg-driver/Cargo.toml --locked --offline --target-dir "$build_driver_target"
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
shasum -a 256 "$build_driver_target/debug/bg-driver" "$tool_target/debug/cargo-build-graph"
mkdir -p "$validation_root/sources" "$validation_root/first-capture"
cp -R tests/fixtures/build-supply-chain "$validation_root/sources/build-supply-chain"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$build_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/build-supply-chain/app/Cargo.toml" --target-dir "$build_target" --out "$build_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$build_driver_target/debug/bg-driver" --no-compress -- --offline
cp "$build_capture_out/graph.json" "$validation_root/first-capture/graph.json"
cp "$build_capture_out/graph.html" "$validation_root/first-capture/graph.html"
BUILD_SUPPLY_CAPTURE="$build_capture_out/graph.json" BUILD_SUPPLY_HTML="$build_capture_out/graph.html" node --test scripts/test-build-supply-chain.cjs scripts/test-viewer-build-supply-chain.cjs
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$build_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/sources/build-supply-chain/app/Cargo.toml" --target-dir "$build_target" --out "$build_capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$build_driver_target/debug/bg-driver" --no-compress -- --offline
BUILD_SUPPLY_CAPTURE="$build_capture_out/graph.json" BUILD_SUPPLY_HTML="$build_capture_out/graph.html" BUILD_SUPPLY_PRIOR_CAPTURE="$validation_root/first-capture/graph.json" node --test scripts/test-build-supply-chain.cjs scripts/test-viewer-build-supply-chain.cjs
shasum -a 256 "$build_capture_out/graph.json" "$build_capture_out/graph.html"
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-supply-chain.cjs scripts/test-entry-effects.cjs scripts/test-ordered-execution.cjs scripts/test-value-flow.cjs scripts/test-guard-obligations.cjs scripts/test-viewer-effects.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-values.cjs scripts/test-viewer-guards.cjs scripts/test-viewer-supply-chain.cjs
```

The browser build suite reuses the existing actual viewer harness; its imported baseline entry/effect cases register in that process as ordinary regressions. Synthetic graphs cannot satisfy the conditional capture gates. Fresh emitted HTML must contain the current shared module bytes and the actual captured graph. No patched HTML, capture edits, application execution, remote source upload or new monitoring service is part of this recipe. Previous driver/CLI archives cannot prove these new producer or embedded-module capabilities.

## Call paths and local advisory exposure (current)

`callPaths` is a shared API/browser operation independent of advisory data. Obtain exact endpoints from `functions.items[].id`, then query:

```json
{"op":"callPaths","from":"<exact function ID>","to":"<exact function ID>","includePossible":true,"page":{"nodes":{"limit":100},"edges":{"limit":100}}}
```

The result is the **complete finite connecting captured call subgraph** when `completion.graphComplete` is true: the intersection of forward reachability from `from` and reverse reachability from `to`, with every directed call edge between those nodes. Branch alternatives and call cycles remain in the graph. There is no enumeration of walks and no claim that bounded witnesses are “all paths.” When endpoints are equal, the zero-length route exists and all captured cycles returning to that endpoint are included. Candidate/function-reference edges and intraprocedural CFG-loop display edges are excluded; real recursion is retained. Ambiguous path spellings fail with `AMBIGUOUS_ENDPOINT`; non-ID path aliases and unknown IDs fail separately. An actual ID always names that exact node, including duplicate package versions/build units.

The default `includePossible:true` includes global callback/indirect alternatives as **possible overapproximations**. These bindings are not invocation-specific proof. Setting it false excludes uncertain constituent callsites while preserving separately captured direct callsites on a coalesced recursive edge. Mixed edges expose per-callsite certainty; `invocationExact` stays false. Reachable excluded alternatives make coverage partial. `captured-route`, `no-captured-route` and budget/cancellation `indeterminate` describe the captured graph and selected policy. They never establish global impossibility, feasible execution, exploitability or non-exposure. Query coverage includes the source-reachable missing-body/unknown-call frontier, Model callback/binding/native/legacy gaps (including empty bindings), accepted per-procedure opaque/yield body gaps and missing-MIR stubs with block identity/source, possible-policy exclusions and hidden outside-scope intermediaries. Body-gap facts are indexed once from accepted Model blocks and visited/charged only for source-reachable procedures; these visits share the query work/byte/cancellation bounds. A producer missing-MIR stub has `bodyStatus:"unavailable"` and `bodyAvailability:"missing-mir"`, while retaining a uniquely linked procedure/compiler symbol identity. Other accepted bodies have `bodyAvailability:"available"`; opaque/yield boundaries still make their query coverage partial. Whole-capture coverage is retained separately as `capturedCoverage`; disconnected uncertainty does not itself make a query partial. `scope` affects presentation only; traversal crosses all captured packages.

Default/hard maximum budgets are `maxWork:2000000`, `maxNodes:50000`, `maxEdges:200000`, `maxEvidenceBytes:8388608`; timeout is 2000 ms by default, maximum 5000 ms. Evidence bytes conservatively count retained UTF-16 JSON bytes, and the index is proportional to the loaded capture. Query traversal yields periodically and accepts a cancellation callback in the shared module. Budget/cancel results expose `completion.reason` and do not publish an alleged complete subgraph. Paging is separate: `completion.graphComplete` can be true while `completion.evidenceComplete` is false. Detailed evidence tables still page via independent `nextOffset` values. `membership:{schemaVersion:1,complete,nodeIds,edges}` separately carries the full bounded corridor topology: edge tuples are `[sourceId,targetId,kind]`. It is charged against the same work/node/edge/evidence bounds, never enumerates walks, and is unchanged by table-page selection. Interrupted analysis returns incomplete empty membership. Replay binds `callPaths:"captured-call-paths-v2"` and `advisoryExposure:"local-osv-exposure-v2"`; older semantic versions require a new query. Each edge carries all retained callsites and source evidence within the query budget.

In the existing unified function map, use **Use as call-path start/destination** on two functions; the existing call overview also accepts Shift-click/Alt-click. The sidebar displays the selected endpoints, source-linked callsites, symbolic graph and pages. Highlighting uses complete bounded membership, independently of table pages, and discloses incomplete maps. The shared map highlight has an exact actor/generation/capture-catalog lease. Explicit entry/effect selection or a new call/advisory run transfers ownership; late results and old-panel clears, filter refreshes or paging cannot overwrite another actor. Current-owner paging retains full bounded membership. Capture replacement fences all old leases before panel cleanup. Pins and tree/node/edge filters are preserved. Scope/tree filters can hide intermediaries and are disclosed; they do not restrict analysis. Function-inspection links inspect one captured function only. **Open endpoint route flow/flamegraph/sequence** first runs existing `orderedPath` from the exact source procedure to the exact destination procedure, then opens its supported complete witness. An absent, truncated or ambiguous witness is reported as indeterminate instead of showing an unrelated endpoint-route execution. Query changes/cancellation/capture replacement discard stale results and endpoint witnesses. Endpoint detail owns an exact ordered generation and catalog; a later independent ordered/value/guard/structural query replaces that ownership and its current proof is preserved.

`advisoryExposure` accepts only local JSON; no database download, network refresh or mandatory service is introduced. Import a bounded envelope (at most 1 MiB JSON characters, 1000 advisory records, 1000 mappings of each kind):

```json
{
  "op":"advisoryExposure",
  "snapshot":{
    "schemaVersion":1,
    "source":{"name":"Local RustSec OSV export","uri":"file:///local/snapshot.json"},
    "retrievedAt":"2026-11-01T00:00:00Z",
    "asOf":"2026-11-16T00:00:00Z",
    "advisories":[{"schema_version":"1.9.2","id":"x_EXAMPLE-001","modified":"2026-11-01T00:00:00Z","affected":[{"package":{"ecosystem":"crates.io","name":"example"},"ranges":[{"type":"SEMVER","events":[{"introduced":"1.0.0"},{"fixed":"2.0.0"}]}]}]}],
    "coordinateMappings":[],
    "functionMappings":[]
  },
  "phase":"application",
  "page":{"findings":{"limit":100},"unmatched":{"limit":100},"diagnostics":{"limit":100}}
}
```

The supported interchange is the [OSV schema, currently 1.9.2](https://ossf.github.io/osv-schema/), including RustSec exports **in OSV JSON format**; native RustSec TOML is not accepted. Schema 1.0.0 (also the OSV default when omitted) through 1.9.2, Cargo `crates.io` coordinates, exact listed SemVer versions and `SEMVER` intervals using `introduced` (`"0"` sentinel allowed), exclusive `fixed`/`limit`, and inclusive `last_affected` are supported. SemVer prereleases and arbitrary-length decimal components are ordered without floating-point conversion. Events are sorted by SemVer before evaluation; `limit:"*"` and multiple limits follow OSV scope semantics. Mixed fixed/last-affected timelines and contradictory boundaries remain unknown. Unsupported `GIT`/`ECOSYSTEM` ranges, purls, applicability conditions/extra database or ecosystem facts, unsupported ecosystems/schema versions, malformed versions/events and unknown native versions remain **unknown**, never unaffected by assumption. Unsupported/malformed/unmatched and withdrawn records remain in the complete replay/export snapshot and diagnostics. A supported positive interval can establish affected-version membership even if an additional union range is unsupported; unsupported conditions cannot.

Source identity is required in addition to name/version. Only exact captured `registry+https://github.com/rust-lang/crates.io-index` or `sparse+https://index.crates.io/` sources bind automatically to crates.io. Local/path/git packages with identical name/version remain source-unknown. An explicit envelope `coordinateMappings` record can declare a relationship, requiring `{schemaVersion:1,packageId,source,version,ecosystem,name,provenance}`: `packageId`, captured `source` (including explicit null for a local package), and `version` must agree exactly. Duplicate, unbound and malformed mappings are unknown. Such evidence is labeled **declared**, not verified registry provenance.

Findings keep three facts separate: package presence; reachable captured code in an affected **package version**; and an identified vulnerable **function**. The last requires an explicit `functionMappings` record `{schemaVersion:1,advisoryId,packageId,functionId,provenance}`. Optional `procedureId`, `nodeId`, `buildUnitId` fields are conjunctive exact selectors, never fallbacks. All supplied fields must match one uniquely accepted, exact package-owned captured body. Missing-MIR stubs do not qualify as captured bodies or identified vulnerable functions even when their compiler symbol is linked. Unavailable package bodies keep a negative captured-reachability/exposure conclusion indeterminate; a positive route to other available captured code remains separately visible. Ambiguous matches stay unknown. Prose, summaries and matching function names never identify vulnerable functions. A package-only advisory does not identify every function as vulnerable; `reachableIdentifiedFunction` is separate from package reachability.

Each finding preserves its exact package version/source, the finite dependency subgraph connecting established workspace roots to that exact package (forward-root/backward-package intersection, all alternatives/cycles and conditions retained), application/build/dev-test entry evidence, source-linked captured targets, build-unit target/features/context, and shared `callPaths` request/replay descriptors. Phase filtering selects the existing entry inventory; it does not promote global callback bindings into phase proof. Orphan catalog ancestors are not inclusion explanations. With no established workspace-root route, inclusion is explicitly unknown. Package presence and dependency activation remain distinct. A no-captured-route result or missing MIR/bindings/native bodies never means safety or non-exposure. Findings with incomplete/unknown coverage remain indeterminate; `capturedReachability` separately names reachability in the captured graph. Withdrawn advisories are retained and do not issue an active exposure assertion.

Freshness is measured against the envelope's pinned `asOf`, never the live clock: older than 30 days is `stale`, future retrieval is explicit. Source/age are evidence, not trust certification. Every request/replay embeds the **complete immutable snapshot and mappings**, and results expose its canonical SHA-256 plus local export. Mutating imported input, results or later local files cannot silently alter a dispatched query/replay. `phase` and exact `packageId` filters are replayed. Default/hard ceilings are `maxWork:2000000`, `maxRoutes:200`, `maxFindings:1000`, `maxEvidenceBytes:16777216`; exhausted work/routes/findings/time/cancellation leaves `completion.complete:false`. All generated retained diagnostics, unmatched rows, inclusion evidence, structured symbol mappings/diagnostics, routes and final finding fields are charged before append/copy using conservative UTF-16 JSON bytes. The mandatory immutable normalized request/replay, pinned snapshot/export and fixed response envelope are excluded explicitly from this generated-evidence budget; original unknown records remain identifiable in the snapshot when generated evidence is truncated. Conservative accounting can include intermediate/replaced finding fields. Version lists, ranges, events, timeline sort/comparisons, coordinate/mapping and symbol-target scans spend work before collection growth and yield cooperatively during inner passes. Tiny work/byte limits and cancellation return explicit incompleteness. Findings, unmatched records and diagnostics page independently. Export in the browser produces the local envelope for download; source data stays local.

Focused verification commands (execute only after independent review of the candidate):

```sh
node --test scripts/test-call-paths.cjs scripts/test-advisory-exposure.cjs scripts/test-viewer-call-paths.cjs scripts/test-viewer-advisories.cjs
CALL_PATHS_CAPTURE=/owned/current/graph.json CALL_PATHS_HTML=/owned/current/graph.html ADVISORY_CAPTURE=/owned/current/graph.json ADVISORY_HTML=/owned/current/graph.html node --test scripts/test-call-paths.cjs scripts/test-advisory-exposure.cjs scripts/test-viewer-call-paths.cjs scripts/test-viewer-advisories.cjs
```

The second command requires both graph and HTML from the **current CLI**. Browser tests consume the actual emitted module bytes, real Blob-worker source and fallback transport. The compiler fixture is generic; product behavior has no fixture/package/function name exceptions. Historical emitted HTML is not current UI evidence.

## Failure, cleanup and partial updates (08, source candidate)

`failureObligations` uses the same JSON API, browser Blob worker, fallback, capture identity and complete-model replay envelope. It evaluates a **declared finite protocol**, never a transaction inferred from a repository, type, function or filename. Obtain exact procedure, callsite, node and edge IDs from the captured model. A resource example is:

```json
{
  "op":"failureObligations",
  "function":"<exact root procedure ID>",
  "model":{
    "version":1,
    "provenance":"reviewed resource contract v1",
    "rules":[{
      "id":"resource",
      "states":["idle","held"],
      "initial":"idle",
      "terminal":{"normal":["idle"],"error":["idle"],"unwind":["idle"],"cancel":["idle"],"drop":["idle"]},
      "transitions":[
        {"id":"acquire","call":"<exact acquisition callsite>","outcome":"normal","subject":{"port":"argument","index":0},"from":["idle"],"to":"held"},
        {"id":"release","call":"<exact cleanup callsite>","outcome":"normal","subject":{"port":"argument","index":0},"from":["held"],"to":"idle"}
      ]
    }],
    "summaries":[],
    "outcomes":[]
  }
}
```

Each transition names a call **completion** (`normal` or `unwind`), a typed argument or normal result, optional typed `fields` indices, allowed prior states and the next state. All terminal outcome lists are explicit. There is at most one transition per protocol/call/outcome. A begin/update/commit/rollback contract uses states such as idle/begun/dirty/done/rolled: normal may permit done, while error/unwind permit only idle/rolled. An apply-once contract permits idle→applied; a repeated same-subject call produces `unexpected-transition`. Declared idempotency permits applied→applied. These are assumptions supplied by the analyst and retained with provenance, not facts recovered from names or proof that the policy is correct.

`outcomes:[{id,node,outcome}]` labels an exact accepted captured node. Normal/error labels are sticky until another explicit annotation. Exact captured `edge` selectors support normal/error labels too. Handled failures require these declarations; no `Result::Err`, catch or transaction interpretation is inferred. A `cancel`/`drop` node annotation explicitly models termination at that point; it does not fabricate an observed edge or claim the compiler captured cancellation/destruction. Ordinary yield, drop, assert, opaque, abort, unavailable MIR and unsupported control stay unknown. Captured normal/unwind calls, callee effects/returns and cleanup continuations are traversed in stack order. Call-completion actions apply only to their matching outcome.

Identity comes from accepted `ValueFlow.build` facts and validated `GuardObligations.build` boolean/function-value indexes. Per-invocation parameters, scalar/field copies and supported call arguments/returns preserve identity; moves invalidate the source, overwrites replace it, and field writes replace containing aggregate identity and invalidate its inherited freshness. Distinct scalar origins or parameters do **not** prove distinct runtime resource IDs. A new same-protocol subject with an uncertain relationship to an existing subject stops at `unproven-subject-alias`. Explicit fresh-result summaries can establish fresh object tokens; freshness of a container does not establish distinctness of its field values. Constants, references, unsupported aliases, ambiguous calls/callbacks, malformed ownership/facts and unsupported transformations remain unknown. Reachable accepted raw execution metadata is checked before traversal; discarded malformed target/callback fields produce an unknown frontier even when a normalized direct target remains. Disjoint malformed records remain capture diagnostics without degrading this root's coverage. A symbol identity alone does not provide a body.

An exact invocation summary has `{id,version:1,call,outcomes:["normal","unwind"],returns:"fresh"|"argument"|"unknown",argument?,effects:"declared-protocol-only"}`. It explicitly assumes that all effects relevant to these protocols are covered by declared transitions, and may replace an opaque/external invocation. Returns/coverage/provenance remain visibly modelled. A summary that omits a captured normal or unwind continuation adds an unknown gap; it cannot silently remove cleanup coverage. Without a valid explicit summary, unknown external/global/alias effects prevent a missing-compensation conclusion beyond that boundary.

Witnesses expose rule, object token, state, outcome, relevant assignment/call/transition steps, invocation context, exact edge IDs, accepted source identity and model assumptions. `candidate-violation` is scoped to a supported structural path under the declared contract. `supported-compliant` describes a supported path. Partial coverage can coexist with retained candidates; no bounded search result proves absence, universal consistency, branch feasibility or runtime exploitability. Scope is presentation context (`scope.requested`), and traversal crosses the full captured graph. The browser opens one selected witness's captured steps/root/context in the existing execution-flow view and keeps other actors' newer evidence and pins intact. Replay includes the whole model and fences capture content and analysis versions.

Default/hard ceilings are work 2,000,000; processed states 20,000; frames 64; cumulative protocol instances 2,000; conservative allocated/retained bytes 8 MiB; repeated block visits 4. Evidence defaults to 200 and is capped at 1,000 rows/step records. Timeout defaults to 2,000 ms and is capped at 5,000 ms. Nested fact walks, shape construction, state forks, clones, instance/evidence retention and traversal spend work before growth and yield cooperatively. Generated source/identity/view enrichment runs within witness retention under the same work/byte/time/cancellation checks, before result finalization. Variable source metadata is preflighted before deriving links; interrupted enrichment does not retain an unfinished witness. Repeated blocks beyond the selected visit bound and recursion end at explicit unknown frontiers. Budget, cancellation or time exhaustion cannot become a clean result. The fixed normalized request/replay/envelope and prebuilt accepted capture indexes are outside the generated-evidence byte accounting; conservative allocation counts include temporary/replaced copies and the rejected reservation that triggers exhaustion.

### Frozen local validation for 08

All checks below are **pending** until independent clean source review. The writer performs static parsing/whitespace inspection only. Use an unused issue-owned local run directory with isolated CLI target, fixture copy, fixture target and capture output. Keep every source/build/capture local; no fixture/application execution, network, profiler or sandbox execution is part of this change. This fixture has no dependencies or build script. Cargo may create a lock only in the owned runtime copy.

Unset all historical capture variables before ordinary checks: `BUILD_SUPPLY_CAPTURE`, `BUILD_SUPPLY_HTML`, `BUILD_SUPPLY_PRIOR_CAPTURE`, `GUARD_CAPTURE`, `GUARD_HTML`, `VALUE_CAPTURE`, `VALUE_HTML`, `ORDERED_CAPTURE`, `ORDERED_HTML`, `ENTRY_EFFECT_CAPTURE`, `ENTRY_EFFECT_HTML`, `ENTRY_EFFECT_ADAPTER_CAPTURE`, `ENTRY_EFFECT_ADAPTER_HTML`, `CALL_PATHS_CAPTURE`, `CALL_PATHS_HTML`, `ADVISORY_CAPTURE`, `ADVISORY_HTML`; also unset `FAILURE_CAPTURE` and `FAILURE_HTML`. No old capture can qualify the new fixture paths.

```sh
node --test scripts/test-failure-obligations.cjs scripts/test-viewer-failure-obligations.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --bin cargo-build-graph --target-dir "$tool_target"
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
cp -R tests/fixtures/failure-obligations "$validation_root/failure-obligations"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$fixture_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/failure-obligations/Cargo.toml" --target-dir "$fixture_target" --out "$capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$qualified_driver" --no-compress -- --offline
FAILURE_CAPTURE="$capture_out/graph.json" FAILURE_HTML="$capture_out/graph.html" node --test scripts/test-failure-obligations.cjs scripts/test-viewer-failure-obligations.cjs
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-call-paths.cjs scripts/test-advisory-exposure.cjs scripts/test-build-supply-chain.cjs scripts/test-viewer-effects.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-values.cjs scripts/test-viewer-guards.cjs scripts/test-viewer-call-paths.cjs scripts/test-viewer-advisories.cjs scripts/test-viewer-build-supply-chain.cjs scripts/test-viewer-supply-chain.cjs scripts/test-value-flow.cjs scripts/test-guard-obligations.cjs scripts/test-ordered-execution.cjs
node scripts/test-viewer-renderer.cjs
node --test scripts/test-viewer-loader.cjs
```

Recheck exact compiler-input identity before reusing the qualified private driver: all `crates/bg-driver` tracked files, root Cargo manifest/lock and Cargo/toolchain configuration must match tested SHA `bf30f3f52eec5b8f88ceb028569e1246cca80b2b`, including working bytes and modes. The archived driver SHA-256 is `1d23eac573e1a993d39a1189d164d6a5e2b6fbda1abb4089cdc6f060a1f2a701`. Keep attribution to that tested SHA and verify local toolchain/link-library availability. The stable CLI must be rebuilt because its embedded modules changed; HTML must be emitted by that current CLI. Capture tests read actual current embedded module bytes and the exact new inline graph through both real transports. Record each command, environment, status, candidate SHA and artifact hashes; an old driver receipt does not qualify the new fixture or UI.

## 09 — Static resource and concurrency candidates

`resourceRisks` is portable across the API, emitted browser worker and fallback. It requires an exact `function`, optional independent exact `actors` (at most seven), and a declared model with `version:1` and `provenance`. Names never infer allocation, lock, policy, range or suspension semantics. Capabilities and replay carry `resource-risks-v1`.

```json
{
  "op":"resourceRisks",
  "function":"<exact procedure ID>",
  "actors":[],
  "model":{
    "version":1,"provenance":"<analyst model source/version>",
    "sources":[{"id":"input","at":{"procedure":"<exact procedure ID>","port":"parameter","index":0,"fields":[]}}],
    "operations":[{"id":"allocation","version":1,"kind":"allocation","call":"<exact callsite ID>","outcome":"normal","subject":{"port":"argument","index":0,"fields":[]},"cost":{"perUnit":8,"unit":"bytes"}}],
    "guardBounds":[],"loopBounds":[],"summaries":[]
  }
}
```

A source binds an exact typed parameter and optional typed field indices. Its optional `maximum` is a declared range assumption. Operations declare `allocation`, `clone`, `io`, `work`, `acquire`, `release`, `drop` or `suspend`. Value and lock effects require an exact `call`, matching `normal`/`unwind` completion, and typed `argument` or normal `result` subject. Static costs require nonnegative integer `perUnit` and `unit:bytes|operations|io-operations`; these are weights, never elapsed time, measurements or a measured hotspot. Input dependencies follow accepted copy/move/field/overwrite/argument/return facts. Supported computes conservatively union dependencies but never inherit numeric ranges or prove runtime object distinctness.

`guardBounds:[{id,version:1,call,subject:{port:"argument",index,fields:[]},success:true,maximum:64}]` assumes that this exact predicate's successful boolean result bounds that same value. A supported branch must correlate the exact returned value identity and declared success. An ignored predicate, failed outcome, other subject or overwritten/derived value supplies no bound. No arithmetic range solver is added. `loopBounds:[{id,version:1,node:"<exact header node>",maximum:10}]` declares an iteration bound. Natural CFG regions retain nesting and declared bounds, with irreducible regions explicitly unknown when reached. A repeated block stops at a representative frontier; unknown limits do not mean proven unbounded execution. Recursion likewise retains a finite representative frontier. Declared bounds do not assert that an opaque loop body, termination, feasibility or total cost was proved.

Locks require an explicit `lockId` representing an assumed shared object, along with the typed subject. Typed value identity correlates a release/drop with its acquisition; different scalar origins alone never prove different runtime locks. Derived lock subjects, references and unsupported aliases remain unknown. Shared lock IDs are visibly declared assumptions, including across independent actors. Acquisition order records retain their actor, root, invocation and boolean constraints. Simple cycle joins exclude contradictory supported constraints in the same invocation; independent actors' parameters and booleans are not global shared conditions. `possible-lock-order-cycle` is a **conditional structural union**, not a concrete execution, schedule, feasible deadlock or deadlock proof.

Suspension is declared at an exact `node`, or at an exact call with `outcome:"invoke"`. Invocation-start suspension is checked before entering the callee; a callee's later release cannot erase the held-at-suspension candidate. A completion effect never invents an earlier suspension. Captured normal/unwind control remains ordered. Actual `std::sync::Mutex`, RAII destruction, async bodies, native calls and callback wrappers without supported facts or an explicit complete summary stay unknown. A summary has `{id,version:1,call,outcomes:["normal","unwind"],returns:"fresh"|"argument"|"unknown",argument?,effects:"declared-resource-only"}` and explicitly assumes complete resource effects for that invocation. Missing captured continuations still add unknown coverage.

Rows retain source-linked representative steps, root, invocation, model provenance, static classification, bounds, loop regions and cost assumptions. `supported-bounded` is scoped to a supported per-invocation bound; it is no universal resource-safety assertion. Every response keeps `measuredHotspot:false`, `deadlockProven:false`, `definitiveNegative:false` and `vulnerabilityAbsenceProven:false`. Partial coverage can coexist with candidates. The browser discloses complete JSON and opens only one selected representative's root/invocation/steps. Cycle order paths have separate open actions; their union never becomes one concrete flow. Map highlighting uses that selected path's accepted imported owner IDs and captured call pairs, with the existing shared map lease and independent flow lease. Pins, newer owners, reset and catalog replacement retain their established behavior.

The internal observer seam reuses the failure interpreter; hooks are product code and cannot be supplied in request JSON. Observer events, state forks, conservative lineage, nested clones, source enrichment, loop-region indexing, cycle joins and retained wire evidence share work/byte/cancel/timeout accounting. Failure analysis uses the same interpreter with its observer disabled. Defaults/hard ceilings match the bounded interpreter: 2,000,000 work, 20,000 states, 64 frames, 2,000 instances, 8 MiB conservative allocation accounting and 200 evidence rows/steps (maximum 1,000). Resource analysis always visits a block once, regardless of requested visit budget. Timeout defaults to 2,000 ms and caps at 5,000 ms. Budget/time/cancel/truncated evidence remains partial. Accepted capture indexes and the fixed normalized request/replay envelope retain the existing accounting contract; generated resource/source evidence is reserved before retention. No actual metrics, profiler, application execution or external service is involved.

### Frozen local validation for 09

All commands remain **UNRUN** until independent clean exact-head source review. Use one unused EDEN-3853-owned local run directory, isolated stable CLI target, fresh fixture copy, fixture target and capture output. No Adam, source upload, network, app execution or original-preview mutation. Do not commit generated fixture `Cargo.lock`; Cargo may create it only in the owned validation copy.

Unset all 21 variables before ordinary gates: `BUILD_SUPPLY_CAPTURE BUILD_SUPPLY_HTML BUILD_SUPPLY_PRIOR_CAPTURE GUARD_CAPTURE GUARD_HTML VALUE_CAPTURE VALUE_HTML ORDERED_CAPTURE ORDERED_HTML ENTRY_EFFECT_CAPTURE ENTRY_EFFECT_HTML ENTRY_EFFECT_ADAPTER_CAPTURE ENTRY_EFFECT_ADAPTER_HTML CALL_PATHS_CAPTURE CALL_PATHS_HTML ADVISORY_CAPTURE ADVISORY_HTML FAILURE_CAPTURE FAILURE_HTML RESOURCE_CAPTURE RESOURCE_HTML`.

```sh
node --test scripts/test-resource-risks.cjs scripts/test-viewer-resource-risks.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --bin cargo-build-graph --target-dir "$tool_target"
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
cp -R tests/fixtures/resource-risks "$validation_root/resource-risks"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$fixture_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$validation_root/resource-risks/Cargo.toml" --target-dir "$fixture_target" --out "$capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$qualified_driver" --no-compress -- --offline
RESOURCE_CAPTURE="$capture_out/graph.json" RESOURCE_HTML="$capture_out/graph.html" node --test scripts/test-resource-risks.cjs scripts/test-viewer-resource-risks.cjs
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-failure-obligations.cjs scripts/test-viewer-failure-obligations.cjs scripts/test-viewer-effects.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-values.cjs scripts/test-viewer-guards.cjs scripts/test-viewer-call-paths.cjs scripts/test-value-flow.cjs scripts/test-guard-obligations.cjs scripts/test-ordered-execution.cjs
node scripts/test-viewer-renderer.cjs
node --test scripts/test-viewer-loader.cjs
```

Gate two new scripts is a full `node --test` invocation; the fresh gate sets **only** the new `RESOURCE_CAPTURE`/`RESOURCE_HTML` pair. Their emitted-HTML gate verifies the actual current inline graph and all 16 module bytes in real worker and fallback transports. Reuse the archived driver only after exact bytes/modes for all nine private-producer inputs match tested source `bf30f3f52eec5b8f88ceb028569e1246cca80b2b`, with original attribution retained; binary SHA-256 must be `1d23eac573e1a993d39a1189d164d6a5e2b6fbda1abb4089cdc6f060a1f2a701`. Embedded changes require the fresh stable CLI/current HTML regardless of driver reuse. Retain commands, environments, statuses, source hashes and artifact hashes. Passing static parsing is not functional evidence.

## 10. Compare source revisions and builds (EDEN-3854)

`exportRevision` exports a bounded side snapshot; `compareRevisions` recomputes both sides through the existing entry/effect, call-path, advisory, guard, failure and resource engines. A snapshot retains its exact queries/models/advisory snapshot, declaration, SHA-256 input/evidence/capture/version pins and source-linked results. A digest proves content integrity, not producer authenticity. Imported findings alone are never compiler proof.

`registerRevisionCapture` admits `{op:"registerRevisionCapture",raw:"<JSON capture text>",maxCaptureBytes?}` and returns a content reference. Both `capabilities` and `schema` advertise the 512 MiB default (`standaloneCaptureImportBytes`) and 1 GiB maximum (`standaloneCaptureImportMaxBytes`), separately from 4 MiB compact inputs, 32 MiB retained query allocation and 8 MiB escaped output. Registration is atomic parse/owned-structure/hash/index admission, with cancellation checks before and after; cooperative query budgets do not apply to that phase. Registering content identical to the current candidate, including through constructor `revisionCaptures`, retains the original current byte SHA/source pins and saved snapshot validity. A distinct baseline occupies the replaceable baseline slot. Optional null selectors follow public-engine omission semantics; an explicit empty package scope still selects no inventory rows.

```js
const api = Analysis.create(candidateGraph, { revisionCaptures: [baselineGraph] });
const before = await api.query({ op: 'exportRevision', input: {
  capture: { contentSha256: Evidence.digest(baselineGraph) },
  selection: { function: '<exact baseline procedure>' },
  declaration: { revision: { value: '<label>', provenance: '<caller declaration>' } },
  queries: [{ key: 'access-policy', request: baselineGuardRequest }]
} });
const after = await api.query({ op: 'exportRevision', input: {
  selection: { function: '<exact candidate procedure>' },
  queries: [{ key: 'access-policy', request: candidateGuardRequest }]
} });
const diff = await api.query({ op: 'compareRevisions', before: before.snapshot,
  after: after.snapshot, mappings: [{ before: '<baseline procedure>',
    after: '<candidate procedure>', certainty: 'declared', provenance: '<continuity evidence>' }] });
const replay = await api.query({ op: 'replay', replay: diff.replay });
```

References keep large loaded graphs out of every response/replay. The API accepts one supplied baseline beside the current candidate. The browser imports one baseline capture and exports/compares JSON through the actual worker or fallback. References resolve only to opaque admission tokens backed by private owned capture/index state. Registration copies and freezes JSON structure once, pins its canonical SHA-256 and builds private indexes once; repeated selected exports/import recomputation/replay reuse that state. Caller raw graphs, public catalogs, viewer models and returned outputs cannot change the admitted source. Missing/forged tokens are `CAPTURE_UNAVAILABLE`; a reference whose digest differs from the token is `CAPTURE_MISMATCH`. For a small portable self-contained side, provide `input.graph` instead of `input.capture`; retain both original bundle inputs for later replay. Requests own bounded copies at dispatch, and replay retains both side inputs rather than reading later model edits.

The CLI attaches optional typed `capture_provenance_v1` JSON to existing crate attributes. Its read-only local probes capture object format/full HEAD tree OID and commit context separately, scoped to package/repository manifests; staged, unstaged, untracked and submodule state are explicit. Before-build and after-extraction records report stable, dirty-unverified, changed, unavailable or extraction-only context. Cargo metadata establishes the actual workspace before the build; selected member manifests and workspace manifest/lock/config paths are recorded exactly at both observations, including absent/unavailable inputs. Both child completion and inherited stdout EOF share a two-second probe deadline on Unix; other platforms report unavailable rather than starting an unbounded pipe reader. No Git remote, index write or `write-tree` operation is involved. Dirty inputs are not the HEAD tree. Missing Git remains unavailable.

Each side separately pins a SHA-256 of the captured build-context record (profile, selected packages, forwarded-argument digest, selected environment digests, toolchain context, lock/manifest/toolchain/Cargo-config file digests). Small input digests are explicitly labelled FNV1a-64; the graph, side, model and exported build record use SHA-256. This is a context fingerprint, not a complete compiler-input or hermetic-build attestation. Ignored/generated/build-script/external/submodule and inherited configuration/environment inputs retain explicit coverage gaps. The same tree may produce different build fingerprints; different commits may share a tree. Caller revision/configuration labels remain declarations beside actual capture records.

Configuration/build/analysis/model/question differences appear first. A matching query key is only a pairing label: operation selectors, every function/entry/effect/package endpoint, phase/scope/filter/possible policy and page/budget limits must align through established or visibly declared one-to-one mappings. Changed questions remain non-equivalent/incomplete. Selected inventories apply the real package scope; automatic routes retain selected phase/scope while keeping cross-scope route intermediaries. Semantic result projections exclude transport/capture/replay envelopes and execution counters, retaining meaningful sources, witnesses, findings and coverage; commit-only context changes do not invent changed modeled outputs. Both original envelopes remain in snapshots/replay. The union of package contexts retains unmatched sides and duplicate conflicts explicitly; observed presence does not prove source/build continuity. Code comparisons are incompatible, conditional or incomplete where those facts do not align. Model hashes may differ with exact side selectors; an optional `equivalences:[{key,beforeModelHash,afterModelHash,provenance}]` records an explicit caller equivalence and remains an assumption. Symbol joins require a unique original compiler ID/original symbol plus package/build/capture/target scope, or an explicit one-to-one declared/uncertain mapping. Names, normalized IDs, source lines and body similarity never establish continuity. Version-spanning package joins require `packageMappings:[{before,after,provenance}]`; exact versions/sources and both dependency inclusion paths remain visible. Duplicate definitions, targets, local forks and phases are not merged.

Changes retain entries, sensitive effects, entry/caller routes, dependency exposure and requested public-model findings with both sides' own sources, witnesses, coverage and requests. Missing models/results/bodies or truncated pages never resolve a finding. Static modeled possibilities are distinct from observations; no response proves exploitability, safety or runtime regression. The existing map/flow leases are reused only for an exact current **after** capture. Before-side IDs cannot highlight the candidate; its source evidence stays independent. Candidate entry/effect symbol IDs resolve to exactly one accepted current Model procedure; unavailable/ambiguous resolution is disclosed without name matching. Pins, newer actors and existing map organizations/minimap behavior remain intact.

Limits are finite: loaded capture references support up to 200,000 nodes/1,000,000 edges; compact side input is 4 MiB escaped UTF-8 wire bytes. Loaded/API/browser capture registration has an independent 512 MiB default byte limit, configurable via `maxCaptureBytes` (or the browser import byte-limit field) up to 1 GiB, plus a 16-million-value/40-level structure ceiling. This atomic registration phase includes bounded native parse, private structure admission, hashing and index construction; cancellation is checked before and after it, and it is separate from the cooperative query timeout/retained/output budgets. It permits large imported baselines without repeating graph copies or index construction on reference queries. Exported definitions/packages cap at 2,000 and dependency rows at 5,000; inventories page at 100, automatic entry routes at 32, explicit queries at 32 and changes at 1,000. Selection uses exact function/package scope through existing engines, so an already loaded graph larger than 2,000 nodes/5,000 edges can produce a small comparison. Default/hard shared ceilings are 2,000,000 work, 32 MiB conservative retained allocation and 8 MiB final escaped UTF-8 output (strings, keys and every repeated envelope/replay occurrence counted before final materialization), with 5,000 ms timeout (configurable downward). Dispatch admission/native JSON cloning and existing synchronous constructors are atomically bounded; cooperative checks surround constructor phases. Subsequent admission, hashing, copies, matching, joins and final wire materialization share cancellation/time/work/byte checks; inherited semantic engine traversal retains its public bounds and charged work. A limit/cancel/error returns incomplete evidence rather than an alleged clean comparison.

All execution is **UNRUN** until independent exact-clean-head source review. The frozen nine-gate handoff requires: full new pair with all 21 historical and four revision capture variables unset; stable library/bin tests; fresh stable CLI; qualified original private-driver input/binary identity; a fresh whole paired fixture copy with independently initialized owned Git repositories and baseline/candidate offline compiler-only captures; full new pair with only its four fresh capture/HTML variables; affected semantic/browser compatibility; renderer; loader. Unit tests may initialize/stage/commit only their new owned temporary Git repositories. Do not run fixture applications, network operations or old issue09 HTML to qualify the new modules. Generated locks belong only in owned fixture copies. The external writer handoff records exact commands, environments and SHA-256/mode manifests; static parsing is not functional evidence.

## 11. Generate regression and bounded fuzz candidates (EDEN-3855)

`testCandidates` recomputes a selected side through `exportRevision` and its public semantic engines. `target` must be the exact query root procedure and have one captured side definition. For `callPaths`, `from`/`to` remain exact graph endpoint IDs, which may differ from procedure IDs; the recomputed root endpoint must link uniquely to `target` with an available captured body and matching exact owner, function/build-unit and source facts; `queryKey` selects one complete request/model, rather than trusting a supplied finding. The current capture is implicit, or `input.capture` selects an admitted baseline. `input.graph` supports a small portable bundle. Optional `witnessSha256` selects exactly one canonical witness from the fresh query; a missing, ambiguous, paged or truncated selection produces an unsupported manifest with no code. Omitting it makes a query-level proposal, with no selected witness. Query coverage, unknown calls, sources, conditions and rule/model provenance remain in the complete recomputed operation.

```js
const result = await api.query({ op: 'testCandidates', target: exactProcedure,
  queryKey: 'route', input: { selection: { function: exactProcedure },
    queries: [{ key: 'route', request: { op: 'callPaths', from: exactGraphEndpoint, to: exactGraphEndpoint } }] },
  callable: { kind: 'public-free-function', path: 'normalize', sourcePath: 'src/lib.rs',
    sourceSha256: suppliedSourceSha256, parameters: ['u8'], returns: 'u8', setup: 'none',
    provenance: 'Caller binding and signature declaration' },
  oracle: { kind: 'identity', parameter: 0, provenance: 'Declared identity specification' },
  cases: [{ inputs: [7] }]
});
```

An optional `revision:{before,after,side:"before"|"after",key,mappings?,packageMappings?,equivalences?}` reruns the existing comparison and retains its configuration differences, mapping assumptions, source/build contexts and selected changed row. The selected side must match the candidate's entire input and evidence hashes, including every query, model and capture pin. No unique changed query row means unsupported. Saved findings or recomputed hashes alone do not establish producer authenticity. Both side inputs must remain available for replay. The comparator receives a disjoint conservative half of the remaining work/retained ceiling; the outer query reserves that ceiling and enforces its total timeout. Queries reuse private admitted capture state without copying or hashing the entire loaded graph again.

Supported generation is deliberately finite: caller-declared public free Rust functions, up to eight `bool`, `i8`, `u8`, `i16`, `u16`, `i32` or `u32` scalar parameters and one supported scalar return. The source path, signature and callable binding remain declarations beside captured facts. Methods, async, generics, references, dependencies and custom setup are unsupported. Observables are return equality: `oracle.kind:"cases"` requires an expected value per explicit case; `identity` refers to a same-type parameter; `constant` supplies a typed value. Every oracle requires provenance. No generic panic oracle claims finding reproduction.

Instead of `cases`, supply `fuzz:{domains:[[0,1,7,255]],maxCases:4,provenance:"Finite declared seeds"}` with an identity/constant oracle. Each parameter domain has 1–256 unique typed seeds; the entire Cartesian product must fit the caller's maximum and the hard 4,096-case ceiling. Enumeration is deterministic and exhaustive over those declared seeds. This is bounded input fuzzing, with no coverage guidance, random search, predicate solving or claim that a seed reaches a static witness. Unreachable routes, opaque calls and unknown conditions remain explicit static evidence. No LLM, package installation, network or automatic execution is involved.

The response carries code plus a canonical SHA-256 manifest/artifact binding and byte SHA-256 code pin, all bounded by the existing 8 MiB escaped UTF-8 output, 32 MiB retained and 2,000,000-work ceilings. Requests/replay own bounded copies; cancellation, timeout, stale replies, worker errors and catalog replacement complete or reject the independent candidate transport. Candidate actions do not own map/flow highlights or change pins/revision navigation. The browser exports JSON and Rust source and always labels generated proposals **GENERATED / UNRUN**.

The explicit local producer accepts exported artifact JSON (or the complete response):

```sh
node scripts/run-test-candidate.cjs --artifact "$artifact_json" --source-root "$source_root" --output-dir "$unused_output_dir"
node scripts/run-test-candidate.cjs --artifact "$artifact_json" --source-root "$source_root" --output-dir "$another_unused_output_dir" --run
```

It verifies canonical generated code/integrity, exact supplied source SHA-256 and a regular source file inside the read-only source root. It canonicalizes the output through existing ancestors before any write, refuses reused output directories and writes only a new explicitly owned directory outside that root. Symlinked parents and filesystem aliases cannot admit a destination inside the source root. Source paths equal to, inside, or containing the fixed `candidate.rs`, `candidate-test` or `receipt.json` output paths are invalid in generation, artifact verification and producer admission. It copies the one pinned source file and compiles a separate std-only `rustc --edition=2021 --test` harness. Transitive includes/modules, environment, toolchain internals and other unobserved inputs remain explicit gaps; this is never a complete compiler-input attestation or execution of the captured application binary. Rustup auto-install is disabled and Cargo is offline. Compiler identity, actual source/harness/binary hashes, full argv/cwd, bounded diagnostic stdout/stderr, exit/signal/timeout/output limits and a separate generated instrumentation transcript are retained in `receipt.json`. Defaults are 10 seconds per process and 256 KiB combined diagnostic output; hard maxima are 60 seconds and 1 MiB. Instrumentation has a separate limit of 96 bytes per declared case plus 64 bytes (393,280 bytes at 4,096 cases). The shared process deadline includes EOF on every inherited output pipe; timeout/output limits kill only the owned process group and close its pipes, with bounded cleanup. No imported receipt becomes query execution evidence.

States are distinct: `generated-unrun`, `compiled`, `compile-failed`, `failing-reproduction`, `passing-regression` and `execution-failed`. On supported Unix hosts the harness uses fully qualified std machinery and an inherited fd 3 instrumentation pipe; other platforms return an explicit unsupported error before compiler/output work. Ordinary subject stdout is diagnostic-only. The runner requires ordered unique observations for every declared case, exact expected values and one terminal evaluated-oracle completion. A failing reproduction requires a genuine caught equality assertion failure, full case accounting and a compatible failed run; a passing regression requires complete matching observations and a successful run. Timeout/output/process errors, a subject panic/early exit, duplicate/out-of-order/truncated evidence, or any incomplete transcript prove neither. If a later case is interrupted after an earlier mismatch, execution remains failed rather than an oracle result. This instrumentation boundary separates diagnostics from generated observations; it does not authenticate arbitrary native code in the same process or sandbox it. Such code can deliberately access inherited descriptors. Receipts retain these limits explicitly, with no trusted stdout prefix or secret-based authentication claim. Even a failing/passing receipt retains `findingReproduced:false`, `witnessReached:"unknown"` and `capturedApplicationCorrespondence:"unknown"`: only the declared observable has been checked in the new harness build.

### Frozen local validation for 11

All functional gates remain **UNRUN** until independent review accepts the exact clean source head. One executor owns a fresh EDEN-3855 run directory and retains full command/environment/result/artifact identities. Ordinary gates unset all 25 historical inputs: `BUILD_SUPPLY_CAPTURE BUILD_SUPPLY_HTML BUILD_SUPPLY_PRIOR_CAPTURE GUARD_CAPTURE GUARD_HTML VALUE_CAPTURE VALUE_HTML ORDERED_CAPTURE ORDERED_HTML ENTRY_EFFECT_CAPTURE ENTRY_EFFECT_HTML ENTRY_EFFECT_ADAPTER_CAPTURE ENTRY_EFFECT_ADAPTER_HTML CALL_PATHS_CAPTURE CALL_PATHS_HTML ADVISORY_CAPTURE ADVISORY_HTML FAILURE_CAPTURE FAILURE_HTML RESOURCE_CAPTURE RESOURCE_HTML REVISION_BASELINE_CAPTURE REVISION_CANDIDATE_CAPTURE REVISION_BASELINE_HTML REVISION_CANDIDATE_HTML`. Also unset the four new `TEST_CANDIDATE_*` inputs except during their explicit fresh capture gate.

```sh
node --test scripts/test-test-candidates.cjs scripts/test-viewer-test-candidates.cjs scripts/test-run-test-candidate.cjs
CARGO_NET_OFFLINE=true cargo +stable test --locked --offline --features rustc-driver --lib --bin cargo-build-graph --target-dir "$tool_target"
CARGO_NET_OFFLINE=true cargo +stable build --locked --offline --features rustc-driver --bin cargo-build-graph --target-dir "$tool_target"
cp -R tests/fixtures/test-candidates "$validation_root/test-candidates"
# Verify whole copied fixture file bytes/modes/directory inventory before any Git/Cargo mutation.
# For each copied baseline/candidate: generate its offline lock, initialize a new
# owned fixture-context Git repo, then add/commit only that copy with explicit
# fixture user/email, commit.gpgsign=false and core.hooksPath=/dev/null on both
# add and commit; do not change global config or a user's index.
CARGO_NET_OFFLINE=true cargo +stable generate-lockfile --offline --manifest-path "$fixture_root/Cargo.toml"
CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$fixture_target" "$tool_target/debug/cargo-build-graph" build --manifest-path "$fixture_root/Cargo.toml" --target-dir "$fixture_target" --out "$capture_out" --rich --nightly nightly-2026-02-27 --driver-bin "$qualified_driver" --no-compress -- --offline
TEST_CANDIDATE_BASELINE_CAPTURE="$before_out/graph.json" TEST_CANDIDATE_BASELINE_HTML="$before_out/graph.html" TEST_CANDIDATE_CAPTURE="$after_out/graph.json" TEST_CANDIDATE_HTML="$after_out/graph.html" node --test scripts/test-test-candidates.cjs scripts/test-viewer-test-candidates.cjs
node --test scripts/test-analysis-api.cjs scripts/test-analysis-evidence.cjs scripts/test-revision-comparison.cjs scripts/test-viewer-revision-comparison.cjs scripts/test-call-paths.cjs scripts/test-guard-obligations.cjs scripts/test-failure-obligations.cjs scripts/test-resource-risks.cjs scripts/test-viewer-guards.cjs scripts/test-viewer-failure-obligations.cjs scripts/test-viewer-resource-risks.cjs scripts/test-viewer-evidence.cjs scripts/test-viewer-ordered.cjs scripts/test-viewer-values.cjs
node scripts/test-viewer-renderer.cjs
node --test scripts/test-viewer-loader.cjs
```

The fresh pair gate verifies all 19 embedded module bytes and actual inline capture in both real transports. The external frozen validation matrix also produces retained artifact JSON and explicit runner receipts from each fresh capture/source copy: compile-only, known oracle failure before, pass after and a valid finite fuzz pass. The three focused scripts also cover canonical/symlink source isolation with untouched inventory/bytes/modes and no compiler start, all reserved output prefixes, exact forged stdout with panic/early exit, incomplete/duplicate/out-of-order instrumentation, macro shadowing, inherited-pipe deadlines and distinct graph/procedure identity through core/API/replay/worker/fallback. Same-ID and valid nested-source controls remain. The fresh emitted pair must exercise the accepted distinct-ID linkage. Source mismatch, tampered code/manifest, reused output, timeout/output bounds, unsolved/opaque/unreachable and unsupported shapes remain required. The 14 affected compatibility scripts include the common evidence/ordered/values viewer lifecycle and independent flow boundary. Stable CLI/current HTML must be rebuilt because embedded bytes changed. Reuse the archived private driver only after all nine private inputs and binary/mode qualification match its original tested `bf30f3f52eec5b8f88ceb028569e1246cca80b2b` closure; binary SHA-256 is `1d23eac573e1a993d39a1189d164d6a5e2b6fbda1abb4089cdc6f060a1f2a701`. Preserve the original build/unit receipts and original attribution; do not rebuild that producer or relabel old evidence as current. No Adam, source upload, network, protected branch, sample, preview or fixture application run is part of these gates; only explicit generated harness tests execute. Passing static parsing is not functional evidence.

## Optional local performance measurements (EDEN-3856)

`importMeasurements`, `loadMeasurements`, and `compareMeasurements` use the same
`local-performance-v1` module in the JSON API, browser worker, and browser fallback.
The Local performance measurements panel accepts a request or saved snapshot as
local JSON, displays a measured flame graph, and saves the complete immutable
snapshot. It never launches a workload, profiler, service, or telemetry request.
The existing structural Flamegraph and UML sequence views keep their structural
semantics. A measured flame graph orders sampled population alphabetically;
its horizontal axis is not elapsed time or execution chronology.

An import request has this shape (the source `text` is original UTF-8 file text):

```json
{
  "op": "importMeasurements",
  "input": {
    "schemaVersion": 1,
    "capture": { "contentSha256": "<captured graph canonical SHA-256>" },
    "provenance": {
      "build": { "id": "<declared build identity>" },
      "tree": { "sha": "<declared source tree identity>" },
      "workload": { "id": "<workload and input identity>" },
      "configuration": { "mode": "<measurement configuration>" },
      "toolchain": { "id": "<toolchain identity>" },
      "machine": { "id": "<machine identity>" },
      "environment": { "id": "<environment identity>" },
      "recordedAt": "<original collection time>"
    },
    "sources": [{ "id": "local-result", "format": "generic-benchmark-v1", "text": "<original JSON text>" }],
    "mappings": []
  }
}
```

Omitting `capture` pins the current capture before replay is constructed, so
implicit and explicit current references produce identical normalized requests.
Provenance is caller supplied and may be absent; missing fields are reported as
unknown. Import time never substitutes for collection time. A capture mismatch
preserves source data and statistics and disables function/call attachment.
Imported IDs and mappings do not prove that the compiler confirmed performance
ownership or that the declared profile/build actually came from that capture.

Supported source formats are deliberately versioned:

| Format | Original source text / contract |
| --- | --- |
| `generic-benchmark-v1` | JSON `{schemaVersion:1,benchmarks:[...]}`. Each benchmark has `id`, `name`, explicit `unit`, `statistic` (`mean`, `median`, `slope`, `median_abs_dev`, `std_dev`), and `estimate:{value,confidenceInterval?:{level,lower,upper},standardError?}`. Optional `subject` is an explicit stable comparison ID; `method`, `input`, `metadata`, `target`, and `throughput:{perIteration,unit,format?}` preserve declarations. Unknown fields, invalid numbers, or inconsistent confidence bounds produce actionable errors. A generic throughput estimate can instead be a benchmark with its own explicit rate unit. |
| `criterion-json-v1` | JSON bundle `{criterionVersion:"0.5.1",measurement:"WallTime",estimatesText:"<original estimates.json text>",benchmarkText:"<original benchmark.json text>",subject?:"<declared continuity ID>"}`. Supports the exact 0.5.1 `Estimates` fields `mean`, `median`, `median_abs_dev`, nullable `slope`, `std_dev`; each non-null estimate has `point_estimate`, `standard_error`, `confidence_interval:{confidence_level,lower_bound,upper_bound}`. Complete `BenchmarkId` metadata has `group_id`, nullable `function_id`, nullable `value_str`, nullable `throughput`, `full_id`, `directory_name`, `title`. Throughput variants are one of `{Bytes:n}`, `{BytesDecimal:n}`, `{Elements:n}` with nonnegative safe integer `n`. The known WallTime scale is `ns/iteration`; no unit inference is made for custom measurements. Unsupported versions, measurements or fields are rejected explicitly. |
| `folded-stacks-v1` | Original lines `root;caller;leaf 7`, with positive weights, blank lines and `#` comments. Source requires `weightKind:"samples",unit:"samples"` for integer sample counts, or `weightKind:"sampled-weight",unit:"<explicit unit>"` for finite positive sampled weights. Optional `frameIdentities` maps exact raw frame text to `{target,provenance,inlined?:boolean}`. No demangling, path guessing, automatic inline reconstruction or time reconstruction occurs. |

Criterion JSON is not a versioned public interchange standard; the adapter is
limited to the verified 0.5.1 structs and file-writing behavior. The official
[Criterion estimate structs](https://bheisler.github.io/criterion.rs/src/criterion/estimate.rs.html),
[BenchmarkId structs](https://bheisler.github.io/criterion.rs/src/criterion/report.rs.html),
[WallTime measurement](https://bheisler.github.io/criterion.rs/src/criterion/measurement.rs.html),
and locally cached upstream 0.5.1 source informed this narrow contract.
[Criterion command-line output](https://bheisler.github.io/criterion.rs/book/user_guide/command_line_output.html)
describes per-iteration intervals and noise; its
[profiling mode](https://bheisler.github.io/criterion.rs/book/user_guide/profiling.html)
does not produce the usual statistical result files. This importer does not
turn a statistical result into profile samples.

`target` accepts exact `nodeId`, `procedureId`, or `functionId` plus
`buildUnitId`; combining selectors requires all to identify one captured row.
A build unit is mandatory with a compiler function ID. Display paths, matching
benchmark names and duplicate function labels never establish ownership.
Alternatively, `mappings:[{sourceId,recordId,target,provenance}]` declares a
binding. `recordId` is a generic benchmark ID, a Criterion
`full_id + ":" + statistic`, or exact folded frame text. The result labels
declared attribution, conflicting mappings, unmatched records, source/capture
mismatches and unknown inlining. Unused mappings remain in the snapshot and
are diagnosed. Matching is capture scoped and never falls back from an
unmatched exact ID to its display name.

Each profile/unit remains a separate dataset. Recursive frames remain in their
context in the measured flame graph. A function's inclusive weight counts a
stack once even if recursion repeats that function; exclusive weight is its
leaf weight. `occurrenceWeight` separately counts all recursive occurrences.
Adjacent frames contribute one co-occurrence weight per directed pair per
stack only when both map exactly, both explicitly represent physical
(`inlined:false`) frames, and the capture has one unambiguous directed call
projection. Callback/possible/unknown sites, inline/unknown frames, references,
gaps and absent edges remain unattached diagnostics. Even attached adjacency
is sampled evidence, never invocation count, call frequency, latency, error
rate or temporal order. Those call metrics are unavailable in this version.
Missing samples never prove unused code. See the upstream
[FlameGraph format and examples](https://github.com/brendangregg/FlameGraph) and
[population-axis explanation](https://www.brendangregg.com/flamegraphs.html).

The dataset selector shows one measured source/profile or one benchmark subject
at a time. Heat attaches to function nodes and existing directed call edges;
crates remain containers. Benchmark statistics stay on their explicitly bound
subject and are never distributed among callees. Flame frames and function/edge
rows share the architecture's function selection and details. Clearing or
cancelling measurements removes only measurement heat and saved download URLs;
existing flow analyses, shared AND pins, other panel leases, layout, filters,
tree visibility, fit and minimap state remain owned by their existing controls.
Catalog replacement and worker failure fence pending measurement generations.

An immutable snapshot retains the full normalized input, original source text,
raw-text SHA-256 pins, separate Criterion original-file pins, and a canonical
payload hash. Load with `{op:"loadMeasurements",snapshot:<complete snapshot>}`.
Replay contains the complete normalized request, request hash, current capture
pin and engine version. It requires that exact current capture; loading a
snapshot from another capture is supported and reports mismatch. Caller edits
cannot mutate a pending import or the engine's private identities. Save/reload
and replay recompute results; they do not trust precomputed heat or statistics.

Compare with `{op:"compareMeasurements",before:<snapshot>,after:<snapshot>}`.
Benchmark names alone do not establish subject continuity: both records need
the same explicitly declared `subject`, or
`subjectMappings:[{before:"<subject>",after:"<subject>",provenance:"<continuity evidence>"}]`.
Exactly one observation per subject/statistic is required on each side, and
subject continuity must be one-to-one in both directions. Duplicate observations
or many-to-one declarations remain ambiguous with original source/record IDs and
candidate IDs; they produce no compatible ratio. Original rows remain in the
complete before/after snapshots. Compatibility requires known,
equal workload, configuration, machine, environment, method, input and units.
Unknown values do not establish compatibility. Capture, build, source tree,
toolchain and original collection time differences are listed as provenance
changes; intentional revision/build changes and differing timestamps do not
automatically prohibit a comparison. Raw confidence intervals and their
individual levels remain visible. Any endpoint ratio range is labelled a
derived arithmetic range, with no joint confidence level, significance claim,
or invented p-value. Interval overlap is not a significance test.

Admission owns JSON atomically before cooperative work. Total escaped UTF-8
request bytes (including keys and replay) are limited to 8 MiB; each escaped
source envelope to 4 MiB; at most 64 sources, 20,000 total benchmark/stack
records and 100,000 total frames with stack depth 128 are supported. JSON
ownership has the existing 250,000-value / depth-40 bound. Timeout is 1..5000 ms
(default 2000), with a default/maximum 2,000,000 work units. Source/payload
hashing, wire keys/bytes, inner candidate and comparison joins,
record/frame matching, identity-index traversal and aggregation yield for
cancellation. Caller ownership is admitted before its atomic clone using the
effective input, retained and output ceilings. Bounded source JSON parsing and
the final ownership clone, plus the existing capture-owned function identity
extraction, are atomic boundaries checked before/after. Oversize, timeout and
cancellation return no partial saved snapshot. The 32 MiB output bound includes raw files, evidence and complete
replay; retained serialized values are bounded at 64 MiB. Each generated retained
payload is reserved before append/clone, including repeated mapping metadata,
ambiguous candidates, flame contexts, snapshots and final response/replay
occurrences. Reservations are conservative and cumulative, including private
intermediate/index payloads; generated evidence also reserves against the
configured output ceiling. These are wire/value bounds, not a claim about extra
JavaScript object overhead. Measurement indexes are built lazily once from existing function/call identities; this optional
feature adds no graph-size admission cap or per-query raw-capture clone. The
existing CLI's 65,536-character request limit still applies there; the API and
browser accept the larger bounded request contract.

The real-profile fixture is a small, explicitly derived excerpt of upstream
FlameGraph's provided perf profile, pinned at commit
`41fee1f99f9276008b7cd112fca19dc3ea84ac32`. The fixture provenance JSON records
the original URL, compressed/decoded source hashes, excerpt/folded hashes and
the exact first-16-sample derivation. Each derived frame label replaces `%`
with `%25`, then `;` with `%3B` before joining; decode `%3B` then `%25` once to
recover the original label. This preserves Java symbol boundaries and recursion.
The original raw excerpt is unchanged; this explicit fixture encoding does not
change the general folded import format. Synthetic mapping/recursion fixtures are
separate and labelled as fixtures. No fixture profiler/workload runs are needed.

Required focused and fresh-boundary commands, after independent source review:

```sh
node --test scripts/test-performance-measurements.cjs scripts/test-viewer-performance.cjs
PERFORMANCE_BASELINE_CAPTURE="$before_out/graph.json" PERFORMANCE_BASELINE_HTML="$before_out/graph.html" PERFORMANCE_CAPTURE="$after_out/graph.json" PERFORMANCE_HTML="$after_out/graph.html" node --test scripts/test-performance-measurements.cjs scripts/test-viewer-performance.cjs
```

The fresh pair uses the current CLI/HTML and verifies all 20 embedded module
bytes, the actual inline capture, complete API/worker/fallback payload equality,
distinct captured IDs, saved sources, and replay. The four `PERFORMANCE_*`
variables are unset during ordinary runs. Existing affected API/evidence,
viewer module-loader, renderer/loader, revision and lifecycle compatibility
checks remain required. Source parsing and formatting alone are not functional
validation; no test, build, capture or product import was run while authoring.

## Comments and documentation

`comments` in `capabilities`/`schema` describes the portable optional corpus and
shared Node/browser/worker/fallback engine. This implementation reconstructs the
applicable public EDEN-3206 occurrence, cache and retrieval design because its
historical uncommitted source was unavailable in bounded local discovery. It does
not qualify that historical implementation or change the private fleet rollout.

Rich Rust capture retains `Item.docs` on **original rustdoc item occurrences**
before normalized graph nodes merge. Crate roots, tuple field ordinals (including
stripped gaps), methods, types, fields, traits and modules retain independent
occurrence IDs. Exact package ID and target identity are part of that namespace;
display names and merged signatures never establish ownership. The metadata
carrier has kind `comment_corpus` and an `item__<normalized crate>__...` ID solely
for existing incremental crate removal. It creates no execution edges and is
excluded from the viewer's architecture layout. A graph node can represent
several original occurrences; selecting one retains its occurrence ID and source
citation independently.

The Rust adapter observes bounded local `.rs` sources before and after rustdoc.
New body ownership also requires a successful rustdoc command and its artifact
mtime observed inside that command's bracket. Matching SHA-256/mtime observations
are not a hermetic compiler-input attestation. An older/cached artifact retains
effective docs as stale/unverified and ordinary comments as file evidence. A
previously qualified cached corpus remains reusable when its exact source,
artifact and selected build-context pins still match; an old mtime alone does not
invalidate it. Cache admission and pre/post rustdoc observations share a bounded
selected-context SHA-256: resolved Cargo metadata/features, package/workspace
manifests and lock, invocation/workspace ancestor and Cargo-home configuration,
target directory/profile, selected toolchain compiler version, and recognized
Cargo/Rust environment controls. File contents and environment values remain
hashes. Missing probes, unsupported inputs, limits or changed context prevent
qualified cache reuse/export; old captures without this pin are recaptured.
This record does not attest arbitrary build-script, external/include or
undeclared environment reads. Compiler version probes are capture-time only,
reuse the two-second bounded local probe, and never run for comment queries.
On a first upgrade over old Cargo doc caches, an explicitly fresh
owned `--target-dir` can recapture complete observations; no user source is touched
and no compiler cfg/cache-forcing hack is used.
Ordinary line/block comments retain exact UTF-8 slices, including delimiters and
intervening whitespace in contiguous same-kind line-comment runs. Nested block
comments, raw/normal/byte/C strings, character literals and lifetimes are treated
lexically. Raw inner/outer doc tokens are separately labelled from effective
Markdown. Effective docs cite compiler **declaration** spans, not fabricated doc
comment ranges. Included Markdown and macro/cfg expansion origins remain
unverified; cfg-disabled, generated, unavailable, stale and unsupported source
coverage is explicit. Source token ranges use UTF-8 byte offsets, one-based
lines and zero-based Unicode scalar columns, with an exclusive end. Declaration
coordinates are one-based lines and one-based Unicode scalar columns with an
exclusive end, verified against the pinned rustdoc producer
[`6a979b3e32522049d0acb4a47f7ae44b7c8abfd5`](https://github.com/rust-lang/rust/blob/6a979b3e32522049d0acb4a47f7ae44b7c8abfd5/src/librustdoc/json/conversions.rs).
They come from normalized compiler source. BOM/CRLF inputs retain exact raw
comment slices but do not qualify body ownership through raw offsets.

Only uniquely enclosing, lexer-confirmed simple function/method body geometry
can own an ordinary comment. Generic/where/const signature braces, macros,
closures and unsupported nested items conservatively leave comments attached to
the source file. There is no nearest-name or nearest-line rule. Missing metadata
in older graphs is `missing-comment-metadata`, not zero comments in the source.
Comments are author intent and untrusted text, never execution, authorization,
security evidence, agent instructions or executable markup.

All comment operations accept `timeoutMs` (default 2000, maximum 5000) and bounded
`budgets: {maxWork,maxRetainedBytes,maxOutputBytes}`. The capability publishes
hard ceilings. Requests are owned before any asynchronous work. Index/search
limits include escaped wire output, complete replay payloads and cumulative
retained reservations; JavaScript object overhead is additional. Capture
admission owns only optional corpus metadata and exact target IDs once. Search
does not copy, rehash or rebuild the full captured graph. A corpus/index exceeding
its limits is explicitly unavailable or rejected, rather than silently complete.

| Operation | Required fields | Result |
| --- | --- | --- |
| `indexComments` | `repositoryScope` | Immutable index plus missing exact embedding texts; optional pinned `model`, `previous`, keyed `vectors`, `vectorProvenance`. No provider call. |
| `loadCommentIndex` | `repositoryScope`, `index` | Validate version, integrity, current capture/corpus and every source chunk binding. No provider call. |
| `searchComments` | `repositoryScope`, `index`, `query` | Ranked exact text/citations/coverage; optional `queryVector`, `queryProvenance`, `kinds`, `limit` (1..100). |
| `commentDetails` | `nodeId` or `occurrenceId` | Bounded original occurrence records; both selectors are conjunctive. |
| `embedComments` | `repositoryScope`, `texts: [{id,text}]` | Explicit configured endpoint action, actual vectors and provenance. Non-replayable; no index mutation. |

`repositoryScope` is a required explicit local repository/tenant namespace for
index and embedding operations. It is distinct from the older structural API's
package `scope` selector. Each corpus additionally retains exact package/target
scope. Caches never reuse a vector across scope/model/configuration changes.

Chunker `comment-text-utf16-1024-v1` splits exact text into at most 1024 UTF-16
code units without splitting a surrogate pair. It does not trim, normalize,
prefix names/paths or invent summaries. `textSha256` hashes the exact UTF-8 text.
The canonical sorted-JSON SHA-256 cache key covers repository scope, corpus scope,
original occurrence, record identity, kind, chunk offset, exact text hash,
extractor, chunker and full model descriptor. Index snapshot pins additionally
cover the graph capture, complete corpus, build/source/export hashes and vector
provenance. Doc-only changes update affected content keys; deleted/renamed
occurrences disappear from rebuilt snapshot bindings. Changed model revisions,
artifacts/tokenizers, dimensions or pooling/normalization invalidate old vectors.
An old index is usable only as an incremental cache input, never as current
search evidence. Ordinary record identity uses the exact supported original body
owner plus same-kind source-order ordinal (or exact file plus ordinal when
unattached), independently of absolute byte shifts. Exact current geometry and
source hashes remain snapshot evidence. This permits unrelated earlier doc edits
to retain unchanged comment vectors without reusing an old source attachment.

A model descriptor is `{id,revision,artifactSha256,tokenizerSha256,dimension,
normalization,pooling}`. Dimension is 1..1536; normalization is `l2` or `none`.
Vectors must contain finite bounded components and a nonzero norm. Imported
vector/query provenance must contain the same pinned `model`. Integrity is not
provider authenticity: caller-owned data remains labelled as such.

Lexical query tokens use Unicode letters/numbers/underscores and case folding.
A fixed English function-word list excludes common articles, pronouns,
auxiliaries, conjunctions, prepositions and question words from lexical candidate
admission, so grammar-only overlap cannot add a second fusion vote. Negations,
short content tokens and underscored identifiers remain searchable. This is an
English lexical policy, not multilingual language detection or semantic query
rewriting. A query containing only excluded words has no lexical candidates;
supplied query vectors still participate unchanged. Exact chunk and embedding
input text is never filtered. Capabilities expose `english-function-words-v1`;
query/result/replay version `portable-comments-v2` rejects older replay semantics
rather than silently reranking them. Index format `portable-comments-v1`, chunk
keys and embedding inputs are unchanged, so existing source-bound indexes and
incremental vectors remain compatible.

Lexical content-token candidates and cosine-vector candidates are ranked separately and
combined by reciprocal rank fusion (`1/(60+rank)`), with deterministic chunk-key
tie breaking. A semantic hit need not contain a function name or a lexical term.
Responses expose both ranks/scores and exact matched text. `lexical-only` and
`missing-embedding-configuration`/`missing-query-vector`/partial vector coverage
are explicit. Cosine similarity is not a probability or a universal relevance
threshold; unrelated queries still have nearest vectors. Graph-neighbor expansion
is a separate existing `neighbors` query, not part of text relevance.

Configure an endpoint only through **trusted host configuration**, never a
request/index/corpus/replay field. Node hosts use `Analysis.create(graph,
{commentProvider: {url,model,allowExternal?}})`. The browser has a deliberate
configuration action, then separate buttons for embedding pending chunks and
searching text with configured embeddings. Capture, index construction, import,
load and replay make no model request. Default endpoint policy permits HTTP(S)
loopback only (`localhost`, `127.0.0.1`, `[::1]`); an external endpoint requires
explicit trusted `allowExternal:true`. Userinfo, query strings, fragments,
unsupported schemes, redirects and ambient credentials are rejected/disabled.
No shell/eval or bundled generative reader exists. CORS/provider failure is an
explicit error; offline vector import/export remains available.

The provider protocol is a bounded JSON POST:

```json
{"model":{"id":"…","revision":"…","artifactSha256":"…","tokenizerSha256":"…","dimension":384,"normalization":"l2","pooling":"attention-mask-mean"},"inputs":[{"id":"exact-request-id","text":"exact text"}]}
```

Response: `{model: <identical pinned descriptor>, vectors: [{id,vector}]}`. IDs are
matched exactly, not by response order. An action accepts at most 256 texts,
batches at most 16, bounds each response to 1 MiB and each call to at most five
seconds, and cooperates with cancellation. Returned vectors/provenance can be
passed to `indexComments` or `searchComments`; replay uses those saved actual
vectors and never refetches. Keep endpoint secrets outside this configuration;
URL credentials and query secrets are intentionally unsupported.

`query-analysis.cjs --comment-request-file PATH` admits up to 8 MiB for comment
requests/indexes. `--comment-provider PATH` loads a bounded trusted configuration
file and alone performs no network call. Existing non-comment operations retain
their 65536-character request ceiling. Standard `--request`/stdin/JSONL also
support bounded comment operations. Save complete result/index JSON before replay;
raw saved integrity and fully normalized request equality are checked before any
default repair. Fresh/replay reserve the same complete response envelope and hash
normalized request content once. The hash is caller-recomputable integrity, not
authentication: a changed fully normalized valid request with its recomputed
hash is a new request descriptor and replays exactly like that fresh request.
Missing/noncanonical normalized fields, an unrehashed edit, mismatched capture
pins and changed index/source bindings remain invalid.

The fixture under `tests/fixtures/comment-search` fixes source text and relevance
ground truth before model generation. Synthetic vectors test engine math and do
not establish model relevance. Its `model-vectors.json` contains the verbatim separately reviewed/root-verified
local model measurement, with complete original input/provenance pins. Product
ranking validation remains unrun until independent exact-head source review.
No measured relevance, cost saving, automatic paid provider or historical delivery
claim follows from authored source or passing synthetic controls.

The CS1 configuration regression adds `BUILD_GRAPH_COMMENT_CONTEXT_AFTER` to
the focused comment-search script; unset it in ordinary synthetic runs. After
exact-head source clearance, use one fresh owned fixture, CLI, driver, source,
target and output paths. Generate its offline lock before the qualified baseline
and archive the baseline capture/HTML. **Before any `.rs` edit**, change only
the copied Cargo.toml `default = []` to `default = ["blue"]`, capture and archive
the context result, and record that every `.rs` path, bytes and mtime exactly
matches the original baseline. Pass the original baseline as
`BUILD_GRAPH_COMMENT_BEFORE` and this third capture as
`BUILD_GRAPH_COMMENT_CONTEXT_AFTER`. Its independently owned cfg_attr control
must change Default to Blue effective documentation, retain the original source
snapshot, reuse all eight measured source vectors and reject the old index as a
current snapshot. The root receipt must verify the Cargo-only edit and unchanged
source mtimes; exported source hashes alone do not prove the mtime control.
Then restore the copied manifest's exact baseline bytes/hash, make only the
original single doc-line edit in copied source.rs, and run the original paired
doc capture with seven reused vectors and one missing vector. Keep the original
matrix/evidence intact; do not restore source bytes between the baseline and
configuration-only capture, touch mtimes, delete caches or retune model data.
All these authored regression controls remain UNRUN until independent review.

### Composable program queries and compact evidence slices

`programQuery` version 1 is one read-only JSON plan over the existing capture.
It supports named selections, literal filters, relation traversals, scalar hash
joins, projections, existing value/guard analyses, and forward/backward/usage
slices. `schema.programQuery` and `capabilities.programQuery` describe the typed
contract and unavailable facts. There is no script evaluator, scanner/model pack,
new capture backend, or autonomous exploitation workflow.

```js
const api = require('./src/analysis-api.js').create(capture);
const result = await api.query({
  op: 'programQuery', version: 1,
  steps: [
    { name: 'operation', op: 'select', kind: 'callsite',
      procedures: ['<exact captured procedure ID>'],
      where: [{ field: 'callsiteId', test: 'eq', value: '<exact captured callsite ID>' }] },
    { name: 'arguments', op: 'traverse', from: 'operation',
      relations: ['argument'], depth: 1 },
    { name: 'usage', op: 'slice', from: 'arguments',
      relations: ['reads', 'writes'], direction: 'usage', depth: 2 },
    { name: 'sources', op: 'project', from: 'usage',
      fields: { fact: 'id', kind: 'kind', source: 'source', owner: 'identity' } }
  ], return: ['sources', 'usage']
}, { cancelled: () => abortSignal.aborted });
const same = await api.query({ op: 'replay', replay: result.replay });
```

Obtain exact procedure/callsite IDs from the captured facts or existing public
functions/CFG operations. A `function` fact denotes one imported procedure; its
identity separately retains the owning raw graph node, compiler function ID,
symbol ID, exact package and build unit. It does not merge a same-named declaration
or claim a body for an unavailable dependency/native symbol. Every fact has a
stable `pq1:` ID encoding `[kind, exact procedure ID, local key]`, `refs`, source
span/absolute source link when captured, original `evidencePath`, classification
and explicit unknown identity fields. Statements, parameters, argument positions,
local/projected places, blocks, exits, callsites, boolean conditions and boundaries
retain their typed owners. Legacy/invalid value and guard capabilities remain
explicit unavailable boundaries; no facts are reconstructed from type or display
names. Compiler-confirmed, modeled, possible and unknown evidence remain distinct.

Control edges retain the exact raw successor pointer, ordinal, action and kind.
Action-only successors become modeled `exit` facts: `continue` reaches the return
or unwind exit according to its edge kind, while `terminate` and `unreachable`
retain their own exits. They never become invented blocks. Missing/invalid
successors reach unknown boundaries and make the slice's coverage partial.
Unsupported place projections retain every captured descriptor (including
reasons, index locals and constant offsets). Their identities are specific to the
captured occurrence; the place and its syntactic usage edge are unknown. Usage
slices expose these boundaries without equating unsupported locations. Supported
local/field/deref identities retain the existing exact syntactic behavior.

`contains`, `calls`, `control`, `argument`, `parameter`, `reads` and `writes` expose
supported captured structure. Reads/writes mean syntactic use/definition of a
place; chaining them does **not** establish reaching definitions or propagation.
`analyze` accepts an existing exact `valueFlow` or `guardObligations` query with its
complete declared model. It calls the same capture-owned public analyzer indexes;
per-step budgets, scope and timeout are rejected. Its rows are `valueStep` or
`guardStep`, with the original proof details, witness/context/condition metadata
and exact source owner. `valueEvidence` and `guardEvidence` connect steps only
inside one returned analyzer witness. `atCall` connects those steps to their exact
captured callsite. No relations are inferred from spelling. Analyzer status,
finding, semantics, completion, query coverage and model declarations remain
available in `analysis` metadata and each resulting slice's `analysisCoverage`.

A combined agent example is executable as fixture-owned declarations:

```js
const { fixture, plan } = require('./tests/fixtures/program-queries/fixture-graphs.cjs');
const api = require('./src/analysis-api.js').create(fixture());
const combined = await api.query(plan());
// plan() declares a user-input parameter, follows the supported cross-package
// value witness into decoding, joins its exact sink call to a guard operation,
// and returns source-linked summary + backward value/guard evidence slice.
```

The positive fixture requires the user-input parameter, intermediary argument and
return, decoder sink, successful guard result/outcome and operation. The near-miss
uses another parameter: the declared input route is absent and the independent
guard analyzer reports the value-binding difference. Real compiler-backed examples
bind the unchanged multi-crate guard/value fixtures through
`tests/fixtures/program-queries/capture-model.cjs`; these compare public analyzer
semantics and independently expected membership rather than only comparing two
transports. Names in those fixture helpers resolve explicit declarations once;
production queries carry exact IDs. Configure sources and conditions as review
assumptions, never as proof that a vulnerability or authorization policy exists.

`filter.where` is an AND of at most 16 `{field,test,value}` predicates. Tests are
`eq`, `ne`, `in` (at most 100 scalar values), `exists` (boolean) or literal string
`contains`. Field paths are bounded plain property names; no prototype access,
regex execution or host code is allowed. `join` uses exact typed scalar equality
on `on.left` / `on.right`, with `inner` or `left` behavior; missing/null keys never
match. `project.fields` maps plain output names to paths and always retains
unaltered `refs`. A slice can therefore consume a projected or joined result while
retaining exact underlying evidence ownership. Plans reject unsupported keys,
forward/unknown result names, invalid kinds/relations and stale owner/fact/model
references before returning results. Use selections with exact `procedures` to
avoid unnecessary owner scans.

Slices use minimum-distance bounded expansion so convergent routes do not hide a
shorter route's descendants. A separate bounded gray/black traversal distinguishes
cycles from DAG convergence. Each slice returns typed rows, relations, relevant
conditions, cycle/recursion summaries, unmatched/unknown boundaries, depth
frontiers, truncation and partial-coverage flags. `direction: 'usage'` follows
incoming syntactic reads/writes or exact analyzer evidence; it is not a claim of
alias completeness. Captured structural reachability does not solve branch
feasibility; a slice never proves exhaustiveness, exploitability, policy
correctness or vulnerability absence.

The plan owns its input at dispatch (at most 65,536 escaped UTF-8 JSON bytes,
32 steps, JSON nesting at most 64). Unknown fields, non-finite/cyclic values,
accessors and unsafe property names are rejected. The capture's existing imported
owner/value/guard indexes are shared. Facts are materialized lazily per procedure
and published atomically only when complete, with a 16 MiB shared cache cap and
safe eviction; active plans retain their own charged references. Incoming call
lookup is built once lazily and included in the same cap. A plan never clones or
reindexes the whole capture. Cold and warm owner/index use incur the same recorded
logical work/memory charges, so equivalent successful receipts are deterministic.

Whole-plan limits cover cumulative work, rows (including discarded intermediates),
subanalysis states/evidence, retained plan/index/output allocations and escaped
wire output. Defaults are 2,000,000 work, 2,000 rows, 10,000 analyzer states,
200 evidence steps, 4 MiB retained memory and 512 KiB output. Hard ceilings are
reported by `schema.programQuery`; the shared deadline is at most 5 seconds.
Subanalyses receive only remaining cumulative work/state/evidence allowances and
the remaining parent deadline; their existing private state engines retain their
own bounded semantics. Output metadata, projections, joins, replay descriptors,
JSON escaping and result hashing participate in the plan budget. Cooperative
work yields through an initial timer then immediate/message-channel turns, with
channel cleanup. Cancellation, timeout, budget exhaustion or error returns an
empty `results` object with the failing step and actionable diagnostic; no partial
result table is published.

The response pins the complete normalized plan and models, canonical capture
SHA-256, schema/analysis versions, and independent available build/tree provenance
records (or an explicit missing build-context status). `result.plan` contains the
complete canonical normalized plan, including expanded query/model defaults.
The saved `replay.plan` instead retains the original admitted declaration. Replay
applies the same 65,536-byte cap and shape validation to that original, then
checks its mandatory `normalizedPlanSha256` against the complete normalized plan
before any query work, exact-reference resolution or analyzer traversal. A
changed original or changed normalization semantics cannot silently alter the
saved question. Missing hashes, changed capture/version pins, normalized-plan
hash mismatches or changed results are rejected.
An exact-shaped
`{op:'replay', replay:{version,capture,versions,plan,normalizedPlanSha256,resultSha256}}`
program receipt has a separate outer admission bound of 1,048,608 escaped UTF-8
JSON bytes (`schema.programQuery.replayInputBytes`): the 1 MiB maximum successful
wire response plus 32 wrapper bytes. This contains every successfully emitted
receipt, including build provenance, while its inner declaration keeps the fresh
limit. An admitted original whose normalized expansion exceeds 65,536 bytes
remains replayable; fresh and replay responses retain the same original and
complete normalized plan, hashes and accounting. The CLI applies the outer
replay bound to its lexical UTF-8 input too; other operations retain their
existing ingress caps.
These are reproducibility/integrity checks, **not** authentication: a caller can
make and hash a different valid bounded declaration and its normalization.
Retain the capture separately;
replay does not upload or fetch source. `resultSha256` covers the complete stable
semantic payload, including source/provenance/models/results; the receipt also
reports bounded execution accounting.

CLI request, normal stdin and JSONL require no special dispatcher:

```sh
node scripts/query-analysis.cjs --graph /owned/capture.json --request '{"op":"programQuery","version":1,"steps":[{"name":"functions","op":"select","kind":"function","procedures":["<exact procedure ID>"]}],"return":["functions"]}'
node scripts/query-analysis.cjs --graph /owned/capture.json < /owned/plan.json
node scripts/query-analysis.cjs --graph /owned/capture.json --jsonl < /owned/plans-and-replays.jsonl
```

The browser exposes the same engine as `FLOW_UI.queryProgram(plan)` and
`FLOW_UI.cancelProgram()`. Actual Blob-worker and main-thread fallback execution
share immutable requests, generation/catalog cancellation and full payload/hash
replay. A program query is independent of graph selection, filters, pins,
highlights and existing analysis ownership; no additional product panel is added.
