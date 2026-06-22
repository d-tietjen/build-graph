package dev.eden.buildgraph

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.io.File

/** Shows build-graph's viewer in a tool window, reloading when the graph changes. */
class BuildGraphToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val outDir = File(project.basePath ?: ".", "target/build-graph")
        val browser = JBCefBrowser()
        Disposer.register(toolWindow.disposable, browser)

        fun render() {
            if (File(outDir, "graph.html").isFile) {
                val port = GraphServer.ensure(outDir)
                browser.loadURL("http://127.0.0.1:$port/graph.html?t=${System.currentTimeMillis()}")
            } else {
                browser.loadHTML(
                    "<html><body style='font-family:sans-serif;padding:1rem'>" +
                        "No graph yet — run <b>Tools → build-graph: Start Watch</b> " +
                        "(or <code>cargo build-graph watch --driver</code>).</body></html>",
                )
            }
        }
        render()

        // Live-reload the viewer whenever graph.json[.gz] is rewritten.
        val connection = project.messageBus.connect(toolWindow.disposable)
        connection.subscribe(
            com.intellij.openapi.vfs.VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: MutableList<out VFileEvent>) {
                    if (events.any { it.path.contains("/build-graph/graph.json") }) render()
                }
            },
        )
        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(outDir)

        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
        toolWindow.disposable.let { d: Disposable -> Disposer.register(d, browser) }
    }
}
