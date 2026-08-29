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
  description = "Git branch Vercel deploys to production."
  type        = string
}

variable "preview_branch" {
  description = "The only Git branch permitted to create Vercel preview deployments."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$", var.preview_branch))
    error_message = "preview_branch must be a valid Git branch name without shell-special characters."
  }
}
