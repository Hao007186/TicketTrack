locals {
  image_uri = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"

  # 不是機密的設定；機密在冷啟動時從 SSM_PARAMETER_PATH 讀進來
  lambda_env = {
    ENV                = "prod"
    SSM_PARAMETER_PATH = local.ssm_path
    APP_BASE_URL       = "https://${var.domain}"
    EMAIL_SENDER       = "ses"
    EMAIL_FROM         = local.email_from
    LOG_LEVEL          = "INFO"
  }

  lambdas = {
    api  = { timeout = 30, command = null }
    jobs = { timeout = 900, command = ["app.lambda_handlers.jobs_handler"] }
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# 兩個 Lambda 都只能讀 /farewatch/prod/ 底下的參數
data "aws_iam_policy_document" "read_ssm" {
  statement {
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(local.ssm_path, "/")}*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "jobs" {
  name               = "${local.name}-jobs"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

locals {
  lambda_roles = {
    api  = aws_iam_role.api
    jobs = aws_iam_role.jobs
  }
}

resource "aws_iam_role_policy_attachment" "basic" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "read_ssm" {
  for_each = local.lambda_roles
  name     = "read-ssm"
  role     = each.value.id
  policy   = data.aws_iam_policy_document.read_ssm.json
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambdas
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  role          = aws_iam_role.api.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = local.lambdas.api.timeout

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.basic]
}

resource "aws_lambda_function" "jobs" {
  function_name = "${local.name}-jobs"
  role          = aws_iam_role.jobs.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  architectures = ["arm64"]
  memory_size   = 512
  # 最壞情況：8 個查價 × SerpApi 逾時 60 秒，再加上寄信
  timeout = local.lambdas.jobs.timeout

  image_config {
    command = local.lambdas.jobs.command
  }

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.basic]
}

# 公開網址；只接受 CloudFront 帶著 X-Origin-Verify 的請求（app 的 middleware 檢查）
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}
