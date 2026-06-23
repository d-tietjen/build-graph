# GitHub Action: Architecture Docs

`build-graph` ships a composite GitHub Action that keeps an AI-readable
`ARCHITECTURE.md` in sync with a Rust workspace.

The action:

1. Installs the pinned nightly toolchain used for rustdoc JSON.
2. Installs `cargo-build-graph`, with the `rustc-driver` feature when requested.
3. Runs `cargo build-graph build` with the selected Layer 3 backend.
4. Writes `graph.json[.gz]`, `graph.html`, and `GRAPH_REPORT.md`.
5. Replaces the generated build-graph block in `ARCHITECTURE.md`.

The generated block is deterministic: no timestamps or runner-specific metadata.
Scheduled runs only create a diff when the graph-derived architecture facts
change.

## Minimal Workflow

```yaml
name: Architecture docs

on:
  workflow_dispatch:
  schedule:
    - cron: "0 9 * * 1"

permissions:
  contents: write

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: d-tietjen/build-graph@master
        with:
          manifest-path: Cargo.toml
          architecture-path: ARCHITECTURE.md
          references-backend: rustc-driver

      - name: Commit architecture update
        run: |
          if git diff --quiet -- ARCHITECTURE.md; then
            echo "ARCHITECTURE.md is already current"
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add ARCHITECTURE.md
          git commit -m "Update architecture documentation"
          git push
```

Use `@master` until the next repository tag includes `action.yml`; use a pinned
tag once one exists.

`references-backend: rustc-driver` installs `build-graph` with the
`rustc-driver` feature and uses the compiler-backed Layer 3 backend. Omit it to
keep the default rust-analyzer SCIP backend.

## PR-Based Workflow

For repositories that prefer review before updating docs, use the GitHub CLI
already available on hosted runners:

```yaml
name: Architecture docs

on:
  workflow_dispatch:
  schedule:
    - cron: "0 9 * * 1"

permissions:
  contents: write
  pull-requests: write

jobs:
  architecture:
    runs-on: ubuntu-latest
    env:
      BRANCH: build-graph/update-architecture
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4

      - uses: d-tietjen/build-graph@master
        with:
          manifest-path: Cargo.toml
          architecture-path: ARCHITECTURE.md
          references-backend: rustc-driver

      - name: Open pull request
        run: |
          if git diff --quiet -- ARCHITECTURE.md; then
            echo "ARCHITECTURE.md is already current"
            exit 0
          fi

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -B "$BRANCH"
          git add ARCHITECTURE.md
          git commit -m "Update architecture documentation"
          git push --force-with-lease origin "$BRANCH"
          if [[ "$(gh pr list --head "$BRANCH" --json number --jq 'length')" == "0" ]]; then
            gh pr create \
              --base "${GITHUB_REF_NAME}" \
              --head "$BRANCH" \
              --title "Update architecture documentation" \
              --body "Regenerated ARCHITECTURE.md from build-graph."
          else
            echo "Architecture documentation PR already exists"
          fi
```

## Inputs

| Input | Default | Notes |
|---|---|---|
| `manifest-path` | `Cargo.toml` | Workspace manifest to graph. |
| `graph-dir` | `target/build-graph` | Output directory for graph artifacts. |
| `architecture-path` | `ARCHITECTURE.md` | Markdown file to update. |
| `nightly` | `nightly-2026-02-27` | Must match the pinned `rustdoc-types` format. |
| `references` | `true` | Adds Layer 3 `calls`/`uses` edges. Set to `false` for Layer 2 only. |
| `references-backend` | `rust-analyzer` | Layer 3 backend when `references` is `true`: `rust-analyzer` or `rustc-driver`. |
| `driver-bin` | empty | Optional prebuilt `bg-driver` binary path for `references-backend: rustc-driver`. |
| `no-derives` | `false` | Drop derive-generated impls from the rich symbol layer. |
| `no-compress` | `false` | Write plain `graph.json` instead of `graph.json.gz`. |
| `release` | `false` | Build the target workspace with `--release`. |
| `package` | empty | Optional Cargo package passed as `-p`. |
| `install-source` | `action` | `action`, `crates.io`, or `skip`. |
| `build-graph-version` | `0.2.0` | Used when `install-source: crates.io`. |
| `architecture-limit` | `15` | Maximum rows in generated tables. |

## Layer 3 Backend Choice

The default `references-backend: rust-analyzer` preserves the original action
behavior: it installs `rust-analyzer` and runs `cargo build-graph build
--references`.

For large workspaces, prefer `references-backend: rustc-driver`. The action
installs the pinned nightly's `rustc-dev` component, installs `build-graph` with
`--features rustc-driver`, and runs `cargo build-graph build --driver`. The
driver builds on demand and cargo caches it, so subsequent runs reuse both the
driver binary and the target workspace's incremental check artifacts.

Set `references: false` to skip Layer 3 entirely while still generating the rich
rustdoc symbol layer.

## Agent Guidance

Point agents at the generated architecture doc before they inspect code:

````md
Before making code changes, read ARCHITECTURE.md. Its build-graph section is
generated from Rust build artifacts and should be treated as the current map of
crates, symbols, and relationships.

When you need exact code navigation, use:

```bash
cargo build-graph find <symbol> --json --out target/build-graph
cargo build-graph refs <symbol-or-id> --json --out target/build-graph
```
````

Keep hand-written guidance outside the generated block:

```md
<!-- build-graph:architecture:start -->
...
<!-- build-graph:architecture:end -->
```

The action may replace everything inside those markers.
