import {afterEach,expect,it,vi} from 'vitest';
import {fetchRechargeSubscriptionCohort,type RetainedRechargeCreation} from '../../lib/sources/recharge-subscription-cohort';
import {fetchKindBatches,fetchKindSource} from '../../lib/sources/kind-fetch';
import {queryClient} from '../../lib/analytics/query';
import {buildSubscriptionExplorer} from '../../lib/analytics/subscription-explorer';
import {kindQualification,type KindConfig} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
import type {Client,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';

const client=initial[0] as Client,now=new Date('2026-10-13T12:35:00Z'),window={from:'2026-10-12',to:'2026-10-13'};
const config:KindConfig={SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'};
const source={provider:'kind-recharge-cancellations',endpoint:'https://api.rechargeapps.com'} as any;
const birth=(subscriptionId:string,createdAt:string):RetainedRechargeCreation=>({subscriptionId,createdAt});
const event=(id:number,object_id:number,created_at:string)=>({id,object_id,created_at,object_type:'subscription',verb:'cancelled',customer_id:999,source:{account_email:'private@example.com'}});
const subscription=(id:number,created_at:string,cancelled_at:string|null=null)=>({id,created_at,cancelled_at,status:cancelled_at?'cancelled':'active'});
const read=(subscriptions:unknown[],events:unknown[]):typeof fetch=>async input=>{
 const url=new URL(String(input));
 if(url.pathname==='/store')return Response.json({store:{platform_domain:config.SHOP_DOMAIN,storefront_domain:'kindpatches.com',test_mode:false}});
 if(url.pathname==='/events')return Response.json({events,next_cursor:null});
 return Response.json({subscriptions:url.searchParams.has('status')?[]:subscriptions,next_cursor:null});
};
const total=(batch:SourceBatch,date:string,metric:string)=>batch.rows.filter(row=>row.date===date&&row.metric===metric).reduce((sum,row)=>sum+(row.value??0),0);
afterEach(()=>vi.useRealTimers());

it('retains a real creation deleted before polling so its cancellation event remains in both sides of the creation-day rate',async()=>{
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,read([],[event(1,41,'2026-10-13T10:00:00Z')]),Date.now()+10000,now,[birth('41','2026-10-13T08:00:00Z')]);
 expect(total(batch,'2026-10-13','new_subscriptions')).toBe(1);
 expect(total(batch,'2026-10-13','same_day_subscription_cancellation_events')).toBe(1);
 expect(total(batch,'2026-10-13','same_day_subscription_cancellations')).toBe(0);
 expect(total(batch,'2026-10-13','subscription_cancellation_events')).toBe(1);
 expect(batch.rows.find(row=>row.metric==='new_subscriptions'&&row.value===1)).toMatchObject({start:'2026-10-13T08:00:00Z',end:'2026-10-13T09:00:00Z'});
 const contract=requireQualifiedSource(kindQualification(batch,source.provider),client);expect(()=>validateRegisteredBatch(batch,contract)).not.toThrow();
 expect(JSON.stringify(batch)).not.toContain('private@example.com');expect(JSON.stringify(batch)).not.toContain('customer_id');expect(JSON.stringify(batch)).not.toContain('subscriptionId');
});

it('unions retained and current records once while keeping the current cancelled-state numerator independent',async()=>{
 const retained=[birth('1','2026-10-13T08:00:00Z'),birth('1','2026-10-13T08:00:00.000Z'),birth('2','2026-10-13T09:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,read([subscription(1,'2026-10-13T08:00:00Z','2026-10-13T10:00:00Z'),subscription(1,'2026-10-13T08:00:00Z','2026-10-13T10:00:00Z')],[event(1,1,'2026-10-13T10:00:00Z')]),Date.now()+10000,now,retained);
 expect(total(batch,'2026-10-13','new_subscriptions')).toBe(2);expect(total(batch,'2026-10-13','same_day_subscription_cancellations')).toBe(1);expect(total(batch,'2026-10-13','same_day_subscription_cancellation_events')).toBe(1);
});

it('rejects conflicting retained births instead of silently assigning one identity to two creation times',async()=>{
 await expect(fetchRechargeSubscriptionCohort(client,config,window,read([],[]),Date.now()+10000,now,[birth('41','2026-10-13T08:00:00Z'),birth('41','2026-10-13T09:00:00Z')])).rejects.toThrow(/creation.*conflict|conflict.*creation/);
});

it('rejects a live record that conflicts with a retained original creation time',async()=>{
 await expect(fetchRechargeSubscriptionCohort(client,config,window,read([subscription(41,'2026-10-13T09:00:00Z')],[]),Date.now()+10000,now,[birth('41','2026-10-13T08:00:00Z')])).rejects.toThrow(/creation.*conflict|conflict.*creation/);
});

it.each([
 ['empty identity',birth('','2026-10-13T08:00:00Z')],
 ['zero identity',birth('0','2026-10-13T08:00:00Z')],
 ['nondecimal identity',birth('not-an-id','2026-10-13T08:00:00Z')],
 ['invalid date',birth('41','2026-02-30T08:00:00Z')],
 ['missing UTC timezone',birth('41','2026-10-13T08:00:00')],
 ['non-UTC offset',birth('41','2026-10-13T09:00:00+01:00')],
 ['event-shaped timestamp',{subscriptionId:'41',created_at:'2026-10-13T08:00:00Z'}],
] as const)('rejects a retained %s without publishing zero-filled cohort facts',async(_label,invalid)=>{
 await expect(fetchRechargeSubscriptionCohort(client,config,window,read([],[]),Date.now()+10000,now,[invalid] as RetainedRechargeCreation[])).rejects.toThrow(/retained.*creation|creation.*retained/);
});

it('keeps retained births inside exact store-day boundaries and excludes the uncompleted hour without inferring births from cancellation events',async()=>{
 const retained=[birth('1','2026-10-11T21:59:59Z'),birth('2','2026-10-11T22:00:00Z'),birth('3','2026-10-13T11:59:59Z'),birth('4','2026-10-13T12:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,read([],[event(1,1,'2026-10-12T10:00:00Z'),event(2,3,'2026-10-13T11:59:59Z'),event(3,99,'2026-10-13T10:00:00Z')]),Date.now()+10000,now,retained);
 expect(total(batch,'2026-10-12','new_subscriptions')).toBe(1);expect(total(batch,'2026-10-13','new_subscriptions')).toBe(1);
 expect(total(batch,'2026-10-12','same_day_subscription_cancellation_events')).toBe(0);expect(total(batch,'2026-10-13','same_day_subscription_cancellation_events')).toBe(1);
 expect(total(batch,'2026-10-13','subscription_cancellation_events')).toBe(2);expect(batch.coverageThrough).toBe('2026-10-13T12:00:00Z');
});

it('uses retained originals in exact-hour day-over-day rates and excludes yesterday’s later event',async()=>{
 const retained=[birth('1','2026-10-12T08:00:00Z'),birth('2','2026-10-12T08:00:00Z'),birth('3','2026-10-13T08:00:00Z'),birth('4','2026-10-13T09:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,read([],[event(1,1,'2026-10-12T10:00:00Z'),event(2,2,'2026-10-12T14:00:00Z'),event(3,3,'2026-10-13T10:00:00Z')]),Date.now()+10000,now,retained);
 const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',compare:'previous',mode:'partial',view:'subscriptions',market:'',stream:'',source:'',device:'',page:''},connections=['kind-triple-whale','kind-recharge-cancellations'].map(provider=>({provider,enabled:true,coverageThrough:batch.coverageThrough})) as any;
 const query=queryClient(client,batch.rows,connections,filters,{preparedDatasets:['subscriptions','subscriptionEvents']}),explorer=buildSubscriptionExplorer({current:[],comparison:[],currentEvents:query.datasetSeries.subscriptionEvents,comparisonEvents:query.comparisonDatasetSeries.subscriptionEvents,range:filters,comparisonRange:query.comparison});
 expect(query.cutoff).toBe('2026-10-13T12:00:00Z');expect(explorer.current.metrics.new_subscriptions).toBe(2);expect(explorer.previous.metrics.new_subscriptions).toBe(2);
 expect(explorer.current.metrics.same_day_cancellation_rate).toBe(.5);expect(explorer.previous.metrics.same_day_cancellation_rate).toBe(.5);expect(explorer.current.metrics.same_day_subscription_cancellations).toBeUndefined();
});

it.each(['source','batches'] as const)('passes retained creations through the %s entry point into qualified published counts',async entry=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 const retained=[birth('41','2026-10-13T08:00:00Z')],fetcher=read([],[event(1,41,'2026-10-13T10:00:00Z')]);
 const batch=entry==='source'?await fetchKindSource(source,client,window,JSON.stringify(config),fetcher,Date.now()+10000,now,retained):(await fetchKindBatches(source,client,window,JSON.stringify(config),fetcher,Date.now()+10000,undefined,undefined,retained).next()).value!.batch;
 expect(total(batch,'2026-10-13','new_subscriptions')).toBe(1);expect(total(batch,'2026-10-13','same_day_subscription_cancellation_events')).toBe(1);
 expect(()=>validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,source.provider),client))).not.toThrow();
});
