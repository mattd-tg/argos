locals {
  project        = "twingate-playground"
  project_number = "417269620845"
  region         = "us-east4"
  zone           = "us-east4-a"
  private_ip     = "10.87.40.10"

  operator_subject = "VXNlcjo0NzE4"

  github_repository_id = "1451923766"

  labels = {
    deployment = "argos-poc"
    keep       = "true"
    owner      = "matt-demichele"
  }

  secret_ids = {
    runtime   = "argos-poc-runtime"
    connector = "argos-poc-connector"
    tls       = "argos-poc-tls"
  }

  gateway_ca_certificate = file(var.ca_certificate_path)
}

