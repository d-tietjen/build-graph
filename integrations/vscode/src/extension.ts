import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as os from "os";

// One watcher process, one static server, one webview panel, one status item.
let watcher: cp.ChildProcess | undefined;
let server: http.Server | undefined;
let serverPort = 0;
let panel: vscode.WebviewPanel | undefined;
let fsWatcher: fs.FSWatcher | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  // .gz is served RAW (no Content-Encoding) — the viewer inflates it itself.
  ".gz": "application/octet-stream",
};

const cfg = () => vscode.workspace.getConfiguration("buildGraph");
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const isCargo = () => {
  const r = root();
  return !!r && fs.existsSync(path.join(r, "Cargo.toml"));
};

function outDir(): string {
  const rel = cfg().get<string>("outDir", "target/build-graph");
  return path.isAbsolute(rel) ? rel : path.join(root() ?? ".", rel);
}

function argv(sub: string): string[] {
  const base = cfg().get<string>("command", "cargo build-graph").split(/\s+/).filter(Boolean);
  const refs = cfg().get<string>("references", "driver");
  const refFlag = refs === "driver" ? ["--driver"] : refs === "rust-analyzer" ? ["--references"] : [];
  return [...base, sub, ...refFlag, "--out", outDir(), ...cfg().get<string[]>("extraArgs", [])];
}

// Put ~/.cargo/bin on PATH so `cargo build-graph` resolves even when VS Code was
// launched from the Dock/Finder without the login-shell PATH.
function spawnEnv(): NodeJS.ProcessEnv {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  return { ...process.env, PATH: cargoBin + path.delimiter + (process.env.PATH || "") };
}

function spawn(sub: string, onExit?: () => void): cp.ChildProcess | undefined {
  const cwd = root();
  if (!cwd) {
    vscode.window.showErrorMessage("build-graph: open a folder first.");
    return undefined;
  }
  const a = argv(sub);
  output.appendLine("$ " + a.join(" "));
  const p = cp.spawn(a[0], a.slice(1), { cwd, env: spawnEnv() });
  p.stdout?.on("data", (d) => output.append(d.toString()));
  p.stderr?.on("data", (d) => output.append(d.toString()));
  p.on("error", (e) => output.appendLine("error: " + e.message));
  p.on("exit", (c) => {
    output.appendLine(`(exited ${c})`);
    onExit?.();
  });
  return p;
}

const isWatching = () => !!watcher && watcher.exitCode === null;

function startWatch() {
  if (isWatching()) return;
  watcher = spawn("watch", () => {
    watcher = undefined;
    updateStatus();
  });
  updateStatus();
}

function stopWatch() {
  watcher?.kill();
  watcher = undefined;
  updateStatus();
}

function rebuild() {
  spawn("build"); // one-shot; the open panel reloads when the graph changes
}

function updateStatus() {
  status.text = isWatching() ? "$(graph) build-graph $(sync~spin)" : "$(graph) build-graph";
  status.tooltip = isWatching() ? "Watching — click to open the graph" : "Open the architecture graph";
  status.command = "buildGraph.show";
  status.show();
}

// ---- static server + webview (in-editor graph) ----
async function ensureServer(dir: string): Promise<number> {
  if (server) return serverPort;
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(dir, rel === "/" ? "graph.html" : rel);
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
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh;background:#0e1116}</style></head>
<body><iframe id="g" src="${src}?t=${Date.now()}"></iframe>
<script nonce="${nonce}">
  const f = document.getElementById('g');
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'reload') f.src = 'http://127.0.0.1:${port}/graph.html?t=' + Date.now();
  });
</script></body></html>`;
}

const nonce = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

async function showGraph() {
  const dir = outDir();
  if (!fs.existsSync(path.join(dir, "graph.html"))) {
    const pick = await vscode.window.showWarningMessage(
      `No graph at ${dir} yet.`,
      "Start Auto Build",
    );
    if (pick === "Start Auto Build") startWatch();
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
      fsWatcher?.close();
      fsWatcher = undefined;
    });
    fsWatcher = fs.watch(dir, (_e, name) => {
      if (name && name.startsWith("graph.json")) panel?.webview.postMessage({ type: "reload" });
    });
  }
  panel.webview.html = webviewHtml(port, nonce());
  panel.reveal();
}

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("build-graph");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  ctx.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand("buildGraph.show", showGraph),
    vscode.commands.registerCommand("buildGraph.rebuild", rebuild),
    vscode.commands.registerCommand("buildGraph.toggle", () => (isWatching() ? stopWatch() : startWatch())),
  );
  updateStatus();
  // Auto-start the watcher when a Cargo workspace opens.
  if (cfg().get<boolean>("autoStart", true) && isCargo()) startWatch();
}

export function deactivate() {
  stopWatch();
  fsWatcher?.close();
  server?.close();
}
