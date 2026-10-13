import {expect,it} from 'vitest';
import {buildAIContext} from '../../lib/ai/context';
import {buildChatModelContext} from '../../lib/ai/chat-input';
import {queryClient} from '../../lib/analytics/query';
import clients from '../../data/initial-clients.json';
import type {Client,Observation} from '../../lib/analytics/contracts';
const filters={from:'2026-10-13',to:'2026-10-13',view:'revenue',mode:'partial',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
function context(){
 const record=queryClient(clients[0] as any,[],[],filters),input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}] as any,filters),client=input.clients[0];client.selectedObservationCount=42;client.sourceQuality=['complete'];
 const review={sourceId:'review:previous',storeDate:'2026-10-12',revision:1,scopeLabel:'Dated report, separate from live dashboard',payload:{type:'ai',text:'Earlier report narrative '.repeat(500),kpis:[],sections:[]}};
 client.sourceReviews=[review] as any;client.priorSourceReviews=[review] as any;input.sources.push({id:'review:previous',label:'Earlier report',url:'/clients/kind-patches/reviews/previous'});
 const summary={revenue:0,orders:0,aov:null,spend:null,sessions:null,cvr:null,mer:null,newOrders:null,recurringRevenue:null,atc:null,checkoutCompletion:null};
 const series=(date:string,count:number)=>Array.from({length:count},(_,hour)=>({date,start:new Date(`${date}T00:00:00Z`).getTime()+hour*3600000,end:new Date(`${date}T00:00:00Z`).getTime()+(hour+1)*3600000,metrics:{revenue:hour===0?0:hour,orders:hour,refunds:0,missing:null},summary:{...summary,revenue:hour===0?0:hour,orders:hour,aov:hour?1:null}}));
 client.selectedView={...client.selectedView,dataset:'revenue',history:series('2026-10-01',30),hourlyChart:{current:series(filters.to,18),comparison:series('2026-10-12',18)}} as any;
 return input;
}
it('keeps all displayed chart points, zero values, dates and qualification while removing only unavailable series cells',()=>{
 const input=context(),before=JSON.stringify(input),projection=buildChatModelContext(input,'Which hour in this current Revenue chart has the most sales compared with yesterday?'),selected=projection.context.clients[0].selectedView as any;
 expect(selected.history).toHaveLength(30);expect(selected.hourlyChart.current).toHaveLength(18);expect(selected.hourlyChart.comparison).toHaveLength(18);
 expect(selected.hourlyChart.current[0]).toMatchObject({date:filters.to,metrics:{revenue:0,orders:0,refunds:0},summary:{revenue:0,orders:0}});expect(selected.hourlyChart.current[0].metrics).not.toHaveProperty('missing');expect(selected.hourlyChart.current[0].summary).not.toHaveProperty('aov');
 expect(selected.scope).toEqual(input.clients[0].selectedView.scope);expect(projection.context.clients[0].reportTiming).toEqual(input.clients[0].reportTiming);expect(projection.context.clients[0].warnings).toEqual(input.clients[0].warnings);
 expect(JSON.stringify(input)).toBe(before);expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);
});
it('explicitly excludes dated report prose from a live chart question while retaining source identities',()=>{
 const input=context(),projection=buildChatModelContext(input,'Compare the figures shown today with yesterday');
 expect(projection.context.clients[0].sourceReviews).toEqual([]);expect(projection.context.clients[0].priorSourceReviews).toEqual([]);expect(projection.context.sources).toEqual(input.sources);
 expect(projection.chatPreview.omittedFields.some(field=>field.path==='clients[0].sourceReviews')).toBe(true);expect(projection.chatPreview.omittedFields.some(field=>field.path==='clients[0].priorSourceReviews')).toBe(true);
});
it('preserves reports when explicitly requested or when the selected scope is a fixed saved report',()=>{
 const input=context();expect(buildChatModelContext(input,'Explain the previous daily review').context.clients[0].priorSourceReviews).toHaveLength(1);
 input.clients[0].selectedReview={storeDate:'2026-10-12',revision:1};const fixed=buildChatModelContext(input,'Explain these figures').context.clients[0];expect(fixed.sourceReviews).toHaveLength(1);expect(fixed.selectedReview).toEqual({storeDate:'2026-10-12',revision:1});
});
it('keeps subscription chart events separate and supplies daily cohort rates from matching counts',()=>{
 const f={...filters,from:'2026-10-07',to:'2026-10-07',view:'subscriptions',mode:'closed'} as const;
 const rows=['2026-10-05','2026-10-06','2026-10-07'].flatMap(date=>[{date,dataset:'subscriptions',metric:'recurring_orders',value:10,population:'renewal_orders',definition:'renewal_orders',dimensions:{}},{date,dataset:'subscriptions',metric:'recurring_refund_orders',value:2,population:'renewal_orders',definition:'renewal_orders',dimensions:{}},{date,dataset:'subscriptions',metric:'recurring_cancelled_orders',value:1,population:'renewal_orders',definition:'renewal_orders',dimensions:{}},{date,dataset:'subscriptionEvents',metric:'subscription_cancellations',value:8,population:'cancelled_subscriptions',definition:'calendar_cancellations',dimensions:{}}].map(row=>({...row,currency:null,quality:'complete',sourceId:'renewal-source',retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:'2026-10-08T04:00:00Z'})));
 const record=queryClient(clients[0] as Client,rows as Observation[],[],f,{preparedDatasets:['subscriptions','subscriptionEvents']});
 const input=buildAIContext([{...record,note:{body:'',version:0},findings:[],reviews:[]}],f),projection=buildChatModelContext(input,'How did the seven-day cancellation and refund trend change?'),chart=projection.context.clients[0].selectedView.dailyChart;
 expect(chart?.current.filter(day=>day.date>='2026-10-05').map(day=>day.metrics.refund_rate)).toEqual([.2,.2,.2]);
 expect(chart?.current.at(-1)?.metrics.cancellation_rate).toBe(.1);
 expect(chart?.calendarCancellations?.current.at(-1)?.metrics.subscription_cancellations).toBe(8);
 expect(chart?.current.at(-1)?.metrics.recurring_cancelled_orders).toBe(1);
 expect(chart?.current[0].metrics).not.toHaveProperty('recurring_orders');
 expect(chart?.scope.sourceId).toBe('selection:kind-patches');
 expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);
});
