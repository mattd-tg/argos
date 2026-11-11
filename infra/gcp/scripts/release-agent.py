#!/usr/bin/env python3
"""Apply the Argos PoC release that deploy.mjs names in instance metadata."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

METADATA = "http://metadata.google.internal/computeMetadata/v1/instance"
HEADERS = {"Metadata-Flavor": "Google"}
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


def metadata(path: str, **params: str) -> tuple[str, str]:
    url = f"{METADATA}/{path}?{urllib.parse.urlencode(params)}"
    timeout = int(params.get("timeout_sec", "0")) + 30
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode(), response.headers.get("ETag", "0")


def report(state: str, **fields: Any) -> None:
    release = current_release()
    status = {
        "state": state,
        "current": str(release) if release else None,
        "pins": read_env(release / "release.env") if release else {},
        **fields,
    }
    request = urllib.request.Request(
        f"{METADATA}/guest-attributes/argos-poc/status",
        data=json.dumps(status).encode(),
        headers=HEADERS,
        method="PUT",
    )
    urllib.request.urlopen(request, timeout=30).close()


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
    etag = "0"
    while True:
        try:
            body, etag = metadata(
                "attributes/",
                recursive="true",
                wait_for_change="true",
                last_etag=etag,
                timeout_sec="300",
            )
            handle(json.loads(body).get("argos-poc-release"))
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(5)


if __name__ == "__main__":
    main()
