#!/usr/bin/env bash
set -euo pipefail

readonly DATA_DEVICE="/dev/disk/by-id/google-argos-poc-data"
readonly DATA_MOUNT="/srv/argos-poc"
readonly METADATA_BASE="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
readonly LIBRARY_DIRECTORY="/usr/local/lib/argos-poc"

fail() {
  printf 'argos-poc host initialization: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "must run as root"
# GCE runs this startup script on every boot; an upgrade would restart dockerd under the running stack.
if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg python3

  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod 0644 /etc/apt/keyrings/docker.gpg
  source /etc/os-release
  printf '%s\n' \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  curl --fail --silent --show-error --location https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor --yes -o /etc/apt/keyrings/google-cloud.gpg
  chmod 0644 /etc/apt/keyrings/google-cloud.gpg
  printf '%s\n' \
    "deb [signed-by=/etc/apt/keyrings/google-cloud.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update
  apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin google-cloud-cli
  apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker.service
fi

for _ in $(seq 1 60); do
  [ -b "$DATA_DEVICE" ] && break
  sleep 1
done
[ -b "$DATA_DEVICE" ] || fail "managed data disk did not attach within 60 seconds"

set +e
probe="$(blkid -p -o export "$DATA_DEVICE" 2>/dev/null)"
blkid_status=$?
set -e
case "$blkid_status" in
  0)
    filesystem_type="$(printf '%s\n' "$probe" | grep '^TYPE=' | cut -d= -f2-)"
    [ -n "$filesystem_type" ] || fail "managed data disk has an unrecognized signature"
    ;;
  2)
    [ -z "$probe" ] || fail "managed data disk returned an ambiguous blkid probe"
    mkfs.ext4 -F "$DATA_DEVICE"
    filesystem_type=ext4
    ;;
  *) fail "blkid could not inspect the managed data disk" ;;
esac
uuid="$(blkid -s UUID -o value "$DATA_DEVICE")"
[ -n "$uuid" ] || fail "managed data disk has no filesystem UUID"
install -d -m 0700 "$DATA_MOUNT"
fstab_entry="UUID=${uuid} ${DATA_MOUNT} ${filesystem_type} defaults,nofail 0 2"
if grep -Eq '^[^#].*[[:space:]]/srv/argos-poc[[:space:]]' /etc/fstab; then
  grep -Fqx "$fstab_entry" /etc/fstab || fail "an unexpected fstab entry already owns ${DATA_MOUNT}"
else
  printf '%s\n' "$fstab_entry" >> /etc/fstab
fi
if ! mountpoint -q "$DATA_MOUNT"; then
  mount "$DATA_MOUNT"
fi
chmod 0700 "$DATA_MOUNT"
install -d -m 0700 \
  "$DATA_MOUNT/releases" \
  "$DATA_MOUNT/data" \
  "$DATA_MOUNT/data/postgres" \
  "$DATA_MOUNT/data/redis" \
  "$DATA_MOUNT/data/rabbitmq"

fetch_metadata_file() {
  local attribute="$1"
  local destination="$2"
  local temporary
  temporary="$(mktemp "${destination}.XXXXXX")"
  trap 'rm -f "$temporary"' RETURN
  curl --fail --silent --show-error --retry 3 \
    -H 'Metadata-Flavor: Google' \
    "${METADATA_BASE}/${attribute}" \
    | base64 --decode > "$temporary"
  install -o root -g root -m "$3" "$temporary" "$destination"
  rm -f "$temporary"
  trap - RETURN
}

install -d -o root -g root -m 0755 "$LIBRARY_DIRECTORY"
fetch_metadata_file argos-poc-secret-loader "$LIBRARY_DIRECTORY/load-secrets.py" 0755
fetch_metadata_file argos-poc-systemd-unit /etc/systemd/system/argos-poc.service 0644
fetch_metadata_file argos-poc-prepare-unit /etc/systemd/system/argos-poc-prepare.service 0644
install -d -m 0755 /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/argos-poc.conf <<'DOCKER_PREPARE'
[Unit]
Requires=argos-poc-prepare.service
After=argos-poc-prepare.service
DOCKER_PREPARE

