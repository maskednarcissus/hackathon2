resource "google_kms_key_ring" "keyring" {
  name     = "ci-keyring-${var.environment}"
  location = var.region
}

resource "google_kms_crypto_key" "data_key" {
  name            = "ci-data-key"
  key_ring        = google_kms_key_ring.keyring.id
  rotation_period = "7776000s" # 90 days
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "ci-db-password-${var.environment}"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "ci-jwt-secret-${var.environment}"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "device_signing_key" {
  secret_id = "ci-device-signing-key-${var.environment}"

  replication {
    auto {}
  }
}

# Shared service-to-service token (INTERNAL_API_TOKEN, header x-internal-token).
resource "google_secret_manager_secret" "internal_api_token" {
  secret_id = "ci-internal-api-token-${var.environment}"

  replication {
    auto {}
  }
}
