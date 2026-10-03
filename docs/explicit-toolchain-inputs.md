# Explicit occurrence tool inputs

The `rustc-driver` feature adds a complete optional supplied-tool mode to the
existing occurrence capture route:

```sh
CARGO_ENCODED_RUSTFLAGS='' CARGO_ENCODED_RUSTDOCFLAGS='' \
  /tools/cargo-build-graph build --manifest-path /project/Cargo.toml \
  --observe-compiler-inputs --observe-definition-occurrences --rich \
  --nightly nightly-2026-02-27 --driver-bin /tools/bg-driver \
  --occurrence-cargo /tools/cargo --occurrence-rustc /tools/rustc \
  --occurrence-rustdoc /tools/rustdoc --occurrence-sysroot /tools/sysroot
```

Supply all five paths together. Executables must be existing absolute file
paths, executable on Unix; the sysroot must be an absolute directory containing
`lib/`. Paths are bounded to 4096 bytes and reject control bytes and parent
traversal. The prebuilt driver must actually match the supplied compiler and
sysroot. Path admission does not establish that compatibility, source identity,
installed code closure, custody or a qualified role.

The caller must supply the **complete effective compiler and rustdoc flag
baseline** through `CARGO_ENCODED_RUSTFLAGS` and
`CARGO_ENCODED_RUSTDOCFLAGS`, or the existing `RUSTFLAGS` and `RUSTDOCFLAGS`.
Each role needs an explicitly present value, including empty when there are no
flags. Encoded values retain Cargo's precedence over plain values and use U+001F
between arguments. Plain values use Cargo's whitespace splitting. This explicit
baseline replaces Cargo-config flag discovery; a wrapper must derive it from
its actual captured configuration. The empty example applies only to a project
whose complete baseline really is empty.

The selected sysroot is composed into both encoded baselines as one
`--sysroot=PATH` argument, including paths with spaces. A preexisting identical
selection is retained; conflicting, repeated or incomplete selections fail
before the first selected Cargo process. The existing rich-doc command's JSON
flags are appended to the supplied doc baseline. Final per-command flags are
bounded to 512 arguments and 4096 bytes. A connected launch observer cannot
replace the selected compiler/doc paths or flag baseline between route and
final carrier freeze.

This mode bypasses build-graph's `rustup which`, ambient `rustc --print sysroot`
and on-demand driver-building subprocesses. Initial metadata, the actual build,
post-build metadata and rich docs use the same selected Cargo session with the
supplied `RUSTC`, `RUSTDOC` and sysroot library directory. Compiler version
observations still query the actual supplied compiler. Selected tools may
perform their own work; this API does not authenticate what a supplied
executable delegates to. The original command, launch intent/carrier, callback,
child lifetime, bounds, partial outcomes and graph export semantics apply.
The existing separate driver-reference `cargo check` also uses these supplied
tools. When a connected observer is present, it freezes, ACKs, spawns and waits
through that same Session/Child owner under a distinct `driver_check` launch
kind. It shares the 16-operation bound; it is not added to or relabelled inside
the metadata/build/docs attachment. Its existing reference-edge reader and
partial failure reporting remain unchanged.

Omitting all three new options preserves discovery, legacy Cargo selection,
default toolchains and driver building. The new options are absent without the
`rustc-driver` feature. Generic selection works on supported platforms; the
connected observer remains Linux-only.

## Validation

The added unit and actual CLI controls cover complete/incomplete selection,
feature gating, bounded paths, executable/sysroot admission, encoded/plain flag
precedence, explicit empty baselines, rich-doc flag retention, duplicate or
conflicting sysroots, final command checks, and a real connected session through
sealed intent, ACK, spawn and wait. Controlled tool failures prove ordering and
zero discovery; they never stand in for a working compiler callback.

`genuine_explicit_tools_build_rich_docs_and_callback_without_ambient_discovery`
requires actual matching `BUILD_GRAPH_TEST_EXPLICIT_CARGO`,
`BUILD_GRAPH_TEST_EXPLICIT_RUSTC`, `BUILD_GRAPH_TEST_EXPLICIT_RUSTDOC`,
`BUILD_GRAPH_TEST_EXPLICIT_SYSROOT`, `BUILD_GRAPH_DRIVER`, and complete encoded
`BUILD_GRAPH_TEST_EXPLICIT_RUSTFLAGS` / `BUILD_GRAPH_TEST_EXPLICIT_RUSTDOCFLAGS`
values. Missing inputs fail. It must retain genuine definitions/references,
metadata/build/docs session outcomes, and a successful export while discovery
shims remain unused. Existing occurrence, semantic stream and launch-channel
controls remain required. All authored controls still need execution; source
inspection is not runtime evidence.
