# -------------------------------------------------------
# Cloud selection
# -------------------------------------------------------
variable "cloud" {
  description = "Cloud provider to use: gcp, aws, or hetzner"
  type        = string

  validation {
    condition     = contains(["gcp", "aws", "hetzner"], var.cloud)
    error_message = "cloud must be one of: gcp, aws, hetzner"
  }
}

variable "project" {
  description = "Project name — used for resource naming"
  type        = string
}

variable "db_name" {
  description = "Database name to create on startup"
  type        = string
  default     = "serverless_saas"
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to connect (your team's IPs). Use [\"0.0.0.0/0\"] to allow all (dev only)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# -------------------------------------------------------
# GCP
# -------------------------------------------------------
variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
  default     = ""
}

variable "gcp_region" {
  description = "GCP region"
  type        = string
  default     = "asia-south1"
}

variable "gcp_machine_type" {
  description = "GCP machine type"
  type        = string
  default     = "e2-medium"
}

# -------------------------------------------------------
# AWS
# -------------------------------------------------------
variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "aws_instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "aws_ami" {
  description = "EC2 AMI ID (Ubuntu 22.04 LTS in your region)"
  type        = string
  default     = ""
}
