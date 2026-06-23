package dev.eden.buildgraph

import com.intellij.ide.BrowserUtil
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import java.io.File

private const val AUTO_START_KEY = "buildGraph.autoStart"

/** Whether to auto-start the watcher on project open (default on). */
object BuildGraphSettings {
    fun autoStartEnabled(): Boolean =
        PropertiesComponent.getInstance().getBoolean(AUTO_START_KEY, true)

    fun setAutoStart(enabled: Boolean) =
        PropertiesComponent.getInstance().setValue(AUTO_START_KEY, enabled, true)
}

/**
 * On opening a Cargo project, auto-start `cargo build-graph watch --driver` so the
 * architecture graph stays fresh with no menu click. Off-able from the notification.
 */
class AutoStartActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val base = project.basePath ?: return
        if (!File(base, "Cargo.toml").isFile) return // only Rust workspaces
        if (!BuildGraphSettings.autoStartEnabled()) return

        val group = NotificationGroupManager.getInstance().getNotificationGroup("build-graph")
        try {
            project.service<WatchService>().ensureWatching()
            val n = group.createNotification(
                "build-graph is watching this project (graph refreshes on save).",
                NotificationType.INFORMATION,
            )
            n.addAction(NotificationAction.createSimple("Open graph") {
                BrowserUtil.browse(project.service<WatchService>().liveUrl())
            })
            n.addAction(NotificationAction.createSimple("Disable auto-start") {
                BuildGraphSettings.setAutoStart(false)
                n.expire()
            })
            n.notify(project)
        } catch (ex: Exception) {
            group.createNotification(
                "build-graph: couldn't start the watcher — ${ex.message}. " +
                    "Is `build-graph` on PATH (built with --features rustc-driver)?",
                NotificationType.WARNING,
            ).notify(project)
        }
    }
}
