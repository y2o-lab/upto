data "vercel_domain_config" "custom" {
  for_each = var.vercel_domains

  domain             = each.key
  project_id_or_name = module.vercel_project.id
  team_id            = var.vercel_team_id == "" ? null : var.vercel_team_id

  # A custom domain must first be associated with the Vercel project before
  # Vercel can return the DNS record it recommends for that domain.
  depends_on = [module.vercel_domains]
}
