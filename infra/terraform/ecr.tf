resource "aws_ecr_repository" "backend" {
  name = "${local.name}-backend"
  # tag 用 git SHA，不允許覆蓋，回滾時才知道每個 tag 對應哪一版
  image_tag_mutability = "IMMUTABLE"
}

# 只保留最新 3 個 image，避免儲存費累積
resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "只保留最新 3 個 image"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = { type = "expire" }
    }]
  })
}
