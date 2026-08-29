locals {
  vercel_dns_records = {
    for domain, record in var.vercel_domains : domain => {
      name    = record.record_name
      type    = record.record_type
      content = (
        record.record_type == "A"
        ? one(data.vercel_domain_config.custom[domain].recommended_ipv4s)
        : data.vercel_domain_config.custom[domain].recommended_cname
      )
      ttl     = record.ttl
      proxied = record.proxied
      comment = record.comment
    }
  }
}
