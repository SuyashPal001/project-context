output "server_ip" {
  description = "Public IP of the dev server"
  value = var.cloud == "gcp" ? (
    length(google_compute_instance.dev) > 0 ?
    google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip : ""
  ) : var.cloud == "aws" ? (
    length(aws_instance.dev) > 0 ? aws_instance.dev[0].public_ip : ""
  ) : ""
}

output "database_url" {
  description = "PostgreSQL connection string for .env"
  value = var.cloud == "gcp" ? (
    length(google_compute_instance.dev) > 0 ?
    "postgresql://postgres:postgres@${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:5432/${var.db_name}" : ""
  ) : var.cloud == "aws" ? (
    length(aws_instance.dev) > 0 ?
    "postgresql://postgres:postgres@${aws_instance.dev[0].public_ip}:5432/${var.db_name}" : ""
  ) : ""
  sensitive = true
}

output "redis_url" {
  description = "Redis connection URL for .env"
  value = var.cloud == "gcp" ? (
    length(google_compute_instance.dev) > 0 ?
    "redis://${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:6379" : ""
  ) : var.cloud == "aws" ? (
    length(aws_instance.dev) > 0 ?
    "redis://${aws_instance.dev[0].public_ip}:6379" : ""
  ) : ""
}

output "lakehouse_url" {
  description = "Lakehouse service URL for .env"
  value = var.cloud == "gcp" ? (
    length(google_compute_instance.dev) > 0 ?
    "http://${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:8001" : ""
  ) : var.cloud == "aws" ? (
    length(aws_instance.dev) > 0 ?
    "http://${aws_instance.dev[0].public_ip}:8001" : ""
  ) : ""
}

output "env_block" {
  description = "Ready-to-paste .env values — paste into apps/api/.env, apps/ai-service/.env, apps/mcp-server/.env, apps/relay/.env"
  value = <<-EOT
    # --- Paste into all services that need DATABASE_URL ---
    DATABASE_URL=${var.cloud == "gcp" && length(google_compute_instance.dev) > 0 ?
      "postgresql://postgres:postgres@${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:5432/${var.db_name}" :
      var.cloud == "aws" && length(aws_instance.dev) > 0 ?
      "postgresql://postgres:postgres@${aws_instance.dev[0].public_ip}:5432/${var.db_name}" : "<IP>"}

    # --- Paste into apps/api/.env (Redis — no token needed in dev) ---
    UPSTASH_REDIS_URL=${var.cloud == "gcp" && length(google_compute_instance.dev) > 0 ?
      "redis://${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:6379" :
      var.cloud == "aws" && length(aws_instance.dev) > 0 ?
      "redis://${aws_instance.dev[0].public_ip}:6379" : "<IP>"}
    UPSTASH_REDIS_TOKEN=

    # --- Paste into apps/api/.env (Lakehouse) ---
    LAKEHOUSE_URL=${var.cloud == "gcp" && length(google_compute_instance.dev) > 0 ?
      "http://${google_compute_instance.dev[0].network_interface[0].access_config[0].nat_ip}:8001" :
      var.cloud == "aws" && length(aws_instance.dev) > 0 ?
      "http://${aws_instance.dev[0].public_ip}:8001" : "<IP>"}
  EOT
  sensitive = true
}
