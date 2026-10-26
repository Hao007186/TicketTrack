# CloudFront 轉送到 Lambda 時帶的密碼標頭。CloudFront 的設定本來就會存這個值，
# 所以由 Terraform 產生；其他機密由使用者用 AWS CLI 填進 SSM，Terraform 不碰
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "origin_verify" {
  name  = "${local.ssm_path}origin_verify_secret"
  type  = "SecureString"
  value = random_password.origin_verify.result
}
