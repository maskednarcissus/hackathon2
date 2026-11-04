output "vpc_id" {
  description = "VPC Network ID"
  value       = module.networking.vpc_id
}

output "audio_raw_bucket_name" {
  description = "Cloud Storage bucket for raw audio capture"
  value       = module.storage.audio_raw_bucket_name
}

output "database_connection_name" {
  description = "Cloud SQL / AlloyDB connection string name"
  value       = module.database.connection_name
}

output "kms_key_id" {
  description = "Primary Cloud KMS key ID for data encryption"
  value       = module.secrets.kms_key_id
}

output "pubsub_topics" {
  description = "List of core Pub/Sub event topics"
  value       = module.pubsub.topic_names
}
