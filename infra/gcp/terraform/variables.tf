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
