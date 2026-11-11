resource "google_service_account" "runtime" {
  account_id   = "argos-poc-runtime"
  display_name = "Argos PoC runtime"
  description  = "Runtime identity for the private Argos PoC VM."
}

resource "google_service_account" "storage" {
  account_id   = "argos-poc-storage"
  display_name = "Argos PoC screenshot signer"
  description  = "HMAC signing identity with object access only on the Argos screenshot bucket."
}

resource "google_storage_bucket" "screenshots" {
  name                        = "twingate-playground-argos-poc-screenshots"
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = 7
    }
  }

  cors {
    origin          = ["https://app.argos-poc.internal"]
    method          = ["GET", "HEAD", "POST", "PUT"]
    response_header = ["Content-Type", "Content-Disposition", "ETag", "Content-Range", "Accept-Ranges"]
    max_age_seconds = 3600
  }

  dynamic "ip_filter" {
    for_each = var.storage_ip_filter_enabled ? [true] : []

    content {
      mode                           = "Enabled"
      allow_cross_org_vpcs           = false
      allow_all_service_agent_access = false

      vpc_network_sources {
        network                = "projects/${local.project}/global/networks/${google_compute_network.network.name}"
        allowed_ip_cidr_ranges = ["${local.private_ip}/32"]
      }
    }
  }

  depends_on = [google_compute_instance.vm]
}

# Holds release image archives and manifests the VM pulls. Images go to
# Artifact Registry instead once the runtime account can be granted read
# access there (see README, "Images and installation").
resource "google_storage_bucket" "releases" {
  name                        = "twingate-playground-argos-poc-releases"
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = 7
    }
  }
}

resource "google_storage_bucket_iam_member" "runtime_releases" {
  bucket = google_storage_bucket.releases.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# Read on every plan so the plan guard sees grants made outside Terraform,
# which the non-authoritative iam_member below would never show.
data "google_storage_bucket_iam_policy" "screenshots" {
  bucket = google_storage_bucket.screenshots.name
}

resource "google_storage_bucket_iam_member" "storage_objects" {
  bucket = google_storage_bucket.screenshots.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.storage.email}"
}

resource "google_secret_manager_secret" "deployment" {
  for_each = local.secret_ids

  secret_id = each.value

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "runtime_accessor" {
  for_each = google_secret_manager_secret.deployment

  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

