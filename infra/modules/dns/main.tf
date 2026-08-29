resource "cloudflare_dns_record" "vercel_cname" {
  for_each = var.vercel_domains

  zone_id = var.zone_id
  name    = each.value.cname_record_name
  type    = "CNAME"
  content = each.value.cname_target
  ttl     = each.value.ttl
  proxied = each.value.proxied
  comment = each.value.comment
}

resource "cloudflare_dns_record" "vercel_verification" {
  for_each = var.verification_dns_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = "TXT"
  content = each.value.content
  ttl     = each.value.ttl
  proxied = false
  comment = each.value.comment
}
