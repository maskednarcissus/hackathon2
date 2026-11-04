locals {
  topics = [
    "ci-recording-started",
    "ci-audio-uploaded",
    "ci-transcription-complete",
    "ci-event-extracted",
    "ci-event-confirmed",
    "ci-event-published",
    "ci-device-heartbeat",
    "ci-capture-incident",
    "ci-audit"
  ]
}

resource "google_pubsub_topic" "topics" {
  for_each = toset(locals.topics)
  name     = "${each.value}-${var.environment}"

  message_retention_duration = "604800s" # 7 days
}

resource "google_pubsub_subscription" "subs" {
  for_each = toset(locals.topics)
  name     = "${each.value}-sub-${var.environment}"
  topic    = google_pubsub_topic.topics[each.value].name

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
}
