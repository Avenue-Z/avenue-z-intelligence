import {expect,it} from 'vitest';
import {fetchRechargeSubscriptionCohort} from '../../lib/sources/recharge-subscription-cohort';
import {queryClient} from '../../lib/analytics/query';
import {buildSubscriptionExplorer,subscriptionMetricValue} from '../../lib/analytics/subscription-explorer';
import {buildAIContext} from '../../lib/ai/context';
import {kindQualification} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
import type {Client,QueryFilters} from '../../lib/analytics/contracts';

const client=initial[0] as Client,config={RECHARGE_ADMIN_TOKEN:'private-test-token'} as any;
const now=new Date('2026-10-13T12:35:00Z'),window={from:'2026-10-12',to:'2026-10-13'};
const subscription=(id:number,created_at:string,cancelled_at:string|null=null)=>({id,created_at,cancelled_at,status:cancelled_at?'cancelled':'active'});
const event=(id:number,object_id:number,created_at:string)=>({id,object_id,created_at,object_type:'subscription',verb:'cancelled',customer_id:999,source:{account_email:'private@example.com'},updated_attributes:[]});
const fetcher=(subscriptions:unknown[],events:unknown[]):typeof fetch=>async url=>new URL(String(url)).pathname==='/events'?Response.json({events,next_cursor:null}):Response.json({subscriptions,next_cursor:null});
const sum=(batch:Awaited<ReturnType<typeof fetchRechargeSubscriptionCohort>>,date:string,metric:string)=>batch.rows.filter(row=>row.date===date&&row.metric===metric).reduce((n,row)=>n+(row.value??0),0);

