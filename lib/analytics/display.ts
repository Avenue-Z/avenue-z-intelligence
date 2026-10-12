type MetricValue=number|null|undefined;
export const finiteMetric=(value:MetricValue):value is number=>typeof value==='number'&&Number.isFinite(value);
export const money=(value:MetricValue,currency='USD')=>finiteMetric(value)?new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:0}).format(value):'—';
export const number=(value:MetricValue)=>finiteMetric(value)?new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value):'—';
export const percent=(value:MetricValue)=>finiteMetric(value)?`${(value*100).toFixed(2)}%`:'—';
export const multiple=(value:MetricValue)=>finiteMetric(value)?`${value.toFixed(2)}×`:'—';
export function timestamp(value:string,timezone:string){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-US',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(date):'Unavailable';}
const financial=new Set(['revenue','spend','platform_spend','refunds','gross','discounts','aov','recurring_revenue','summary_spend','sql_spend','summary_spend_delta','meta_ad_spend','meta_ad_pixel_purchase_value']);
export function formatMetric(key:string,value:MetricValue,currency:string){
  if(['summary_spend','sql_spend','summary_spend_delta'].includes(key))return finiteMetric(value)?new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2}).format(value):'—';
  if(financial.has(key))return money(value,currency);
  if(key.includes('rate')||['checkout_completion','uplift_low','uplift_high'].includes(key))return percent(value);
  if(key==='mer')return multiple(value);
  return number(value);
}
