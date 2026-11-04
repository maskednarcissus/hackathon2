variable "project_id" {
  description = "The Google Cloud Project ID"
  type        = string
}

variable "region" {
  description = "Primary GCP Region (Default: São Paulo, Brazil)"
  type        = string
  default     = "southamerica-east1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, production)"
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "Environment must be one of: dev, staging, production."
  }
}

variable "database_tier" {
  description = "Machine tier for Cloud SQL Postgres"
  type        = string
  default     = "db-custom-4-15360"
}

variable "enable_alloydb" {
  description = "Whether to deploy AlloyDB cluster instead of standard Cloud SQL"
  type        = bool
  default     = false
}

variable "audio_retention_days" {
  description = "Retention period for raw audio files in days under LGPD policy"
  type        = number
  default     = 90
}

variable "service_urls" {
  description = "Cloud Run base URL per logical service name (keys as in infrastructure/events/subscriptions.yaml)"
  type        = map(string)
  default     = {}
}

variable "scheduled_institution_ids" {
  description = "Institutions that get daily analytics snapshot and retention jobs"
  type        = list(string)
  default     = []
}

variable "retention_dry_run" {
  description = "Run scheduled retention as a dry run (no deletions)"
  type        = bool
  default     = true
}

variable "group_holding_companies" {
  description = "Holding companies for Group Intelligence reader views: key = slug, value = { id, readers = [IAM members] }"
  type = map(object({
    id      = string
    readers = list(string)
  }))
  default = {}
}
