package dev.eden.buildgraph

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.Messages

private fun fail(e: AnActionEvent, ex: Exception) = Messages.showErrorDialog(
    e.project,
    "build-graph: ${ex.message}\nIs `build-graph` on PATH (built with --features rustc-driver)?",
    "build-graph",
)

/** Force a one-shot rebuild of the graph now. */
class TriggerRebuildAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val svc = e.project?.service<WatchService>() ?: return
        try {
            svc.triggerRebuild()
        } catch (ex: Exception) {
            fail(e, ex)
        }
    }
}

/** Single toggle: stop the watcher if running, otherwise (re)start it. Dynamic
 *  text + the persisted auto-start-on-open flag follow the watcher state. */
class ToggleAutoBuildAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val svc = e.project?.service<WatchService>() ?: return
        try {
            if (svc.isRunning()) {
                svc.stop()
                BuildGraphSettings.setAutoStart(false)
            } else {
                BuildGraphSettings.setAutoStart(true)
                svc.ensureWatching()
            }
        } catch (ex: Exception) {
            fail(e, ex)
        }
    }

    override fun update(e: AnActionEvent) {
        val running = e.project?.service<WatchService>()?.isRunning() == true
        e.presentation.text = if (running) "Stop Auto Build" else "Resume Auto Build"
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/** Open (or reopen) the graph in the system browser. */
class OpenInBrowserAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val svc = e.project?.service<WatchService>() ?: return
        try {
            svc.ensureServer()
            BrowserUtil.browse(svc.liveUrl())
        } catch (ex: Exception) {
            fail(e, ex)
        }
    }
}
