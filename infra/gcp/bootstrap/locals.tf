locals {
  environment = jsondecode(file("${path.module}/../environment.json"))

  project = local.environment.gcp.project
  region  = local.environment.gcp.region
  zone    = local.environment.gcp.zone

  # Every API the main stack and the operator's IAP tunnel call.
  services = toset([
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])
}
