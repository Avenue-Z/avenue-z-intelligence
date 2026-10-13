import type {Observation,QueryFilters} from '../analytics/contracts';
import type {Store} from './store';
import {snapshotDayManifests,snapshotDayManifest,readSnapshotDayProjection} from './snapshot-day-projections';
import {observationCodec} from './observation-codec';
import {TrendRollupAccumulator} from '../analytics/trend-rollup';
import {durableObservationPayload} from './durable-observation-cache';
type Pointer={snapshotId:string;sourceId:string;date:string};
const dimensions=['market','stream','source','device','page'] as const;
/** Compact immutable historical facts for daily chart cohorts. Ready day
 * projections are preferred; legacy facts use bounded indexed pages. */
export async function readTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string}):Promise<Observation[]>{
 if(!pointers.length||!datasets.length)return [];
 const key=JSON.stringify(['daily-chart-context-v2',pointers.map(({snapshotId,date})=>[snapshotId,date]).sort(),[...datasets].sort(),dimensions.map(dimension=>[dimension,filters[dimension]])]);
 const payload=await durableObservationPayload(store.db,scope.organizationId,scope.clientId,key,async()=>observationCodec.encode(await computeTrendObservations(store,pointers,datasets,filters,scope)),undefined,{publish:true});
 return observationCodec.decode(payload);
}
async function computeTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string}):Promise<Observation[]>{
 const manifests=await snapshotDayManifests(store.db,scope.organizationId,scope.clientId,pointers),accumulator=new TrendRollupAccumulator(filters),missing:Pointer[]=[];
 let next=0;
 const worker=async()=>{for(;;){const pointer=pointers[next++];if(!pointer)return;const manifest=snapshotDayManifest(manifests,pointer),payload=manifest?await readSnapshotDayProjection(store.db,scope.organizationId,scope.clientId,manifest):null;if(!payload){missing.push(pointer);continue;}try{observationCodec.visit(payload,row=>{if(datasets.includes(row.dataset))accumulator.add(row);},pointer);}catch{missing.push(pointer);}}};
 await Promise.all(Array.from({length:4},worker));
 if(!missing.length)return accumulator.finish();
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
 const pageSql=(cursor:boolean)=>`WITH page AS MATERIALIZED (SELECT o.payload,o.rowKey,o.date FROM observations o INDEXED BY idx_observations_snapshot_date_dataset_rowkey WHERE o.snapshotId=? AND o.date=? AND json_extract(o.payload,'$.dataset')=?${cursor?' AND o.rowKey>?':''} ORDER BY o.rowKey LIMIT 2000), raw AS (SELECT date,rowKey,${fields},${selectedDimensions} AS dimensions,json_type(payload,'$.value') AS valueType,CASE WHEN ${extract('numerator')} IS NOT NULL OR ${extract('denominator')} IS NOT NULL THEN rowKey ELSE '' END AS component,CASE WHEN ${extract('start')} IS NULL AND ${extract('end')} IS NULL THEN 'daily' WHEN julianday(${extract('end')})>julianday(${extract('start')}) THEN CASE WHEN ROUND((julianday(${extract('end')})-julianday(${extract('start')}))*86400)<=7200 THEN 'hourly' ELSE 'interval' END ELSE 'unknown' END AS grain FROM page) SELECT (SELECT MAX(rowKey) FROM page) AS lastRowKey,(SELECT COUNT(*) FROM page) AS pageCount,grain,json_object('date',date,'dataset',dataset,'metric',metric,'value',CASE WHEN COUNT(value)<>COUNT(*) OR MIN(valueType IN ('integer','real'))<>1 OR (${count} AND (MIN(value)<0 OR MAX(value<>CAST(value AS INTEGER))=1 OR ABS(SUM(value))>9007199254740991)) OR (${rate} AND COUNT(*)>1) THEN NULL ELSE SUM(value) END,'definition',definition,'population',population,'currency',currency,'quality',quality,'sourceId',sourceId,'retrievedAt',MAX(retrievedAt),'coverageThrough',CASE WHEN COUNT(coverageThrough)=COUNT(*) THEN MIN(coverageThrough) ELSE NULL END,'start',CASE WHEN COUNT(start)=COUNT(*) THEN MIN(start) ELSE NULL END,'end',CASE WHEN COUNT(end)=COUNT(*) THEN MAX(end) ELSE NULL END,'channels',json(channels),'dimensions',json(dimensions),'numerator',numerator,'denominator',denominator) AS payload FROM raw GROUP BY date,dataset,metric,definition,population,currency,quality,sourceId,channels,dimensions,grain,component`;
 const reads=missing.flatMap(pointer=>[...new Set(datasets)].map(dataset=>({pointer,dataset})));let nextRead=0;
 const readMissing=async()=>{for(;;){const item=reads[nextRead++];if(!item)return;let cursor:string|null=null;
  for(;;){const page:{payload:string;lastRowKey:string;pageCount:number;grain:'daily'|'hourly'|'interval'|'unknown'}[]=await store.all(pageSql(!!cursor),item.pointer.snapshotId,item.pointer.date,item.dataset,...cursor?[cursor]:[]);
   for(const row of page){const observation=JSON.parse(row.payload);for(const key of ['start','end','population','channels','numerator','denominator'])if(observation[key]===null)delete observation[key];accumulator.add(observation as Observation,row.grain);}
   if(!page.length||page[0].pageCount<2000)break;cursor=page[0].lastRowKey;
  }
 }};
 await Promise.all(Array.from({length:Math.min(2,reads.length)},readMissing));
 return accumulator.finish();
}
