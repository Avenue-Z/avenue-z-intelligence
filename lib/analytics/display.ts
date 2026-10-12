type MetricValue=number|null|undefined;
export const finiteMetric=(value:MetricValue):value is number=>typeof value==='number'&&Number.isFinite(value);
export const money=(value:MetricValue,currency='USD')=>finiteMetric(value)?new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:0}).format(value):'—';
export const number=(value:MetricValue)=>finiteMetric(value)?new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value):'—';
export const percent=(value:MetricValue)=>finiteMetric(value)?`${(value*100).toFixed(2)}%`:'—';
export const multiple=(value:MetricValue)=>finiteMetric(value)?`${value.toFixed(2)}×`:'—';
const financial=new Set(['revenue','spend','platform_spend','refunds','gross','discounts','aov','recurring_revenue']);
export function formatMetric(key:string,value:MetricValue,currency:string){
  if(financial.has(key))return money(value,currency);
  if(key.includes('rate')||['checkout_completion','uplift_low','uplift_high'].includes(key))return percent(value);
  if(key==='mer')return multiple(value);
  return number(value);
}
