provider "aws" {
  region = "ap-southeast-1"

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
