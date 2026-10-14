locals {
  prefix = "upto-collector-${var.environment}"
  phase  = index(["foundation", "worker", "workflows", "ready"], var.settings.bootstrap_phase)
  workflows = {
    feed    = { name = "${local.prefix}-feed", class = "FeedWorkflow", binding = "FEED_WORKFLOW" }
    article = { name = "${local.prefix}-article", class = "ArticleWorkflow", binding = "ARTICLE_WORKFLOW" }
  }
  contract = {
    environment               = var.environment
    mode                      = var.settings.control_mode
    collector_origin          = var.collector_origin
    collection_crons          = sort(tolist(var.settings.collection_crons))
    maintenance_crons         = sort(tolist(var.settings.maintenance_crons))
    feed_concurrency          = var.settings.feed_concurrency
    max_items_per_feed        = var.settings.max_items_per_feed
    stage_concurrency         = var.settings.stage_concurrency
    in_flight_limit           = var.settings.in_flight_limit
    gemini_project_id         = var.settings.gemini_project_id
    gemini_rpm                = var.settings.gemini_rpm
    gemini_tpm                = var.settings.gemini_tpm
    gemini_rpd                = var.settings.gemini_rpd
    maintenance_page_limit    = var.settings.maintenance_page_limit
    maintenance_time_limit_ms = var.settings.maintenance_time_limit_ms
    cleanup_delete_limit      = var.settings.cleanup_delete_limit
  }
}

resource "terraform_data" "activation" {
  input = var.settings.bootstrap_phase
  lifecycle {
    precondition {
      condition     = local.phase == 0 || (var.bundle_path != "" && can(file(var.bundle_path)))
      error_message = "Worker phases require a readable module bundle."
    }
    precondition {
      condition     = var.bundle_sha256 == "" || try(filesha256(var.bundle_path) == var.bundle_sha256, false)
      error_message = "Worker bundle hash differs from the release manifest."
    }
    precondition {
      condition     = (!var.settings.consumer_enabled && length(setunion(var.settings.collection_crons, var.settings.maintenance_crons)) == 0 && var.settings.control_mode == "paused") || (local.phase == 3 && var.settings.runtime_verified && var.settings.secrets_verified)
      error_message = "Activation requires ready phase and verified runtime, connectivity, migrations, and secret retention."
    }
    precondition {
      condition     = length(var.settings.collection_crons) == 0 || (var.settings.control_mode == "active" && var.settings.consumer_enabled && var.settings.gemini_project_id != "")
      error_message = "Collection Cron requires active mode, a consumer, and an environment-specific Gemini project."
    }
  }
}

resource "cloudflare_d1_database" "control" {
  account_id = var.account_id
  name       = "${local.prefix}-control"
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_queue" "articles" {
  account_id = var.account_id
  queue_name = "${local.prefix}-articles"
  settings = {
    message_retention_period = var.settings.queue_retention_seconds
    delivery_delay           = 0
    delivery_paused          = !var.settings.consumer_enabled || var.settings.control_mode == "paused"
  }
  depends_on = [terraform_data.activation]
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_queue" "dlq" {
  account_id = var.account_id
  queue_name = "${local.prefix}-dlq"
  settings = {
    message_retention_period = var.settings.queue_retention_seconds
    delivery_delay           = 0
    delivery_paused          = true
  }
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_workers_script" "control" {
  count               = local.phase >= 1 ? 1 : 0
  account_id          = var.account_id
  script_name         = "${local.prefix}-control"
  content_file        = var.bundle_path
  content_sha256      = try(filesha256(var.bundle_path), "")
  content_type        = "application/javascript+module"
  main_module         = basename(var.bundle_path)
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags
  keep_bindings       = ["secret_text"]
  observability       = { enabled = true, head_sampling_rate = 1 }
  migrations = {
    new_tag            = "v1"
    new_sqlite_classes = ["CapacityGate", "GeminiGate"]
  }
  bindings = concat([
    { name = "CONTROL_DB", type = "d1", id = cloudflare_d1_database.control.id },
    { name = "ARTICLE_QUEUE", type = "queue", queue_name = cloudflare_queue.articles.queue_name },
    { name = "CAPACITY_GATE", type = "durable_object_namespace", class_name = "CapacityGate" },
    { name = "GEMINI_GATE", type = "durable_object_namespace", class_name = "GeminiGate" },
    { name = "COLLECTOR_CONFIG", type = "json", json = jsonencode(local.contract) }
    ], local.phase == 3 ? [for workflow in values(local.workflows) : {
      name = workflow.binding, type = "workflow", workflow_name = workflow.name, class_name = workflow.class
  }] : [])
  depends_on = [terraform_data.activation]
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_workflow" "pipeline" {
  for_each      = local.phase >= 2 ? local.workflows : {}
  account_id    = var.account_id
  workflow_name = each.value.name
  class_name    = each.value.class
  script_name   = cloudflare_workers_script.control[0].script_name
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_workers_script_subdomain" "gate" {
  count            = local.phase >= 1 ? 1 : 0
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.control[0].script_name
  enabled          = true
  previews_enabled = false
}
resource "cloudflare_queue_consumer" "articles" {
  count             = var.settings.consumer_enabled ? 1 : 0
  account_id        = var.account_id
  queue_id          = cloudflare_queue.articles.id
  type              = "worker"
  script_name       = try(cloudflare_workers_script.control[0].script_name, "${local.prefix}-control")
  dead_letter_queue = cloudflare_queue.dlq.queue_name
  settings = {
    batch_size       = var.settings.batch_size
    max_wait_time_ms = var.settings.batch_wait_ms
    max_retries      = var.settings.max_retries
    retry_delay      = var.settings.retry_delay_seconds
    max_concurrency  = var.settings.max_concurrency
  }
  depends_on = [cloudflare_workflow.pipeline, terraform_data.activation]
}
# One resource owns the entire Cron set, including the empty bootstrap set.
resource "cloudflare_workers_cron_trigger" "control" {
  count       = local.phase >= 1 ? 1 : 0
  account_id  = var.account_id
  script_name = cloudflare_workers_script.control[0].script_name
  schedules   = [for cron in sort(tolist(setunion(var.settings.collection_crons, var.settings.maintenance_crons))) : { cron = cron }]
  depends_on  = [cloudflare_workflow.pipeline, cloudflare_queue_consumer.articles, terraform_data.activation]
}
