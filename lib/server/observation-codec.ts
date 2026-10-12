import type {Observation} from '../analytics/contracts';
import type {FunnelRollupObservation} from '../analytics/funnel-rollup';
type Scope=Omit<FunnelRollupObservation,'value'|'dimensions'|'date'|'start'|'end'|'contributionCount'>;
type Timing=Pick<FunnelRollupObservation,'date'|'start'|'end'|'contributionCount'>;
type Compact={scopes:Scope[];dimensions:Observation['dimensions'][];timings:Timing[];rows:[number,number,number,number|null][]};

/** Most detail rows repeat the source contract and dimensions for five metrics.
 * Store those dictionaries once rather than holding a second full raw export.
 * Every observation field, interval and rollup contribution remains available.
 */
export const observationCodec={
 valid(payload:string):boolean{
  try{
   const data=JSON.parse(payload) as Compact,record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value),optionalString=(value:unknown)=>value===undefined||typeof value==='string';
   if(!record(data)||!Array.isArray(data.scopes)||!Array.isArray(data.dimensions)||!Array.isArray(data.timings)||!Array.isArray(data.rows))return false;
   if(!data.scopes.every(scope=>record(scope)&&(['dataset','metric','definition','sourceId','retrievedAt'] as const).every(key=>typeof scope[key]==='string')&&['complete','partial','historical','estimated'].includes(String(scope.quality))&&(scope.currency===null||typeof scope.currency==='string')&&(scope.coverageThrough===null||typeof scope.coverageThrough==='string')&&optionalString(scope.population)&&(scope.channels===undefined||Array.isArray(scope.channels)&&scope.channels.every(channel=>typeof channel==='string'))))return false;
   if(!data.dimensions.every(dimension=>record(dimension)&&Object.values(dimension).every(value=>typeof value==='string')))return false;
   if(!data.timings.every(timing=>record(timing)&&typeof timing.date==='string'&&optionalString(timing.start)&&optionalString(timing.end)&&(timing.contributionCount===undefined||Number.isSafeInteger(timing.contributionCount)&&Number(timing.contributionCount)>=0)))return false;
   return data.rows.every(row=>Array.isArray(row)&&row.length===4&&[data.scopes,data.dimensions,data.timings].every((dictionary,index)=>Number.isInteger(row[index])&&Number(row[index])>=0&&Number(row[index])<dictionary.length)&&(row[3]===null||typeof row[3]==='number'&&Number.isFinite(row[3])));
  }catch{return false;}
 },
 encode(observations:Observation[]):string{
  const data:Compact={scopes:[],dimensions:[],timings:[],rows:[]},scopes=new Map<string,number>(),dimensions=new Map<string,number>(),timings=new Map<string,number>();
  const index=<T>(value:T,entries:T[],keys:Map<string,number>)=>{const key=JSON.stringify(value),existing=keys.get(key);if(existing!==undefined)return existing;const next=entries.length;entries.push(value);keys.set(key,next);return next;};
  for(const observation of observations){
   const {value,dimensions:dimension,date,start,end,contributionCount,...scope}=observation as FunnelRollupObservation;
   const timing:Timing={date,...start!==undefined?{start}:{},...end!==undefined?{end}:{},...contributionCount!==undefined?{contributionCount}:{}};
   data.rows.push([index(scope,data.scopes,scopes),index(dimension,data.dimensions,dimensions),index(timing,data.timings,timings),value]);
  }
  return JSON.stringify(data);
 },
 decode(payload:string):Observation[]{
  const data=JSON.parse(payload) as Compact;
  return data.rows.map(([scopeId,dimensionId,timingId,value])=>{const scope=data.scopes[scopeId];return {...scope,...data.timings[timingId],dimensions:{...data.dimensions[dimensionId]},...scope.channels?{channels:[...scope.channels]}:{},value};});
 }
};
