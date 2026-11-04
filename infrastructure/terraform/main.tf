terraform {
  required_version = ">= 1.9.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
  backend "gcs" {
    # Configure via: terraform init -backend-config="bucket=<tfstate-bucket>"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# -----------------------------------------------------------------------------
# Google Cloud APIs Enablement
# -----------------------------------------------------------------------------
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudrun.googleapis.com",
    "sqladmin.googleapis.com",
    "alloydb.googleapis.com",
    "storage.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "speech.googleapis.com",
    "aiplatform.googleapis.com",
    "bigquery.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "cloudscheduler.googleapis.com",
    "bigquerydatatransfer.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# -----------------------------------------------------------------------------
# Infrastructure Modules
# -----------------------------------------------------------------------------
module "networking" {
  source      = "./modules/networking"
  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  depends_on  = [google_project_service.apis]
}

module "secrets" {
  source      = "./modules/secrets"
  project_id  = var.project_id
  region      = var.region
  environment = var.environment
  depends_on  = [google_project_service.apis]
}

module "storage" {
  source               = "./modules/storage"
  project_id           = var.project_id
  region               = var.region
  environment          = var.environment
  kms_key_id           = module.secrets.kms_key_id
  audio_retention_days = var.audio_retention_days
  depends_on           = [google_project_service.apis]
}

module "database" {
  source          = "./modules/database"
  project_id      = var.project_id
  region          = var.region
  environment     = var.environment
  network_id      = module.networking.vpc_id
  kms_key_id      = module.secrets.kms_key_id
  database_tier   = var.database_tier
  enable_alloydb  = var.enable_alloydb
  depends_on      = [google_project_service.apis, module.networking]
}

module "pubsub" {
  source             = "./modules/pubsub"
  project_id         = var.project_id
  environment        = var.environment
  subscriptions_file = "${path.root}/../events/subscriptions.yaml"
  service_urls       = var.service_urls
  depends_on         = [google_project_service.apis]
}

module "iam" {
  source      = "./modules/iam"
  project_id  = var.project_id
  environment = var.environment
  depends_on  = [google_project_service.apis]
}

module "scheduler" {
  source                        = "./modules/scheduler"
  project_id                    = var.project_id
  region                        = var.region
  environment                   = var.environment
  service_urls                  = var.service_urls
  internal_token_secret_id      = module.secrets.internal_api_token_secret_id
  invoker_service_account_email = module.iam.service_accounts["ci-scheduler"]
  institution_ids               = var.scheduled_institution_ids
  retention_dry_run             = var.retention_dry_run
  depends_on                    = [google_project_service.apis, module.secrets, module.iam]
}

module "bigquery" {
  source                 = "./modules/bigquery"
  project_id             = var.project_id
  environment            = var.environment
  location               = var.region
  kms_key_name           = module.secrets.kms_key_id
  writer_service_account = module.iam.service_accounts["ci-group-intel"]
  holding_companies      = var.group_holding_companies
  depends_on             = [google_project_service.apis, module.iam]
}
