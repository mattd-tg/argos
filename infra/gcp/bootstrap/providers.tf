provider "google" {
  project               = local.project
  region                = local.region
  zone                  = local.zone
  billing_project       = local.project
  user_project_override = true

  default_labels = {
    deployment = local.name
    keep       = "true"
    owner      = local.environment.operator.label
  }
}
