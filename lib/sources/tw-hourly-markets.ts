import type {Client,Observation} from '../analytics/contracts';
import {checkDate,commerce,localHourInterval,numeric,observation,reconcile,sourceDates,sourceMarket,type KindWindow,type Raw} from './kind-patches';
const metrics=['revenue','orders','new_orders'] as const;
/** The billing-country cut uses the exact positive-web nonrecurring cohort from
 * the headline source. Reconcile independently by market, day and store hour
 * before applying the shared commerce/spend coverage boundary. */
export function normalizeTwHourlyMarkets(input:{hourly:Raw[];daily:Raw[];commerceHourly:Raw[]},client:Client,w:KindWindow,coverageThrough:string):Observation[]{
 const hours=new Map<string,{date:string;hour:number;market:string;values:Record<string,number>}>(),daily=new Map<string,Record<string,number>>(),rawHours=new Set<string>(),rawDays=new Set<string>();
 const measures=(row:Raw)=>{const values=Object.fromEntries(metrics.map(metric=>[metric,numeric(row[metric])]));for(const metric of ['orders','new_orders'])if(!Number.isSafeInteger(values[metric])||values[metric]<0)throw new Error('Invalid market order count');return values;};
 for(const row of input.daily){checkDate(row.event_date,w);const rawKey=JSON.stringify([row.event_date,row.billing_country_code]);if(rawDays.has(rawKey))throw new Error('Duplicate independent market aggregate');rawDays.add(rawKey);const key=JSON.stringify([row.event_date,sourceMarket(row.billing_country_code)]),values=measures(row),existing=daily.get(key);if(existing)for(const metric of metrics)existing[metric]+=values[metric];else daily.set(key,values);}
 for(const row of input.hourly){checkDate(row.event_date,w);const hour=numeric(row.event_hour);if(!Number.isInteger(hour)||hour<0||hour>23)throw new Error('Invalid market event hour');if(!localHourInterval(row.event_date,hour,client.timezone))throw new Error('Market data contains a skipped store hour');const rawKey=JSON.stringify([row.event_date,hour,row.billing_country_code]);if(rawHours.has(rawKey))throw new Error('Duplicate hourly market aggregate');rawHours.add(rawKey);const market=sourceMarket(row.billing_country_code),key=JSON.stringify([row.event_date,hour,market]),values=measures(row),existing=hours.get(key);if(existing)for(const metric of metrics)existing.values[metric]+=values[metric];else hours.set(key,{date:row.event_date,hour,market,values});}
 for(const [key,values] of daily){const [date,market]=JSON.parse(key),matching=[...hours.values()].filter(group=>group.date===date&&group.market===market);for(const metric of metrics)reconcile(values[metric],matching.reduce((sum,group)=>sum+group.values[metric],0));}
 if([...hours.values()].some(group=>!daily.has(JSON.stringify([group.date,group.market]))))throw new Error('Independent market daily aggregate is missing');
 for(const date of sourceDates(w))for(let hour=0;hour<24;hour++)for(const metric of metrics){
  const expected=input.commerceHourly.filter(row=>row.event_date===date&&numeric(row.event_hour)===hour).reduce((sum,row)=>sum+numeric(row[metric]),0),actual=[...hours.values()].filter(group=>group.date===date&&group.hour===hour).reduce((sum,group)=>sum+group.values[metric],0);reconcile(expected,actual);
 }
 const rows:Observation[]=[];
 for(const [key] of daily){const [date,market]=JSON.parse(key);for(let hour=0;hour<24;hour++){
  const interval=localHourInterval(date,hour,client.timezone);if(!interval||Date.parse(interval.end)>Date.parse(coverageThrough))continue;const group=hours.get(JSON.stringify([date,hour,market]));
  for(const metric of metrics)rows.push(observation(date,'markets',metric,group?.values[metric]??0,commerce,'web_nonrecurring',metric==='revenue'?client.currency:null,{market},interval));
 }}
 return rows;
}
