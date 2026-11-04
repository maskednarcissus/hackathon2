# Phase 5 group warehouse (5.7): dataset + partitioned fact tables, per-holding-company
# authorised views, IAM and a monthly roll-up scheduled query. Schemas mirror
# data/bigquery/001_group_tables.sql (schemas/*.json are generated from it).

locals {
  dataset_id       = "ci_group_${var.environment}"
  views_dataset_id = "ci_group_views_${var.environment}"
  partitioned = {
    institution_daily = { field = "date", clustering = ["holding_company_id", "institution_id"] }
    campus_daily      = { field = "date", clustering = ["holding_company_id", "institution_id", "campus_id"] }
    cost_daily        = { field = "date", clustering = ["holding_company_id", "institution_id", "category"] }
  }
}

resource "google_project_service" "bigquery" {
  for_each           = toset(["bigquery.googleapis.com", "bigquerydatatransfer.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_bigquery_dataset" "group" {
  project                    = var.project_id
  dataset_id                 = local.dataset_id
  location                   = var.location
  description                = "Classroom Intelligence group facts (aggregates only, no student identifiers)"
  delete_contents_on_destroy = false
  labels                     = { environment = var.environment, phase = "5" }

  dynamic "default_encryption_configuration" {
    for_each = var.kms_key_name == null ? [] : [var.kms_key_name]
    content {
      kms_key_name = default_encryption_configuration.value
    }
  }

  depends_on = [google_project_service.bigquery]
}

resource "google_bigquery_table" "facts" {
  for_each            = local.partitioned
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.group.dataset_id
  table_id            = each.key
  schema              = file("${path.module}/schemas/${each.key}.json")
  clustering          = each.value.clustering
  deletion_protection = true

  time_partitioning {
    type                     = "DAY"
    field                    = each.value.field
    expiration_ms            = var.partition_expiration_days * 86400000
    require_partition_filter = false
  }
}

resource "google_bigquery_table" "cost_allocations" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.group.dataset_id
  table_id            = "cost_allocations"
  schema              = file("${path.module}/schemas/cost_allocations.json")
  clustering          = ["holding_company_id", "institution_id"]
  deletion_protection = true
}

resource "google_bigquery_table" "pipeline_runs" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.group.dataset_id
  table_id            = "pipeline_runs"
  schema              = file("${path.module}/schemas/pipeline_runs.json")
  deletion_protection = false

  time_partitioning {
    type  = "DAY"
    field = "started_at"
  }
}

resource "google_bigquery_table" "monthly_rollup" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.group.dataset_id
  table_id            = "institution_monthly"
  deletion_protection = false
  schema = jsonencode([
    { name = "holding_company_id", type = "STRING", mode = "REQUIRED" },
    { name = "institution_id", type = "STRING", mode = "REQUIRED" },
    { name = "month", type = "STRING", mode = "REQUIRED" },
    { name = "classes_scheduled", type = "INTEGER", mode = "NULLABLE" },
    { name = "classes_captured", type = "INTEGER", mode = "NULLABLE" },
    { name = "capture_rate", type = "FLOAT", mode = "NULLABLE" },
    { name = "total_cost_usd", type = "NUMERIC", mode = "NULLABLE" },
    { name = "cost_per_captured_class_usd", type = "NUMERIC", mode = "NULLABLE" },
    { name = "refreshed_at", type = "TIMESTAMP", mode = "NULLABLE" },
  ])
}

# --- writer IAM -------------------------------------------------------------
resource "google_bigquery_dataset_iam_member" "writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.group.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${var.writer_service_account}"
}

resource "google_project_iam_member" "writer_jobs" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${var.writer_service_account}"
}

# --- per holding company authorised views -----------------------------------
resource "google_bigquery_dataset" "views" {
  project     = var.project_id
  dataset_id  = local.views_dataset_id
  location    = var.location
  description = "Per-holding-company reader views over the group facts"
  labels      = { environment = var.environment, phase = "5" }
  depends_on  = [google_project_service.bigquery]
}

resource "google_bigquery_table" "institution_view" {
  for_each            = var.holding_companies
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.views.dataset_id
  table_id            = "institution_daily_${each.key}"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = "SELECT * FROM `${var.project_id}.${local.dataset_id}.institution_daily` WHERE holding_company_id = '${each.value.id}'"
  }
  depends_on = [google_bigquery_table.facts]
}

