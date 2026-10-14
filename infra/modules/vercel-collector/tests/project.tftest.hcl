mock_provider "vercel" {}
variables {
  project_name = "upto-collector-staging"
}
run "cli_only_project" {
  command = plan
  assert {
    condition     = vercel_project.collector.root_directory == "apps/collector" && vercel_project.collector.framework == null && vercel_project.collector.git_repository == null
    error_message = "Collector must be a standalone Node project with no Git deployment integration."
  }
  assert {
    condition     = vercel_project.collector.node_version == "24.x" && vercel_project.collector.install_command == "pnpm install --frozen-lockfile" && vercel_project.collector.build_command == "pnpm build:node"
    error_message = "Terraform build settings must match vercel.json."
  }
}
