output "dataset_id" {
  description = "Base dataset holding the group fact tables (BIGQUERY_DATASET for group-intelligence)"
  value       = google_bigquery_dataset.group.dataset_id
}

output "views_dataset_id" {
  description = "Dataset with the per-holding-company authorised views"
  value       = google_bigquery_dataset.views.dataset_id
}

output "tables" {
  value = concat(
    [for t in google_bigquery_table.facts : t.table_id],
    [google_bigquery_table.cost_allocations.table_id, google_bigquery_table.pipeline_runs.table_id, google_bigquery_table.monthly_rollup.table_id],
  )
}
