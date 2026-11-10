locals {
  project    = "twingate-playground"
  region     = "us-east4"
  zone       = "us-east4-a"
  private_ip = "10.87.40.10"

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

