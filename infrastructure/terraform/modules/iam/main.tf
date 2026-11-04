locals {
  service_accounts = [
    "ci-audio-ingestion",
    "ci-transcription",
    "ci-lecture-intelligence",
    "ci-event-extraction",
    "ci-api",
    "ci-device-management",
    "ci-audit"
  ]
}

resource "google_service_account" "sa" {
  for_each     = toset(locals.service_accounts)
  account_id   = "${each.value}-${var.environment}"
  display_name = "Service Account for ${each.value}"
}
