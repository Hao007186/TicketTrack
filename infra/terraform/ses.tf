# 用自己的網域寄信：Easy DKIM（3 筆 CNAME）＋自訂 MAIL FROM（退信地址），DNS 記錄在 dns.tf
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# 只有 jobs Lambda 會寄信
data "aws_iam_policy_document" "send_email" {
  statement {
    actions = ["ses:SendEmail"]
    # 寄件網域與收件地址都要授權：沙盒期間 SES 也會檢查「已驗證的收件信箱」這個 identity
    resources = ["arn:aws:ses:${local.region}:${local.account_id}:identity/*"]
  }
}

resource "aws_iam_role_policy" "jobs_send_email" {
  name   = "send-email"
  role   = aws_iam_role.jobs.id
  policy = data.aws_iam_policy_document.send_email.json
}
