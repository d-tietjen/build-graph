package dev.eden.buildgraph

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessHandlerFactory
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import java.io.File

/** Runs `cargo build-graph watch --driver` in the project root; the tool window
 *  then refreshes the graph as it's rewritten on save. */
class StartWatchAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val base = e.project?.basePath ?: return
        val cmd = GeneralCommandLine(
            "cargo", "build-graph", "watch", "--driver", "--out", "target/build-graph",
        ).withWorkDirectory(File(base))
        try {
            val handler: OSProcessHandler =
                ProcessHandlerFactory.getInstance().createProcessHandler(cmd)
            handler.startNotify()
        } catch (ex: Exception) {
            Messages.showErrorDialog(
                e.project,
                "Failed to start build-graph watch: ${ex.message}\n" +
                    "Is `build-graph` on PATH (built with --features rustc-driver)?",
                "build-graph",
            )
        }
    }
}
