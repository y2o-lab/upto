"""Check the provider's real schema instead of accepting guessed resource attributes."""
import json
import sys

schema = json.load(sys.stdin)["provider_schemas"]
cloudflare = schema["registry.terraform.io/cloudflare/cloudflare"]["resource_schemas"]
required = {
    "cloudflare_d1_database": {"account_id", "name", "id"},
    "cloudflare_queue": {"account_id", "queue_name", "settings", "id"},
    "cloudflare_queue_consumer": {"account_id", "queue_id", "script_name", "dead_letter_queue", "settings"},
    "cloudflare_workers_script": {"content_file", "content_sha256", "main_module", "keep_bindings", "bindings", "migrations", "observability", "compatibility_date", "compatibility_flags"},
    "cloudflare_workflow": {"account_id", "script_name", "workflow_name", "class_name"},
    "cloudflare_workers_cron_trigger": {"script_name", "schedules"},
    "cloudflare_workers_script_subdomain": {"enabled", "previews_enabled", "script_name"},
}
for resource, attributes in required.items():
    if not attributes <= cloudflare[resource]["block"]["attributes"].keys():
        raise SystemExit(f"Missing provider attributes for {resource}")
worker = cloudflare["cloudflare_workers_script"]["block"]["attributes"]
if worker["keep_bindings"]["type"] != ["set", "string"] or "new_sqlite_classes" not in worker["migrations"]["nested_type"]["attributes"]:
    raise SystemExit("Secret preservation or SQLite DO migrations are unsupported")
bindings = worker["bindings"]["nested_type"]["attributes"]
if not {"id", "class_name", "queue_name", "workflow_name", "json"} <= bindings.keys():
    raise SystemExit("Collector bindings are unsupported")
vercel = schema["registry.terraform.io/vercel/vercel"]["resource_schemas"]["vercel_project"]["block"]["attributes"]
if not {"root_directory", "node_version", "build_command", "install_command", "environment", "framework", "git_repository"} <= vercel.keys():
    raise SystemExit("Collector Vercel project settings are unsupported")
print("Collector provider schema contract passed (Cloudflare 5.24.0 / Vercel 5.14.0 locks).")
