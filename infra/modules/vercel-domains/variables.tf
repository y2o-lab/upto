variable "project_id" {
  description = "ID of the Vercel project that owns the custom domains."
  type        = string
}

variable "vercel_team_id" {
  description = "Vercel team ID, or an empty string for a personal project."
  type        = string
}

variable "vercel_domains" {
  description = "Map keyed by fully-qualified Vercel custom domain."
  type = map(object({
    cname_record_name = string
    cname_target      = string
    ttl               = optional(number, 1)
    proxied           = optional(bool, false)
    comment           = optional(string, "Managed by Terraform for Vercel")
  }))
}
