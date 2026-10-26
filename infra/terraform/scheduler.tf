# EventBridge Scheduler 叫醒 jobs Lambda；時間都是台灣時間
locals {
  schedules = {
    check-prices = { cron = "cron(0 8 * * ? *)", job = "check_prices" }
    # 查價後重寄兩次：只寄仍待寄的信，避免頻繁叫醒 Neon
    resend-1    = { cron = "cron(0 9 * * ? *)", job = "send_notifications" }
    resend-2    = { cron = "cron(0 11 * * ? *)", job = "send_notifications" }
    maintenance = { cron = "cron(10 0 * * ? *)", job = "maintenance" }
  }
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "invoke_jobs" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.jobs.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke_jobs" {
  name   = "invoke-jobs"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.invoke_jobs.json
}

resource "aws_scheduler_schedule" "jobs" {
  for_each = local.schedules

  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value.cron
  schedule_expression_timezone = "Asia/Taipei"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.jobs.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = each.value.job })

    # 不自動重試：查價重試會重複花 SerpApi 額度；失敗由告警通知
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# Scheduler 用非同步方式呼叫 Lambda；Lambda 對非同步呼叫的失敗與逾時預設會再重試 2 次，
# 上面的 retry_policy 只管 Scheduler 自己的投遞，所以這裡也要關掉
resource "aws_lambda_function_event_invoke_config" "jobs" {
  function_name          = aws_lambda_function.jobs.function_name
  maximum_retry_attempts = 0
}
