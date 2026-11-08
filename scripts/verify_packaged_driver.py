#!/usr/bin/env python3
"""Exercise the registry package, not a binary retaining its source checkout.

Requires Python 3.11+, Cargo and the driver's pinned nightly with rustc-dev.
An optional --target-dir reuses CLI build outputs. The installed driver's
content-addressed user cache is also retained for subsequent invocations.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    version = tomllib.loads((repo / "Cargo.toml").read_text())["package"]["version"]
    nightly = tomllib.loads(
        (repo / "driver-bundle/toolchain.toml").read_text()
    )["toolchain"]["channel"]
    env = os.environ.copy()
    for key in ("BUILD_GRAPH_DRIVER", "BUILD_GRAPH_DRIVER_SRC", "CARGO_TARGET_DIR"):
        env.pop(key, None)
    env.setdefault("CARGO_BUILD_JOBS", "2")

    def run(*cmd, cwd=repo, capture=False):
        return subprocess.run(
            list(map(str, cmd)), cwd=cwd, env=env, check=True,
            text=True, stdout=subprocess.PIPE if capture else None,
        ).stdout

    with tempfile.TemporaryDirectory(prefix="build-graph-package-") as tmp:
        root = Path(tmp)
        target = args.target_dir.resolve() if args.target_dir else root / "target"
        run("cargo", "package", "--locked", "--allow-dirty", "--no-verify",
            "--features", "rustc-driver", "--target-dir", target)
        archive_path = target / f"package/build-graph-{version}.crate"
        with tarfile.open(archive_path) as archive:
            bundled = [m for m in archive.getmembers() if "/driver-bundle/" in m.name]
            assert bundled and all(m.isfile() for m in bundled), "bundle missing or symlinked"
            archive.extractall(root / "unpacked", filter="data")
        source = root / f"unpacked/build-graph-{version}"
        assert not (source / "crates/bg-driver").exists(), "checkout would mask packaging bug"
        run("cargo", "install", "--path", source, "--root", root / "install",
            "--debug", "--locked", "--features", "rustc-driver", "--target-dir", target)
        shutil.rmtree(source)
        binary = root / "install/bin/cargo-build-graph"
        fixture = root / "fixture"
        (fixture / "src").mkdir(parents=True)
        (fixture / "Cargo.toml").write_text(
            '[package]\nname = "packaged-driver-probe"\nversion = "0.0.0"\nedition = "2021"\n'
        )
        (fixture / "src/lib.rs").write_text(
            "pub struct RequestGate;\nimpl RequestGate {\n"
            "    pub fn allows(&self) -> bool { true }\n}\n"
            "pub fn forwardable(gate: &RequestGate) -> bool {\n    gate.allows()\n}\n"
        )
        run(binary, "build", "--driver", "--nightly", nightly, cwd=fixture)
        result = json.loads(run(
            binary, "refs", "allows", "--relation", "calls", "--incoming", "--json",
            cwd=fixture, capture=True,
        ))
        assert any(edge["name"] == "forwardable" for edge in result["edges"]), result
        print(f"Packaged {version}: forwardable calls allows; no checkout or driver overrides.")


if __name__ == "__main__":
    main()
