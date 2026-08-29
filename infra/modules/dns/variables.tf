variable "zone_id" {
  description = "Cloudflare zone ID containing the records."
  type        = string
}

variable "vercel_domains" {
  description = "CNAME records for Vercel custom domains, keyed by FQDN."
  type = map(object({
    cname_record_name = string
    cname_target      = string
    ttl               = optional(number, 1)
    proxied           = optional(bool, false)
    comment           = optional(string, "Managed by Terraform for Vercel")
  }))
}

variable "verification_dns_records" {
  description = "TXT ownership-verification records requested by Vercel."
  type = map(object({
    name    = string
    content = string
    ttl     = optional(number, 1)
    comment = optional(string, "Managed by Terraform for Vercel verification")
  }))
}
