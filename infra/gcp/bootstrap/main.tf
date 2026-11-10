resource "google_storage_bucket" "state" {
  name                        = "twingate-playground-argos-poc-state"
  location                    = "us-east4"
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
