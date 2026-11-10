#!/usr/bin/env python3
"""Install one pinned Argos PoC release's Secret Manager material under /run."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

PROJECT_ID = "twingate-playground"
RUN_DIRECTORY = Path("/run/argos-poc")
RELEASE_ROOT = Path("/srv/argos-poc/releases")
VERSION_NAMES = {
    "RUNTIME_SECRET_VERSION": "argos-poc-runtime",
    "CONNECTOR_SECRET_VERSION": "argos-poc-connector",
    "TLS_SECRET_VERSION": "argos-poc-tls",
}
REQUIRED_RUNTIME_KEYS = {
    "NODE_ENV",
    "PORT",
    "DATABASE_URL",
    "REDIS_URL",
    "AMQP_URL",
    "AMQP_QUEUE_PREFIX",
    "SERVER_URL",
    "API_BASE_URL",
    "SESSION_DOMAIN",
    "WEBAUTHN_RP_ID",
    "ASSETS_BASE_URL",
    "S3_PUBLIC_IMAGE_BASE_URL",
    "AWS_SCREENSHOTS_BUCKET",
    "S3_REGION",
    "AWS_ENDPOINT_URL_S3",
    "S3_FORCE_PATH_STYLE",
    "AWS_REQUEST_CHECKSUM_CALCULATION",
    "AWS_EC2_METADATA_DISABLED",
    "NODE_EXTRA_CA_CERTS",
    "TRACK_NPM_PACKAGE_VERSIONS",
    "TWINGATE_GATEWAY_ENABLED",
    "WILDCARD_DOMAINS",
    "EMAIL_ENABLED",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
    "RABBITMQ_DEFAULT_USER",
    "RABBITMQ_DEFAULT_PASS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "ENCRYPTION_KEY",
    "SERVER_SESSION_SECRET",
}
EMPTY_ALLOWED_RUNTIME_KEYS = {
    "SESSION_DOMAIN",
    "ASSETS_BASE_URL",
    "S3_PUBLIC_IMAGE_BASE_URL",
    "WILDCARD_DOMAINS",
}

ENVIRONMENT_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PINNED_VERSION = re.compile(r"^[1-9][0-9]*$")


class LoaderError(RuntimeError):
    pass


def read_release_environment(release: Path) -> dict[str, str]:
    path = release / "release.env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise LoaderError("release.env is unavailable") from error

    values: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not ENVIRONMENT_KEY.fullmatch(key):
            raise LoaderError("release.env has an invalid entry")
        if "\x00" in value:
            raise LoaderError("release.env has an invalid value")
        values[key] = value
    return values


def access_secret(name: str, version: str) -> Any:
    environment = os.environ.copy()
    environment["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"
    environment["CLOUDSDK_CORE_LOG_HTTP"] = "False"
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            version,
            f"--secret={name}",
            f"--project={PROJECT_ID}",
            "--quiet",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        raise LoaderError(f"could not access required secret {name}")
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise LoaderError(f"secret {name} is not valid JSON") from error


def require_string_map(
    value: Any, name: str, required: set[str], allow_empty: set[str] | None = None
) -> dict[str, str]:
    if not isinstance(value, dict) or not required.issubset(value):
        raise LoaderError(f"secret {name} has missing required fields")
    result: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not ENVIRONMENT_KEY.fullmatch(key):
            raise LoaderError(f"secret {name} has an invalid environment key")
        if not isinstance(item, str) or "\x00" in item or "\n" in item or "\r" in item:
            raise LoaderError(f"secret {name} has an invalid environment value")
        result[key] = item
    allowed_empty = allow_empty or set()
    if any(not result[key] for key in required - allowed_empty):
        raise LoaderError(f"secret {name} has an empty required value")
    return result


def require_tls(value: Any) -> dict[str, str]:
    required = {"rootCert", "proxyCert", "proxyKey", "gatewayCert", "gatewayKey"}
    if not isinstance(value, dict) or set(value) != required:
        raise LoaderError("secret argos-poc-tls has unexpected fields")
    result: dict[str, str] = {}
    for key in required:
        item = value[key]
        if not isinstance(item, str) or not item.strip():
            raise LoaderError("secret argos-poc-tls has invalid certificate material")
        result[key] = item
    return result


def env_content(values: dict[str, str]) -> bytes:
    lines = []
    for key in sorted(values):
        value = values[key].replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$")
        lines.append(f'{key}="{value}"\n')
    return "".join(lines).encode("utf-8")


def write_file(directory: Path, name: str, content: bytes, mode: int, uid: int = 0, gid: int = 0) -> None:
    destination = directory / name
    temporary = directory / f".{name}.new"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
    finally:
        os.close(descriptor)
    os.replace(temporary, destination)


def resolve_release(value: str) -> Path:
    release = Path(value).resolve(strict=True)
    release_root = RELEASE_ROOT.resolve(strict=True)
    if not release.is_dir() or release.parent != release_root:
        raise LoaderError("release must be an installed Argos PoC release")
    return release


def main() -> int:
    parser = argparse.ArgumentParser(description="load a pinned Argos PoC release's secrets")
    parser.add_argument("--release", required=True)
    args = parser.parse_args()

    if os.geteuid() != 0:
        raise LoaderError("secret loader must run as root")
    release = resolve_release(args.release)
    release_environment = read_release_environment(release)

    versions: dict[str, str] = {}
    for environment_name in VERSION_NAMES:
        version = release_environment.get(environment_name, "")
        if not PINNED_VERSION.fullmatch(version):
            raise LoaderError(f"release.env must pin {environment_name}")
        versions[environment_name] = version

    connector = require_string_map(
        access_secret(VERSION_NAMES["CONNECTOR_SECRET_VERSION"], versions["CONNECTOR_SECRET_VERSION"]),
        "argos-poc-connector",
        {"TWINGATE_ACCESS_TOKEN", "TWINGATE_REFRESH_TOKEN"},
    )
    runtime = require_string_map(
        access_secret(VERSION_NAMES["RUNTIME_SECRET_VERSION"], versions["RUNTIME_SECRET_VERSION"]),
        "argos-poc-runtime",
        REQUIRED_RUNTIME_KEYS,
        EMPTY_ALLOWED_RUNTIME_KEYS,
    )
    expected_gateway = {
        "TWINGATE_GATEWAY_ENABLED": "true",
        "TWINGATE_TENANT_HOST": "argospoc.us2.dev.opstg.com",
        "TWINGATE_GATEWAY_AUDIENCE": "argospoc",
        "TWINGATE_GATEWAY_JWKS_URL": "https://argospoc.us2.dev.opstg.com/api/v1/jwk/ec",
        "TWINGATE_GATEWAY_RESOURCE_ADDRESS": "app.argos-poc.internal",
        "TWINGATE_GATEWAY_ENTRY_GROUP": "argos-poc-admins",
    }
    if any(runtime.get(key) != value for key, value in expected_gateway.items()):
        raise LoaderError("runtime must retain the owned Gateway identity boundary")
    tls = require_tls(access_secret(VERSION_NAMES["TLS_SECRET_VERSION"], versions["TLS_SECRET_VERSION"]))
    expected_storage = {
        "AWS_ENDPOINT_URL_S3": "https://storage.googleapis.com",
        "AWS_SCREENSHOTS_BUCKET": "twingate-playground-argos-poc-screenshots",
        "S3_FORCE_PATH_STYLE": "false",
        "S3_REGION": "auto",
        "AWS_REQUEST_CHECKSUM_CALCULATION": "WHEN_REQUIRED",
        "S3_PUBLIC_IMAGE_BASE_URL": "",
    }
    if any(runtime.get(key) != value for key, value in expected_storage.items()):
        raise LoaderError("runtime must target the owned GCS bucket")

    RUN_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(RUN_DIRECTORY, 0, 0)
    os.chmod(RUN_DIRECTORY, 0o700)
    write_file(
        RUN_DIRECTORY,
        "connector.env",
        env_content({
            "TWINGATE_ACCESS_TOKEN": connector["TWINGATE_ACCESS_TOKEN"],
            "TWINGATE_REFRESH_TOKEN": connector["TWINGATE_REFRESH_TOKEN"],
        }),
        0o600,
    )
    write_file(RUN_DIRECTORY, "runtime.env", env_content(runtime), 0o600)
    write_file(RUN_DIRECTORY, "root.crt", tls["rootCert"].encode("utf-8"), 0o644)
    write_file(RUN_DIRECTORY, "proxy.crt", tls["proxyCert"].encode("utf-8"), 0o644)
    write_file(RUN_DIRECTORY, "proxy.key", tls["proxyKey"].encode("utf-8"), 0o600)
    write_file(RUN_DIRECTORY, "gateway.crt", tls["gatewayCert"].encode("utf-8"), 0o644)
    write_file(RUN_DIRECTORY, "gateway.key", tls["gatewayKey"].encode("utf-8"), 0o400, 65532, 65532)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LoaderError as error:
        print(f"argos-poc secret loader: {error}", file=sys.stderr)
        raise SystemExit(1)
