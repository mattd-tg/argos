terraform {
  required_version = "= 1.12.1"

  backend "gcs" {
    bucket = "twingate-playground-argos-poc-state"
    prefix = "terraform"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.10.0"
    }

    twingate = {
      source  = "Twingate/twingate"
      version = "= 5.2.0"
    }
  }
}
