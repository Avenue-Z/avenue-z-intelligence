import type {Observation,QueryFilters} from '../analytics/contracts';
import type {Store} from './store';
import {snapshotDayManifests,snapshotDayManifest,readSnapshotDayProjection} from './snapshot-day-projections';
import {observationCodec} from './observation-codec';
import {TrendRollupAccumulator,TrendIntervalRollupAccumulator} from '../analytics/trend-rollup';
import type {FunnelRollupObservation} from '../analytics/funnel-rollup';
import {durableObservationPayload} from './durable-observation-cache';
import {trendCutoffEnd,type TrendCutoff} from '../analytics/trend-context';
import {readTrendDayPayloads} from './trend-day-cache';
type Pointer={snapshotId:string;sourceId:string;date:string};
export type TrendCacheIdentity={timezone:string|null;clientVersion?:number;config?:string;qualifications:{sourceId:string;profiles:string|null;connectionVersion?:number;clientVersion?:number;version?:number}[]};
const dimensions=['market','stream','source','device','page'] as const;
const checkBudget=(deadline?:number)=>{if(deadline!==undefined&&Date.now()>=deadline)throw Error('Observation cache warm budget elapsed');};
/** Compact immutable historical facts for daily chart cohorts. Ready day
 * projections are preferred; legacy facts use bounded indexed pages. */
