# -----------------------------------------------------------------------------
# Cloud Scheduler jobs for the platform's periodic work (integration stage §6).
# Every job calls an internal endpoint with the shared `x-internal-token`, read from
# Secret Manager. NOTE: Cloud Scheduler stores header values in its job config and the
# value also lands in Terraform state — keep the state bucket restricted.
# -----------------------------------------------------------------------------

data "google_secret_manager_secret_version" "internal_token" {
  project = var.project_id
  secret  = var.internal_token_secret_id
}

locals {
  headers = {
    "Content-Type"     = "application/json"
    "x-internal-token" = data.google_secret_manager_secret_version.internal_token.secret_data
  }

  global_jobs = {
    "alerts-evaluate" = {
      description = "Evaluate time-based capture alert rules (device offline, missed recording, overdue upload)"
      schedule    = "* * * * *"
      service     = "notifications"
      path        = "/v1/alerts/evaluate"
      body        = {}
    }
    "student-reminders" = {
      description = "Send due assessment reminders and flush quiet-hour deferred notifications"
      schedule    = "*/10 * * * *"
      service     = "notifications"
      path        = "/v1/reminders/run"
      body        = {}
    }
    "group-pipeline" = {
      description = "Build yesterday's Group Intelligence fact tables (all holding companies)"
      schedule    = "10 4 * * *"
      service     = "group-intelligence"
      path        = "/v1/pipeline/run"
      body        = {}
    }
    "external-calendar-reconcile" = {
      description = "Reconcile students' external calendar sync (Google/Microsoft) with published events"
      schedule    = "30 2 * * *"
      service     = "calendar"
      path        = "/internal/v1/external-calendars/reconcile"
      body        = {}
    }
    "device-status-sweep" = {
      description = "Mark devices offline after missed heartbeats and publish device.heartbeat_missed"
      schedule    = "* * * * *"
      service     = "device-management"
      path        = "/internal/v1/status-sweep"
      body        = {}
    }
  }

  # Jobs that run once per institution.
  institution_jobs = merge([
    for inst in var.institution_ids : {
      "analytics-snapshot-${inst}" = {
        description = "Materialise yesterday's analytics snapshot"
        schedule    = "0 3 * * *"
        service     = "academic-analytics"
        path        = "/v1/snapshots/run"
        body        = { institutionId = inst }
      }
      "retention-${inst}" = {
        description = "Apply recording-policy retention (legal holds respected)"
        schedule    = "0 4 * * *"
        service     = "organization"
        path        = "/v1/retention/run"
        body        = { institutionId = inst, dryRun = var.retention_dry_run }
      }
    }
  ]...)

  jobs = merge(local.global_jobs, local.institution_jobs)
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each = local.jobs

  project          = var.project_id
  region           = var.region
  name             = "ci-${var.environment}-${each.key}"
  description      = each.value.description
  schedule         = each.value.schedule
  time_zone        = var.time_zone
  attempt_deadline = "320s"
  paused           = var.paused

  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "POST"
    uri         = "${trimsuffix(lookup(var.service_urls, each.value.service, ""), "/")}${each.value.path}"
    headers     = local.headers
    body        = base64encode(jsonencode(each.value.body))

    oidc_token {
      service_account_email = var.invoker_service_account_email
      audience              = trimsuffix(lookup(var.service_urls, each.value.service, ""), "/")
    }
  }
}
