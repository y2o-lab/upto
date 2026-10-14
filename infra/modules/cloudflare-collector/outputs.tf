output "identifiers" {
  value = {
    d1_id            = cloudflare_d1_database.control.id
    article_queue_id = cloudflare_queue.articles.id
    dlq_id           = cloudflare_queue.dlq.id
    worker_name      = try(cloudflare_workers_script.control[0].script_name, null)
    workflows        = { for key, workflow in cloudflare_workflow.pipeline : key => workflow.workflow_name }
  }
}
output "gate_origin" {
  description = "Configured workers.dev origin; bootstrap must verify account subdomain and actual HTTPS reachability."
  value       = local.phase >= 1 ? "https://${local.prefix}-control.${var.workers_dev_subdomain}.workers.dev" : null
}
output "runtime_contract" { value = local.contract }
output "bootstrap_phase" { value = var.settings.bootstrap_phase }
