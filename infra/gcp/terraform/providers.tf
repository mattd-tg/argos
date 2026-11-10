provider "google" {
  project               = local.project
  region                = local.region
  zone                  = local.zone
  billing_project       = local.project
  user_project_override = true
  default_labels        = local.labels
}

provider "twingate" {
  network = "argospoc"
  url     = "us2.dev.opstg.com"

  cache = {
    groups_enabled   = false
    resource_enabled = false
  }

  default_tags = {
    tags = local.labels
  }
}
