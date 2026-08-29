resource "cloudflare_dns_record" "vercel" {
  for_each = var.dns_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
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
