output "r2_s3_endpoint" {
  description = "S3 endpoint to copy into the production backend configuration."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "state_bucket_name" {
  description = "Name of the R2 bucket that stores Terraform state."
  value       = cloudflare_r2_bucket.terraform_state.name
}
