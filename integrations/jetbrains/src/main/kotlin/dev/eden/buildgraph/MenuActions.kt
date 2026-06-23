package dev.eden.buildgraph

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.components.service

/** Open the graph in the browser without (re)starting the watcher, if it's up. */
class OpenInBrowserAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val svc = e.project?.service<WatchService>() ?: return
        if (svc.isRunning() && svc.port != 0) {
            BrowserUtil.browse(svc.liveUrl())
        }
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.service<WatchService>()?.isRunning() == true
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/** Stop this project's build-graph watcher. */
class StopWatcherAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<WatchService>()?.stop()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.service<WatchService>()?.isRunning() == true
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/** Toggle "auto-start the watcher when a Cargo project opens". */
class AutoStartToggleAction : ToggleAction() {
    override fun isSelected(e: AnActionEvent): Boolean = BuildGraphSettings.autoStartEnabled()

    override fun setSelected(e: AnActionEvent, state: Boolean) = BuildGraphSettings.setAutoStart(state)

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}
