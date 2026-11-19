locals {
  environment = jsondecode(file("${path.module}/../environment.json"))

  name   = local.environment.deployment.name
  title  = local.environment.deployment.title
  domain = local.environment.deployment.domain

  project        = local.environment.gcp.project
  project_number = local.environment.gcp.projectNumber
  region         = local.environment.gcp.region
  zone           = local.environment.gcp.zone
  private_ip     = "10.87.40.10"

  operator_subject = local.environment.operator.subject

  github_repository_id = local.environment.github.repositoryId

  entry_group        = local.environment.twingate.entryGroup
  entry_group_source = local.environment.twingate.entryGroupSource
  admin_group        = try(local.environment.twingate.adminGroup, null)

  labels = {
    deployment = local.name
    keep       = "true"
    owner      = local.environment.operator.label
  }

  secret_ids = {
    runtime   = "${local.name}-runtime"
    connector = "${local.name}-connector"
    tls       = "${local.name}-tls"
  }

  gateway_ca_certificate = file(var.ca_certificate_path)
}
