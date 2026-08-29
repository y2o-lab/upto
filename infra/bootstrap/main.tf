provider "cloudflare" {}

# This root module intentionally uses local state only once, to create the
# bucket that will subsequently hold the production root module's remote state.
resource "cloudflare_r2_bucket" "terraform_state" {
  account_id = var.cloudflare_account_id
  name       = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}
