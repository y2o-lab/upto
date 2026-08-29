output "domains" {
  description = "Custom domains associated with the Vercel project."
  value       = [for domain in values(vercel_project_domain.custom) : domain.domain]
}
