variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID that owns the Vercel hostnames."
  type        = string
  default     = "ff325226cc30d0e6e3d50f7368d2f4a5"

  validation {
    condition     = length(trimspace(var.cloudflare_zone_id)) > 0
    error_message = "cloudflare_zone_id must not be empty."
  }
}

variable "vercel_project_name" {
  description = "Vercel project name for apps/web."
  type        = string
  default     = "prod-upto-web"

  validation {
    condition     = length(trimspace(var.vercel_project_name)) > 0
    error_message = "vercel_project_name must not be empty."
  }
}

variable "vercel_git_repository" {
  description = "GitHub repository in owner/repository form that Vercel deploys."
  type        = string
  default     = "y2o-lab/upto"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.vercel_git_repository))
    error_message = "vercel_git_repository must use owner/repository form."
  }
}

variable "vercel_production_branch" {
  description = "Git branch that creates production deployments. Other branches create preview deployments."
  type        = string
  default     = "release"

  validation {
    condition     = length(trimspace(var.vercel_production_branch)) > 0
    error_message = "vercel_production_branch must not be empty."
  }
}

variable "vercel_team_id" {
  description = "Vercel team ID. Leave empty only when the project belongs to a personal account."
  type        = string
  default     = "team_jqmDLliwu4jcFFvB10Lynk9n"
}

variable "vercel_domains" {
  description = "Vercel custom domains and the Cloudflare record type used for each one."
  type = map(object({
    record_name = string
    record_type = optional(string, "CNAME")
    ttl         = optional(number, 1)
    proxied     = optional(bool, false)
    comment     = optional(string, "Managed by Terraform for Vercel")
  }))
  default = {
    "upto.yuno-i.com" = {
      record_name = "upto"
      record_type = "CNAME"
      ttl         = 1
      proxied     = false
    }
  }
}

variable "verification_dns_records" {
  description = "Optional DNS-only TXT records required by Vercel ownership verification."
  type = map(object({
    name    = string
    content = string
    ttl     = optional(number, 1)
    comment = optional(string, "Managed by Terraform for Vercel verification")
  }))
  default = {}

  validation {
    condition = alltrue([
      for record in values(var.verification_dns_records) :
      length(trimspace(record.name)) > 0 &&
      length(trimspace(record.content)) > 0 &&
      (record.ttl == 1 || (record.ttl >= 60 && record.ttl <= 86400))
    ])
    error_message = "Every verification TXT record requires a name, content, and ttl 1 or 60-86400 seconds."
  }
}
