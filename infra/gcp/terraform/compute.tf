resource "google_compute_network" "network" {
  name                    = "argos-poc-network"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "subnet" {
  name                     = "argos-poc-subnet"
  region                   = local.region
  network                  = google_compute_network.network.id
  ip_cidr_range            = "10.87.40.0/24"
  private_ip_google_access = true
}

resource "google_compute_router" "router" {
  name    = "argos-poc-router"
  region  = local.region
  network = google_compute_network.network.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "argos-poc-nat"
  router                             = google_compute_router.router.name
  region                             = google_compute_router.router.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.subnet.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "argos-poc-iap-ssh"
  network       = google_compute_network.network.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["35.235.240.0/20"]

  target_service_accounts = [google_service_account.runtime.email]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_disk" "data" {
  name = "argos-poc-data"
  type = "pd-balanced"
  zone = local.zone
  size = 50

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "vm" {
  name         = "argos-poc"
  zone         = local.zone
  machine_type = "e2-standard-2"
  depends_on = [
    google_compute_router_nat.nat,
    google_secret_manager_secret_iam_member.runtime_accessor,
  ]

  boot_disk {
    initialize_params {
      image  = "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261024"
      size   = 20
      type   = "pd-balanced"
      labels = local.labels
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    network_ip = local.private_ip
  }

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin          = "TRUE"
    block-project-ssh-keys  = "TRUE"
    argos-poc-secret-loader = base64encode(file("${path.module}/../scripts/load-secrets.py"))
    argos-poc-systemd-unit  = base64encode(file("${path.module}/../systemd/argos-poc.service"))
    argos-poc-prepare-unit  = base64encode(file("${path.module}/../systemd/argos-poc-prepare.service"))
    argos-poc-release-agent = base64encode(file("${path.module}/../scripts/release-agent.py"))
    argos-poc-agent-unit    = base64encode(file("${path.module}/../systemd/argos-poc-release-agent.service"))
    enable-guest-attributes = "TRUE"
    startup-script          = file("${path.module}/../scripts/initialize-host.sh")
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # deploy.mjs points argos-poc-release at the release the VM should run.
  lifecycle {
    ignore_changes = [attached_disk, metadata["argos-poc-release"]]
  }
}

resource "google_compute_attached_disk" "data" {
  disk            = google_compute_disk.data.id
  instance        = google_compute_instance.vm.id
  zone            = local.zone
  device_name     = "argos-poc-data"
  mode            = "READ_WRITE"
  deletion_policy = "ABANDON"
}
