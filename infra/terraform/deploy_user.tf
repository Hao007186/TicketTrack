# GitHub Actions 自動部署用的 IAM 使用者（帳號的 SCP 不允許建 OIDC provider，所以用存取金鑰）。
# 存取金鑰由使用者在主控台手動建立，不用 Terraform 建，否則金鑰會存進 state。
# 權限只夠推 image、更新 2 個 Lambda、上傳前端；不能讀 SSM、不能動 IAM。
# 已知風險：能部署任意程式到 Lambda，而 Lambda 讀得到機密；外洩時的處理見 docs/deploy-runbook.md

resource "aws_iam_user" "deploy" {
  name = "${local.name}-deploy"
}

data "aws_iam_policy_document" "deploy" {
  # AWS 規定這個動作只能給 *
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushAndPull"
    actions = [
      # push-image.sh 先查 tag 是否已存在
      "ecr:DescribeImages",
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      # 更新 Lambda 的 image 時，呼叫者也要能讀這個 image
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.backend.arn]
  }

  statement {
    sid = "UpdateLambdas"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = [aws_lambda_function.api.arn, aws_lambda_function.jobs.arn]
  }

  statement {
    sid       = "ListFrontendBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]
  }

  statement {
    sid       = "UploadFrontend"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }

  statement {
    sid       = "InvalidateCache"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_user_policy" "deploy" {
  name   = "deploy"
  user   = aws_iam_user.deploy.name
  policy = data.aws_iam_policy_document.deploy.json
}
