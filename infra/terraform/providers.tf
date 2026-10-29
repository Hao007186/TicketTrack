# 帳號只開放 ap-southeast-2（雪梨），其他區域被 SCP 擋（us-east-1 的 ACM 例外）
provider "aws" {
  region = "ap-southeast-2"

  default_tags {
    tags = {
      Project = "farewatch"
    }
  }
}

# CloudFront 規定 HTTPS 憑證必須建在 us-east-1，只有憑證用這個 provider
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project = "farewatch"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
