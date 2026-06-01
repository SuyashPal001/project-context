variable "domain" {
  description = "The sending domain for SES (e.g. mail.projectcontext.co)"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "project" {
  description = "Project name for tagging"
  type        = string
}
