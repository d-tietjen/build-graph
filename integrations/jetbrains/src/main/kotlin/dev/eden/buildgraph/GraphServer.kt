package dev.eden.buildgraph

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress

/**
 * A tiny static file server for the build-graph output dir, so the JCEF browser
 * can load `graph.html` (which fetches `graph.json[.gz]` from the same origin).
 * `.gz` is served raw — the viewer decompresses it itself via DecompressionStream.
 */
object GraphServer {
    private var server: HttpServer? = null
    var port: Int = 0
        private set

    @Synchronized
    fun ensure(dir: File): Int {
        server?.let { return port }
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/") { ex ->
            val rel = ex.requestURI.path.let { if (it == "/") "/graph.html" else it }
            val file = File(dir, rel.trimStart('/'))
            if (!file.canonicalPath.startsWith(dir.canonicalPath) || !file.isFile) {
                ex.sendResponseHeaders(404, -1); ex.close(); return@createContext
            }
            val ct = when (file.extension) {
                "html" -> "text/html; charset=utf-8"
                "js" -> "text/javascript"
                "json" -> "application/json"
                else -> "application/octet-stream"
            }
            val bytes = file.readBytes()
            ex.responseHeaders.add("Content-Type", ct)
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        s.executor = null
        s.start()
        server = s
        port = s.address.port
        return port
    }
}
