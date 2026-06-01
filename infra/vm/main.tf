# -------------------------------------------------------
# Cloud-agnostic dev infrastructure
# Provisions a VM on any cloud + runs docker-compose
#
# Usage:
#   terraform init
#   terraform apply -var="cloud=gcp" -var="project=my-project"
#
# Supported clouds: gcp, aws, hetzner
# -------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  name = "${var.project}-dev-server"
}

# -------------------------------------------------------
# GCP
# -------------------------------------------------------
provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

resource "google_compute_instance" "dev" {
  count        = var.cloud == "gcp" ? 1 : 0
  name         = local.name
  machine_type = var.gcp_machine_type
  zone         = "${var.gcp_region}-a"

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 30
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  metadata = {
    user-data = templatefile("${path.module}/cloud-init.sh", {
      db_name = var.db_name
    })
  }

  tags = ["dev-server"]
}

resource "google_compute_firewall" "dev" {
  count   = var.cloud == "gcp" ? 1 : 0
  name    = "${local.name}-firewall"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22", "5432", "6379", "8001"]
  }

  source_ranges = var.allowed_cidr_blocks
  target_tags   = ["dev-server"]
}

# -------------------------------------------------------
# AWS
# -------------------------------------------------------
provider "aws" {
  region = var.aws_region
}

resource "aws_instance" "dev" {
  count         = var.cloud == "aws" ? 1 : 0
  ami           = var.aws_ami
  instance_type = var.aws_instance_type

  user_data = templatefile("${path.module}/cloud-init.sh", {
    db_name = var.db_name
  })

  vpc_security_group_ids = [aws_security_group.dev[0].id]

  tags = {
    Name = local.name
  }
}

resource "aws_security_group" "dev" {
  count = var.cloud == "aws" ? 1 : 0
  name  = "${local.name}-sg"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    from_port   = 8001
    to_port     = 8001
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
