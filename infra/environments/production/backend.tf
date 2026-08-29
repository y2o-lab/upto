terraform {
  backend "s3" {
    bucket                      = "upto-tf-backend"
    key                         = "web-production/terraform.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    skip_region_validation      = true
    skip_requesting_account_id  = true

    endpoints = {
      s3 = "https://06109ed4642ce78eccfe61da32f44c9b.r2.cloudflarestorage.com"
    }
  }
}
