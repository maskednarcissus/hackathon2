output "connection_name" {
  value = var.enable_alloydb ? google_alloydb_cluster.cluster[0].name : google_sql_database_instance.postgres[0].connection_name
}
