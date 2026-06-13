#!/usr/bin/env python3
"""Render the generated build-graph section of ARCHITECTURE.md.

The output is deterministic: no timestamps, run IDs, or host paths unless they
are already in the graph. That keeps scheduled GitHub Action runs from opening
PRs when the code shape did not change.
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path


START = "<!-- build-graph:architecture:start -->"
END = "<!-- build-graph:architecture:end -->"


def read_graph(path: Path) -> dict:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b" or path.suffix == ".gz":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def find_graph(graph_dir: Path) -> Path:
    gz = graph_dir / "graph.json.gz"
    if gz.exists():
        return gz
    plain = graph_dir / "graph.json"
    if plain.exists():
        return plain
    raise SystemExit(f"no graph.json[.gz] found in {graph_dir}")


def rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def attr(node: dict, key: str, default: str = "") -> str:
    return node.get("attributes", {}).get(key, default)


def esc(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def source_of(node: dict) -> str:
    src = node.get("source_file") or ""
    line = node.get("source_location")
    if src and line:
        return f"{src}:{line}"
    return src


def top_items(counter: Counter[str], limit: int) -> list[tuple[str, int]]:
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]


def render_block(graph: dict, graph_path: Path, architecture_path: Path, limit: int) -> str:
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    by_id = {n.get("id"): n for n in nodes}

    kinds = Counter(attr(n, "kind", "?") for n in nodes)
    rels = Counter(e.get("relation", "?") for e in edges)

    crate_files: Counter[str] = Counter()
    crate_items: Counter[str] = Counter()
    for n in nodes:
        krate = attr(n, "crate", "")
        kind = attr(n, "kind", "?")
        if not krate:
            continue
        if kind == "file":
            crate_files[krate] += 1
        elif kind not in {"crate"}:
            crate_items[krate] += 1

    degree: Counter[str] = Counter()
    for e in edges:
        source = e.get("source")
        target = e.get("target")
        if source:
            degree[source] += 1
        if target:
            degree[target] += 1

    interesting = []
    for node_id, count in top_items(degree, limit * 3):
        node = by_id.get(node_id)
        if not node:
            continue
        kind = attr(node, "kind", "?")
        if kind in {"crate", "file", "module"}:
            continue
        interesting.append((node, count))
        if len(interesting) >= limit:
            break

    source_files = kinds.get("file", 0)
    crates = kinds.get("crate", 0)
    graph_dir = graph_path.parent
    graph_arg = rel(graph_dir, architecture_path.parent)

    out: list[str] = []
    out.append(START)
    out.append("## build-graph Snapshot")
    out.append("")
    out.append(
        "This section is generated from the compiler-derived build graph. "
        "Keep human-written architecture notes outside this block; the GitHub "
        "Action can safely replace this section."
    )
    out.append("")
    out.append("### Workspace Shape")
    out.append("")
    out.append(f"- Nodes: **{len(nodes)}**")
    out.append(f"- Edges: **{len(edges)}**")
    out.append(f"- Crates: **{crates}**")
    out.append(f"- Source files: **{source_files}**")
    out.append("")

    if crate_files or crate_items:
        out.append("### Crates")
        out.append("")
        out.append("| Crate | Source files | Graph items |")
        out.append("|---|---:|---:|")
        for krate in sorted(set(crate_files) | set(crate_items), key=lambda k: (-(crate_items[k] + crate_files[k]), k))[:limit]:
            out.append(f"| `{esc(krate)}` | {crate_files[krate]} | {crate_items[krate]} |")
        out.append("")

    out.append("### Node Kinds")
    out.append("")
    out.append(", ".join(f"`{esc(k)}` {v}" for k, v in top_items(kinds, limit)))
    out.append("")
    out.append("")

    if rels:
        out.append("### Edge Relations")
        out.append("")
        out.append(", ".join(f"`{esc(k)}` {v}" for k, v in top_items(rels, limit)))
        out.append("")
        out.append("")

    if interesting:
        out.append("### Highly Connected Symbols")
        out.append("")
        out.append("| Symbol | Kind | Crate | Connections | Source |")
        out.append("|---|---|---|---:|---|")
        for node, count in interesting:
            out.append(
                f"| `{esc(node.get('label', '?'))}` | `{esc(attr(node, 'kind', '?'))}` | "
                f"`{esc(attr(node, 'crate', ''))}` | {count} | `{esc(source_of(node))}` |"
            )
        out.append("")

    out.append("### Agent Usage")
    out.append("")
    out.append("- Read this file first for the current architecture map.")
    out.append("- Query exact symbol context with build-graph instead of guessing from text search:")
    out.append("")
    out.append("```bash")
    out.append(f"cargo build-graph find <symbol> --json --out {graph_arg}")
    out.append(f"cargo build-graph refs <symbol-or-id> --json --out {graph_arg}")
    out.append("```")
    out.append("")
    out.append(f"- Graph artifacts live in `{esc(rel(graph_dir, architecture_path.parent))}`.")
    out.append(f"- The dashboard is `{esc(rel(graph_dir / 'graph.html', architecture_path.parent))}`.")
    out.append(f"- The raw report is `{esc(rel(graph_dir / 'GRAPH_REPORT.md', architecture_path.parent))}`.")
    out.append(END)
    out.append("")
    return "\n".join(out)


def update_architecture(path: Path, block: str) -> None:
    if path.exists():
        existing = path.read_text()
    else:
        existing = (
            "# Architecture\n\n"
            "This document has a generated build-graph section plus any "
            "human-written notes you keep outside that generated block.\n\n"
        )

    if START in existing and END in existing:
        before = existing.split(START, 1)[0].rstrip()
        after = existing.split(END, 1)[1].lstrip()
        new = f"{before}\n\n{block}{after}"
    else:
        new = existing.rstrip() + "\n\n" + block

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path)
    parser.add_argument("--graph-dir", type=Path, default=Path("target/build-graph"))
    parser.add_argument("--architecture", type=Path, default=Path("ARCHITECTURE.md"))
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()

    graph_path = args.graph or find_graph(args.graph_dir)
    architecture_path = args.architecture
    graph = read_graph(graph_path)
    block = render_block(graph, graph_path, architecture_path, max(1, args.limit))
    update_architecture(architecture_path, block)


if __name__ == "__main__":
    main()
