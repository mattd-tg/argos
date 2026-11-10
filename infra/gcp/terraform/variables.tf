variable "ca_certificate_path" {
  description = "Absolute local path to the public Argos root CA PEM."
  type        = string

  validation {
    condition     = startswith(var.ca_certificate_path, "/")
    error_message = "ca_certificate_path must be an absolute local path."
  }
}

variable "storage_ip_filter_enabled" {
  description = "Keep true except the initial empty, IAM-private bootstrap before the operator tunnel exists."
  type        = bool
  default     = true
}

variable "entry_group" {
  description = "Twingate group whose members may enter Argos. The deploy scripts give Argos the same name as TWINGATE_GATEWAY_ENTRY_GROUP."
  type        = string
  default     = "argos-poc-admins"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9 ._-]*$", var.entry_group))
    error_message = "entry_group must be a group name of letters, digits, spaces, dots, underscores and hyphens."
  }
}