cat > "$LIBRARY_DIRECTORY/run-release.sh" <<'RUN_RELEASE'
#!/usr/bin/env bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export CLOUDSDK_CORE_LOG_HTTP=False

readonly ROOT=/srv/argos-poc
readonly CURRENT="$ROOT/current"

fail() {
  printf 'argos-poc release: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -eq 3 ] && [ "$1" = --release ]; then
  release="$(readlink -f "$2")"
  action="$3"
elif [ "$#" -eq 1 ]; then
  [ -L "$CURRENT" ] || fail "no installed release"
  release="$(readlink -f "$CURRENT")"
  action="$1"
else
  fail "usage: run-release.sh [--release <installed-release>] start|stop"
fi

[ "$(dirname "$release")" = "$ROOT/releases" ] || fail "release is not an installed Argos PoC release"
install -d -o root -g root -m 0700 /run/argos-poc
exec 9>/run/argos-poc/release.lock
flock -n 9 || fail "another release operation is already running"
if [ "$action" = start ] && [ -e "$ROOT/cutover-in-progress" ] && [ "${ARGOS_POC_CUTOVER:-0}" != 1 ]; then
  fail "an operator cutover is in progress"
fi
[ -f "$release/release.env" ] || fail "release.env is absent"
[ -f "$release/images.env" ] || fail "images.env is absent"

compose=(docker compose --project-name argos-poc --project-directory "$release" \
  --env-file "$release/images.env" --env-file "$release/release.env" \
  --env-file /run/argos-poc/connector.env --env-file /run/argos-poc/runtime.env \
  -f "$release/compose.yaml")

case "$action" in
  start)
    /usr/local/lib/argos-poc/load-secrets.py --release "$release"
    python3 - "$release" "${ARGOS_POC_CUTOVER:-0}" <<'VERIFY_INFRA'
import hashlib
import json
from pathlib import Path
import subprocess
import sys

release = Path(sys.argv[1])
cutover = sys.argv[2] == "1"

def command(args):
    result = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return result.stdout

