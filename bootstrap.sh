#!/bin/bash
# Bootstrap — creates AWS resources that must exist before sam deploy / terraform init
# Safe to run multiple times (all operations are idempotent)
#
# Usage:
#   chmod +x bootstrap.sh
#   AWS_PROFILE=your-profile ./bootstrap.sh [dev|staging|prod]
#
# What it creates:
#   S3  project-context-sam-deployments-dev   (SAM Lambda artifacts — dev only)
#   S3  project-context-sam-deployments        (SAM Lambda artifacts — staging + prod)
#   S3  project-context-terraform-state        (Terraform remote state)
#   DDB project-context-terraform-locks        (Terraform state locking)

set -e

REGION="ap-south-1"
PROJECT="project-context"

# -------------------------------------------------------
# Helpers
# -------------------------------------------------------
create_bucket() {
  local bucket=$1
  if aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>/dev/null; then
    echo "  ✓ S3 bucket already exists: $bucket"
  else
    aws s3api create-bucket \
      --bucket "$bucket" \
      --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" > /dev/null
    echo "  ✓ Created S3 bucket: $bucket"
  fi

  # Enable versioning on state bucket
  if [[ "$bucket" == *"terraform-state"* ]]; then
    aws s3api put-bucket-versioning \
      --bucket "$bucket" \
      --versioning-configuration Status=Enabled > /dev/null
    echo "    versioning enabled"
  fi

  # Block all public access
  aws s3api put-public-access-block \
    --bucket "$bucket" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" > /dev/null
}

create_dynamodb_table() {
  local table=$1
  if aws dynamodb describe-table --table-name "$table" --region "$REGION" 2>/dev/null | grep -q "ACTIVE\|CREATING"; then
    echo "  ✓ DynamoDB table already exists: $table"
  else
    aws dynamodb create-table \
      --table-name "$table" \
      --attribute-definitions AttributeName=LockID,AttributeType=S \
      --key-schema AttributeName=LockID,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      --region "$REGION" > /dev/null
    echo "  ✓ Created DynamoDB table: $table"
  fi
}

# -------------------------------------------------------
# Run
# -------------------------------------------------------
echo ""
echo "Bootstrap: $PROJECT ($REGION)"
echo "AWS account: $(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo 'check credentials')"
echo ""

echo "→ SAM deployment buckets"
create_bucket "${PROJECT}-sam-deployments-dev"
create_bucket "${PROJECT}-sam-deployments"

echo ""
echo "→ Terraform state bucket"
create_bucket "${PROJECT}-terraform-state"

echo ""
echo "→ Terraform lock table"
create_dynamodb_table "${PROJECT}-terraform-locks"

echo ""
echo "✓ Bootstrap complete. You can now run:"
echo ""
echo "  1. pnpm install"
echo "  2. make build"
echo "  3. sam deploy --config-env dev"
echo "  4. cd infra/terraform/foundation"
echo "     cp terraform.tfvars.example terraform.tfvars   # fill in values"
echo "     terraform init -backend-config=../environments/dev/backend.hcl"
echo "     terraform apply"
echo ""
echo "  Seed these secrets in AWS Secrets Manager before step 4:"
echo "    ${PROJECT}/dev/gcp-sa-key          → GCP service account JSON"
echo "    ${PROJECT}/dev/internal-service-key → openssl rand -hex 32"
echo "    ${PROJECT}/dev/token-encryption-key → openssl rand -hex 32"
echo "    ${PROJECT}/dev/jira-oauth           → {\"client_id\":\"...\",\"client_secret\":\"...\"}"
echo "    ${PROJECT}/dev/github-app           → {\"app_id\":\"...\",\"private_key\":\"...\",\"webhook_secret\":\"...\"}"
echo "    ${PROJECT}/dev/zoho-oauth           → {\"client_id\":\"...\",\"client_secret\":\"...\"}"
