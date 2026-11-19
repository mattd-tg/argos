locals {
  environment = jsondecode(file("${path.module}/../environment.json"))

  project        = local.environment.gcp.project
  project_number = local.environment.gcp.projectNumber
  region         = local.environment.gcp.region
  zone           = local.environment.gcp.zone
  private_ip     = "10.87.40.10"

  operator_subject = local.environment.operator.subject

  github_repository_id = local.environment.github.repositoryId

  entry_group        = local.environment.twingate.entryGroup
  entry_group_source = local.environment.twingate.entryGroupSource

  labels = {
    deployment = "argos-poc"
    keep       = "true"
    owner      = local.environment.operator.label
  }

  secret_ids = {
    runtime   = "argos-poc-runtime"
    connector = "argos-poc-connector"
    tls       = "argos-poc-tls"
  }

  gateway_ca_certificate = file(var.ca_certificate_path)
}
