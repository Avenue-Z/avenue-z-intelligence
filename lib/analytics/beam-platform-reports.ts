import type {Observation} from './contracts';
/** Provider calendar reports retain their own dates, never Shopify hour coverage. */
export function beamPlatformReport(row:Observation){
 return row.population==='motion_meta_account_report'&&row.dataset==='media'&&row.definition==='motion_meta_account_spend_provider_date_cached'
  ||row.dataset==='creatives'&&row.definition==='motion_meta_per_ad_delivery_provider_date_cached'
  ||row.dataset==='experiments'&&row.population==='intelligems_exposed_experiment_visitors'&&['intelligems_us_experiment_all_products_all_currencies_daily_visitors_zscore3','intelligems_all_countries_experiment_all_products_all_currencies_daily_visitors_zscore3'].includes(row.definition);
}
