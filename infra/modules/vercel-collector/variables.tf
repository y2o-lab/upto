variable "project_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,98}$", var.project_name))
    error_message = "Use a lowercase collector project name."
  }
}
variable "vercel_team_id" {
  type    = string
  default = ""
}
