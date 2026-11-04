variable "project_id" { type = string }
variable "environment" { type = string }

variable "subscriptions_file" {
  description = "Path to infrastructure/events/subscriptions.yaml"
  type        = string
}

variable "service_urls" {
  description = "Base URL (Cloud Run URL) per logical service name used in subscriptions.yaml"
  type        = map(string)
  default     = {}
}

variable "max_delivery_attempts" {
  description = "Delivery attempts before a message is moved to the dead-letter topic (5–100)"
  type        = number
  default     = 10
  validation {
    condition     = var.max_delivery_attempts >= 5 && var.max_delivery_attempts <= 100
    error_message = "max_delivery_attempts must be between 5 and 100."
  }
}
