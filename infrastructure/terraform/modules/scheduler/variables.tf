variable "project_id" { type = string }
variable "region" { type = string }
variable "environment" { type = string }

variable "service_urls" {
  description = "Base URL per logical service (notifications, device-management, academic-analytics, organization, group-intelligence)"
  type        = map(string)
}

variable "internal_token_secret_id" {
  description = "Secret Manager secret id holding INTERNAL_API_TOKEN"
  type        = string
}

variable "invoker_service_account_email" {
  description = "Service account with roles/run.invoker on the target services"
  type        = string
}

variable "institution_ids" {
  description = "Institutions that get daily analytics snapshot and retention jobs"
  type        = list(string)
  default     = []
}

variable "time_zone" {
  type    = string
  default = "America/Sao_Paulo"
}

variable "retention_dry_run" {
  description = "Run retention in dry-run mode (recommended until policies are reviewed)"
  type        = bool
  default     = true
}

variable "paused" {
  type    = bool
  default = false
}
