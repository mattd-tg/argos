provider "google" {
  project               = local.project
  region                = local.region
  zone                  = local.zone
  billing_project       = local.project
  user_project_override = true

  default_labels = {
    deployment = "argos-poc"
    keep       = "true"
    owner      = local.environment.operator.label
  }
}
