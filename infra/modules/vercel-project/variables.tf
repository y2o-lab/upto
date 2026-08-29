variable "project_name" {
  description = "Name of the Vercel project that deploys apps/web."
  type        = string
}

variable "vercel_team_id" {
  description = "Vercel team ID, or an empty string for a personal project."
  type        = string
}

variable "git_repository" {
  description = "GitHub repository in owner/repository form connected to the Vercel project."
  type        = string
}

variable "production_branch" {
  description = "Git branch Vercel deploys to production. Other branches create preview deployments."
  type        = string
}
