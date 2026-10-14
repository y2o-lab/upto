mock_provider "cloudflare" {}
mock_provider "vercel" {
  mock_data "vercel_domain_config" {
    defaults = { recommended_cname = "fixture.vercel-dns.com", recommended_ipv4s = ["192.0.2.1"] }
  }
}
variables {
  cloudflare_account_id = "00000000000000000000000000000000"
  cloudflare_zone_id    = "11111111111111111111111111111111"
  collector_domain      = "collector-production.example.com"
  dns_record_name       = "collector-production"
  workers_dev_subdomain = "fixture"
}
run "isolated_stopped_root" {
  command = plan
  assert {
    condition     = local.environment == "production" && module.cloudflare_collector.runtime_contract.environment == "production" && module.cloudflare_collector.bootstrap_phase == "foundation"
    error_message = "Root must fix its environment and default to stopped foundation."
  }
  assert {
    condition     = module.cloudflare_collector.gate_origin == null && output.collector_origin == "https://collector-production.example.com"
    error_message = "Collector endpoints must be isolated and the foundation must not expose a Gate."
  }
}
