# -------------------------------------------------------
# S3 — File Storage
# -------------------------------------------------------
resource "aws_s3_bucket" "files" {
  bucket = "${local.name_prefix}-files"

  tags = {
    Name        = "${local.name_prefix}-files"
    Environment = var.environment
    Project     = var.project
  }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket = aws_s3_bucket.files.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id

  versioning_configuration {
    status = "Enabled"
  }
}

# CORS for presigned URL uploads from the browser
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["http://localhost:3000", "https://${var.domain}", "https://*.${var.domain}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# SSM parameter so Lambda can read the bucket name at runtime
resource "aws_ssm_parameter" "storage_bucket" {
  name  = "${local.ssm_prefix}/s3/documents-bucket-name"
  type  = "String"
  value = aws_s3_bucket.files.bucket
}

# -------------------------------------------------------
# IAM — S3 permissions for the API Lambda
# -------------------------------------------------------
resource "aws_iam_role_policy" "lambda_s3_files" {
  name = "${local.name_prefix}-lambda-s3-files"
  role = module.iam.role_names["foundation_api"]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.files.arn}/*"
      }
    ]
  })
}

#---------------------------------------------------------
# IAM — S3 read permission for the task worker Lambda
#---------------------------------------------------------
resource "aws_iam_role_policy" "task_worker_s3_files" {
  name = "${local.name_prefix}-task-worker-s3-files"
  role = module.iam.role_names["task_worker"]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
        ]
        Resource = "${aws_s3_bucket.files.arn}/*"
      }
    ]
  })
}
