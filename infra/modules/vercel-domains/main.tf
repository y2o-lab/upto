resource "vercel_project_domain" "custom" {
  for_each = var.vercel_domains

  project_id = var.project_id
  domain     = each.key
  team_id    = var.vercel_team_id == "" ? null : var.vercel_team_id
}
