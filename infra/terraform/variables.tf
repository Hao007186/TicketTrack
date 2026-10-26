variable "domain" {
  description = "網站與寄信用的網域（根網域）"
  type        = string
  default     = "hao007186.com"
}

variable "image_tag" {
  description = "要部署的 backend image tag（git SHA）"
  type        = string
}

variable "alert_email" {
  description = "告警與費用通知要寄到的信箱"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token，權限只限這個網域的 DNS 編輯"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "網域在 Cloudflare 的 Zone ID"
  type        = string
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "farewatch"
  ssm_path   = "/farewatch/prod/"
  email_from = "FareWatch <noreply@${var.domain}>"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}
