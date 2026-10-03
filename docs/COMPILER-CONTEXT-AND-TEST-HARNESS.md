# Analysed compiler context and generated test harness observations

`--observe-compiler-context` and `--observe-test-harness` are optional extensions
of `--observe-semantic-stream`, which already requires occurrence observations
and a matching nightly driver. The harness route includes context. Both options
are absent by default; the original request domain, callback control bytes and
path readers remain the default. They also work with immutable held callback
controls. No new dependency, MSRV, source pin or licence changes are required.

The successor domains are `local_hir_with_compiler_context` and
`local_hir_with_test_harness`. They reuse the existing schema version, semantic
pages and terminal, with explicitly tagged, boxed observation targets. Consumers
that support only `local_hir` must reject these opt-in domains. Legacy fields and
constructors are unchanged. The wrapper clears both optional driver selectors
before delegation and sets them only from its selected configuration.

## Actual compiler state

The callback runs after analysis of the same compiler Session. It borrows
`Session.psess.config`, `target_features` and `unstable_target_features`, after
rustc has added defaults, user configuration and codegen backend configuration.
It emits their actual iteration order, row ordinals, inventory counts, compiler
version, LLVM target and architecture. It does not rebuild effective cfg from
Cargo metadata, command arguments or an extra compiler query. This applies to
ordinary units as well as test units. Enabled backend features are Session
features, not an assertion that every function has identical function attributes.

## Generated harness

The producer checks the actual entry definition's `AstPass::TestHarness`
expansion and its resolved call, then type checks the actual array of referenced
local constants. It reads the actual typed `TestDescAndFn` and nested `TestDesc`
fields, resolved runner/constructor/variant/closure/function definitions, and
used test-crate source paths relative to the selected sysroot. The generated
ordered table includes tests and benches, ignore messages, panic expectations,
compile-fail/no-run fields, test type and source coordinates. No field is inferred
from `--test`, a Cargo harness flag, source text or harness stdout. The standard
runner and descriptor ownership must match the same compiler crate identities.
A custom runner, changed HIR shape, missing owner table or missing sysroot member
produces a typed gap rather than a standard harness observation.

Definition observations retain the compiler crate name, stable crate identifier,
crate hash, definition path hash, index and bounded compiler path. Stable crate
identifiers and crate hashes use fixed-width numeric hexadecimal; definition
path hashes encode all sixteen `Fingerprint::to_le_bytes()` bytes, including
leading zeros. No compiler formatting helper allocates an uncharged hash string. These are
compiler observations, not portable test keys or execution authority. Used crate
paths do not prove descriptor consumption, source CAS, immutable installation,
output provenance or test execution. Those checks belong to their actual owners.

## Limits and partial results

The original limits remain 24 KiB per page, 64 definition and reference rows per
page, 8 MiB across a run's semantic attachments, 32 MiB source work and one million
traversal events. Control requests retain the shared 32 KiB pair limit. The new
observation rows spend the original monotonic output reservation before owned
strings, boxes or member vectors grow; they also retain the existing serialized
page/index charges. Payloads are boxed so the original reference-vector element
size remains unchanged. Each row has a 24 KiB owned-capacity bound before growth.
The test table is borrowed and streamed, with no clone of the entire table.

A terminal that reaches the end still preserves unsupported rows and gaps. Exact
header counts and contiguous ordinals are checked across page boundaries; missing
context/table rows require a relevant typed gap or an interrupted terminal.
Duplicate inventory keys, constants, wrong domains, foreign descriptor identities
and unsorted test names are rejected. The original sixteen gap slots remain
bounded; excess diversity stops publication explicitly. No empty set, terminal,
transport selector, observation DTO or matching output hash grants completeness.

## Required validation

The source controls cover strict DTO/stream validation, real configuration and
request producers, default byte compatibility and CLI dependencies. The genuine
Linux controls require an actual driver, rustc, rustdoc, Cargo and sysroot from
one matching nightly toolchain. They exercise effective cfg/backend changes,
standard/empty/custom/ordinary/bench harnesses, large paged tables and the actual
selected Cargo wrapper/export route. These tests are authored here, not executed.
Source review, matching compiler build, native custody, original output/harness
joins and complete consumer qualification remain required independently.
