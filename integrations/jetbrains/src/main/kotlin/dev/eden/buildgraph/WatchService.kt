package dev.eden.buildgraph

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessHandlerFactory
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.io.File

/**
 * Per-project owner of the `cargo build-graph watch --driver` process and the
 * local graph server. Starting is idempotent, so the auto-start activity and the
 * menu action share one watcher. Disposed (process killed) when the project closes.
 */
@Service(Service.Level.PROJECT)
class WatchService(private val project: Project) : Disposable {
    @Volatile
    private var handler: OSProcessHandler? = null

    @Volatile
    var port: Int = 0
        private set

    /** Ensure the watcher + server are running. Throws if `cargo build-graph`
     *  can't be launched (e.g. not on PATH). */
    @Synchronized
    fun ensureWatching() {
        val base = project.basePath ?: error("project has no base path")
        if (handler == null || handler?.isProcessTerminated == true) {
            val cmd = GeneralCommandLine(
                cargoExe(), "build-graph", "watch", "--driver", "--out", "target/build-graph",
            ).withWorkDirectory(File(base))
            // Ensure ~/.cargo/bin is on PATH so cargo can locate the
            // `cargo-build-graph` subcommand even when the IDE was launched from
            // the Dock/Finder without the login-shell PATH.
            val cargoBin = File(System.getProperty("user.home"), ".cargo/bin").absolutePath
            cmd.withEnvironment("PATH", cargoBin + File.pathSeparator + (System.getenv("PATH") ?: ""))
            val h = ProcessHandlerFactory.getInstance().createProcessHandler(cmd)
            h.startNotify()
            handler = h
        }
        port = GraphServer.ensure(File(base, "target/build-graph"))
    }

    /** Prefer the explicit rustup cargo path; fall back to PATH. */
    private fun cargoExe(): String {
        val candidate = File(System.getProperty("user.home"), ".cargo/bin/cargo")
        return if (candidate.canExecute()) candidate.absolutePath else "cargo"
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
}
