import {expect,it} from 'vitest';
import {TrafficPageLoader,trafficPageKey,trafficPageRequest,type TrafficPageState} from '../../lib/analytics/traffic-page-loader';
import {compactTrafficExplorer} from '../../lib/analytics/traffic-presentation';
import type {QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-01',to:'2026-10-11',mode:'closed',compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-11',view:'traffic',market:'US',source:'social',device:'mobile',stream:'',page:''};
const request=(scope='actor-a',page='/lp',version='v1')=>({key:trafficPageKey(scope,'kind-patches',filters,page,version),url:trafficPageRequest('kind-patches',filters,page),clientId:'kind-patches',scope});
const body=(scope='actor-a')=>({clients:[{client:{id:'kind-patches',timezone:'UTC',currency:'USD'},browserScopeKey:scope,trafficExplorer:compactTrafficExplorer([],[],'traffic'),cutoff:null,warnings:[],comparison:{from:'2026-09-01',to:'2026-09-11'},datasetSeries:{},comparisonDatasetSeries:{}}],loadedAt:'2026-10-12T12:00:00Z'});
it('binds all filters, comparison dates, page, client, authenticated scope and source version',()=>{
 const params=new URL(request().url,'https://workspace.example').searchParams;expect(params.get('drill')).toBe('traffic-page');expect(params.get('page')).toBe('/lp');for(const key of ['from','to','compare','compareFrom','compareTo','mode','market','source','device'] as const)expect(params.get(key)).toBe(filters[key]);
 for(const changes of [{from:'2026-10-02'},{to:'2026-10-12'},{compareFrom:'2026-08-01'},{mode:'partial'},{market:'CA'},{source:'search'},{device:'desktop'},{stream:'subscriptions'}])expect(trafficPageKey('actor-a','kind-patches',{...filters,...changes} as QueryFilters,'/lp','v1')).not.toBe(request().key);
 expect(request('actor-b').key).not.toBe(request().key);expect(request('actor-a','/other').key).not.toBe(request().key);expect(request('actor-a','/lp','v2').key).not.toBe(request().key);
});
it('serves a fresh page immediately then refreshes it after sixty seconds without extending freshness on reads',async()=>{
 let now=0,calls=0;const loader=new TrafficPageLoader(()=>now),states:TrafficPageState[]=[],fetcher:typeof fetch=async()=>{calls++;return Response.json(body());};
 await loader.load(request(),state=>states.push(state),fetcher);now=59000;await loader.load(request(),state=>states.push(state),fetcher);expect(calls).toBe(1);expect(states.at(-1)?.loading).toBe(false);now=60000;await loader.load(request(),state=>states.push(state),fetcher);expect(calls).toBe(2);expect(states.at(-2)).toMatchObject({loading:true,error:''});expect(states.at(-2)?.data).not.toBeNull();
});
it('aborts page changes and ignores a late response from the previous request',async()=>{
 const loader=new TrafficPageLoader(),states:TrafficPageState[]=[],pending:{resolve:(response:Response)=>void;signal:AbortSignal}[]=[];
 const fetcher:typeof fetch=async(_url,options)=>new Promise<Response>(resolve=>pending.push({resolve,signal:options!.signal as AbortSignal}));
 const old=loader.load(request(),state=>states.push(state),fetcher),next=loader.load(request('actor-a','/other'),state=>states.push(state),fetcher);expect(pending[0].signal.aborted).toBe(true);pending[1].resolve(Response.json(body()));await next;const count=states.length;pending[0].resolve(Response.json(body()));await old;expect(states).toHaveLength(count);expect(states.at(-1)?.key).toBe(request('actor-a','/other').key);
 loader.cancel();expect(pending[1].signal.aborted).toBe(true);
});
it('shows a failed load and permits a retry; legacy and changed authenticated scopes cannot replay cached data',async()=>{
 const loader=new TrafficPageLoader(),states:TrafficPageState[]=[];await loader.load(request(),state=>states.push(state),async()=>Response.json({error:'Please sign in again'},{status:401}));expect(states.at(-1)).toMatchObject({loading:false,error:'Please sign in again',data:null});
 await loader.load(request(),state=>states.push(state),async()=>Response.json(body()),true);expect(states.at(-1)?.data).not.toBeNull();await loader.load(request('actor-b'),state=>states.push(state),async()=>Response.json(body()));expect(states.at(-1)?.error).toContain('access changed');expect(states.at(-1)?.data).toBeNull();
 let calls=0;const legacy={...request(),scope:undefined};for(let index=0;index<2;index++)await loader.load(legacy,state=>states.push(state),async()=>{calls++;return Response.json(body());});expect(calls).toBe(2);
});