it('counts first creation-day cancellation events after reactivation while preserving the separate state metric',async()=>{
 const subscriptions=[subscription(1,'2026-10-13T08:00:00Z'),subscription(2,'2026-10-13T09:00:00Z','2026-10-13T10:00:00Z'),subscription(3,'2026-10-13T11:00:00Z')];
 const events=[event(102,1,'2026-10-13T11:00:00Z'),event(101,1,'2026-10-13T10:00:00'),event(101,1,'2026-10-13T10:00:00'),event(103,2,'2026-10-13T10:00:00Z'),event(104,3,'2026-10-13T12:00:00Z'),event(105,99,'2026-10-13T10:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,fetcher(subscriptions,events),Date.now()+10000,now);
 expect(sum(batch,window.to,'new_subscriptions')).toBe(3);
 expect(sum(batch,window.to,'same_day_subscription_cancellations')).toBe(1);
 expect(sum(batch,window.to,'same_day_subscription_cancellation_events')).toBe(2);
 expect(sum(batch,window.to,'subscription_cancellation_events')).toBe(3);
 expect(batch.rows.find(row=>row.metric==='same_day_subscription_cancellation_events'&&row.value===2)).toMatchObject({start:'2026-10-13T10:00:00Z',end:'2026-10-13T11:00:00Z',population:'recharge_new_subscription_records',quality:'partial'});
 const contract=requireQualifiedSource(kindQualification(batch,'kind-recharge-cancellations'),client);
 expect(contract.profiles.filter(profile=>profile.dataset==='subscriptionEvents')).toHaveLength(5);
 expect(()=>validateRegisteredBatch(batch,contract)).not.toThrow();
 expect(JSON.stringify(batch)).not.toContain('customer_id');expect(JSON.stringify(batch)).not.toContain('private@example.com');expect(JSON.stringify(batch)).not.toContain('object_id');
});

it('matches the completed cancellation hour in the query, explorer and AI context without using current-state counts',async()=>{
 const subscriptions=[subscription(1,'2026-10-12T08:00:00Z'),subscription(2,'2026-10-12T08:00:00Z'),subscription(3,'2026-10-13T08:00:00Z'),subscription(4,'2026-10-13T09:00:00Z')];
 const events=[event(1,1,'2026-10-12T10:00:00Z'),event(2,2,'2026-10-12T14:00:00Z'),event(3,3,'2026-10-13T10:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,fetcher(subscriptions,events),Date.now()+10000,now);
 const filters:QueryFilters={from:window.to,to:window.to,view:'subscriptions',mode:'partial',compare:'previous',market:'',stream:'',source:'',device:'',page:''};
 const connections=['kind-triple-whale','kind-recharge-cancellations'].map(provider=>({provider,enabled:true,coverageThrough:batch.coverageThrough})) as any;
 const storedRows=batch.rows.map(row=>({...row,sourceId:'recharge',coverageThrough:batch.coverageThrough,retrievedAt:now.toISOString()}));
 const query=queryClient(client,storedRows,connections,filters,{preparedDatasets:['subscriptions','subscriptionEvents']});
 const explorer=buildSubscriptionExplorer({current:[],comparison:[],currentEvents:query.datasetSeries.subscriptionEvents,comparisonEvents:query.comparisonDatasetSeries.subscriptionEvents,range:filters,comparisonRange:query.comparison});
 expect(query.cutoff).toBe('2026-10-13T12:00:00Z');
 expect(explorer.current.metrics.same_day_subscription_cancellation_events).toBe(1);expect(explorer.previous.metrics.same_day_subscription_cancellation_events).toBe(1);
 expect(subscriptionMetricValue(explorer.current.metrics,'same_day_cancellation_rate')).toBe(.5);expect(subscriptionMetricValue(explorer.previous.metrics,'same_day_cancellation_rate')).toBe(.5);
 const context=buildAIContext([{...query,note:{body:''},findings:[],reviews:[]}],filters),visual=(context.clients[0] as any).visualBreakdowns.subscriptions;
 expect(visual.current.metrics.same_day_cancellation_rate).toBe(.5);expect(visual.previous.metrics.same_day_cancellation_rate).toBe(.5);
 expect(visual.current.metrics.subscription_cancellation_events).toBe(1);expect(visual.previous.metrics.subscription_cancellation_events).toBe(1);
 expect(visual.instruction).toContain('same_day_subscription_cancellation_events');
 expect(context.clients[0].strategyDiagnoses.calendarCancellations.current.total).toBe(1);expect(context.clients[0].strategyDiagnoses.calendarCancellations.comparison.total).toBe(1);
});

it('keeps AI historical chart context at the same completed clock while selected multi-day cancellation totals retain full prior days',async()=>{
 const subscriptions=[subscription(1,'2026-10-12T08:00:00Z'),subscription(2,'2026-10-12T08:00:00Z'),subscription(3,'2026-10-13T08:00:00Z')];
 const events=[event(1,1,'2026-10-12T10:00:00Z'),event(2,2,'2026-10-12T14:00:00Z'),event(3,3,'2026-10-13T10:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,{from:'2026-10-11',to:window.to},fetcher(subscriptions,events),Date.now()+10000,now);
 const filters:QueryFilters={from:window.from,to:window.to,view:'subscriptions',mode:'partial',compare:'previous',market:'',stream:'',source:'',device:'',page:''};
 const connections=['kind-triple-whale','kind-recharge-cancellations'].map(provider=>({provider,enabled:true,coverageThrough:batch.coverageThrough})) as any;
 const storedRows=batch.rows.map(row=>({...row,sourceId:'recharge',coverageThrough:batch.coverageThrough,retrievedAt:now.toISOString()}));
 const query=queryClient(client,storedRows,connections,filters,{preparedDatasets:['subscriptions','subscriptionEvents']}),context=buildAIContext([{...query,note:{body:''},findings:[],reviews:[]}],filters),shown=context.clients[0].selectedView as any;
 expect((context.clients[0] as any).visualBreakdowns.subscriptions.current.metrics.subscription_cancellation_events).toBe(3);
 expect(shown.dailyChart.calendarCancellations.current.find((day:any)=>day.date==='2026-10-12').metrics.subscription_cancellation_events).toBe(1);
 expect(shown.dailyChart.instruction).toContain('same completed store hour');
});

it('counts the same subscription once on each cancellation store day at its earliest event hour',async()=>{
 const events=[event(1,99,'2026-10-12T10:00:00Z'),event(2,99,'2026-10-12T08:00:00Z'),event(3,99,'2026-10-13T09:00:00Z'),event(4,99,'2026-10-13T10:00:00Z')];
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,fetcher([],events),Date.now()+10000,now);
 expect(sum(batch,'2026-10-12','subscription_cancellation_events')).toBe(1);expect(sum(batch,'2026-10-13','subscription_cancellation_events')).toBe(1);
 expect(batch.rows.find(row=>row.date==='2026-10-12'&&row.metric==='subscription_cancellation_events'&&row.value===1)).toMatchObject({start:'2026-10-12T08:00:00Z',end:'2026-10-12T09:00:00Z'});
 expect(sum(batch,'2026-10-13','same_day_subscription_cancellation_events')).toBe(0);
});

it('completes cancellation-event pagination with the documented filters and cursor-only subsequent pages',async()=>{
 const requests:URL[]=[];
 const read:typeof fetch=async url=>{const u=new URL(String(url));if(u.pathname!=='/events')return Response.json({subscriptions:[subscription(1,'2026-10-13T08:00:00Z')],next_cursor:null});requests.push(u);return u.searchParams.has('cursor')?Response.json({events:[event(1,1,'2026-10-13T09:00:00Z'),event(2,1,'2026-10-13T10:00:00Z')],next_cursor:null}):Response.json({events:[event(1,1,'2026-10-13T09:00:00Z')],next_cursor:'page2'});};
 const batch=await fetchRechargeSubscriptionCohort(client,config,window,read,Date.now()+10000,now);
 expect(requests).toHaveLength(2);expect(requests[0].searchParams.get('object_type')).toBe('subscription');expect(requests[0].searchParams.get('verbs')).toBe('cancelled');expect(requests[0].searchParams.get('created_at_min')).toBe('2026-10-11T21:59:58');expect(requests[0].searchParams.get('created_at_max')).toBe('2026-10-13T12:00:02');expect([...requests[1].searchParams.keys()].sort()).toEqual(['cursor','limit']);expect(sum(batch,window.to,'same_day_subscription_cancellation_events')).toBe(1);
});

it.each([
 ['missing event identity',{...event(1,1,'2026-10-13T10:00:00Z'),id:undefined},'identity'],
 ['missing subscription identity',{...event(1,1,'2026-10-13T10:00:00Z'),object_id:undefined},'identity'],
 ['invalid timestamp',event(1,1,'invalid'),'timestamp'],
 ['wrong object',{...event(1,1,'2026-10-13T10:00:00Z'),object_type:'charge'},'filter'],
 ['wrong verb',{...event(1,1,'2026-10-13T10:00:00Z'),verb:'activated'},'filter'],
 ['before subscription creation',event(1,1,'2026-10-13T07:59:59Z'),'creation'],
 ['ignored time filter',event(1,1,'2026-10-13T12:05:00Z'),'filter'],
] as const)('rejects %s rather than publishing exact zero buckets',async(_label,invalid,reason)=>{
 await expect(fetchRechargeSubscriptionCohort(client,config,window,fetcher([subscription(1,'2026-10-13T08:00:00Z')],[invalid]),Date.now()+10000,now)).rejects.toThrow(reason);
});

it('rejects changed duplicate events and incomplete event cursors',async()=>{
 const subscriptions=[subscription(1,'2026-10-13T08:00:00Z')];
 await expect(fetchRechargeSubscriptionCohort(client,config,window,fetcher(subscriptions,[event(1,1,'2026-10-13T09:00:00Z'),event(1,1,'2026-10-13T10:00:00Z')]),Date.now()+10000,now)).rejects.toThrow('changed');
 for(const response of [{events:[]},{events:[],next_cursor:'repeat'},{events:Array.from({length:251},(_,index)=>event(index+1,1,'2026-10-13T09:00:00Z')),next_cursor:null}]){
  const read:typeof fetch=async url=>new URL(String(url)).pathname==='/events'?Response.json(response):Response.json({subscriptions,next_cursor:null});
  await expect(fetchRechargeSubscriptionCohort(client,config,window,read,Date.now()+10000,now)).rejects.toThrow(/pagination|limit/);
 }
});

it('withholds exact event facts for a partially retained store day and never queries wholly expired event history',async()=>{
 const requests:string[]=[];
 const read:typeof fetch=async url=>{requests.push(new URL(String(url)).pathname);return fetcher([],[])(url);};
 const batch=await fetchRechargeSubscriptionCohort(client,config,{from:'2026-10-04',to:'2026-10-06'},read,Date.now()+10000,now);
 expect(requests).toEqual(['/subscriptions']);expect(batch.rows.some(row=>row.metric==='same_day_subscription_cancellation_events')).toBe(false);expect(batch.rows).toHaveLength(3*24*2);
 const mixed=await fetchRechargeSubscriptionCohort(client,config,{from:'2026-10-06',to:'2026-10-08'},fetcher([],[]),Date.now()+10000,now);
 expect(mixed.rows.some(row=>row.date==='2026-10-06'&&row.metric==='same_day_subscription_cancellation_events')).toBe(false);
 expect(mixed.rows.filter(row=>row.date==='2026-10-07'&&row.metric==='same_day_subscription_cancellation_events')).toHaveLength(24);
 expect(mixed.rows.filter(row=>row.date==='2026-10-08'&&row.metric==='same_day_subscription_cancellation_events')).toHaveLength(24);
 const expiredContract=requireQualifiedSource(kindQualification(batch,'kind-recharge-cancellations'),client);expect(()=>validateRegisteredBatch(batch,expiredContract)).not.toThrow();
});

it('keeps first cancellation events in their actual Stockholm creation day across DST and local midnight',async()=>{
 const fall=await fetchRechargeSubscriptionCohort(client,config,{from:'2026-10-25',to:'2026-10-25'},fetcher([subscription(1,'2026-10-25T00:20:00Z')],[event(1,1,'2026-10-25T01:20:00Z')]),Date.now()+10000,new Date('2026-10-26T12:00:00Z'));
 expect(fall.rows.find(row=>row.metric==='same_day_subscription_cancellation_events'&&row.value===1)).toMatchObject({start:'2026-10-25T00:00:00Z',end:'2026-10-25T02:00:00Z'});
 const spring=await fetchRechargeSubscriptionCohort(client,config,{from:'2026-03-29',to:'2026-03-29'},fetcher([subscription(1,'2026-03-29T00:20:00Z')],[event(1,1,'2026-03-29T01:20:00Z')]),Date.now()+10000,new Date('2026-03-30T12:00:00Z'));
 expect(spring.rows.filter(row=>row.metric==='same_day_subscription_cancellation_events')).toHaveLength(23);expect(sum(spring,'2026-03-29','same_day_subscription_cancellation_events')).toBe(1);
 const midnight=await fetchRechargeSubscriptionCohort(client,config,window,fetcher([subscription(1,'2026-10-12T21:59:00Z'),subscription(2,'2026-10-12T22:01:00Z')],[event(1,1,'2026-10-12T22:00:00Z'),event(2,2,'2026-10-13T00:00:00Z')]),Date.now()+10000,now);
 expect(sum(midnight,'2026-10-12','same_day_subscription_cancellation_events')).toBe(0);expect(sum(midnight,'2026-10-13','same_day_subscription_cancellation_events')).toBe(1);
});