resource "google_bigquery_table" "cost_view" {
  for_each            = var.holding_companies
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.views.dataset_id
  table_id            = "cost_daily_${each.key}"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = "SELECT * FROM `${var.project_id}.${local.dataset_id}.cost_daily` WHERE holding_company_id = '${each.value.id}'"
  }
  depends_on = [google_bigquery_table.facts]
}

# Authorise the views to read the base dataset (readers never get base-table access).
resource "google_bigquery_dataset_access" "authorised_institution_view" {
  for_each   = var.holding_companies
  project    = var.project_id
  dataset_id = google_bigquery_dataset.group.dataset_id
  view {
    project_id = var.project_id
    dataset_id = google_bigquery_dataset.views.dataset_id
    table_id   = google_bigquery_table.institution_view[each.key].table_id
  }
}

resource "google_bigquery_dataset_access" "authorised_cost_view" {
  for_each   = var.holding_companies
  project    = var.project_id
  dataset_id = google_bigquery_dataset.group.dataset_id
  view {
    project_id = var.project_id
    dataset_id = google_bigquery_dataset.views.dataset_id
    table_id   = google_bigquery_table.cost_view[each.key].table_id
  }
}

locals {
  view_readers = merge([
    for slug, hc in var.holding_companies : {
      for member in hc.readers : "${slug}|${member}" => { slug = slug, member = member }
    }
  ]...)
}

resource "google_bigquery_table_iam_member" "institution_view_reader" {
  for_each   = local.view_readers
  project    = var.project_id
  dataset_id = google_bigquery_dataset.views.dataset_id
  table_id   = google_bigquery_table.institution_view[each.value.slug].table_id
  role       = "roles/bigquery.dataViewer"
  member     = each.value.member
}

resource "google_bigquery_table_iam_member" "cost_view_reader" {
  for_each   = local.view_readers
  project    = var.project_id
  dataset_id = google_bigquery_dataset.views.dataset_id
  table_id   = google_bigquery_table.cost_view[each.value.slug].table_id
  role       = "roles/bigquery.dataViewer"
  member     = each.value.member
}

# --- monthly roll-up scheduled query ----------------------------------------
resource "google_bigquery_data_transfer_config" "monthly_rollup" {
  count                  = var.enable_scheduled_rollup ? 1 : 0
  project                = var.project_id
  display_name           = "ci-group-monthly-rollup-${var.environment}"
  location               = var.location
  data_source_id         = "scheduled_query"
  schedule               = "every day 07:30" # UTC = 04:30 America/Sao_Paulo, after the 03:00 analytics snapshot
  service_account_name   = var.writer_service_account
  destination_dataset_id = google_bigquery_dataset.group.dataset_id
  params = {
    query = <<-SQL
      MERGE `${var.project_id}.${local.dataset_id}.institution_monthly` AS t
      USING (
        SELECT
          holding_company_id,
          institution_id,
          FORMAT_DATE('%Y-%m', date) AS month,
          SUM(classes_scheduled) AS classes_scheduled,
          SUM(classes_captured) AS classes_captured,
          SAFE_DIVIDE(SUM(classes_captured), SUM(classes_scheduled)) AS capture_rate,
          SUM(ai_cost_usd + stt_cost_usd + storage_cost_usd + infra_cost_usd) AS total_cost_usd,
          SAFE_DIVIDE(SUM(ai_cost_usd + stt_cost_usd + storage_cost_usd + infra_cost_usd),
                      SUM(classes_captured)) AS cost_per_captured_class_usd
        FROM `${var.project_id}.${local.dataset_id}.institution_daily`
        WHERE date >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)
        GROUP BY 1, 2, 3
      ) AS s
      ON t.institution_id = s.institution_id AND t.month = s.month
      WHEN MATCHED THEN UPDATE SET
        classes_scheduled = s.classes_scheduled, classes_captured = s.classes_captured,
        capture_rate = s.capture_rate, total_cost_usd = s.total_cost_usd,
        cost_per_captured_class_usd = CAST(s.cost_per_captured_class_usd AS NUMERIC),
        refreshed_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN INSERT
        (holding_company_id, institution_id, month, classes_scheduled, classes_captured,
         capture_rate, total_cost_usd, cost_per_captured_class_usd, refreshed_at)
      VALUES (s.holding_company_id, s.institution_id, s.month, s.classes_scheduled,
              s.classes_captured, s.capture_rate, s.total_cost_usd,
              CAST(s.cost_per_captured_class_usd AS NUMERIC), CURRENT_TIMESTAMP())
    SQL
  }
  depends_on = [google_bigquery_table.monthly_rollup, google_project_service.bigquery]
}
