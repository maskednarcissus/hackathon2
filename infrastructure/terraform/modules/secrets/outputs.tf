output "kms_key_id" {
  value = google_kms_crypto_key.data_key.id
}

output "internal_api_token_secret_id" {
  value = google_secret_manager_secret.internal_api_token.secret_id
}
