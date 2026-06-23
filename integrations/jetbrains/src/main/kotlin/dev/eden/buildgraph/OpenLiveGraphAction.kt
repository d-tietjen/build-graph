package dev.eden.buildgraph

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.ProcessHandlerFactory
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import java.io.File

/**
 * Starts `cargo build-graph watch --driver` and opens the live graph in the
 * system browser. The served `/live` page reloads itself whenever the graph is
 * rewritten on save, so the browser tab stays current with no IDE-embedded UI.
 */
class OpenLiveGraphAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val base = project.basePath ?: return
        val outDir = File(base, "target/build-graph")

        try {
            val cmd = GeneralCommandLine(
                "cargo", "build-graph", "watch", "--driver", "--out", "target/build-graph",
            ).withWorkDirectory(File(base))
            ProcessHandlerFactory.getInstance().createProcessHandler(cmd).startNotify()
        } catch (ex: Exception) {
            Messages.showErrorDialog(
                project,
                "Failed to start build-graph watch: ${ex.message}\n" +
                    "Is `build-graph` on PATH (built with --features rustc-driver)?",
                "build-graph",
            )
            return
        }

        val port = GraphServer.ensure(outDir)
        BrowserUtil.browse("http://127.0.0.1:$port/live")
    }
}
