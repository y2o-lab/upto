terraform {
  required_version = "= 1.11.4"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "= 5.24.0" }
    vercel     = { source = "vercel/vercel", version = "= 5.14.0" }
  }
}
