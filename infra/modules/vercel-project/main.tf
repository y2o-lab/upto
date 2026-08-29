resource "vercel_project" "web" {
  name    = var.project_name
  team_id = var.vercel_team_id == "" ? null : var.vercel_team_id

  # The repository is a pnpm workspace. Vercel uses apps/web to detect Next.js
  # while the build runs from the workspace root to resolve internal packages.
  framework      = "nextjs"
  node_version   = "24.x"
  root_directory = "apps/web"
  build_command  = "cd ../.. && pnpm --filter @upto/web build"

  auto_assign_custom_domains                        = true
  automatically_expose_system_environment_variables = true
  enable_affected_projects_deployments              = true
  git_fork_protection                               = true
  # Vercel invokes this from apps/web. The script limits previews to the
  # configured branch and skips builds without web or workspace-package changes.
  ignore_command = "UPTO_VERCEL_PREVIEW_BRANCH=${var.preview_branch} bash ../../infra/scripts/vercel-ignore-build.sh"

  git_repository = {
    type              = "github"
    repo              = var.git_repository
    production_branch = var.production_branch
  }

  # Runtime credentials are intentionally configured in Vercel's secret store,
  # not Terraform state. This also preserves existing project environment vars
  # when importing a previously dashboard-managed project.
  lifecycle {
    ignore_changes = [environment]
  }
}
