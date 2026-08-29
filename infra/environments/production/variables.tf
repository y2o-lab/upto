variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID that owns the Vercel hostnames."
  type        = string
  validation {
    condition     = length(trimspace(var.cloudflare_zone_id)) > 0
    error_message = "cloudflare_zone_id must not be empty."
  }
}

variable "vercel_project_name" {
  description = "Vercel project name for apps/web."
  type        = string

  validation {
    condition     = length(trimspace(var.vercel_project_name)) > 0
    error_message = "vercel_project_name must not be empty."
  }
}

variable "vercel_git_repository" {
  description = "GitHub repository in owner/repository form that Vercel deploys."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.vercel_git_repository))
    error_message = "vercel_git_repository must use owner/repository form."
  }
}

variable "vercel_production_branch" {
  description = "Git branch that creates production deployments. Other branches create preview deployments."
  type        = string
  default     = "main"

  validation {
    condition     = length(trimspace(var.vercel_production_branch)) > 0
    error_message = "vercel_production_branch must not be empty."
  }
}

variable "vercel_team_id" {
  description = "Vercel team ID. Leave empty only when the project belongs to a personal account."
  type        = string
  default     = ""
}

variable "vercel_domains" {
  description = "Custom Vercel domains and their Cloudflare DNS-only CNAME records."
  type = map(object({
    cname_record_name = string
    cname_target      = string
    ttl               = optional(number, 1)
    proxied           = optional(bool, false)
    comment           = optional(string, "Managed by Terraform for Vercel")
  }))

  validation {
    condition = alltrue([
      for domain, record in var.vercel_domains :
      length(trimspace(domain)) > 0 &&
      length(trimspace(record.cname_record_name)) > 0 &&
      can(regex("^[A-Za-z0-9.-]+$", record.cname_target)) &&
      (record.ttl == 1 || (record.ttl >= 60 && record.ttl <= 86400))
    ])
    error_message = "Every Vercel domain requires a hostname, a CNAME target, and ttl 1 or 60-86400 seconds."
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
