package dev.eden.buildgraph

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress

/**
 * A tiny static server for the build-graph output dir, so the system browser can
 * load the bundled viewer. Serves the files as-is (`.gz` raw — the viewer
 * inflates it itself) plus two helpers:
 *
 *  - `GET /live`   — an auto-reloading wrapper page that polls `/mtime` and
 *                    reloads `graph.html` whenever the graph is rewritten on save.
 *  - `GET /mtime`  — the graph data file's mtime (404 until the first build).
 */
object GraphServer {
    private var server: HttpServer? = null
    private var servedDir: File? = null
    var port: Int = 0
        private set

    @Synchronized
    fun ensure(dir: File): Int {
        if (server != null && servedDir == dir) return port
        server?.stop(0)
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/") { ex ->
            try {
                when (ex.requestURI.path) {
                    "/mtime" -> {
                        val data = graphData(dir)
                        if (data == null) {
                            ex.sendResponseHeaders(404, -1)
                        } else {
                            ex.responseHeaders.add("Cache-Control", "no-store")
                            respond(ex, data.lastModified().toString().toByteArray(), "text/plain")
                        }
                    }
                    "/live", "/live.html" -> respond(ex, LIVE_HTML.toByteArray(), "text/html; charset=utf-8")
                    else -> {
                        val rel = ex.requestURI.path.let { if (it == "/") "/graph.html" else it }
                        val file = File(dir, rel.trimStart('/'))
                        if (!file.canonicalPath.startsWith(dir.canonicalPath) || !file.isFile) {
                            ex.sendResponseHeaders(404, -1)
                        } else {
                            respond(ex, file.readBytes(), contentType(file.extension))
                        }
                    }
                }
            } finally {
                ex.close()
            }
        }
        s.start()
        server = s
        servedDir = dir
        port = s.address.port
        return port
    }

    private fun respond(ex: HttpExchange, bytes: ByteArray, contentType: String) {
        ex.responseHeaders.add("Content-Type", contentType)
        ex.sendResponseHeaders(200, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    private fun graphData(dir: File): File? =
        listOf("graph.json.gz", "graph.json").map { File(dir, it) }.firstOrNull { it.isFile }

    private fun contentType(ext: String): String = when (ext) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "text/javascript"
        "json" -> "application/json"
        else -> "application/octet-stream"
    }

    private val LIVE_HTML = """
        <!doctype html><meta charset="utf-8"><title>build-graph</title>
        <style>html,body,iframe{margin:0;border:0;width:100%;height:100vh}
        #m{font-family:sans-serif;padding:1rem;color:#888}</style>
        <div id="m">Building the graph…</div>
        <iframe id="g" style="display:none"></iframe>
        <script>
        var last=null;
        function poll(){
          fetch('mtime',{cache:'no-store'}).then(function(r){return r.ok?r.text():null;}).then(function(t){
            if(t){ t=t.trim();
              if(t!==last){ last=t;
                var g=document.getElementById('g');
                g.src='graph.html?t='+encodeURIComponent(t);
                g.style.display='block';
                document.getElementById('m').style.display='none';
              }
            }
          }).catch(function(){}).finally(function(){ setTimeout(poll,1000); });
        }
        poll();
        </script>
    """.trimIndent()
}
