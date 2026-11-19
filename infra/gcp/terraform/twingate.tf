resource "twingate_remote_network" "argos_poc" {
  name = local.name

  lifecycle {
    precondition {
      condition     = contains(["terraform", "idp"], local.entry_group_source)
      error_message = "environment.json twingate.entryGroupSource must be \"terraform\" or \"idp\"."
    }
    precondition {
      condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9 ._-]*$", local.entry_group))
      error_message = "environment.json twingate.entryGroup must be a group name of letters, digits, spaces, dots, underscores and hyphens."
    }
    precondition {
      condition = local.admin_group == null || (
        can(regex("^[A-Za-z0-9][A-Za-z0-9 ._-]*$", local.admin_group)) &&
        lower(local.admin_group) != lower(local.entry_group)
      )
      error_message = "environment.json twingate.adminGroup must be null or a group name, other than entryGroup, of letters, digits, spaces, dots, underscores and hyphens."
    }
  }
}

resource "twingate_connector" "argos_poc" {
  name              = "${local.name}-connector"
  remote_network_id = twingate_remote_network.argos_poc.id
}

resource "twingate_connector_tokens" "argos_poc" {
  connector_id = twingate_connector.argos_poc.id
}

# Argos admits exactly this group's members. With entryGroupSource
# "terraform", Terraform creates it and keeps the operator in it; everyone else
# is added and removed in the Admin Console. With "idp", the group is synced
# from the identity provider and Terraform only looks it up.
resource "twingate_group" "admins" {
  count            = local.entry_group_source == "terraform" ? 1 : 0
  name             = local.entry_group
  is_authoritative = false
  user_ids         = [local.operator_subject]
}

moved {
  from = twingate_group.admins
  to   = twingate_group.admins[0]
}

data "twingate_groups" "entry" {
  count = local.entry_group_source == "idp" ? 1 : 0
  name  = local.entry_group
  types = ["SYNCED"]

  lifecycle {
    postcondition {
      condition     = length(self.groups) == 1
      error_message = "Expected exactly one IdP-synced Twingate group named by environment.json twingate.entryGroup."
    }
  }
}

# Members of the optional admin group also enter Argos, as team owners. It
# comes from the same source as the entry group.
resource "twingate_group" "owners" {
  # A fixed key, so renaming the group updates it in place. The provider
  # rejects a null name even on a zero count.
  for_each         = local.admin_group != null && local.entry_group_source == "terraform" ? { admin = local.admin_group } : {}
  name             = each.value
  is_authoritative = false
  user_ids         = [local.operator_subject]
}

data "twingate_groups" "owners" {
  for_each = local.admin_group != null && local.entry_group_source == "idp" ? { admin = local.admin_group } : {}
  name     = each.value
  types    = ["SYNCED"]

  lifecycle {
    postcondition {
      condition     = length(self.groups) == 1
      error_message = "Expected exactly one IdP-synced Twingate group named by environment.json twingate.adminGroup."
    }
  }
}

locals {
  entry_group_id = (
    local.entry_group_source == "terraform"
    ? one(twingate_group.admins[*].id)
    : one(data.twingate_groups.entry[0].groups[*].id)
  )
  admin_group_id = (
    local.admin_group == null ? null
    : local.entry_group_source == "terraform"
    ? twingate_group.owners["admin"].id
    : one(data.twingate_groups.owners["admin"].groups[*].id)
  )
  access_group_ids = compact([local.entry_group_id, local.admin_group_id])
}

# GitHub Actions uploads from mattd-tg/argos-wif-demo. Its Service Key is
# created in the Admin Console so the secret never enters Terraform state.
resource "twingate_service_account" "ci" {
  name = local.environment.twingate.ciServiceAccount
}

# Not authoritative: Terraform manages only the grants below and leaves access
# added in the Admin Console. deploy.mjs still rejects any extra group grant.
resource "twingate_resource" "api" {
  name                        = "api.${local.domain}"
  address                     = "api.${local.domain}"
  remote_network_id           = twingate_remote_network.argos_poc.id
  routing_mode                = "THROUGH_TWINGATE"
  is_authoritative            = false
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

  dynamic "access_group" {
    for_each = local.access_group_ids
    content {
      group_id = access_group.value
    }
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
  is_authoritative            = false
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

  dynamic "access_group" {
    for_each = local.access_group_ids
    content {
      group_id = access_group.value
    }
  }

  access_service {
    service_account_id = twingate_service_account.ci.id
  }
}

resource "twingate_x509_certificate_authority" "argos_poc" {
  name        = "${local.name}-constrained-ca"
  certificate = local.gateway_ca_certificate
}

resource "twingate_gateway" "argos_poc" {
  address           = "gateway.${local.domain}:8443"
  remote_network_id = twingate_remote_network.argos_poc.id
  x509_ca_id        = twingate_x509_certificate_authority.argos_poc.id
}

resource "twingate_web_app_resource" "app_gateway" {
  name              = "app.${local.domain}"
  address           = "app.${local.domain}"
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

  dynamic "access_group" {
    for_each = local.access_group_ids
    content {
      group_id = access_group.value
    }
  }
}
