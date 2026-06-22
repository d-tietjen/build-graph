import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

// One static file server + one webview panel + one watch terminal, reused.
let server: http.Server | undefined;
let serverPort = 0;
let panel: vscode.WebviewPanel | undefined;
let watchTerminal: vscode.Terminal | undefined;
let fsWatcher: fs.FSWatcher | undefined;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  // .gz is served RAW (no Content-Encoding) — the viewer decompresses it itself
  // via DecompressionStream, so the browser must not pre-inflate it.
  ".gz": "application/octet-stream",
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function outDir(): string {
  const rel = vscode.workspace
    .getConfiguration("buildGraph")
    .get<string>("outDir", "target/build-graph");
  const root = workspaceRoot() ?? ".";
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

/** `[command, ...args]` for an invocation, with the references backend + extras. */
function commandLine(sub: string): string[] {
  const cfg = vscode.workspace.getConfiguration("buildGraph");
  const base = cfg.get<string>("command", "cargo build-graph").split(/\s+/).filter(Boolean);
  const refs = cfg.get<string>("references", "driver");
  const extra = cfg.get<string[]>("extraArgs", []);
  const refFlag = refs === "driver" ? ["--driver"] : refs === "rust-analyzer" ? ["--references"] : [];
  return [...base, sub, ...refFlag, "--out", outDir(), ...extra];
}

async function ensureServer(dir: string): Promise<number> {
  if (server) return serverPort;
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(dir, rel === "/" ? "graph.html" : rel);
    // Contain to the served dir.
    if (!path.resolve(file).startsWith(path.resolve(dir))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;
  return serverPort;
}

function webviewHtml(port: number, nonce: string): string {
  const src = `http://127.0.0.1:${port}/graph.html`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh;background:#fff}</style></head>
<body><iframe id="g" src="${src}?t=${Date.now()}"></iframe>
<script nonce="${nonce}">
  const f = document.getElementById('g');
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'reload')
      f.src = 'http://127.0.0.1:${port}/graph.html?t=' + Date.now();
  });
</script></body></html>`;
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

async function showGraph() {
  const dir = outDir();
  if (!fs.existsSync(path.join(dir, "graph.html"))) {
    const pick = await vscode.window.showWarningMessage(
      `No graph at ${dir}. Build it first?`,
      "Start Watch",
      "Cancel",
    );
    if (pick === "Start Watch") startWatch();
    return;
  }
  const port = await ensureServer(dir);
  if (!panel) {
    panel = vscode.window.createWebviewPanel("buildGraph", "build-graph", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    // Live-reload the frame whenever the graph data changes on disk.
    fsWatcher?.close();
    fsWatcher = fs.watch(dir, (_e, name) => {
      if (name && name.startsWith("graph.json")) panel?.webview.postMessage({ type: "reload" });
    });
    panel.onDidDispose(() => fsWatcher?.close());
  }
  panel.webview.html = webviewHtml(port, nonce());
  panel.reveal();
}

function startWatch() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage("build-graph: open a workspace folder first.");
    return;
  }
  watchTerminal?.dispose();
  watchTerminal = vscode.window.createTerminal({ name: "build-graph watch", cwd: root });
  watchTerminal.show();
  watchTerminal.sendText(commandLine("watch").join(" "));
  // Open the live view alongside (small delay so the first graph exists).
  setTimeout(showGraph, 4000);
}

function stopWatch() {
  watchTerminal?.dispose();
  watchTerminal = undefined;
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("buildGraph.show", showGraph),
    vscode.commands.registerCommand("buildGraph.watch", startWatch),
    vscode.commands.registerCommand("buildGraph.stopWatch", stopWatch),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === watchTerminal) watchTerminal = undefined;
    }),
  );
}

export function deactivate() {
  fsWatcher?.close();
  server?.close();
  watchTerminal?.dispose();
}
