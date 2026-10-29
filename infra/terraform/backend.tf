# state 存在手動建立的 S3 bucket（不能讓 Terraform 自己建，否則一開始沒地方存 state）。
# bucket 名稱含帳號 ID，用 init 時的 -backend-config="bucket=..." 傳入，見 docs/deploy-runbook.md
terraform {
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
    encrypt      = true
  }
}
