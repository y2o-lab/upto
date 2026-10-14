locals {
  environment  = "production"
  project_name = "upto-collector-${local.environment}"
}
module "vercel_collector" {
  source         = "../../modules/vercel-collector"
  project_name   = local.project_name
  vercel_team_id = var.vercel_team_id
}
module "domains" {
  source         = "../../modules/vercel-domains"
  project_id     = module.vercel_collector.id
  vercel_team_id = var.vercel_team_id
  vercel_domains = { (var.collector_domain) = { record_name = var.dns_record_name, record_type = var.dns_record_type, proxied = false } }
}
data "vercel_domain_config" "collector" {
  domain             = var.collector_domain
  project_id_or_name = module.vercel_collector.id
  team_id            = var.vercel_team_id == "" ? null : var.vercel_team_id
  depends_on         = [module.domains]
}
module "dns" {
  source  = "../../modules/dns"
  zone_id = var.cloudflare_zone_id
  dns_records = { (var.collector_domain) = {
    name    = var.dns_record_name
    type    = var.dns_record_type
    content = var.dns_record_type == "A" ? one(data.vercel_domain_config.collector.recommended_ipv4s) : data.vercel_domain_config.collector.recommended_cname
    proxied = false
  } }
  verification_dns_records = var.verification_dns_records
}
module "cloudflare_collector" {
  source                = "../../modules/cloudflare-collector"
  account_id            = var.cloudflare_account_id
  environment           = local.environment
  collector_origin      = "https://${var.collector_domain}"
  workers_dev_subdomain = var.workers_dev_subdomain
  bundle_path           = var.bundle_path
  bundle_sha256         = var.bundle_sha256
  compatibility_date    = var.compatibility_date
  compatibility_flags   = var.compatibility_flags
  settings              = var.settings
}
