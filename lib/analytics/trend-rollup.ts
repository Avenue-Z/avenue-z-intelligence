import type {Observation,QueryFilters} from './contracts';
import type {FunnelRollupObservation} from './funnel-rollup';
import {sanitizePage,sourceMarket} from '../sources/kind-patches';

const dimensions=['market','source','device','page','stream'] as const;
const denseDatasets=new Set(['traffic','funnels','products','markets']);
const countMetrics=new Set(['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts','orders','new_orders','recurring_orders']);
const ratioMetrics=new Set(['cvr','atc','checkoutCompletion','aov','mer','roas','ctr','cpc','cpa']);
type Group={row:FunnelRollupObservation;count:number};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function grain(row:Observation){
 if(row.start===undefined&&row.end===undefined)return 'daily';
 const start=Date.parse(row.start??''),end=Date.parse(row.end??''),duration=end-start;
 return Number.isFinite(start)&&Number.isFinite(end)&&duration>0?(duration<=7200000?'hourly':'interval'):'unknown';
}

/** Compact captured history for daily charts. Source archives retain every
 * segment; context keeps only active filters and never changes selected KPIs.
 */
export class TrendRollupAccumulator {
 private active:typeof dimensions[number][];
 private groups=new Map<string,Group>();
 private contracts=new Map<string,Map<string,Group>>();
 private rows:FunnelRollupObservation[]=[];
 constructor(filters:QueryFilters){this.active=dimensions.filter(dimension=>!!filters[dimension]);}
 add(input:Observation){
  const selected:Observation['dimensions']={};
  for(const dimension of this.active){const value=input.dimensions[dimension];if(value!==undefined)selected[dimension]=dimension==='market'?sourceMarket(value):dimension==='page'?sanitizePage(value):value;}
  const row:FunnelRollupObservation={...input,dimensions:selected,...input.channels?{channels:[...input.channels]}:{},contextOnly:true};
  // Ratio components retain their own evidence; adding reported ratios would
  // discard the denominator population and manufacture a pooled rate.
  if(!denseDatasets.has(row.dataset)||row.numerator!==undefined||row.denominator!==undefined){this.rows.push(row);return;}
  const category=grain(input),scope=JSON.stringify([row.sourceId,row.date,row.dataset,row.metric,row.definition,row.population,row.currency,row.quality,[...row.channels??[]].sort(),selected]),key=JSON.stringify([scope,category]);
  let group=this.groups.get(key);
  if(!group){
   if(!finite(row.value)||countMetrics.has(row.metric)&&(!Number.isSafeInteger(row.value)||row.value<0))row.value=null;
   if(category==='daily'||category==='unknown'){delete row.start;delete row.end;}
   group={row,count:1};this.groups.set(key,group);this.rows.push(row);
   let contracts=this.contracts.get(scope);if(!contracts){contracts=new Map();this.contracts.set(scope,contracts);}contracts.set(category,group);
   if(contracts.size>1)for(const contract of contracts.values())contract.row.value=null;
   return;
  }
  const target=group.row;group.count++;
  const sum=finite(target.value)&&finite(row.value)?target.value+row.value:null;
  const isRate=ratioMetrics.has(row.metric)||row.metric.endsWith('_rate')||row.metric.endsWith('_ratio');
  target.value=isRate||!finite(sum)||countMetrics.has(row.metric)&&(!Number.isSafeInteger(sum)||!Number.isSafeInteger(row.value)||row.value!<0)?null:sum;
  if(Date.parse(row.retrievedAt)>Date.parse(target.retrievedAt))target.retrievedAt=row.retrievedAt;
  if(!target.coverageThrough||!row.coverageThrough||!Number.isFinite(Date.parse(row.coverageThrough)))target.coverageThrough=null;
  else if(Date.parse(row.coverageThrough)<Date.parse(target.coverageThrough))target.coverageThrough=row.coverageThrough;
  if(target.start&&target.end&&row.start&&row.end){if(Date.parse(row.start)<Date.parse(target.start))target.start=row.start;if(Date.parse(row.end)>Date.parse(target.end))target.end=row.end;}
  else{delete target.start;delete target.end;}
 }
 finish():Observation[]{return this.rows;}
}
