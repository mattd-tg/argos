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
fetch_metadata_file argos-poc-release-agent "$LIBRARY_DIRECTORY/release-agent.py" 0755
fetch_metadata_file argos-poc-agent-unit /etc/systemd/system/argos-poc-release-agent.service 0644
install -d -m 0755 /etc/systemd/system/docker.service.d
# Docker restarts the containers at boot. A missing /run/argos-poc bind source would be
# created as a directory, which the secret loader cannot then replace with the file.
cat >/etc/systemd/system/docker.service.d/argos-poc.conf <<'DOCKER_PREPARE'
[Unit]
Requires=argos-poc-prepare.service
After=argos-poc-prepare.service
DOCKER_PREPARE

cat > "$LIBRARY_DIRECTORY/run-release.sh" <<'RUN_RELEASE'
#!/usr/bin/env bash
set -euo pipefail

release="$(readlink -f /srv/argos-poc/current)"
compose=(docker compose --project-name argos-poc --project-directory "$release" \
  --env-file "$release/images.env" --env-file "$release/release.env" \
  --env-file /run/argos-poc/connector.env --env-file /run/argos-poc/runtime.env \
  -f "$release/compose.yaml")

case "${1:-}" in
  start)
    /usr/local/lib/argos-poc/load-secrets.py --release "$release"
    "${compose[@]}" up -d --wait
    ;;
  stop)
    "${compose[@]}" stop
    ;;
  *)
    printf 'usage: run-release.sh start|stop\n' >&2
    exit 1
    ;;
esac
RUN_RELEASE
chmod 0755 "$LIBRARY_DIRECTORY/run-release.sh"

systemctl daemon-reload
systemctl enable argos-poc.service argos-poc-release-agent.service
if [ -f /srv/argos-poc/current/release.env ]; then
  systemctl start argos-poc.service
fi
install -d -m 0700 /var/lib/argos-poc
touch /var/lib/argos-poc/initialized
# Restart so a re-run of this script picks up a new agent from metadata.
systemctl restart --no-block argos-poc-release-agent.service
