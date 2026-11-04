output "job_names" {
  value = { for k, v in google_cloud_scheduler_job.jobs : k => v.name }
}
