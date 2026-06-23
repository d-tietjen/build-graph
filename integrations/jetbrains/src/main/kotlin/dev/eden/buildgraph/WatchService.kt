package dev.eden.buildgraph

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessHandlerFactory
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.io.File

/**
 * Per-project owner of the `cargo build-graph` processes and the local graph
 * server. Starting the watcher is idempotent (shared by the auto-start activity
 * and the menu); the watcher is killed when the project closes.
 */
@Service(Service.Level.PROJECT)
class WatchService(private val project: Project) : Disposable {
    @Volatile
    private var handler: OSProcessHandler? = null

    @Volatile
    var port: Int = 0
        private set

    /** Ensure the watcher (`watch --driver`) + server are running. Idempotent.
     *  Throws if `cargo build-graph` can't be launched. */
    @Synchronized
    fun ensureWatching() {
        if (handler == null || handler?.isProcessTerminated == true) {
            val h = ProcessHandlerFactory.getInstance().createProcessHandler(command("watch"))
            h.startNotify()
            handler = h
        }
        ensureServer()
    }

    /** Force a one-shot rebuild now (`build --driver`), independent of saves. */
    fun triggerRebuild() {
        ProcessHandlerFactory.getInstance().createProcessHandler(command("build")).startNotify()
        ensureServer()
    }

    /** Start the graph server (without the watcher) so an existing graph is viewable. */
    @Synchronized
    fun ensureServer() {
        val base = project.basePath ?: error("project has no base path")
        port = GraphServer.ensure(File(base, "target/build-graph"))
    }

    fun isRunning(): Boolean = handler?.isProcessTerminated == false

    @Synchronized
    fun stop() {
        handler?.destroyProcess()
        handler = null
    }

    fun liveUrl(): String = "http://127.0.0.1:$port/live"

    override fun dispose() {
        handler?.destroyProcess()
        handler = null
    }

    private fun command(sub: String): GeneralCommandLine {
        val base = project.basePath ?: error("project has no base path")
        val cmd = GeneralCommandLine(
            cargoExe(), "build-graph", sub, "--driver", "--out", "target/build-graph",
        ).withWorkDirectory(File(base))
        // Put ~/.cargo/bin on PATH so cargo finds the `cargo-build-graph` subcommand
        // even when the IDE was launched from the Dock without the login-shell PATH.
        val cargoBin = File(System.getProperty("user.home"), ".cargo/bin").absolutePath
        cmd.withEnvironment("PATH", cargoBin + File.pathSeparator + (System.getenv("PATH") ?: ""))
        return cmd
    }

    /** Prefer the explicit rustup cargo path; fall back to PATH. */
    private fun cargoExe(): String {
        val candidate = File(System.getProperty("user.home"), ".cargo/bin/cargo")
        return if (candidate.canExecute()) candidate.absolutePath else "cargo"
    }
}
