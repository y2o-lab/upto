variable "cloudflare_account_id" {
  description = "Set the non-secret target account ID before the first Plan."
  type        = string
  # TODO: 初回Plan前に、collectorを配置するCloudflare account IDへ置換する。
  default = "TODO"
}
variable "cloudflare_zone_id" {
  type = string
  # TODO: 初回Plan前に、collectorドメインを管理するzone IDへ置換する。
  default = "TODO"
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a zone ID."
  }
}
variable "vercel_team_id" {
  type = string
  # TODO: team利用時はteam IDを記入する。personal accountの場合のみ空文字のまま。
  default = ""
}
variable "collector_domain" {
  description = "Dedicated environment hostname, confirmed not to overlap existing Web or the other collector environment."
  type        = string
  # TODO: production専用のFQDNへ置換する。staging初回Plan前に両環境の予約domainを記入する。
  default = "TODO"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$", var.collector_domain)) && !contains(["upto.yuno-i.com", "www.upto.yuno-i.com"], var.collector_domain)
    error_message = "Use a dedicated collector FQDN, distinct from existing Web."
  }
}
variable "dns_record_name" {
  description = "Collector hostname relative to the selected zone."
  type        = string
  # TODO: collector_domainに合わせてzone内のrecord名を確認・変更する。
  default = "collector"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*$", var.dns_record_name)) && var.dns_record_name != "upto"
    error_message = "Use a dedicated collector DNS record."
  }
}
variable "dns_record_type" {
  type    = string
  default = "CNAME"
  validation {
    condition     = contains(["A", "CNAME"], var.dns_record_type)
    error_message = "DNS record type must be A or CNAME."
  }
}
variable "verification_dns_records" {
  type    = map(object({ name = string, content = string, ttl = optional(number, 1), comment = optional(string, "Collector ownership verification") }))
  default = {}
}
variable "workers_dev_subdomain" {
  type = string
  # TODO: 既存のworkers.dev subdomainへ置換する（https://や.workers.devを含めない）。
  default = "TODO"
}
variable "bundle_path" {
  type    = string
  default = ""
}
variable "bundle_sha256" {
  type    = string
  default = ""
}
variable "compatibility_date" {
  type    = string
  default = "2026-10-11"
}
variable "compatibility_flags" {
  type    = set(string)
  default = []
}
variable "settings" {
  description = "Non-secret runtime configuration. Verification flags are evidence gates, not proof of staging acceptance."
  type = object({
    bootstrap_phase           = optional(string, "foundation")
    consumer_enabled          = optional(bool, false)
    control_mode              = optional(string, "paused")
    runtime_verified          = optional(bool, false)
    secrets_verified          = optional(bool, false)
    collection_crons          = optional(set(string), [])
    maintenance_crons         = optional(set(string), [])
    queue_retention_seconds   = optional(number, 86400)
    max_retries               = optional(number, 3)
    retry_delay_seconds       = optional(number, 60)
    max_concurrency           = optional(number, 2)
    batch_size                = optional(number, 1)
    batch_wait_ms             = optional(number, 1000)
    feed_concurrency          = optional(number, 1)
    max_items_per_feed        = optional(number, 20)
    stage_concurrency         = optional(number, 2)
    in_flight_limit           = optional(number, 4)
    gemini_project_id         = optional(string, "")
    gemini_rpm                = optional(number, 1)
    gemini_tpm                = optional(number, 1000)
    gemini_rpd                = optional(number, 1)
    maintenance_page_limit    = optional(number, 50)
    maintenance_time_limit_ms = optional(number, 10000)
    cleanup_delete_limit      = optional(number, 100)
  })
  default = {
    bootstrap_phase    = "foundation"
    control_mode       = "paused"
    consumer_enabled   = false
    runtime_verified   = false
    secrets_verified   = false
    collection_crons   = []
    maintenance_crons  = []
    max_concurrency    = 1
    feed_concurrency   = 1
    stage_concurrency  = 1
    in_flight_limit    = 1
    max_items_per_feed = 3
    gemini_rpm         = 5
  }
  validation {
    condition     = contains(["foundation", "worker", "workflows", "ready"], var.settings.bootstrap_phase) && contains(["paused", "active", "drain"], var.settings.control_mode)
    error_message = "Use a supported bootstrap phase and control mode."
  }
  validation {
    condition     = alltrue([for n in [var.settings.max_concurrency, var.settings.batch_size, var.settings.feed_concurrency, var.settings.stage_concurrency, var.settings.in_flight_limit, var.settings.gemini_rpm, var.settings.gemini_tpm, var.settings.gemini_rpd, var.settings.maintenance_page_limit, var.settings.maintenance_time_limit_ms, var.settings.cleanup_delete_limit] : n > 0 && n == floor(n)]) && var.settings.max_items_per_feed >= 1 && var.settings.max_items_per_feed <= 100 && var.settings.max_items_per_feed == floor(var.settings.max_items_per_feed) && var.settings.max_retries >= 0 && var.settings.max_retries <= 100 && var.settings.max_retries == floor(var.settings.max_retries) && var.settings.queue_retention_seconds == floor(var.settings.queue_retention_seconds) && var.settings.retry_delay_seconds == floor(var.settings.retry_delay_seconds) && var.settings.batch_wait_ms == floor(var.settings.batch_wait_ms) && var.settings.queue_retention_seconds >= 60 && var.settings.queue_retention_seconds <= 1209600 && var.settings.retry_delay_seconds >= 0 && var.settings.retry_delay_seconds <= 43200 && var.settings.max_concurrency <= 250 && var.settings.batch_size <= 100 && var.settings.batch_wait_ms >= 0 && var.settings.batch_wait_ms <= 60000
    error_message = "Queue, concurrency, budget, and maintenance limits must be bounded positive integers (retry/wait can be zero)."
  }
  validation {
    condition     = length(setintersection(var.settings.collection_crons, var.settings.maintenance_crons)) == 0 && alltrue([for cron in setunion(var.settings.collection_crons, var.settings.maintenance_crons) : length(split(" ", trimspace(cron))) == 5])
    error_message = "Cron sets must contain distinct UTC expressions with five fields."
  }
}

variable "vercel_org_id" {
  description = "Non-secret personal account owner ID for CLI deployment; leave empty for team projects."
  type        = string
  # TODO: personal accountの場合はowner IDを記入する。team利用時は空文字のまま。
  default = ""
}
variable "bootstrap_probe_action" {
  description = "Staging-only post-Apply secret retention probe, selected in the reviewed Terraform configuration."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "inject", "verify"], var.bootstrap_probe_action)
    error_message = "Use none, inject, or verify."
  }
}
