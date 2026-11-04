output "audio_raw_bucket_name" {
  value = google_storage_bucket.audio_raw.name
}

output "audio_processed_bucket_name" {
  value = google_storage_bucket.audio_processed.name
}

output "transcripts_bucket_name" {
  value = google_storage_bucket.transcripts.name
}
