# build-graph for JetBrains (RustRover / IDEA)

A tool-window plugin that shows [`build-graph`](../../README.md)'s live
**architecture graph** inside the IDE (via a JCEF browser) and can start
`cargo build-graph watch` for you. Like the VS Code extension, it deliberately
does **not** duplicate the IDE's own go-to-def / find-usages — it surfaces the
cross-crate architecture graph the IDE doesn't.

## What's here

- `BuildGraphToolWindowFactory` — a right-hand tool window with the viewer;
  reloads when `graph.json[.gz]` is rewritten.
- `StartWatchAction` (Tools → *build-graph: Start Watch*) — runs the watcher.
- `GraphServer` — serves the output dir locally so the viewer can fetch its data.

## Status

**Builds and loads.** `./gradlew buildPlugin` succeeds and the plugin loads into
a headless RustRover 2024.2 during the build (`buildSearchableOptions`). The
JCEF tool-window UI itself hasn't been exercised in a real GUI session yet — do
that with `./gradlew runIde` (JCEF is disabled headlessly).

```bash
# A JDK 21 is bundled with RustRover; reuse it:
export JAVA_HOME=/Applications/RustRover.app/Contents/jbr/Contents/Home
./gradlew runIde         # launches a sandbox RustRover with the plugin
./gradlew buildPlugin    # produces build/distributions/*.zip to install manually
```

Notes:
- Pinned to the IntelliJ Platform Gradle Plugin 2.1.0 (a newer 2.16.0 exists;
  bumping needs minor `build.gradle.kts` changes, e.g. `instrumentationTools()`
  is no longer needed).
- `rustRover("2024.2")` / `sinceBuild = "242"` target RustRover 2024.2 — adjust
  to your installed build if different.

## Requires

`build-graph` on PATH, built with `--features rustc-driver` for the fast
incremental `--driver` backend.
