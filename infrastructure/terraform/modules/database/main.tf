resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  count            = var.enable_alloydb ? 0 : 1
  name             = "ci-postgres-${var.environment}"
  database_version = "POSTGRES_16"
  region           = var.region

  depends_on = [var.network_id]

  settings {
    tier              = var.database_tier
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }

  deletion_protection = var.environment == "production"
}

resource "google_sql_database" "default_db" {
  count    = var.enable_alloydb ? 0 : 1
  name     = "classroom_intelligence"
  instance = google_sql_database_instance.postgres[0].name
}

resource "google_sql_user" "db_user" {
  count    = var.enable_alloydb ? 0 : 1
  name     = "ci_app"
  instance = google_sql_database_instance.postgres[0].name
  password = random_password.db_password.result
}

# Optional AlloyDB configuration for Production
resource "google_alloydb_cluster" "cluster" {
  count      = var.enable_alloydb ? 1 : 0
  cluster_id = "ci-alloydb-${var.environment}"
  location   = var.region
  network_config {
    network = var.network_id
  }
}

resource "google_alloydb_instance" "primary" {
  count         = var.enable_alloydb ? 1 : 0
  cluster       = google_alloydb_cluster.cluster[0].name
  instance_id   = "ci-alloydb-primary-${var.environment}"
  instance_type = "PRIMARY"
  machine_config {
    cpu_count = 4
  }
}
