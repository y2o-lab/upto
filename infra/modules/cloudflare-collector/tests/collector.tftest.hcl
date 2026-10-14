mock_provider "cloudflare" {
  override_during = plan
}

override_resource {
  target          = cloudflare_d1_database.control
  override_during = plan
  values          = { id = "fixture-d1-id" }
}
override_resource {
  target          = cloudflare_queue.articles
  override_during = plan
  values          = { id = "fixture-queue-id" }
}

variables {
  account_id            = "00000000000000000000000000000000"
  environment           = "staging"
  collector_origin      = "https://collector-staging.example.com"
  workers_dev_subdomain = "fixture"
}

run "foundation_is_stopped" {
  command = plan
  assert {
    condition     = length(cloudflare_workers_script.control) == 0 && length(cloudflare_workflow.pipeline) == 0 && length(cloudflare_queue_consumer.articles) == 0
    error_message = "Foundation must not deploy a worker, workflows, or consumer."
  }
  assert {
    condition     = cloudflare_queue.articles.settings.delivery_paused && cloudflare_queue.dlq.settings.delivery_paused
    error_message = "Initial queues must be paused."
  }
}

run "worker_without_workflow_bindings" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "worker" }
    bundle_path = "../../bootstrap/control.mjs"
  }
  assert {
    condition     = alltrue([for binding in cloudflare_workers_script.control[0].bindings : binding.type != "workflow"])
    error_message = "First upload cannot reference unregistered workflows."
  }
  assert {
    condition     = cloudflare_workers_script.control[0].keep_bindings == toset(["secret_text"]) && cloudflare_workers_script.control[0].migrations.new_sqlite_classes == tolist(["CapacityGate", "GeminiGate"])
    error_message = "Preserve secrets and create SQLite DO classes."
  }
  assert {
    condition     = length(cloudflare_workers_cron_trigger.control[0].schedules) == 0
    error_message = "Bootstrap must have no Cron schedules."
  }
}

run "workflows_registered_before_binding" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "workflows" }
    bundle_path = "../../bootstrap/control.mjs"
  }
  assert {
    condition     = length(cloudflare_workflow.pipeline) == 2 && alltrue([for binding in cloudflare_workers_script.control[0].bindings : binding.type != "workflow"])
    error_message = "Register workflows without circular Worker dependencies."
  }
}

run "ready_binding_contract" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "ready" }
    bundle_path = "../../bootstrap/control.mjs"
  }
  assert {
    condition     = toset([for binding in cloudflare_workers_script.control[0].bindings : binding.name]) == toset(["CONTROL_DB", "ARTICLE_QUEUE", "CAPACITY_GATE", "GEMINI_GATE", "FEED_WORKFLOW", "ARTICLE_WORKFLOW", "COLLECTOR_CONFIG"])
    error_message = "Runtime binding names must match the contract."
  }
  assert {
    condition     = cloudflare_workflow.pipeline["feed"].class_name == "FeedWorkflow" && cloudflare_workflow.pipeline["article"].class_name == "ArticleWorkflow"
    error_message = "Workflow exports must match the bootstrap bundle."
  }
  assert {
    condition     = length(cloudflare_queue_consumer.articles) == 0 && jsondecode(one([for binding in cloudflare_workers_script.control[0].bindings : binding.json if binding.name == "COLLECTOR_CONFIG"])).mode == "paused"
    error_message = "Ready must still be stopped by default."
  }
}

run "reject_unverified_activation" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "ready", consumer_enabled = true }
    bundle_path = "../../bootstrap/control.mjs"
  }
  expect_failures = [terraform_data.activation]
}

run "reject_collection_in_drain" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "ready", control_mode = "drain", collection_crons = ["0 * * * *"], runtime_verified = true, secrets_verified = true }
    bundle_path = "../../bootstrap/control.mjs"
  }
  expect_failures = [terraform_data.activation]
}

