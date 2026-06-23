package dev.eden.buildgraph

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.Messages

/**
 * Ensures the watcher is running (also re-enables auto-start) and opens the live
 * graph in the system browser. Shares the watcher with the auto-start activity.
 */
class OpenLiveGraphAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        try {
            val svc = project.service<WatchService>()
            svc.ensureWatching()
            BuildGraphSettings.setAutoStart(true)
            BrowserUtil.browse(svc.liveUrl())
        } catch (ex: Exception) {
            Messages.showErrorDialog(
                project,
                "Failed to start build-graph watch: ${ex.message}\n" +
                    "Is `build-graph` on PATH (built with --features rustc-driver)?",
                "build-graph",
            )
        }
    }
}
