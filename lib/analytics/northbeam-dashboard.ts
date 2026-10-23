import {shiftDate,todayIn} from './windows';
export const northbeamProfile=Object.freeze({id:'clicks-only-accrual-7d-daily-v1',currency:'USD',reportingTimezone:'America/Detroit',attributionModel:'Clicks only',attributionWindow:7,accountingMode:'accrual',granularity:'daily',platformScope:'all',countryScope:'all',aggregation:'daily_totals'} as const);
export type NorthbeamRange={from:string;to:string};
export type NorthbeamReturnedMetadata={dates:string[];accountingModes:string[];models:string[];windows:string[];currencies:string[];timezones:string[]};
export type NorthbeamCachedDay={date:string;spend:number;attributedRevenue:number;capturedAt:string;providerAsOf:null;exportId:string;exportCreatedAt:string;exportFinishedAt:string|null;returned:NorthbeamReturnedMetadata;revenueMetric:{id:string;label:string};fileHashes:string[]};
export type NorthbeamFreshness={lastSuccess:string|null;lastAttempt:string|null;lastError:string|null};
export type NorthbeamDashboard={clientId:'autobrush';provider:'northbeam';profile:typeof northbeamProfile;status:'disabled'|'empty'|'ready'|'partial';activation:{enabled:boolean};range:NorthbeamRange&{containsCurrentDay:boolean};summary:{spend:number|null;attributedRevenue:number|null;roas:number|null};daily:{date:string;spend:number|null;attributedRevenue:number|null;roas:number|null;capturedAt:string|null;providerAsOf:null;exportFinishedAt:string|null}[];freshness:NorthbeamFreshness;coverage:{cachedDays:number;requestedDays:number;missingDays:string[];complete:boolean};limitations:string[]};
export function validNorthbeamDate(date:string){return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
export function parseNorthbeamRange(params:URLSearchParams,now=new Date()):NorthbeamRange{
 for(const key of params.keys())if(!['from','to'].includes(key)||params.getAll(key).length!==1)throw Error('Invalid Northbeam range');
 const today=todayIn(northbeamProfile.reportingTimezone,now),from=params.get('from')??today,to=params.get('to')??today;
 if(!validNorthbeamDate(from)||!validNorthbeamDate(to)||from>to||to>today||from<shiftDate(today,-29))throw Error('Invalid Northbeam range');return {from,to};
}
const ratio=(revenue:number|null,spend:number|null)=>revenue!==null&&spend!==null&&spend>0&&Number.isFinite(revenue/spend)?revenue/spend:null;
export function buildNorthbeamDashboard(rows:NorthbeamCachedDay[],range:NorthbeamRange,enabled:boolean,now=new Date(),freshness?:NorthbeamFreshness):NorthbeamDashboard{
 const today=todayIn(northbeamProfile.reportingTimezone,now),byDate=new Map(rows.map(row=>[row.date,row]));
 const daily:NorthbeamDashboard['daily']=[];
 for(let date=range.from;date<=range.to;date=shiftDate(date,1)){
  const row=enabled?byDate.get(date):undefined;daily.push({date,spend:row?.spend??null,attributedRevenue:row?.attributedRevenue??null,roas:ratio(row?.attributedRevenue??null,row?.spend??null),capturedAt:row?.capturedAt??null,providerAsOf:null,exportFinishedAt:row?.exportFinishedAt??null});
 }
 const missingDays=daily.filter(day=>day.spend===null||day.attributedRevenue===null).map(day=>day.date),containsCurrentDay=range.to===today;
 const sum=(metric:'spend'|'attributedRevenue')=>{const n=daily.reduce((total,day)=>total+(day[metric]??0),0);return missingDays.length||!Number.isFinite(n)?null:n;};
 const spend=sum('spend'),attributedRevenue=sum('attributedRevenue'),complete=enabled&&!missingDays.length&&!containsCurrentDay;
 return {clientId:'autobrush',provider:'northbeam',profile:northbeamProfile,status:!enabled?'disabled':missingDays.length===daily.length?'empty':complete?'ready':'partial',activation:{enabled},range:{...range,containsCurrentDay},summary:{spend,attributedRevenue,roas:ratio(attributedRevenue,spend)},daily,freshness:freshness??{lastSuccess:rows.map(row=>row.capturedAt).sort().at(-1)??null,lastAttempt:null,lastError:null},coverage:{cachedDays:daily.length-missingDays.length,requestedDays:daily.length,missingDays,complete},limitations:['All platforms and countries; daily Clicks only attribution, seven-day window, accrual accounting.','Currency and reporting timezone verified in the Northbeam account settings; returned export metadata is retained separately.','Northbeam attribution is separate from Shopify commerce and Meta platform delivery.','Current provider day is partial; no hourly coverage or matched-hour comparison is available.','Accrual attribution can revise today and seven prior provider dates; older daily totals may also be corrected.']};
}
