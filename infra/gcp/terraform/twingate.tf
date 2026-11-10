resource "twingate_remote_network" "argos_poc" {
  name = "argos-poc"
}

resource "twingate_connector" "argos_poc" {
  name              = "argos-poc-connector"
  remote_network_id = twingate_remote_network.argos_poc.id
}

resource "twingate_connector_tokens" "argos_poc" {
  connector_id = twingate_connector.argos_poc.id
}

resource "twingate_group" "admins" {
  name             = "argos-poc-admins"
  is_authoritative = true
  user_ids         = ["VXNlcjo0NzE4"]
}

# GitHub Actions uploads from mattd-tg/argos-wif-demo. Its Service Key is
# created in the Admin Console so the secret never enters Terraform state.
resource "twingate_service_account" "ci" {
  name = "argos-wif-demo-ci"
}

resource "twingate_resource" "api" {
  name                        = "api.argos-poc.internal"
  address                     = "api.argos-poc.internal"
  remote_network_id           = twingate_remote_network.argos_poc.id
  routing_mode                = "THROUGH_TWINGATE"
  is_authoritative            = true
  is_visible                  = false
  is_browser_shortcut_enabled = false

  protocols = {
    allow_icmp = false
    tcp = {
      policy = "RESTRICTED"
      ports  = ["443"]
    }
    udp = {
      policy = "DENY_ALL"
    }
  }

  access_group {
    group_id = twingate_group.admins.id
  }

  access_service {
    service_account_id = twingate_service_account.ci.id
  }
}

resource "twingate_resource" "storage" {
  name                        = "${google_storage_bucket.screenshots.name}.storage.googleapis.com"
  address                     = "${google_storage_bucket.screenshots.name}.storage.googleapis.com"
  remote_network_id           = twingate_remote_network.argos_poc.id
  routing_mode                = "THROUGH_TWINGATE"
  is_authoritative            = true
  is_visible                  = false
  is_browser_shortcut_enabled = false

  protocols = {
    allow_icmp = false
    tcp = {
      policy = "RESTRICTED"
      ports  = ["443"]
    }
    udp = {
      policy = "DENY_ALL"
    }
  }

  access_group {
    group_id = twingate_group.admins.id
  }

  access_service {
    service_account_id = twingate_service_account.ci.id
  }
}

resource "twingate_x509_certificate_authority" "argos_poc" {
  name        = "argos-poc-constrained-ca"
  certificate = local.gateway_ca_certificate
}

resource "twingate_gateway" "argos_poc" {
  address           = "gateway.argos-poc.internal:8443"
  remote_network_id = twingate_remote_network.argos_poc.id
  x509_ca_id        = twingate_x509_certificate_authority.argos_poc.id
}

resource "twingate_web_app_resource" "app_gateway" {
  name              = "app.argos-poc.internal"
  address           = "app.argos-poc.internal"
  gateway_id        = twingate_gateway.argos_poc.id
  remote_network_id = twingate_remote_network.argos_poc.id

  downstream = {
    port     = 443
    tls_mode = "TLS13"
  }

  upstream = {
    port     = 443
    tls_mode = "VERIFY_FULL"
  }

  request_header_rewrites = {
    "X-Twingate-GAT" = "{{jwt}}"
  }

  access_group {
    group_id = twingate_group.admins.id
  }
}
