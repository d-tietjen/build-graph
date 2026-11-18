# Comment search fixtures

`source.rs` and `model-input.json` fix eight generic source entries, six paraphrase
queries with expected original occurrence IDs, and two unrelated controls before
any model inference. Function names p01..p08 are intentionally opaque. The first
four embedding texts are exact effective-doc Markdown; the last four are exact
contiguous ordinary line-comment byte slices, including newline/indentation.
Their portable occurrence IDs are synthetic ground truth, not compiler IDs.
`fixture-graphs.cjs` is a labelled synthetic carrier for engine/transport controls;
Rust extraction/capture validation establishes real occurrence ownership.

Embedding input contract: `comment-text-utf16-1024-v1`; use exact `text` chunks,
with no prefix, trim, whitespace normalization, path/name or generated summary.
These eight texts each fit one chunk. SHA-256 is over exact UTF-8 text. Query text
is also exact. Six positives require a relevant occurrence in the top three;
the negatives report honest nearest-neighbor scores/ranks without a universal
rejection threshold or inferred relevance.

`model-vectors.json` is the verbatim root-verified local CPU ONNX measurement
fixture (`fixture.json` in the retained run). It contains eight document vectors
and eight query vectors, the complete unchanged input/expected relevance, and the
full pinned model descriptor. `model-provenance.json` is the verbatim retained
`provenance.json`; `model-complete.json` is the verbatim retained `COMPLETE.json`
receipt. The receipt retains original run filenames, mapped here as above.

| File | SHA-256 |
| --- | --- |
| model-vectors.json | 38c07152430f0923b609baf07f04a0657a2b412ca47e44cb3e7fcf4a00cbb653 |
| model-provenance.json | 262a84bcbce26469f42e628c7e0440c8b232c74fa631ac04ecbf8275c72b245b |
| model-complete.json | 29fd4c93f70dccc4a871ed1717e8465f653ac3efeb52f1f5a208da4852f9c380 |

The model is sentence-transformers/all-MiniLM-L6-v2 revision
1110a243fdf4706b3f48f1d95db1a4f5529b4d41, 384-dimensional attention-mask mean
pooling and L2 normalization. The separate reviewed generator/pinned public model
preparation ran locally with explicit root authorization. The product writer made
no model/network/provider workload call. The source input's historical pending
status remains byte-identical as part of its pre-generation pin; current measured
status is in the output/provenance. Product relevance/ranking validation is still
UNRUN until independent exact-head review; generation alone proves no retrieval
quality, cost saving or compiler occurrence ownership. The model is fixture
provenance only, not a product dependency; providers remain neutral.

Before accepting measured results, bind document and query vectors by exact text
SHA-256 and pinned full model descriptor, compare source slices, retain actual
vectors/provenance and immutable index/replay, and run the fixed positives and
negative diagnostics through API plus the actual worker/fallback browser path.
A later fresh Rust capture must use its actual captured occurrence IDs and source
pins; never relabel portable IDs as compiler-captured ownership. Synthetic engine
vectors remain labelled separately from measured model relevance.

The isolated Cargo fixture has two same-named targets with different kinds:
`source.rs` is the frozen model-groundtruth library and `ownership.rs` is a binary
with independent root/module/type/field/variant/trait/impl/tuple/Unicode/cfg/macro/
include/nested-body controls. `included.md` exercises doc-only input invalidation.
Capture into an explicitly fresh owned target directory after source review;
these fixture sources do not run a workload. The ownership binary's text is not
fed into the frozen eight-document relevance experiment.

The finite validation owner can enable authored real-capture controls with:

- `BUILD_GRAPH_COMMENT_CAPTURE`: plain/gzip graph JSON from the fresh compiled
  fixture capture.
- `BUILD_GRAPH_COMMENT_HTML`: the matching emitted HTML with all 21 source
  modules and exact inline graph binding. Browser controls require both fields.
