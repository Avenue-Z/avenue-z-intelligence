import type {Observation,QueryFilters} from '../analytics/contracts';
import type {Store} from './store';
import {snapshotDayManifests,snapshotDayManifest,readSnapshotDayProjection} from './snapshot-day-projections';
import {observationCodec} from './observation-codec';
import {TrendRollupAccumulator} from '../analytics/trend-rollup';
import {durableObservationPayload} from './durable-observation-cache';
type Pointer={snapshotId:string;sourceId:string;date:string};
const dimensions=['market','stream','source','device','page'] as const;
/** Reduce immutable historical facts in the database; chart reads need daily
 * metric cohorts, rather than transferring every landing-page/hour/UTM row. */
export async function readTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string}):Promise<Observation[]>{
 if(!pointers.length||!datasets.length)return [];
 const key=JSON.stringify(['daily-chart-context-v1',pointers.map(({snapshotId,date})=>[snapshotId,date]).sort(),[...datasets].sort(),dimensions.map(dimension=>[dimension,filters[dimension]])]);
 const payload=await durableObservationPayload(store.db,scope.organizationId,scope.clientId,key,async()=>observationCodec.encode(await computeTrendObservations(store,pointers,datasets,filters,scope)),undefined,{publish:true});
 return observationCodec.decode(payload);
}
async function computeTrendObservations(store:Store,pointers:Pointer[],datasets:string[],filters:QueryFilters,scope:{organizationId:string;clientId:string}):Promise<Observation[]>{
 const manifests=await snapshotDayManifests(store.db,scope.organizationId,scope.clientId,pointers),accumulator=new TrendRollupAccumulator(filters),missing:Pointer[]=[];
 let next=0;
 const worker=async()=>{for(;;){const pointer=pointers[next++];if(!pointer)return;const manifest=snapshotDayManifest(manifests,pointer),payload=manifest?await readSnapshotDayProjection(store.db,scope.organizationId,scope.clientId,manifest):null;if(!payload){missing.push(pointer);continue;}try{observationCodec.visit(payload,row=>{if(datasets.includes(row.dataset))accumulator.add(row);},pointer);}catch{missing.push(pointer);}}};
 await Promise.all(Array.from({length:4},worker));
 const rows=accumulator.finish();
 if(!missing.length)return rows;
 const extract=(key:string)=>`json_extract(o.payload,'$.${key}')`;
 let selectedDimensions="'{}'";
 for(const key of dimensions)if(filters[key])selectedDimensions=`json_patch(${selectedDimensions},CASE WHEN json_type(o.payload,'$.dimensions.${key}')='text' THEN json_object('${key}',json_extract(o.payload,'$.dimensions.${key}')) ELSE '{}' END)`;
 const fields=['dataset','metric','definition','population','currency','quality','sourceId','retrievedAt','coverageThrough','start','end','channels','value'].map(key=>`${extract(key)} AS ${key}`).join(',');
 const raw=`SELECT o.date,${fields},${selectedDimensions} AS dimensions,CASE WHEN ${extract('start')} IS NULL AND ${extract('end')} IS NULL THEN 'daily' WHEN julianday(${extract('end')})>julianday(${extract('start')}) THEN CASE WHEN ROUND((julianday(${extract('end')})-julianday(${extract('start')}))*86400)<=7200 THEN 'hourly' ELSE 'interval' END ELSE 'unknown' END AS grain FROM json_each(?) p CROSS JOIN observations o INDEXED BY idx_observations_snapshot_date_dataset_rowkey ON o.snapshotId=json_extract(p.value,'$.snapshotId') AND o.date=json_extract(p.value,'$.date') WHERE json_extract(o.payload,'$.dataset') IN (${datasets.map(()=>'?').join(',')})`;
 const rate="(metric LIKE '%_rate' OR metric LIKE '%_ratio' OR metric IN ('cvr','atc','checkoutCompletion','aov','mer','roas','ctr','cpc','cpa'))";
 const sql=`SELECT json_object('date',date,'dataset',dataset,'metric',metric,'value',CASE WHEN MIN(grain)<>MAX(grain) OR COUNT(value)<>COUNT(*) OR (${rate} AND COUNT(*)>1) THEN NULL ELSE SUM(value) END,'definition',definition,'population',population,'currency',currency,'quality',quality,'sourceId',sourceId,'retrievedAt',MAX(retrievedAt),'coverageThrough',CASE WHEN COUNT(coverageThrough)=COUNT(*) THEN MIN(coverageThrough) ELSE NULL END,'start',CASE WHEN COUNT(start)=COUNT(*) THEN MIN(start) ELSE NULL END,'end',CASE WHEN COUNT(end)=COUNT(*) THEN MAX(end) ELSE NULL END,'channels',json(channels),'dimensions',json(dimensions),'contextOnly',json('true')) AS payload FROM (${raw}) GROUP BY date,dataset,metric,definition,population,currency,quality,sourceId,channels,dimensions ORDER BY date,dataset,metric`;
 const result=await store.all<{payload:string}>(sql,JSON.stringify(missing),...datasets);
 return [...rows,...result.map(({payload})=>{const row=JSON.parse(payload);for(const key of ['start','end','population','channels'])if(row[key]===null)delete row[key];return row as Observation;})];
}
