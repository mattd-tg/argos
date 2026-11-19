resource "google_project_service" "required" {
  for_each = local.services

  service = each.value
  # Other workloads in a shared project may depend on the same APIs.
  disable_on_destroy         = false
  disable_dependent_services = false
}
