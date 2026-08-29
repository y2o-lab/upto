output "vercel_project_id" {
  description = "Vercel project ID that receives Git deployments and owns the managed domains."
  value       = module.vercel_project.id
}

output "managed_vercel_domains" {
  description = "Vercel custom domains managed by this production root module."
  value       = module.vercel_domains.domains
}

output "managed_cloudflare_dns_record_ids" {
  description = "Cloudflare DNS record IDs for the Vercel CNAME and verification records."
  value       = module.dns.record_ids
}