try:
    expected = json.loads((release / "infrastructure-hashes.json").read_text())
    compose = [
        "docker", "compose", "--project-name", "argos-poc", "--project-directory", str(release),
        "--env-file", str(release / "images.env"), "--env-file", str(release / "release.env"),
        "--env-file", "/run/argos-poc/connector.env", "--env-file", "/run/argos-poc/runtime.env",
        "-f", str(release / "compose.yaml"),
    ]
    model = json.loads(command(compose + ["config", "--format", "json"]))
    hashes = dict(line.split() for line in command(compose + ["config", "--hash", "*"]).splitlines())
    names = ["postgres", "redis", "rabbitmq", "connector", "gateway", "app-proxy", "api-proxy"]
    if sorted(item["name"] for item in expected["services"]) != sorted(names):
        raise ValueError("infrastructure inventory")
    containers = json.loads(command(["docker", "inspect"] + ["argos-poc-" + name + "-1" for name in names]))
    by_name = dict(zip(names, containers))
    networks = {}
    for item in expected["services"]:
        name = item["name"]
        container = by_name[name]
        service = model["services"][name]
        if (
            container["Id"] != item["id"]
            or container["Config"]["Image"] != item["image"]
            or service["image"] != item["image"]
            or container["Config"]["Labels"]["com.docker.compose.config-hash"] != item["configHash"]
            or hashes[name] != item["configHash"]
            or container["HostConfig"].get("PortBindings")
        ):
            raise ValueError("infrastructure configuration")
        if name in {"app-proxy", "api-proxy"} and container["HostConfig"]["RestartPolicy"]["Name"] != ("no" if cutover else "unless-stopped"):
            raise ValueError("ingress restart policy")
        desired_networks = {
            model["networks"][key]["name"]: value for key, value in service["networks"].items()
        }
        if set(container["NetworkSettings"]["Networks"]) != set(desired_networks):
            raise ValueError("container networks")
        for network_name, connection in desired_networks.items():
            network = model["networks"][next(
                key for key in service["networks"] if model["networks"][key]["name"] == network_name
            )]
            networks[network_name] = network
            if connection and connection.get("ipv4_address"):
                attachment = container["NetworkSettings"]["Networks"][network_name]
                if attachment.get("IPAMConfig", {}).get("IPv4Address") != connection["ipv4_address"]:
                    raise ValueError("configured container address")
                if container["State"]["Running"] and attachment["IPAddress"] != connection["ipv4_address"]:
                    raise ValueError("static container address")
        for volume in service.get("volumes", []):
            if volume["type"] != "bind":
                raise ValueError("unexpected volume")
            matches = [mount for mount in container["Mounts"] if mount["Destination"] == volume["target"]]
            if len(matches) != 1 or matches[0]["Source"] != volume["source"] or matches[0]["RW"] == volume.get("read_only", False):
                raise ValueError("infrastructure mount")
    for name, desired in networks.items():
        observed = json.loads(command(["docker", "network", "inspect", name]))[0]
        subnets = [item["subnet"] for item in desired.get("ipam", {}).get("config", [])]
        if (
            observed["Driver"] != desired.get("driver", "bridge")
            or observed["Internal"] != desired.get("internal", False)
            or [item["Subnet"] for item in observed["IPAM"]["Config"]] != subnets
        ):
            raise ValueError("network configuration")
    for item in expected["proxyMounts"]:
        container = by_name[item["name"]]
        mount = next(mount for mount in container["Mounts"] if mount["Destination"] == item["target"])
        if mount["Source"] != item["source"] or mount["RW"] or hashlib.sha256(Path(item["source"]).read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("proxy configuration")
    if cutover:
        marker = json.loads(Path("/srv/argos-poc/cutover-in-progress").read_text())
        if marker["candidateRelease"] != str(release):
            raise ValueError("cutover ownership")
        override = json.loads((release / "cutover.compose.yaml").read_text())
        if override != {"services": {"web": {"restart": "no"}, "worker": {"restart": "no"}}}:
            raise ValueError("cutover override")
        for name in names:
            state = by_name[name]["State"]
            if name in {"app-proxy", "api-proxy"}:
                if state["Running"]:
                    raise ValueError("ingress is not closed")
            elif not state["Running"] or state.get("Health", {}).get("Status", "healthy") != "healthy":
                raise ValueError("dependency is not healthy")
    else:
        applications = json.loads(command(["docker", "inspect", "argos-poc-web-1", "argos-poc-worker-1"]))
        for name, container in zip(["web", "worker"], applications):
            service = model["services"][name]
            environment = dict(value.split("=", 1) for value in container["Config"]["Env"])
            if (
                container["Config"]["Image"] != service["image"]
                or container["HostConfig"].get("PortBindings")
                or container["HostConfig"]["RestartPolicy"]["Name"] != "unless-stopped"
                or any(environment.get(key) != str(value) for key, value in service.get("environment", {}).items())
            ):
                raise ValueError("application image, ports, restart policy or runtime")
except Exception:
    print("argos-poc release: infrastructure/runtime drift guard failed; details withheld", file=sys.stderr)
    raise SystemExit(1)
VERIFY_INFRA
    if [ "${ARGOS_POC_CUTOVER:-0}" = 1 ]; then
      "${compose[@]}" -f "$release/cutover.compose.yaml" up -d --no-deps --wait web worker
    else
      "${compose[@]}" up -d --no-recreate --wait postgres redis rabbitmq connector gateway
      "${compose[@]}" up -d --no-recreate --wait web worker
      "${compose[@]}" up -d --no-recreate --wait app-proxy api-proxy
    fi
    ;;
  stop)
    "${compose[@]}" stop web worker app-proxy api-proxy gateway connector rabbitmq redis postgres
    ;;
  *) fail "usage: run-release.sh [--release <installed-release>] start|stop" ;;
esac
RUN_RELEASE
chmod 0755 "$LIBRARY_DIRECTORY/run-release.sh"

systemctl daemon-reload
systemctl enable argos-poc.service
if [ -f /srv/argos-poc/current/release.env ]; then
  systemctl start argos-poc.service
fi
install -d -m 0700 /var/lib/argos-poc
touch /var/lib/argos-poc/initialized
