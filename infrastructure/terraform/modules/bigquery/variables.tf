variable "project_id" { type = string }
variable "environment" { type = string }

variable "location" {
  description = "BigQuery location (data residency: keep in Brazil)"
  type        = string
  default     = "southamerica-east1"
}

variable "kms_key_name" {
  description = "Optional CMEK key for the datasets (projects/…/cryptoKeys/…)"
  type        = string
  default     = null
}

variable "writer_service_account" {
  description = "Email of the group-intelligence service account (writes facts, runs queries)"
  type        = string
}

variable "holding_companies" {
  description = "Holding companies that get an authorised reader view set: key = short slug, value = { id, readers = [IAM members] }"
  type = map(object({
    id      = string
    readers = list(string)
  }))
  default = {}
}

variable "partition_expiration_days" {
  description = "Partition expiration for fact tables (aggregates; default ~7 years)"
  type        = number
  default     = 2555
}

variable "enable_scheduled_rollup" {
  description = "Create the monthly roll-up scheduled query (requires the BigQuery Data Transfer API)"
  type        = bool
  default     = true
}
