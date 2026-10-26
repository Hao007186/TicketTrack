# Cloudflare 的 DNS 記錄；全部 DNS only（不經過 Cloudflare 代理），ttl = 1 代表自動

# 網站：根網域指向 CloudFront（Cloudflare 會自動把根網域的 CNAME 攤平成 A/AAAA）
resource "cloudflare_dns_record" "site" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "CNAME"
  content = aws_cloudfront_distribution.site.domain_name
  ttl     = 1
  proxied = false
}

# ACM 憑證的 DNS 驗證
resource "cloudflare_dns_record" "acm_validation" {
  for_each = {
    for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => o
  }
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 1
  proxied = false
}

# SES Easy DKIM：固定 3 筆（token 要到 apply 才知道，所以用 count 而不是 for_each）
resource "cloudflare_dns_record" "ses_dkim" {
  count   = 3
  zone_id = var.cloudflare_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  content = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"
  ttl     = 1
  proxied = false
}

# 自訂 MAIL FROM（mail.<domain>）：退信送回 SES，SPF 允許 SES 代寄
resource "cloudflare_dns_record" "mail_from_mx" {
  zone_id  = var.cloudflare_zone_id
  name     = "mail.${var.domain}"
  type     = "MX"
  content  = "feedback-smtp.${local.region}.amazonses.com"
  priority = 10
  ttl      = 1
  proxied  = false
}

resource "cloudflare_dns_record" "mail_from_spf" {
  zone_id = var.cloudflare_zone_id
  name    = "mail.${var.domain}"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 1
  proxied = false
}

# DMARC 先用 p=none（只觀察不擋信），確認寄信都正常後再收緊
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none\""
  ttl     = 1
  proxied = false
}
