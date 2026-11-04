output "topic_names" {
  description = "Event type → physical Pub/Sub topic name"
  value       = { for k, v in google_pubsub_topic.events : k => v.name }
}

output "subscription_names" {
  value = { for k, v in google_pubsub_subscription.push : k => v.name }
}

output "dead_letter_topic" {
  value = google_pubsub_topic.dead_letter.name
}

output "push_service_account_email" {
  description = "Grant roles/run.invoker on each subscriber Cloud Run service to this account"
  value       = google_service_account.push.email
}
