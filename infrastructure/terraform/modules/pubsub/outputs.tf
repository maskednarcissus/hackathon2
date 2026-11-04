output "topic_names" {
  value = { for k, v in google_pubsub_topic.topics : k => v.name }
}
