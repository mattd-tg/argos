provider "google" {
  project               = "twingate-playground"
  region                = "us-east4"
  zone                  = "us-east4-a"
  billing_project       = "twingate-playground"
  user_project_override = true

  default_labels = {
    deployment = "argos-poc"
    keep       = "true"
    owner      = "matt-demichele"
  }
}
