# Private GCP Argos deployment

Argos runs in project `twingate-playground` (`417269620845`), in
`us-east4` / `us-east4-a`. Terraform owns the dedicated `argos-poc-network`
VPC, subnet, router/NAT, private VM, data disk, private storage, deployment
secrets, and Argos-specific Twingate resources.

## Identity and private access

- Twingate tenant/control plane: `https://argospoc.us2.dev.opstg.com`.
- Native Client network: `argospoc.dev.opstg.com`.
- Operator: `mattd@twingate.com`, tenant subject `VXNlcjo0NzE4`.
- Admission group: `argos-poc-admins`. Terraform keeps the operator in it;
  add and remove everyone else in the Admin Console.
- Human application: `https://app.argos-poc.internal`, Gateway-only.
- Bearer-authenticated API: `https://api.argos-poc.internal`.
- Signed screenshots:
  `https://twingate-playground-argos-poc-screenshots.storage.googleapis.com`.

The API proxy strips cookies and Gateway assertions. Only the dedicated group
is granted the app, API, and screenshot Resources. The VM has private address
`10.87.40.10`, no public IP, and no published container ports. Its only VPC
ingress rule permits IAP SSH to the runtime service account.

The administrative API key is referenced by `provision.env` as
`op://Employee/dvoowk5su2fks5fgfdbs42mece/credential`. Inject it with `op run`;
never put its value in source, Terraform variables, VM metadata, or images.
Provisioning does not switch the laptop's native Client. Browser acceptance
requires the operator to sign in to the dedicated tenant.

A group member's first visit to the app creates their Argos account as a team
contributor. Contributors see only projects with a default access level, and
new team projects default to Reviewer. Projects created before that default
existed have none: set theirs to Reviewer in the project's settings.

## Ownership and cleanup protection

Every GCP resource that supports labels receives:

```yaml
deployment: argos-poc
keep: "true"
owner: matt-demichele
```

These are **GCP labels, not GCP tags**. The plan validator checks the labels,
including the VM's separately created boot disk. Disks, buckets, and secrets
carry the same values.

VPC networks, subnetworks, routers/NAT, firewall rules, service accounts,
attachments, and IAM bindings do not support these GCP labels. They are
Argos-named and Terraform-owned; tags are not used as a substitute. Labels are
cleanup-policy inputs, not an IAM prohibition against deletion.

Operator state is under `~/.local/state/argos-poc`, directories `0700` and
files `0600`. Bootstrap state owns only the state bucket. Main state is stored
in that bucket under `terraform/`. `terraform-outputs.json` is a protected
export of actual main outputs, including Connector credentials.

`release.json`, `secret-versions.json`, and `deploy-intent.json` record the
active release and its VM, numeric secret pins, and any in-progress application
cutover. Do not import unrelated resources, use targeted/replacement plans, or
use an old manual inventory as proof of ownership. The plan validator rejects
deleting any disk, bucket, secret, or Twingate resource, and the wrapper has no
destroy command. Every apply lists the validated changes and waits for you to
type `apply <scope>` before it applies the saved plan.

## Storage boundary and operator access

The screenshot bucket has uniform bucket-level access, enforced public-access
prevention, versioning, seven-day soft delete, and exact application-origin
CORS. Its enabled IP filter permits only
`projects/twingate-playground/global/networks/argos-poc-network` from
`10.87.40.10/32`: no public ranges, cross-organization VPC access, or service-agent
bypass.

The signing service account has only bucket-scoped `roles/storage.objectUser`.
Its HMAC secret is created outside Terraform. The VM runtime identity can read
only the three deployment secrets; it has no bucket administration or filtering
bypass role. Signed URLs and POST policies remain bearer capabilities.

Filtered bucket metadata and IAM operations also reject the operator's laptop.
Run subsequent Terraform operations through a local IAP SSH SOCKS tunnel whose
outbound requests originate from the allowed VM:

```sh
gcloud compute ssh argos-poc --project=twingate-playground --zone=us-east4-a \
  --tunnel-through-iap --ssh-flag=-N --ssh-flag=-D \
  --ssh-flag=127.0.0.1:19080 --ssh-flag=-o \
  --ssh-flag=ExitOnForwardFailure=yes
```

In another terminal:

```sh
HTTPS_PROXY=socks5://127.0.0.1:19080 op run --env-file infra/gcp/provision.env -- \
  node infra/gcp/scripts/terraform.mjs main plan
```

The wrapper passes the proxy only to Terraform, not to its own gcloud/SSH
commands. Operator credentials stay on the laptop. Live runtime boundary checks
use a short-lived operator token over SSH stdin, never a persisted operator
login or a runtime-admin grant. Close the operator tunnel when finished.

## Fresh provisioning

Prerequisites: the pinned Terraform 1.12.1 through mise, gcloud with operator
and application-default credentials, Node/PNPM, Docker Compose CLI, and
1Password CLI. Do not install or switch these tools implicitly.

Only for a genuinely empty, approved installation:

