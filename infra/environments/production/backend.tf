# Backend values are deliberately supplied from the ignored backend.hcl file.
# Terraform backends cannot use input variables or provider credentials.
terraform {
  backend "s3" {}
}
