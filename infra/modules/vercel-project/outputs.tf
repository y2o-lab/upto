output "id" {
  description = "ID of the Vercel project that receives Git deployments."
  value       = vercel_project.web.id
}
