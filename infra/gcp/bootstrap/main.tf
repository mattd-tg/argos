resource "google_storage_bucket" "state" {
  name                        = "${local.project}-${local.name}-state"
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.required]

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