```sh
op run --env-file infra/gcp/provision.env -- node infra/gcp/scripts/terraform.mjs bootstrap init
op run --env-file infra/gcp/provision.env -- node infra/gcp/scripts/terraform.mjs bootstrap apply
op run --env-file infra/gcp/provision.env -- node infra/gcp/scripts/terraform.mjs main init
op run --env-file infra/gcp/provision.env -- node infra/gcp/scripts/terraform.mjs main apply -var=storage_ip_filter_enabled=false
```

The first main apply creates an **empty IAM-private bucket** and private VM.
Do not create HMAC credentials, install Argos, or produce signed capabilities
yet. Wait for host initialization and the mounted data disk, start the operator
tunnel, then run the complete filtered apply:

```sh
HTTPS_PROXY=socks5://127.0.0.1:19080 op run --env-file infra/gcp/provision.env -- \
  node infra/gcp/scripts/terraform.mjs main apply
```

The wrapper refuses returning a filter-enabled installation to the unfiltered
bootstrap phase. Bucket-level permission checks use the owned bootstrap bucket;
project-level permission tests cannot see the bucket-scoped rights granted to
project Editors when a new bucket is created.

Create one HMAC key for the output storage service account and capture its
response without logging its secret. Store
`storage-hmac.private.json` in protected state with exactly `accessId`, `secret`,
and `serviceAccountEmail`. Initialization verifies the live bucket boundary
before creating fresh database, session, Connector, and TLS secret versions:

```sh
node infra/gcp/scripts/secrets.mjs initialize \
  --hmac-file "$HOME/.local/state/argos-poc/storage-hmac.private.json"
```

The private root stays on the operator machine. Trust its exact fingerprint in
the login keychain and register its public certificate with the tenant Gateway.
The root is limited to `argos-poc.internal` names and to no IP address, so
whoever trusts it trusts nothing else, even if its key leaks. The helpers refuse
a retained root without these limits. Leaves are valid for 30 days. The certificate helper renews local leaves when
fewer than seven days remain; it does not change the active TLS secret or
container mounts. Use the explicit TLS maintenance workflow below to publish and
activate renewed leaves. Root replacement requires separate trust and
Gateway-registration changes.

## Images and installation

Build the production Dockerfile for linux/amd64 without SaaS build credentials.
Infrastructure image digests are pinned in images.json and are read-only during
deployment. Keep application image archives under protected operator state.
Deployment checks the loaded immutable image ID and platform; archive transfers
also compare local and remote checksums before loading.

    node infra/gcp/scripts/deploy.mjs install \
      --image 'sha256:<loaded-image-id>' \
      --runtime-version '<numeric-initial-runtime-version>' \
      --archive "$HOME/.local/state/argos-poc/images/argos.tar.gz"

Omit --archive when the image is already loaded on the VM. Initial installation
runs migrations, creates an administrator/team/private project, maps the
configured Twingate operator, and enables team/project enrollment. Subsequent
updates do not reconcile or reset application accounts. Manage projects and CI
tokens through the normal application UI.

Email is disabled and no Resend credential is installed. Application containers
use the IAP-loaded image with pull_policy: never; the VM never pulls it from a
registry.

## Updates, recovery, and TLS

Stage a protected runtime patch from the active numeric version with
`secrets.mjs stage-runtime`. Use `deploy.mjs update` with the same image/version
arguments as installation, or `deploy.mjs resume` to continue a recorded failed
cutover. Never reset the database to recover an application rollout.

Cutovers close ingress and hold a durable marker. Before an update migrates the
database, it writes a verified `pg_dump -Fc` archive to
`/srv/argos-poc/backups/<release-id>.dump` on the data disk and records the path
in `deploy-intent.json`; resume reuses that archive.
The host runner and systemd refuse ordinary starts while that marker exists,
including an interrupted first install before a current-release symlink exists.
Existing infrastructure is not recreated during application updates. Image,
configuration, mount, network, or published-port drift fails closed.

Resume also reconciles an interrupted release transfer before the cutover marker
exists. After a reboot with a marker, only explicit resume can authorize the
recorded candidate's pinned secrets and Docker startup. Application and proxy
restart policies stay disabled until the marker is durably removed; ordinary
boot never restores an unfinished cutover's ingress.

For leaf renewal under the existing root, stage a candidate without changing
active pins:

    node infra/gcp/scripts/secrets.mjs stage-tls --renew

Retries reuse the valid candidate. Activate its returned numeric version using
the unchanged active image and runtime:

    node infra/gcp/scripts/deploy.mjs update \
      --image 'sha256:<active-image-id>' \
      --runtime-version '<active-runtime-version>' \
      --tls-version '<staged-tls-version>'

This explicit maintenance recreates only Gateway and the two HTTPS proxies so
their read-only TLS mounts attach the new files. PostgreSQL, Redis, RabbitMQ,
Connector, database credentials, and the root remain unchanged. Ordinary
application updates never perform this infrastructure replacement.

After deployment, check health through the connected Argos Client:

    curl --fail --cacert "$HOME/.local/state/argos-poc/pki/root.crt" \
      https://app.argos-poc.internal/health

Use a real project's normal CI upload and browser review flow to verify worker
processing, private image access, and review persistence. Keep credentials, keys,
state, and screenshots outside the checkout; do not upload them to Argos SaaS.