run "drain_keeps_maintenance" {
  command = plan
  variables {
    settings    = { bootstrap_phase = "ready", control_mode = "drain", maintenance_crons = ["*/5 * * * *"], runtime_verified = true, secrets_verified = true }
    bundle_path = "../../bootstrap/control.mjs"
  }
  assert {
    condition     = toset([for schedule in cloudflare_workers_cron_trigger.control[0].schedules : schedule.cron]) == toset(["*/5 * * * *"])
    error_message = "Drain must keep the reconciliation schedule."
  }
}

run "reject_hash_mismatch" {
  command = plan
  variables {
    settings      = { bootstrap_phase = "worker" }
    bundle_path   = "../../bootstrap/control.mjs"
    bundle_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
  }
  expect_failures = [terraform_data.activation]
}

run "reject_duplicate_cron" {
  command = plan
  variables {
    settings = { collection_crons = ["*/5 * * * *"], maintenance_crons = ["*/5 * * * *"] }
  }
  expect_failures = [var.settings]
}

run "reject_invalid_limits" {
  command = plan
  variables {
    settings = { max_concurrency = 0 }
  }
  expect_failures = [var.settings]
}

run "trigger_migration_limits" {
  command = plan
  variables {
    bundle_path = "../../bootstrap/control.mjs"
    settings = {
      bootstrap_phase    = "ready"
      feed_concurrency   = 1
      stage_concurrency  = 1
      in_flight_limit    = 1
      max_items_per_feed = 3
      gemini_rpm         = 5
    }
  }
  assert {
    condition     = local.contract.feed_concurrency == 1 && local.contract.stage_concurrency == 1 && local.contract.in_flight_limit == 1 && local.contract.max_items_per_feed == 3 && local.contract.gemini_rpm == 5
    error_message = "The Worker contract must retain the migrated collection and RPM limits."
  }
}

run "reject_invalid_feed_limit" {
  command = plan
  variables {
    settings = { max_items_per_feed = 101 }
  }
  expect_failures = [var.settings]
}

run "reject_non_https_origin" {
  command = plan
  variables {
    collector_origin = "http://collector.example.com/path?key=bad"
  }
  expect_failures = [var.collector_origin]
}

run "active_runtime_configuration" {
  command = plan
  variables {
    bundle_path = "../../bootstrap/control.mjs"
    settings = {
      bootstrap_phase   = "ready"
      runtime_verified  = true
      secrets_verified  = true
      consumer_enabled  = true
      control_mode      = "active"
      gemini_project_id = "fixture-staging-gemini"
      collection_crons  = ["0 0,6,12,18 * * *"]
      maintenance_crons = ["*/5 * * * *"]
    }
  }
  assert {
    condition     = cloudflare_queue_consumer.articles[0].queue_id == cloudflare_queue.articles.id && cloudflare_queue_consumer.articles[0].dead_letter_queue == cloudflare_queue.dlq.queue_name && cloudflare_queue_consumer.articles[0].settings.max_concurrency == 2 && cloudflare_queue_consumer.articles[0].settings.max_retries == 3
    error_message = "Queue consumer must use the environment Queue/DLQ and bounded dispatch."
  }
  assert {
    condition     = one([for binding in cloudflare_workers_script.control[0].bindings : binding.id if binding.name == "CONTROL_DB"]) == cloudflare_d1_database.control.id && one([for binding in cloudflare_workers_script.control[0].bindings : binding.queue_name if binding.name == "ARTICLE_QUEUE"]) == cloudflare_queue.articles.queue_name
    error_message = "D1/Queue binding IDs must refer to this environment's resources."
  }
  assert {
    condition     = one([for binding in cloudflare_workers_script.control[0].bindings : binding.workflow_name if binding.name == "FEED_WORKFLOW"]) == cloudflare_workflow.pipeline["feed"].workflow_name && one([for binding in cloudflare_workers_script.control[0].bindings : binding.workflow_name if binding.name == "ARTICLE_WORKFLOW"]) == cloudflare_workflow.pipeline["article"].workflow_name
    error_message = "Workflow bindings must match registered names."
  }
  assert {
    condition     = !cloudflare_queue.articles.settings.delivery_paused && length(cloudflare_workers_cron_trigger.control[0].schedules) == 2 && output.gate_origin == "https://upto-collector-staging-control.fixture.workers.dev"
    error_message = "Only verified ready configuration may enable collection."
  }
}
