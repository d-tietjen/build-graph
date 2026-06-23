# build-graph for JetBrains (RustRover / IDEA)

Starts [`build-graph`](../../README.md)'s watcher and opens the live
**architecture graph in your browser** — no embedded UI. Like the VS Code
extension, it deliberately does **not** duplicate the IDE's own go-to-def /
find-usages; it surfaces the cross-crate architecture graph the IDE doesn't.

## What's here

- `OpenLiveGraphAction` (**Tools → build-graph: Open Live Graph**) — runs
  `cargo build-graph watch --driver` and opens the graph in your default browser.
- `GraphServer` — serves the output dir locally and a `/live` page that polls
  `/mtime` and reloads the viewer whenever the graph is rewritten on save, so the
  browser tab stays live with no JCEF / tool window.

## Build & run

A JDK 21 ships with RustRover; reuse it. Run each line on its own (no trailing
`#` comments — zsh passes them to Gradle as task names):

```bash
export JAVA_HOME=/Applications/RustRover.app/Contents/jbr/Contents/Home
./gradlew runIde
```

`./gradlew runIde` launches a sandbox RustRover with the plugin; `./gradlew
buildPlugin` produces `build/distributions/*.zip` to install manually.

`buildPlugin` succeeds and the plugin loads into a headless RustRover 2024.2
during the build. The action + live browser page haven't been clicked through in
a real GUI session yet — do that with `./gradlew runIde`.

Notes:
- Pinned to the IntelliJ Platform Gradle Plugin 2.1.0 (a newer 2.16.0 exists;
  bumping needs minor `build.gradle.kts` changes, e.g. `instrumentationTools()`
  is no longer needed).
- `rustRover("2024.2")` / `sinceBuild = "242"` target RustRover 2024.2 — adjust
  to your installed build if different.

## Requires

`build-graph` on PATH, built with `--features rustc-driver` for the fast
incremental `--driver` backend.
