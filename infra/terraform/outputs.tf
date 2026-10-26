output "ecr_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "api_function_url" {
  description = "直接打這個網址應該回 403（驗收用）"
  value       = aws_lambda_function_url.api.function_url
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}
