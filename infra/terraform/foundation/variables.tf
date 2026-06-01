variable "project" {
  description = "Project name used for resource naming and tagging."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,28}[a-z0-9]$", var.project))
    error_message = "Project must be 4-30 characters, lowercase letters, numbers, hyphens."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "region" {
  description = "AWS region."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "Region must be a valid AWS region format e.g. ap-south-1."
  }
}

# -------------------------------------------------------
# Cognito
# -------------------------------------------------------
variable "cognito_domain_prefix" {
  description = "Cognito hosted UI domain prefix. Must be globally unique."
  type        = string
}

variable "cognito_callback_urls" {
  description = "Allowed callback URLs for Cognito web client"
  type        = list(string)
  default     = ["http://localhost:3000/auth/callback"]
}

variable "cognito_logout_urls" {
  description = "Allowed logout URLs for Cognito web client"
  type        = list(string)
  default     = ["http://localhost:3000"]
}

variable "pre_token_generation_lambda_arn" {
  description = "ARN of the Pre Token Generation Lambda. Written by SAM, read here."
  type        = string
}

# -------------------------------------------------------
# API Gateway
# -------------------------------------------------------
variable "api_name" {
  description = "Name of the HTTP API Gateway."
  type        = string
}

variable "api_stage_name" {
  description = "API Gateway stage name."
  type        = string
  default     = "$default"
}

variable "cors_allow_origins" {
  description = "List of allowed CORS origins."
  type        = list(string)
}

# -------------------------------------------------------
# SQS
# -------------------------------------------------------
variable "processing_queue_name" {
  description = "Name of the main SQS processing queue."
  type        = string
}

variable "workflow_queue_name" {
  description = "Name of the SQS workflow queue for agent workflows."
  type        = string
}

variable "message_retention_seconds" {
  description = "SQS message retention period in seconds."
  type        = number
  default     = 86400 # 24 hours
}

variable "visibility_timeout_seconds" {
  description = "SQS visibility timeout in seconds. Must be >= Lambda timeout."
  type        = number
  default     = 30
}

# -------------------------------------------------------
# SNS
# -------------------------------------------------------
variable "events_topic_name" {
  description = "Name of the SNS events topic."
  type        = string
}

# -------------------------------------------------------
# EventBridge
# -------------------------------------------------------
variable "event_bus_name" {
  description = "Name of the custom EventBridge event bus."
  type        = string
}

# -------------------------------------------------------
# CloudWatch
# -------------------------------------------------------
variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "Log retention must be a valid CloudWatch retention value."
  }
}

# -------------------------------------------------------
# Lambda ARNs (written by SAM, consumed by Terraform for wiring)
# -------------------------------------------------------
variable "foundation_api_lambda_arn" {
  description = "ARN of the foundation API Lambda. Written by SAM deploy."
  type        = string
}

variable "foundation_worker_lambda_arn" {
  description = "ARN of the foundation worker Lambda. Written by SAM deploy."
  type        = string
}

variable "agent_task_queue_name" {
  description = "Name of the agent task SQS queue"
  type        = string
  default     = "project-context-agent-task-queue-dev"
}

variable "task_worker_lambda_arn" {
  description = "ARN of the Task Worker Lambda (deployed by SAM)"
  type        = string
  default     = ""
}

# Upstash Redis
variable "upstash_redis_rest_url" {
  description = "Upstash Redis REST URL"
  type        = string
}

variable "upstash_redis_rest_token" {
  description = "Upstash Redis REST token"
  type        = string
  sensitive   = true
}

# Neon PostgreSQL
variable "database_url" {
  description = "Neon PostgreSQL connection string"
  type        = string
  sensitive   = true
}

# Websocket Token
variable "ws_token_secret" {
  description = "Secret for signing WebSocket tokens"
  type        = string
  sensitive   = true
}

# Jira OAuth
variable "jira_redirect_uri" {
  description = "Redirect URI registered in the Atlassian OAuth app for Jira"
  type        = string
}

# Google OAuth
variable "google_client_id" {
  description = "Google OAuth 2.0 client ID"
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 client secret"
  type        = string
  sensitive   = true
}

variable "google_redirect_uri" {
  description = "Redirect URI registered in the Google Cloud Console for OAuth (e.g. https://api.example.com/api/v1/integrations/google/callback)"
  type        = string
}

# Zoho OAuth
variable "zoho_redirect_uri" {
  description = "Redirect URI registered in the Zoho API console for OAuth"
  type        = string
}

# Relay
variable "relay_url" {
  description = "Public URL of the relay service (e.g. https://relay.example.com)"
  type        = string
}

# Frontend
variable "frontend_url" {
  description = "Public frontend base URL used for OAuth callback redirects (e.g. https://app.example.com)"
  type        = string
}

# -------------------------------------------------------
# SES
# -------------------------------------------------------
variable "ses_from_domain" {
  description = "SES sending subdomain (e.g. mail.saas.fitnearn.com)"
  type        = string
}

# -------------------------------------------------------
# Storage
# -------------------------------------------------------
variable "domain" {
  description = "Root domain for the project (e.g. saas.fitnearn.com). Used for S3 CORS wildcard."
  type        = string
}
