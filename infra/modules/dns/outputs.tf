output "record_ids" {
  description = "Cloudflare record IDs keyed by managed resource name."
  value = merge(
    { for name, record in cloudflare_dns_record.vercel_cname : "cname:${name}" => record.id },
    { for name, record in cloudflare_dns_record.vercel_verification : "txt:${name}" => record.id },
  )
}