- `BUILD_GRAPH_COMMENT_BEFORE` and `BUILD_GRAPH_COMMENT_AFTER`: paired plain/gzip
  graph JSON, both required, generated from the SAME owned physical package and
  target source paths. Preserve/archive the before output, make one doc-only edit
  to the first effective doc without adding/removing items or comment groups,
  commit that source edit in the owned fixture copy, then recapture after in the
  same owned output/cache/target directory. Seven of the eight measured vectors
  must remain reusable and one must become pending; unrelated checkout paths
  cannot establish this acceptance.
- `BUILD_GRAPH_COMMENT_BEFORE_HTML` and `BUILD_GRAPH_COMMENT_AFTER_HTML`: the
  matching archived HTML for each snapshot. The worker and fallback paired
  controls require both JSON and both HTML paths. `CAPTURE`/`HTML` alias the
  archived baseline, which still contains all eight frozen measured texts.

The exact one-line edit is:

```diff
-/// Retries temporary failures with an exponentially increasing delay. Stops after
+/// Retries temporary failures with a bounded increasing delay. Stops after
```

Apply it only in the owned validation copy, once, preserving all other bytes.
The committed fixture and measured source/input/vector/provenance files stay
unchanged. The baseline source SHA-256 is
`520207a52663f43ebb47bafe4dc07a46b80f415e21839eb783d1d012dc1958b8`.
The capture assertions bind all eight baseline vectors through exact text hashes
to actual compiler occurrence IDs, declaration/source hashes and raw byte slices.
The after snapshot binds the seven unchanged texts and requires the edited
effective doc to have no vector. It does not assign the old vector to new text
or claim measured relevance for that edited text.

Preparation is a whole-tree copy to one fresh owned directory, Git init, offline
lockfile generation, and an initial source commit. Build the current CLI and
the pinned `nightly-2026-02-27` private driver separately after source review;
root Cargo inputs changed, so an older compiler build is not current evidence.
Capture with the current CLI's `build` command, `--manifest-path` pointing to
this fixture's copied Cargo.toml, one fixed `--target-dir` and `--out`, `--rich`,
`--nightly nightly-2026-02-27`, `--driver-bin` pointing to that fresh driver,
`--no-compress`, and forwarded `-- --locked --offline`. Set
`CARGO_TARGET_DIR` to that same target directory, `CARGO_NET_OFFLINE=true`,
`RUSTUP_AUTO_INSTALL=0`, and `RUSTUP_SKIP_UPDATE_CHECK=1`. Do not filter to one
target: the library and same-named binary must both be documented. Their rustdoc
JSON is isolated by target. The first capture requires a previously unused target
directory so successful doc-command artifact mtimes can qualify body ownership.
Archive the complete baseline output (JSON and HTML) before the doc edit. Commit
the edit in the same copied Git repository and run the identical capture argv
and output/target paths again, then archive the after output separately. Do not
touch source/cache mtimes, delete Cargo doc caches or substitute another checkout.

With all six variables absent, these six capture-only tests visibly skip:

- `actual compiled capture binds measured text vectors to exact compiler/source occurrences`
- `actual before/after doc edit reuses unchanged vectors at the SAME physical package/target/source identity`
- `fallback: emitted 21-module HTML binds measured queries and exact captured occurrence navigation`
- `worker: emitted 21-module HTML binds measured queries and exact captured occurrence navigation`
- `fallback: before/after emitted HTML preserves seven measured vectors and fences stale indexes`
- `worker: before/after emitted HTML preserves seven measured vectors and fences stale indexes`

With all six supplied the focused pair requires zero skips. Supplying only part
of a required pair is a failure, never a reason to skip. Ordinary validation
also unsets the 33 historical capture variables; the new six make 39 in total.

Absent variables are visible skips, not real-capture qualification. Root owns the
fresh compiler/CLI build and exact finite run matrix. These hooks never launch a
capture/compiler/model/provider by themselves. The HTTP tests use loopback-only
fake endpoints serving the already pinned measured vectors, not live inference.
