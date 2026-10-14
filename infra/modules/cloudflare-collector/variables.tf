variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a Cloudflare account ID."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}
variable "collector_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.collector_origin))
    error_message = "collector_origin must be an HTTPS origin without path, port, query, or credentials."
  }
}
variable "workers_dev_subdomain" {
  description = "Existing account workers.dev subdomain; verify it before Apply. Terraform does not rename the account subdomain."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.workers_dev_subdomain))
    error_message = "workers_dev_subdomain must be an existing account subdomain."
  }
}
variable "bundle_path" {
  type    = string
  default = ""
}
variable "bundle_sha256" {
  type    = string
  default = ""
  validation {
    condition     = var.bundle_sha256 == "" || can(regex("^[a-f0-9]{64}$", var.bundle_sha256))
    error_message = "bundle_sha256 must be a SHA-256 hex digest."
  }
}
variable "compatibility_date" {
  type    = string
  default = "2026-10-11"
  validation {
    condition     = can(formatdate("YYYY-MM-DD", "${var.compatibility_date}T00:00:00Z"))
    error_message = "compatibility_date must be a valid YYYY-MM-DD date."
  }
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
  default = {}
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
