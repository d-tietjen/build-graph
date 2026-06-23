# build-graph for VS Code

A thin shell over the [`build-graph`](../../README.md) CLI: it **auto-starts**
`cargo build-graph watch` when you open a Cargo workspace and shows the **live
architecture graph** in a side panel that refreshes whenever the graph changes on
save.

It intentionally does **not** reimplement go-to-def / find-references — your
rust-analyzer already does those per symbol. This surfaces the thing it doesn't:
the cross-crate **architecture graph** (crates, files, symbols, and relationships).

## Commands

- **build-graph: Open Graph** — open the graph panel (serves the output dir
  locally and frames the bundled viewer; auto-reloads on change).
- **build-graph: Trigger Rebuild** — force a one-shot rebuild now.
- **build-graph: Start/Stop Auto Build** — toggle the watcher.

A status-bar item (bottom-left) shows whether it's watching and opens the graph.

## Settings

- `buildGraph.autoStart` — start the watcher automatically when a Cargo workspace
  opens (default `true`).
- `buildGraph.command` — base command (default `cargo build-graph`).
- `buildGraph.references` — Layer 3 backend: `driver` (fast/incremental — needs a
  build-graph built with the `rustc-driver` feature), `rust-analyzer`, or `none`.
- `buildGraph.extraArgs` — extra args (e.g. `--nightly`, `--no-derives`).
- `buildGraph.outDir` — graph output dir, relative to the workspace (default
  `target/build-graph`).

## Develop

```bash
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host (or
`npm run watch` to recompile on change). Package with
[`vsce`](https://github.com/microsoft/vscode-vsce): `npx vsce package`.

Requires `build-graph` on PATH (or set `buildGraph.command`). For the fast
incremental `driver` backend, build/install build-graph with
`--features rustc-driver`.