export async function readTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string},cutoff?:TrendCutoff,deadline?:number,identity?:TrendCacheIdentity):Promise<Observation[]>{
 if(!pointers.length||!datasets.length)return [];
 if(filters.mode==='partial'&&(!cutoff||trendCutoffEnd(filters.to,cutoff)===null)&&!(scope.clientId==='beam'&&datasets.some(dataset=>['media','creatives','experiments'].includes(dataset))))return [];
 checkBudget(deadline);
 // Native preparation must populate reusable days even when a foreground
 // request already installed this hour's derived range.
 if(deadline!==undefined)return computeTrendObservations(store,pointers,datasets,filters,scope,cutoff,deadline,identity);
 // Rollup retains every value of each active dimension. The selected value
 // is applied by queryClient, so US and CA use the same immutable market
 // cohort without repeating the thirty-day source read.
 const key=JSON.stringify(['daily-chart-context-v5',pointers.map(({snapshotId,date})=>[snapshotId,date]).sort(),[...datasets].sort(),filters.mode,...filters.mode==='partial'?[cutoff?.timezone,cutoff?.cutoff,cutoff?.anchorDate]:[],dimensions.filter(dimension=>!!filters[dimension]),identity]);
 const payload=await durableObservationPayload(store.db,scope.organizationId,scope.clientId,key,async()=>observationCodec.encode(await computeTrendObservations(store,pointers,datasets,filters,scope,cutoff,deadline,identity)),deadline,{publish:false});
 checkBudget(deadline);const rows=observationCodec.decode(payload);checkBudget(deadline);return rows;
}
async function computeTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string},cutoff?:TrendCutoff,deadline?:number,identity?:TrendCacheIdentity):Promise<Observation[]>{
 const nativeWarm=deadline!==undefined,layouts=[filters];
 // Native all-market preparation also captures the two common layouts from
 // that same raw visit. Browser misses never add per-day write transactions.
 if(nativeWarm&&!dimensions.some(dimension=>!!filters[dimension]))layouts.push({...filters,market:'cohort-layout'},{...filters,page:'cohort-layout'});
 const groups=pointers.map(day=>layouts.map(layout=>({day,layout,key:JSON.stringify(['interval-chart-day-v2',day,[...datasets].sort(),dimensions.filter(dimension=>!!layout[dimension]),identity?{...identity,qualifications:identity.qualifications.filter(value=>value.sourceId===day.sourceId).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}:cutoff?.timezone??null])}))),saved=await readTrendDayPayloads(store,scope.organizationId,scope.clientId,groups.flat(),deadline),accumulator=new TrendRollupAccumulator(filters,cutoff);let next=0;
 const worker=async()=>{for(;;){checkBudget(deadline);const requests=groups[next++];if(!requests)return;const missing=requests.filter(request=>!saved.has(request.key)),computed=new Map<string,string>();
  if(missing.length){const cohorts=missing.map(request=>({request,accumulator:new TrendIntervalRollupAccumulator(request.layout)})),unionFilters={...filters,mode:'closed' as const};for(const dimension of dimensions)if(missing.some(request=>!!request.layout[dimension]))unionFilters[dimension]='cohort-layout';
   await visitUncachedTrendObservations(store,[requests[0].day],datasets,unionFilters,scope,(row,grain)=>{for(const cohort of cohorts)cohort.accumulator.add(row,grain);},deadline);
   for(const cohort of cohorts){checkBudget(deadline);const payload=observationCodec.encode(cohort.accumulator.finish());computed.set(cohort.request.key,payload);if(nativeWarm)await durableObservationPayload(store.db,scope.organizationId,scope.clientId,cohort.request.key,async()=>payload,deadline,{publish:true,trendDay:true,expected:cohort.request.day});}
  }
  const primary=requests[0],payload=saved.get(primary.key)??computed.get(primary.key)!;observationCodec.visit(payload,row=>{const {contextGrain,...point}=row as FunnelRollupObservation;accumulator.add(point,contextGrain);},primary.day);
 }};
 await Promise.all(Array.from({length:Math.min(4,groups.length)},worker));checkBudget(deadline);return accumulator.finish();
}
async function visitUncachedTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string},add:(row:Observation,grain?:'daily'|'hourly'|'interval'|'unknown')=>void,deadline?:number):Promise<void>{
 const manifests=await snapshotDayManifests(store.db,scope.organizationId,scope.clientId,pointers,deadline),missing:Pointer[]=[];
 let next=0;
 const worker=async()=>{for(;;){checkBudget(deadline);const pointer=pointers[next++];if(!pointer)return;const manifest=snapshotDayManifest(manifests,pointer),payload=manifest?await readSnapshotDayProjection(store.db,scope.organizationId,scope.clientId,manifest,deadline):null;if(!payload){missing.push(pointer);continue;}try{observationCodec.visit(payload,row=>{if(datasets.includes(row.dataset))add(row);},pointer);}catch{missing.push(pointer);}}};
 await Promise.all(Array.from({length:4},worker));
 checkBudget(deadline);
 if(!missing.length)return;
 // A legacy day without a projection can contain tens of thousands of UTM
 // facts. Bound the SQL aggregation before decoding them and return compact
 // partial cohorts, rather than a slow full-day GROUP BY or all raw payloads.
 // Original grain and component rows remain intact across page boundaries.
 const extract=(key:string)=>`json_extract(payload,'$.${key}')`;
 let selectedDimensions="'{}'";
 for(const key of dimensions)if(filters[key])selectedDimensions=`json_patch(${selectedDimensions},CASE WHEN json_type(payload,'$.dimensions.${key}')='text' THEN json_object('${key}',json_extract(payload,'$.dimensions.${key}')) ELSE '{}' END)`;
 const fields=['dataset','metric','definition','population','currency','quality','sourceId','retrievedAt','coverageThrough','start','end','channels','value','numerator','denominator'].map(key=>`${extract(key)} AS ${key}`).join(',');
 const rate="(metric LIKE '%_rate' OR metric LIKE '%_ratio' OR metric IN ('cvr','atc','checkoutCompletion','aov','mer','roas','ctr','cpc','cpa'))";
 const count="metric IN ('sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts','orders','new_orders','recurring_orders')";
 const pageSql=(cursor:boolean)=>`WITH page AS MATERIALIZED (SELECT o.payload,o.rowKey,o.date FROM observations o INDEXED BY idx_observations_snapshot_date_dataset_rowkey WHERE o.snapshotId=? AND o.date=? AND json_extract(o.payload,'$.dataset')=?${cursor?' AND o.rowKey>?':''} ORDER BY o.rowKey LIMIT 2000), raw AS (SELECT date,rowKey,${fields},${selectedDimensions} AS dimensions,json_type(payload,'$.value') AS valueType,CASE WHEN ${extract('numerator')} IS NOT NULL OR ${extract('denominator')} IS NOT NULL THEN rowKey ELSE '' END AS component,CASE WHEN ${extract('start')} IS NULL AND ${extract('end')} IS NULL THEN 'daily' WHEN julianday(${extract('end')})>julianday(${extract('start')}) THEN CASE WHEN ROUND((julianday(${extract('end')})-julianday(${extract('start')}))*86400)<=7200 THEN 'hourly' ELSE 'interval' END ELSE 'unknown' END AS grain FROM page), grouped AS (SELECT grain,json_object('date',date,'dataset',dataset,'metric',metric,'value',CASE WHEN COUNT(value)<>COUNT(*) OR MIN(valueType IN ('integer','real'))<>1 OR (${count} AND (MIN(value)<0 OR MAX(value<>CAST(value AS INTEGER))=1 OR ABS(SUM(value))>9007199254740991)) OR (${rate} AND COUNT(*)>1) THEN NULL ELSE SUM(value) END,'definition',definition,'population',population,'currency',currency,'quality',quality,'sourceId',sourceId,'retrievedAt',MAX(retrievedAt),'coverageThrough',CASE WHEN COUNT(coverageThrough)=COUNT(*) THEN MIN(coverageThrough) ELSE NULL END,'start',CASE WHEN COUNT(start)=COUNT(*) THEN MIN(start) ELSE NULL END,'end',CASE WHEN COUNT(end)=COUNT(*) THEN MAX(end) ELSE NULL END,'channels',json(channels),'dimensions',json(dimensions),'numerator',numerator,'denominator',denominator) AS payload FROM raw GROUP BY date,dataset,metric,definition,population,currency,quality,sourceId,channels,dimensions,grain,component,start,end) SELECT (SELECT MAX(rowKey) FROM page) AS lastRowKey,(SELECT COUNT(*) FROM page) AS pageCount,grain,payload FROM grouped UNION ALL SELECT (SELECT MAX(rowKey) FROM page),(SELECT COUNT(*) FROM page),NULL,NULL WHERE NOT EXISTS (SELECT 1 FROM grouped)`;
 const reads=missing.flatMap(pointer=>[...new Set(datasets)].map(dataset=>({pointer,dataset})));let nextRead=0;
 const readMissing=async()=>{for(;;){checkBudget(deadline);const item=reads[nextRead++];if(!item)return;let cursor:string|null=null;
  for(;;){checkBudget(deadline);
   const page:{payload:string|null;lastRowKey:string;pageCount:number;grain:'daily'|'hourly'|'interval'|'unknown'}[]=await store.all(pageSql(!!cursor),item.pointer.snapshotId,item.pointer.date,item.dataset,...cursor?[cursor]:[]);
   checkBudget(deadline);
   for(const row of page){if(!row.payload)continue;const observation=JSON.parse(row.payload);for(const key of ['start','end','population','channels','numerator','denominator'])if(observation[key]===null)delete observation[key];add(observation as Observation,row.grain);}
   if(!page.length||page[0].pageCount<2000)break;cursor=page[0].lastRowKey;
  }
 }};
 await Promise.all(Array.from({length:Math.min(2,reads.length)},readMissing));
 checkBudget(deadline);
}
