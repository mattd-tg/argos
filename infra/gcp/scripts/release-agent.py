#!/usr/bin/env python3
"""Apply the Argos PoC release that the releases bucket's current.json names."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

BUCKET = "gs://twingate-playground-argos-poc-releases"
POINTER = f"{BUCKET}/current.json"
STATUS = f"{BUCKET}/status/agent.json"
POLL_SECONDS = 30
METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HOST_ATTRIBUTES = (
    "startup-script",
    "argos-poc-secret-loader",
    "argos-poc-systemd-unit",
    "argos-poc-prepare-unit",
    "argos-poc-release-agent",
    "argos-poc-agent-unit",
)
HOST_DIGEST = Path("/var/lib/argos-poc/host-metadata.sha256")
ROOT = Path("/srv/argos-poc")
RELEASES = ROOT / "releases"
CURRENT = ROOT / "current"
BACKUPS = ROOT / "backups"
FAILED = Path("/var/lib/argos-poc/failed-release.json")
LOAD_SECRETS = "/usr/local/lib/argos-poc/load-secrets.py"
RELEASE_ID = re.compile(r"^[0-9]+-[a-f0-9]+$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
IMAGE = re.compile(r"^sha256:[a-f0-9]{64}$")
OBJECT = re.compile(r"^gs://twingate-playground-argos-poc-releases/[a-z0-9-]+/[a-z0-9.-]+$")
RELEASE_FILES = {
    "compose.yaml",
    "compose.connector.yaml",
    "gateway.yaml",
    "nginx/api.conf",
    "nginx/app.conf",
    "images.env",
    "release.env",
}


def host_metadata_digest() -> str:
    digest = hashlib.sha256()
    for name in HOST_ATTRIBUTES:
        request = urllib.request.Request(
            f"{METADATA}/{name}", headers={"Metadata-Flavor": "Google"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            digest.update(name.encode() + b"\0" + response.read() + b"\0")
    return digest.hexdigest()


def refresh_host() -> None:
    digest = host_metadata_digest()
    if not HOST_DIGEST.exists():
        # The startup script that installed this agent just ran on this metadata.
        HOST_DIGEST.write_text(digest)
        return
    if HOST_DIGEST.read_text() == digest:
        return
    # Recorded first: the startup script ends by restarting this agent, which
    # would otherwise re-run it forever.
    HOST_DIGEST.write_text(digest)
    print("release agent: host metadata changed; re-running the startup script", flush=True)
    run(["google_metadata_script_runner", "startup"])


def read_pointer() -> str | None:
    result = subprocess.run(
        ["gcloud", "storage", "cat", POINTER], capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout
    if "matched no objects" in result.stderr:
        return None
    raise OSError(f"cannot read {POINTER}: {result.stderr.strip()[:500]}")


last_report = ""


def report(state: str, **fields: Any) -> None:
    global last_report
    release = current_release()
    status = json.dumps(
        {
            "state": state,
            "current": str(release) if release else None,
            "pins": read_env(release / "release.env") if release else {},
            **fields,
        }
    )
    if status == last_report:
        return
    subprocess.run(
        ["gcloud", "storage", "cp", "--quiet", "-", STATUS],
        input=status,
        text=True,
        check=True,
    )
    last_report = status


def current_release() -> Path | None:
    return CURRENT.resolve() if CURRENT.exists() else None


def read_env(path: Path) -> dict[str, str]:
    lines = path.read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if line)


def run(command: list[str], **options: Any) -> None:
    subprocess.run(command, check=True, **options)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(source: str, digest: str, destination: Path) -> None:
    if not OBJECT.match(source) or not SHA256.match(digest):
        raise ValueError("release object outside the releases bucket")
    run(["gcloud", "storage", "cp", "--quiet", source, str(destination)])
    if sha256(destination) != digest:
        raise ValueError(f"checksum mismatch for {source}")


def compose(release: Path) -> list[str]:
    path = str(release)
    return [
        "docker", "compose", "--project-name", "argos-poc",
        "--project-directory", path, "-f", f"{path}/compose.yaml",
        "--env-file", f"{path}/images.env", "--env-file", f"{path}/release.env",
        "--env-file", "/run/argos-poc/runtime.env",
        "--env-file", "/run/argos-poc/connector.env",
    ]


def verify_image(image: str) -> None:
    inspected = json.loads(
        subprocess.run(
            ["docker", "image", "inspect", image],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )[0]
    if (
        inspected["Id"] != image
        or inspected["Architecture"] != "amd64"
        or inspected["Os"] != "linux"
    ):
        raise ValueError("requested linux/amd64 image is not loaded unchanged")


def write_release(work: Path, release_id: str, files: dict[str, str]) -> Path:
    if set(files) != RELEASE_FILES:
        raise ValueError("manifest files differ from the release file set")
    staging = work / "release"
    for name, content in files.items():
        path = staging / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    # Gateway runs as 65532 and reads its configuration through a bind mount.
    (staging / "gateway.yaml").chmod(0o644)
    release = RELEASES / release_id
    staging.rename(release)
    return release


def backup_database(command: list[str], release_id: str) -> Path:
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    backup = BACKUPS / f"{release_id}.dump"
    partial = BACKUPS / f"{release_id}.dump.partial"
    dump = 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
    with partial.open("wb") as stream:
        run([*command, "exec", "-T", "postgres", "sh", "-c", dump], stdout=stream)
    with partial.open("rb") as stream:
        run(
            [*command, "exec", "-T", "postgres", "pg_restore", "--list"],
            stdin=stream,
            stdout=subprocess.DEVNULL,
        )
    partial.rename(backup)
    run(["sync", "-f", str(BACKUPS)])
    return backup


def apply(request: dict[str, Any]) -> Path:
    # The work directory sits on the data disk so the final rename stays on one filesystem.
    with tempfile.TemporaryDirectory(dir=RELEASES) as directory:
        work = Path(directory)
        download(request["manifest"], request["sha256"], work / "manifest.json")
        manifest = json.loads((work / "manifest.json").read_text())
        if manifest["id"] != request["id"] or not IMAGE.match(manifest["image"]):
            raise ValueError("manifest does not match the requested release")
        if str(current_release()) != manifest["from"]:
            raise ValueError("current release differs from the manifest's base")
        archive = manifest.get("archive")
        if archive:
            download(archive["object"], archive["sha256"], work / "image")
            run(["docker", "load", "-i", str(work / "image")], stdout=subprocess.DEVNULL)
        verify_image(manifest["image"])
        release = write_release(work, manifest["id"], manifest["files"])
    run([LOAD_SECRETS, "--release", str(release)])
    command = compose(release)
    run([*command, "stop", "web", "worker"])
    backup = backup_database(command, manifest["id"])
    run([*command, "--profile", "migrate", "run", "--rm", "-T", "migrate"])
    run([*command, "up", "-d", "--wait"])
    following = ROOT / "current.next"
    following.unlink(missing_ok=True)
    following.symlink_to(release)
    following.rename(CURRENT)
    run(["systemctl", "start", "argos-poc.service"])
    return backup


def handle(raw: str | None) -> None:
    if raw is None:
        report("idle")
        return
    request = json.loads(raw)
    release_id = request.get("id", "")
    if not RELEASE_ID.match(release_id):
        report("failed", id=release_id, error="invalid release id")
        return
    if current_release() == RELEASES / release_id:
        report("applied", id=release_id)
        return
    failed = json.loads(FAILED.read_text()) if FAILED.exists() else {}
    if failed.get("id") == release_id:
        report("failed", id=release_id, error=failed["error"])
        return
    report("applying", id=release_id)
    # A half-applied release is never resumed: deploy.mjs publishes a new one.
    try:
        backup = apply(request)
    except Exception as error:
        message = str(error)[:2000]
        FAILED.write_text(json.dumps({"id": release_id, "error": message}))
        report("failed", id=release_id, error=message)
        return
    report("applied", id=release_id, backup=str(backup))


def main() -> None:
    os.umask(0o077)
    while True:
        try:
            refresh_host()
            handle(read_pointer())
        except (OSError, subprocess.CalledProcessError) as error:
            print(f"release agent: {error}", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
