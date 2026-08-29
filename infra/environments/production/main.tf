module "vercel_project" {
  source = "../../modules/vercel-project"

  project_name      = var.vercel_project_name
  vercel_team_id    = var.vercel_team_id
  git_repository    = var.vercel_git_repository
  production_branch = var.vercel_production_branch
}

module "vercel_domains" {
  source = "../../modules/vercel-domains"

  project_id     = module.vercel_project.id
  vercel_team_id = var.vercel_team_id
  vercel_domains = var.vercel_domains
}

module "dns" {
  source = "../../modules/dns"

  dns_records = local.vercel_dns_records
  zone_id     = var.cloudflare_zone_id
  verification_dns_records = var.verification_dns_records
}
