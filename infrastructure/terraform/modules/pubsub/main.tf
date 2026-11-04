# -----------------------------------------------------------------------------
# Pub/Sub topics and push subscriptions generated from the shared routing table
# (infrastructure/events/subscriptions.yaml). Topic = event type; the physical
# topic name is "ci-<env>-<event type>" (services: PUBSUB_TOPIC_TEMPLATE="ci-{env}-{type}").
# -----------------------------------------------------------------------------

locals {
  routing = yamldecode(file(var.subscriptions_file))
  topics  = keys(local.routing.topics)

  subscriptions = merge([
    for topic, subs in local.routing.topics : {
      for s in (subs == null ? [] : subs) : "${topic}.${s.name}" => {
        topic   = topic
        name    = s.name
        service = s.service
        path    = s.path
      }
    }
  ]...)

  missing_service_urls = distinct([
    for s in values(local.subscriptions) : s.service if !contains(keys(var.service_urls), s.service)
  ])
}

resource "google_pubsub_topic" "events" {
  for_each = toset(local.topics)
  project  = var.project_id
  name     = "ci-${var.environment}-${each.value}"

  message_retention_duration = "604800s" # 7 days
  labels = {
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_pubsub_topic" "dead_letter" {
  project                    = var.project_id
  name                       = "ci-${var.environment}-dead-letter"
  message_retention_duration = "1209600s" # 14 days
}

# Pull subscription on the dead-letter topic so failed messages can be inspected and replayed.
resource "google_pubsub_subscription" "dead_letter_inspect" {
  project                    = var.project_id
  name                       = "ci-${var.environment}-dead-letter-inspect"
  topic                      = google_pubsub_topic.dead_letter.id
  ack_deadline_seconds       = 60
  message_retention_duration = "1209600s"
  expiration_policy {
    ttl = ""
  }
}

# Service account Pub/Sub uses to mint OIDC tokens for push requests (Cloud Run invoker).
resource "google_service_account" "push" {
  project      = var.project_id
  account_id   = "ci-${var.environment}-pubsub-push"
  display_name = "Classroom Intelligence Pub/Sub push (${var.environment})"
}

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  pubsub_service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Pub/Sub's service agent must be able to mint tokens as the push SA …
resource "google_service_account_iam_member" "push_token_creator" {
  service_account_id = google_service_account.push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_service_agent
}

# … and to forward undeliverable messages to the dead-letter topic.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "push" {
  for_each = local.subscriptions
  project  = var.project_id
  name     = "ci-${var.environment}-${replace(each.key, ".", "-")}"
  topic    = google_pubsub_topic.events[each.value.topic].id

  ack_deadline_seconds       = 600 # transcription / structuring can take minutes
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  push_config {
    push_endpoint = "${trimsuffix(lookup(var.service_urls, each.value.service, ""), "/")}${each.value.path}"
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = trimsuffix(lookup(var.service_urls, each.value.service, ""), "/")
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  expiration_policy {
    ttl = "" # never expire
  }

  labels = {
    environment = var.environment
    service     = each.value.service
  }

  lifecycle {
    precondition {
      condition     = length(local.missing_service_urls) == 0
      error_message = "service_urls is missing: ${join(", ", local.missing_service_urls)}"
    }
  }
}

# Subscriptions need subscriber rights on themselves for dead-lettering to work.
resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  for_each     = google_pubsub_subscription.push
  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
