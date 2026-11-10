output "connector_tokens" {
  description = "Connector credentials for the deployment secret synchronization step."
  sensitive   = true
  value = {
    access_token  = twingate_connector_tokens.argos_poc.access_token
    refresh_token = twingate_connector_tokens.argos_poc.refresh_token
  }
}

output "instance_name" {
  value = google_compute_instance.vm.name
}

output "zone" {
  value = local.zone
}

output "project_id" {
  value = local.project
}

output "secret_ids" {
  value = {
    runtime   = google_secret_manager_secret.deployment["runtime"].secret_id
    connector = google_secret_manager_secret.deployment["connector"].secret_id
    tls       = google_secret_manager_secret.deployment["tls"].secret_id
  }
}

output "deployment" {
  description = "Non-secret deployment identities consumed by fresh runtime initialization."
  value = {
    vm_id                   = google_compute_instance.vm.id
    network_id              = google_compute_network.network.id
    private_ip              = local.private_ip
    runtime_service_account = google_service_account.runtime.email
    bucket_name             = google_storage_bucket.screenshots.name
    storage_service_account = google_service_account.storage.email
    remote_network_id       = twingate_remote_network.argos_poc.id
    admin_group_id          = twingate_group.admins.id
    entry_group             = twingate_group.admins.name
    operator_subject        = local.operator_subject
    gateway_id              = twingate_gateway.argos_poc.id
    app_resource_id         = twingate_web_app_resource.app_gateway.id
    api_resource_id         = twingate_resource.api.id
    bucket_resource_id      = twingate_resource.storage.id
  }
}

output "storage_ip_filter_enabled" {
  description = "Runtime initialization is allowed only after the operator has enabled the exact VPC /32 filter."
  value       = var.storage_ip_filter_enabled
}
