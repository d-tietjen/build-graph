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

## ⚠️ Status: unbuilt scaffold

This was authored without a JVM available, so it has **not** been compiled or
run. Treat it as a correct-shaped starting point, not a finished plugin. Before
it works you'll likely need to:

1. Install **JDK 17+** and run `./gradlew buildPlugin` (add the Gradle wrapper
   with `gradle wrapper` first).
2. Adjust the platform target in [`build.gradle.kts`](build.gradle.kts) —
   `rustRover("2024.2")` — to a RustRover version you have, and the
   `sinceBuild`/`untilBuild` range in `plugin.xml`/Gradle accordingly.
3. Verify the JCEF + tool-window + `BulkFileListener` APIs against your target
   platform version (these are stable but move occasionally).

Run in a sandbox IDE with `./gradlew runIde`.

## Requires

`build-graph` on PATH, built with `--features rustc-driver` for the fast
incremental `--driver` backend.
