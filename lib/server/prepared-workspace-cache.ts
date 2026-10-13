import {runtimePlatform} from '@avenue/runtime';
import type {Client,Connection,QueryFilters} from '../analytics/contracts';
import type {workspacePresentation} from '../analytics/presentation';
import {todayIn,shiftDate,comparisonPeriod} from '../analytics/windows';
import {withAnalyticsMemory} from './analytics-memory';
import {QueryCache} from './query-cache';
import type {Store} from './store';
import {intradayConnections} from '../analytics/intraday-coverage';
import {trendContextWindows} from '../analytics/trend-context';

type Presentation=ReturnType<typeof workspacePresentation>;
type Frame=Omit<Presentation,'connections'>;
const codecVersion='gzip-frame-v8',maximumExpandedBytes=4*1024*1024,maximumCompressedCharacters=512*1024;
export type PreparedWorkspaceInput={
 store:Store;organizationId:string;client:Client;filters:QueryFilters;preparedDatasets:string[];
 freshConnections?:Connection[];
 selection:{datasets:string[];dimensions?:boolean;includePriorWeek?:boolean;includeOperations?:boolean;trendDatasets?:string[]};
 deadline?:number;
};
// Retained byte limits apply to gzip/base64 strings (including their UTF-16
// allocation). Decoding temporarily allocates the full caller-owned frame.
const cache=new QueryCache<string>({ttlMs:180000,maxEntries:32,maxBytes:16*1024*1024,maxEntryBytes:1024*1024,coalesce:true},{encode:value=>value,decode:value=>value});
const databaseNamespaces=new WeakMap<Store['db'],number>();let nextDatabaseNamespace=0;
function databaseNamespace(db:Store['db']){let namespace=databaseNamespaces.get(db);if(namespace===undefined){namespace=++nextDatabaseNamespace;databaseNamespaces.set(db,namespace);}return namespace;}
// These aliases retain only bounded existing cache keys, never another frame.
// Recovery is allowed after current authorization, source configuration and
// qualifications have been read successfully for this exact analytics scope.
const lastGoodFrames=new Map<string,string>();
function transientDatabaseFailure(error:unknown):boolean{return error instanceof Error&&(error.name==='TimeoutError'||error.message.includes('Database request timed out')||transientDatabaseFailure(error.cause));}
// Deliberately enumerate the analytics contract. A caller's workspace fields,
// browser scope, member records and private notes cannot enter the cache.
const frameFields=['client','metrics','prior','comparison','verdict','series','datasetSeries','comparisonDatasetSeries','trendDatasetSeries','trendComparisonDatasetSeries','datasetHourlySeries','comparisonDatasetHourlySeries','datasetHistorySeries','details','actions','opportunities','views','preparedDatasets','datasetMetrics','activeIncidents','warnings','cutoff','availableDimensions','evidence','comparisonEvidence','selectedCount','liveOperations','subscriptions','viewMetrics','viewPriorMetrics','experimentDetails','comparisonViews','qualifiedPageAlerts','trafficExplorer','sourceQuality','efficiencyEvidence'] as const satisfies readonly (keyof Frame)[];
function analyticsFrame(value:Presentation):Frame{
 // New presentation fields require an explicit decision about cache contents.
 const completeFields:Exclude<keyof Frame,typeof frameFields[number]> extends never?typeof frameFields:never=frameFields;
 return Object.fromEntries(completeFields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])) as unknown as Frame;
}
async function encodeFrame(frame:Frame){
 const json=JSON.stringify(frame);if(new TextEncoder().encode(json).byteLength>maximumExpandedBytes)throw Error('Prepared frame exceeds expanded limit');
 const stream=new Response(json).body!.pipeThrough(new CompressionStream('gzip'));
 const bytes=new Uint8Array(await new Response(stream).arrayBuffer()),parts:string[]=[];
 for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
 return btoa(parts.join(''));
}
async function decodeFrame(payload:string,input:PreparedWorkspaceInput):Promise<Frame>{
 if(typeof payload!=='string'||payload.length>maximumCompressedCharacters||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))throw Error('Invalid prepared frame codec');
 const bytes=Uint8Array.from(atob(payload),character=>character.charCodeAt(0));
 const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts:string[]=[];let total=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>maximumExpandedBytes)throw Error('Prepared frame exceeds expanded limit');parts.push(decoder.decode(value,{stream:true}));}parts.push(decoder.decode());}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const frame=JSON.parse(parts.join(''));if(!validFrame(frame,input))throw Error('Invalid prepared frame contract');return frame;
}
function validFrame(frame:unknown,input:PreparedWorkspaceInput):frame is Frame{
 if(!frame||typeof frame!=='object'||Array.isArray(frame))return false;
 const value=frame as Record<string,unknown>;
 if(Object.keys(value).some(key=>!frameFields.includes(key as typeof frameFields[number])))return false;
 if(JSON.stringify(stable(value.client))!==JSON.stringify(stable(input.client)))return false;
 for(const key of ['warnings','series','details','actions','opportunities','activeIncidents','evidence','comparisonEvidence','liveOperations','experimentDetails','preparedDatasets'])if(!Array.isArray(value[key]))return false;
 if(JSON.stringify([...(value.preparedDatasets as string[])].sort())!==JSON.stringify([...new Set(input.preparedDatasets)].sort()))return false;
 if(!Number.isSafeInteger(value.selectedCount)||(value.selectedCount as number)<0||value.cutoff!==null&&typeof value.cutoff!=='string')return false;
 for(const key of ['metrics','prior','datasetMetrics','viewMetrics','viewPriorMetrics']){const summary=value[key];if(!summary||typeof summary!=='object'||Array.isArray(summary)||Object.values(summary).some(metric=>metric!==null&&(typeof metric!=='number'||!Number.isFinite(metric))))return false;}
 for(const key of ['views','datasetSeries','comparisonDatasetSeries','trendDatasetSeries','trendComparisonDatasetSeries','datasetHourlySeries','comparisonDatasetHourlySeries','datasetHistorySeries','availableDimensions','subscriptions','comparison','verdict'])if(!value[key]||typeof value[key]!=='object'||Array.isArray(value[key]))return false;
 return true;
}
function stable(value:unknown):unknown{
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]));
 return value;
}
async function token(input:PreparedWorkspaceInput,connections:Connection[],configuration?:(key:string)=>void){
 const {store,organizationId,client}=input;
 const pointerRead=store.all<{sourceId:string;snapshotId:string;date:string}>("SELECT c.sourceId,c.snapshotId,c.date FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready' ORDER BY c.sourceId,c.date,c.snapshotId",organizationId,client.id).then(value=>({value}),error=>({error}));
 const qualifications=await store.all<{sourceId:string;connectionVersion:number;clientVersion:number;version:number;profiles:string|null}>("SELECT sourceId,connectionVersion,clientVersion,version,json_extract(payload,'$.profiles') AS profiles FROM qualifications WHERE organizationId=? AND clientId=? ORDER BY sourceId,version",organizationId,client.id);
 const {period:_shortcut,...fixedFilters}=input.filters;
 configuration?.(JSON.stringify(stable([databaseNamespace(store.db),organizationId,client,todayIn(client.timezone),fixedFilters,[...new Set(input.preparedDatasets)].sort(),input.selection,connections.map(source=>[source.id,source.version,source.provider,source.enabled]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),qualifications])));
 const captured=await pointerRead;if('error' in captured)throw captured.error;const pointers=captured.value;
 // Match Store.observations' union of historical source contracts. An unknown
 // or incomplete qualification stays conservative rather than hiding data.
 const profiles=new Map<string,{dataset:string;metric:string}[]|null>();
 for(const qualification of qualifications){let parsed:unknown;try{parsed=JSON.parse(qualification.profiles??'null');}catch{parsed=null;}
  if(!Array.isArray(parsed)||!parsed.length||parsed.some(profile=>!profile||typeof profile.dataset!=='string'||typeof profile.metric!=='string')){profiles.set(qualification.sourceId,null);continue;}
  if(profiles.get(qualification.sourceId)!==null)profiles.set(qualification.sourceId,[...profiles.get(qualification.sourceId)??[],...parsed]);
 }
 const selectedDatasets=new Set(input.selection.datasets),comparison=comparisonPeriod(input.filters),overviewFrom=[comparison.from,shiftDate(input.filters.to,-29)].sort()[0],subscriptionTo=[input.filters.to,comparison.to].sort().at(-1)!;
 const detailWindows:[string,string][]=[[input.filters.from,input.filters.to],[comparison.from,comparison.to]];
 if(input.selection.includePriorWeek!==false)detailWindows.push([shiftDate(input.filters.from,-7),shiftDate(input.filters.to,-7)]);
 const operationalMetrics=new Set(['active_customers','active_ads','active_creatives']);
 const operationalSources=new Set([...profiles].filter(([,registered])=>registered?.length&&registered.every(profile=>operationalMetrics.has(profile.metric))).map(([sourceId])=>sourceId));
 const latestOperationalDates=new Map<string,string>();for(const pointer of pointers)if(operationalSources.has(pointer.sourceId)){const prior=latestOperationalDates.get(pointer.sourceId);if(!prior||pointer.date>prior)latestOperationalDates.set(pointer.sourceId,pointer.date);}
 const inWindow=(date:string,from:string,to:string)=>date>=from&&date<=to;
 const contributes=(sourceId:string,date?:string)=>{const registered=profiles.get(sourceId);if(!registered)return true;
  if(operationalSources.has(sourceId))return input.selection.includeOperations!==false&&(date===undefined||date===latestOperationalDates.get(sourceId));
  return registered.some(profile=>selectedDatasets.has(profile.dataset)&&(date===undefined||
   profile.dataset==='subscriptions'&&date<=subscriptionTo||operationalMetrics.has(profile.metric)||
   profile.dataset==='overview'&&inWindow(date,overviewFrom,input.filters.to)||
   input.selection.trendDatasets?.includes(profile.dataset)&&trendContextWindows(input.filters).some(([from,to])=>inWindow(date,from,to))||
   profile.dataset==='markets'&&inWindow(date,shiftDate(input.filters.from,-1),input.filters.to)||
   detailWindows.some(([from,to])=>inWindow(date,from,to))));
 };
 const selectedPointers=pointers.filter(pointer=>contributes(pointer.sourceId,pointer.date));
 const relevantSources=new Set([...connections.filter(source=>contributes(source.id)).map(source=>source.id),...selectedPointers.map(pointer=>pointer.sourceId)]);
 // Intraday cutoff calculation uses every configured core source, even when
 // that source has no current rows. Closed historical frames do not depend on
 // the current hour's commerce/cancellation pointers outside their windows.
 const primarySources=new Set(intradayConnections(connections,input.filters.view).map(source=>source.id)),partial=input.filters.mode==='partial',core=(source:Connection)=>primarySources.has(source.id);
 if(partial)for(const source of connections)if(core(source))relevantSources.add(source.id);
 const sources=connections.filter(source=>relevantSources.has(source.id)).map(source=>[source.id,source.version,source.provider,source.enabled,...partial&&core(source)?[source.coverageThrough]:[]]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const partialKindCaveat=partial&&connections.some(source=>source.enabled&&source.provider?.startsWith('kind-')&&source.provider!=='kind-triple-whale');
 // The Today shortcut is resolved to exact store dates before this call. It
 // changes navigation, not these analytics; share the hosted warmer's frame.
 const {period:_period,...resolvedFilters}=input.filters;
 return JSON.stringify(stable(['prepared-workspace-v6',organizationId,client,todayIn(client.timezone),resolvedFilters,[...new Set(input.preparedDatasets)].sort(),{...input.selection,datasets:[...new Set(input.selection.datasets)].sort(),dimensions:!!input.selection.dimensions,includePriorWeek:input.selection.includePriorWeek!==false},sources,selectedPointers,qualifications.filter(qualification=>relevantSources.has(qualification.sourceId)),partialKindCaveat]));
}
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
type DurableFrame={payload:string;payloadHash:string};
function checkBudget(input:PreparedWorkspaceInput){if(input.deadline!==undefined&&Date.now()>=input.deadline)throw Error('Prepared frame warm budget elapsed');}
async function durableFrame(input:PreparedWorkspaceInput,cacheKey:string):Promise<{payload:string;frame:Frame}|null>{
 let saved:DurableFrame|null=null;
 try{checkBudget(input);saved=await input.store.first<DurableFrame>('SELECT payload,payloadHash FROM prepared_workspace_cache WHERE organizationId=? AND clientId=? AND cacheKey=? AND codecVersion=? AND expiresAt>?',input.organizationId,input.client.id,cacheKey,codecVersion,Date.now());checkBudget(input);}
 catch(error){checkBudget(input);if(transientDatabaseFailure(error))throw error;return null;}
 if(!saved)return null;
 try{if(typeof saved.payload!=='string'||saved.payload.length>maximumCompressedCharacters||await digest(saved.payload)!==saved.payloadHash)throw Error('Invalid prepared cache integrity');return {payload:saved.payload,frame:await decodeFrame(saved.payload,input)};}
 catch{try{await input.store.run('DELETE FROM prepared_workspace_cache WHERE organizationId=? AND clientId=? AND cacheKey=? AND payloadHash=?',input.organizationId,input.client.id,cacheKey,saved.payloadHash);}catch{/* Optional derived-cache repair. */}return null;}
}
async function publishFrame(input:PreparedWorkspaceInput,cacheKey:string,payload:string){
 if(payload.length>maximumCompressedCharacters)return;
 try{checkBudget(input);const now=Date.now(),db=input.store.db;await db.batch([
  db.prepare('INSERT INTO prepared_workspace_cache(organizationId,clientId,cacheKey,codecVersion,payload,payloadHash,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organizationId,clientId,cacheKey) DO UPDATE SET codecVersion=excluded.codecVersion,payload=excluded.payload,payloadHash=excluded.payloadHash,createdAt=excluded.createdAt,expiresAt=excluded.expiresAt').bind(input.organizationId,input.client.id,cacheKey,codecVersion,payload,await digest(payload),now,now+86400000),
  db.prepare('DELETE FROM prepared_workspace_cache WHERE organizationId=? AND clientId=? AND (expiresAt<=? OR cacheKey NOT IN (SELECT cacheKey FROM prepared_workspace_cache WHERE organizationId=? AND clientId=? ORDER BY createdAt DESC,cacheKey LIMIT 32))').bind(input.organizationId,input.client.id,now,input.organizationId,input.client.id)
 ]);
 }catch{/* Shared derived storage must never break the canonical response. */}
}
// A changed token or failed final metadata read must return this computation
// without installing it. Serialized transport gives coalesced callers their
// own frame even in this uncached path.
class UncachedFrame extends Error {constructor(public payload:string){super('Prepared frame source metadata changed');}}
class UncachedValue extends Error {constructor(public frame:Frame){super('Prepared frame encoding unavailable');}}
class CanonicalFailure extends Error {constructor(public cause:unknown){super('Canonical analytics computation failed');}}
async function lastGoodFrame(input:PreparedWorkspaceInput,configurationKey:string|undefined,connections:Connection[]):Promise<Presentation|null>{
 if(input.deadline!==undefined||!configurationKey)return null;const key=lastGoodFrames.get(configurationKey);if(!key)return null;
 try{const payload=await cache.getEncoded(key,async()=>{throw Error('Saved frame expired');});return {...await decodeFrame(payload,input),connections};}
 catch{lastGoodFrames.delete(configurationKey);return null;}
}

/** Call only after authorizing this client. The shared frame contains no user
 * context; callers attach current scope/findings/reviews/notes independently.
 * Source headers are read fresh and never serialized. Only a native miss takes
 * the expensive analytics memory lease; warm hits do not queue behind it.
 */
export async function preparedWorkspaceFrame(input:PreparedWorkspaceInput,load:(freshConnections:Connection[],canonicalFilters:QueryFilters)=>Promise<Presentation>):Promise<Presentation>{
 checkBudget(input);
 const connections=input.freshConnections??await input.store.connections(input.organizationId,input.client.id);
 const canonical=()=>{
  // Small financial/market frames must not queue behind a monthly traffic
  // warmer. Only dimensional detail needs the large-allocation memory lease.
  const {period:_period,...canonicalFilters}=input.filters;
  const compute=()=>{checkBudget(input);return load(connections,canonicalFilters);};
  const work=input.selection.datasets.some(dataset=>['funnels','traffic','products','creatives','experiments'].includes(dataset))?withAnalyticsMemory(compute):Promise.resolve().then(compute);
  if(input.deadline===undefined)return work;
  let timer:ReturnType<typeof setTimeout>;
  // An expired queued warmer must return promptly and never begin source work
  // when its memory lease arrives later. The native gate still owns any work
  // that was already running until that computation actually settles.
  return Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Prepared frame warm budget elapsed')),Math.max(0,input.deadline!-Date.now()));})]).finally(()=>clearTimeout(timer));
 };
 if(runtimePlatform!=='vercel')return canonical();
 let configurationKey:string|undefined;
 const prepare=async()=>{
 let sourceToken:string,cacheKey:string;
 try{sourceToken=await token(input,connections,key=>{configurationKey=key;});cacheKey=await digest(sourceToken);}catch(error){checkBudget(input);if(transientDatabaseFailure(error)){const saved=await lastGoodFrame(input,configurationKey,connections);if(saved)return saved;}return canonical();}
 // Dedicated warming deadlines cannot cancel a foreground caller that joined
 // the same miss. Both namespaces share the ready durable frame after publish.
 const key=`${databaseNamespace(input.store.db)}:${input.deadline===undefined?'request':'warm'}:${cacheKey}`;
 let started=false,result:Presentation|undefined,decoded:Frame|undefined;
 try{
  const payload=await cache.getEncoded(key,async()=>{
   const saved=await durableFrame(input,cacheKey);if(saved){decoded=saved.frame;return saved.payload;}
   checkBudget(input);
   started=true;try{result=await canonical();}catch(error){throw new CanonicalFailure(error);}
   const frame=analyticsFrame(result);let payload:string;try{payload=await encodeFrame(frame);}catch{throw new UncachedValue(frame);}
   try{checkBudget(input);const currentConnections=await input.store.connections(input.organizationId,input.client.id);if(await token(input,currentConnections)!==sourceToken)throw new UncachedFrame(payload);}
   catch{throw new UncachedFrame(payload);}
   // Contract validation happens before either shared or local publication.
   if(!validFrame(frame,input))throw new UncachedValue(frame);
   await publishFrame(input,cacheKey,payload);
   return payload;
  });
  const frame={...decoded??await decodeFrame(payload,input),connections};
  if(configurationKey){lastGoodFrames.delete(configurationKey);while(lastGoodFrames.size>=32){const oldest=lastGoodFrames.keys().next().value;if(oldest===undefined)break;lastGoodFrames.delete(oldest);}lastGoodFrames.set(configurationKey,key);}
  return frame;
 }catch(error){
  const failure=error instanceof CanonicalFailure?error.cause:error;
  if(transientDatabaseFailure(failure)){const saved=await lastGoodFrame(input,configurationKey,connections);if(saved)return saved;}
  if(error instanceof CanonicalFailure)throw error.cause;
  if(error instanceof UncachedFrame)return {...await decodeFrame(error.payload,input),connections};
  if(error instanceof UncachedValue)return {...structuredClone(error.frame),connections};
  // Optional cache/serialization failures must not invoke an already started
  // canonical computation twice; genuine canonical errors stay errors.
  if(result)return {...analyticsFrame(result),connections};
  if(started)throw error;
  return canonical();
 }
 };
 const work=prepare();if(input.deadline!==undefined)return work;
 let timer:ReturnType<typeof setTimeout>;
 const recovery=new Promise<Presentation>(resolve=>{timer=setTimeout(()=>{void lastGoodFrame(input,configurationKey,connections).then(saved=>{if(saved){console.warn('Prepared workspace reused validated saved frame',{reason:'foreground-deadline'});resolve(saved);}});},8000);});
 // The one existing computation may finish and warm the frame afterwards.
 // A slow optional metadata/cache read must never start a second full rebuild.
 return Promise.race([work,recovery]).finally(()=>clearTimeout(timer));
}
