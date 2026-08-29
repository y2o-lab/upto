variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 state bucket."
  type        = string
  validation {
    condition     = length(trimspace(var.cloudflare_account_id)) > 0
    error_message = "cloudflare_account_id must not be empty."
  }
}

variable "state_bucket_name" {
  description = "Globally unique R2 bucket name used only for Terraform state."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be 3-63 lowercase characters and use only letters, digits, dots, or hyphens."
  }
}
