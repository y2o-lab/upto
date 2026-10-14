resource "vercel_project" "collector" {
  name                                              = var.project_name
  team_id                                           = var.vercel_team_id == "" ? null : var.vercel_team_id
  root_directory                                    = "apps/collector"
  framework                                         = null
  node_version                                      = "24.x"
  install_command                                   = "pnpm install --frozen-lockfile"
  build_command                                     = "pnpm build:node"
  auto_assign_custom_domains                        = true
  automatically_expose_system_environment_variables = true
  git_fork_protection                               = true
  # No git_repository: only CI's Vercel CLI creates deployments.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [environment]
  }
}
