import type {Connection,QueryFilters} from './contracts';
import type {TrafficExplorer} from './traffic-presentation';
import type {ExplorerSeriesPoint} from './traffic-explorer';
import {intradayConnections} from './intraday-coverage';
export type TrafficPageDetail={explorer:TrafficExplorer;cutoff:string|null;warnings:string[];comparison:{from:string;to:string};currentSeries:ExplorerSeriesPoint[];comparisonSeries:ExplorerSeriesPoint[];timezone:string;currency:string;loadedAt:string|null};
export type TrafficPageState={key:string;data:TrafficPageDetail|null;loading:boolean;error:string};
export function trafficPageRequest(clientId:string,filters:QueryFilters,page:string){const params=new URLSearchParams();for(const [key,value] of Object.entries(filters))if(typeof value==='string')params.set(key,value);params.set('clientId',clientId);params.set('view','traffic');params.set('page',page);params.set('drill','traffic-page');return `/api/workspace?${params}`;}
export function trafficPageKey(scope:string|undefined,clientId:string,filters:QueryFilters,page:string,version:string){return JSON.stringify([scope??null,clientId,filters.from,filters.to,filters.compare,filters.compareFrom??null,filters.compareTo??null,filters.mode,filters.market,filters.stream,filters.source,filters.device,page,version]);}
export function trafficRecordVersion(record:{client:{version:number;timezone:string;currency:string};cutoff:string|null;connections:Connection[]},dataset:'traffic'|'funnels'='traffic'){return JSON.stringify([record.client.version,record.client.timezone,record.client.currency,record.cutoff,intradayConnections(record.connections,dataset).map(source=>[source.id,source.version,source.enabled,source.lastSuccess,source.coverageThrough,source.error]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);}
/** Component-local cache. Authenticated scope, source versions, every period
 * and dimension are part of the key; legacy frames without scope never cache.
 * Cancellation also guards late responses from fetchers that ignore abort. */
export class TrafficPageLoader{
 private cache=new Map<string,{data:TrafficPageDetail;receivedAt:number}>();
 private controller:AbortController|null=null;private generation=0;private scope:string|undefined;
 constructor(private now=()=>Date.now()){}
 cancel(){this.generation++;this.controller?.abort();this.controller=null;}
 async load(request:{key:string;url:string;clientId:string;scope:string|undefined},changed:(state:TrafficPageState)=>void,fetcher:typeof fetch=fetch,force=false){
  this.cancel();if(this.scope!==request.scope){this.cache.clear();this.scope=request.scope;}const generation=this.generation,controller=this.controller=new AbortController(),cached=request.scope?this.cache.get(request.key):undefined,data=cached?.data??null;
  let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
  const timeoutMessage='Landing-page detail took too long. Please retry.';
  const emit=(next:Omit<TrafficPageState,'key'>)=>{if(generation===this.generation&&(!controller.signal.aborted||timedOut))changed({key:request.key,...next});};
  if(!force&&cached&&this.now()-cached.receivedAt<60000){emit({data,loading:false,error:''});return;}
  emit({data,loading:true,error:''});
  try{const read=async()=>{const response=await fetcher(request.url,{signal:controller.signal});return {response,body:await response.json() as any};};
   const {response,body}=await Promise.race([read(),new Promise<Awaited<ReturnType<typeof read>>>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error(timeoutMessage));},30000);})]);if(!response.ok)throw Error(typeof body.error==='string'?body.error:'Landing-page detail could not load. Please retry.');
   const record=body.clients?.find((record:any)=>record.client?.id===request.clientId),explorer=record?.trafficExplorer as TrafficExplorer|undefined;
   if(request.scope&&record?.browserScopeKey!==request.scope)throw Error('Your workspace access changed. Refresh the dashboard before opening this page.');
   if(!explorer||explorer.version!==1||!Array.isArray(explorer.current?.pages)||!explorer.current?.breakdowns)throw Error('Landing-page detail was not returned. Please retry.');
   const next:TrafficPageDetail={explorer,cutoff:record.cutoff??null,warnings:Array.isArray(record.warnings)?record.warnings:[],comparison:record.comparison,currentSeries:record.datasetSeries?.[explorer.current.dataset]??[],comparisonSeries:record.comparisonDatasetSeries?.[explorer.current.dataset]??[],timezone:record.client.timezone,currency:record.client.currency,loadedAt:typeof body.loadedAt==='string'?body.loadedAt:null};
   if(generation!==this.generation||controller.signal.aborted)return;
   if(request.scope){this.cache.delete(request.key);this.cache.set(request.key,{data:next,receivedAt:this.now()});if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);}
   emit({data:next,loading:false,error:''});
  }catch(error){emit({data,loading:false,error:timedOut?timeoutMessage:error instanceof Error?error.message:'Landing-page detail could not load. Please retry.'});}
  finally{if(timer)clearTimeout(timer);}
 }
}
