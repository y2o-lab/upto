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
    record_name = string
    record_type = optional(string, "CNAME")
    ttl         = optional(number, 1)
    proxied     = optional(bool, false)
    comment     = optional(string, "Managed by Terraform for Vercel")
  }))
}
