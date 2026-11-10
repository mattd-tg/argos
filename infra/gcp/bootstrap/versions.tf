terraform {
  required_version = "= 1.12.1"
  backend "local" {}


  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.10.0"
    }
  }
}
