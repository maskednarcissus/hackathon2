-- Per-holding-company reader views (authorised views). Replace ${dataset}, ${views_dataset}
-- and ${holding_company_id}. Group readers get access to the view dataset only, never to the
-- base tables, so one holding company can never query another's rows.

CREATE OR REPLACE VIEW `${views_dataset}.institution_daily_${holding_company_key}` AS
SELECT * FROM `${dataset}.institution_daily`
WHERE holding_company_id = '${holding_company_id}';

CREATE OR REPLACE VIEW `${views_dataset}.cost_daily_${holding_company_key}` AS
SELECT * FROM `${dataset}.cost_daily`
WHERE holding_company_id = '${holding_company_id}';

-- Monthly roll-up used by finance dashboards (cost per captured class by institution).
CREATE OR REPLACE VIEW `${views_dataset}.monthly_cost_per_class_${holding_company_key}` AS
SELECT
  i.institution_id,
  FORMAT_DATE('%Y-%m', i.date) AS month,
  SUM(i.classes_captured) AS classes_captured,
  SUM(i.ai_cost_usd + i.stt_cost_usd + i.storage_cost_usd + i.infra_cost_usd) AS total_cost_usd,
  SAFE_DIVIDE(
    SUM(i.ai_cost_usd + i.stt_cost_usd + i.storage_cost_usd + i.infra_cost_usd),
    SUM(i.classes_captured)
  ) AS cost_per_captured_class_usd
FROM `${dataset}.institution_daily` AS i
WHERE i.holding_company_id = '${holding_company_id}'
GROUP BY 1, 2;
