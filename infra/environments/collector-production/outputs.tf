output "collector_project_id" { value = module.vercel_collector.id }
output "collector_domain" { value = var.collector_domain }
output "collector_origin" { value = "https://${var.collector_domain}" }
output "gate_origin" { value = module.cloudflare_collector.gate_origin }
output "cloudflare_identifiers" { value = module.cloudflare_collector.identifiers }
output "runtime_contract" { value = module.cloudflare_collector.runtime_contract }
output "bootstrap_phase" { value = module.cloudflare_collector.bootstrap_phase }
