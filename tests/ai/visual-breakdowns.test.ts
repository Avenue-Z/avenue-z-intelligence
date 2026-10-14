import {expect,it} from 'vitest';
import {buildAIContext} from '../../lib/ai/context';
import {buildChatModelContext} from '../../lib/ai/chat-input';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
const client=clients[0] as Client,filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:'/pages/glp'};
function fixture(){const rows:Observation[]=Array.from({length:234},(_,index)=>{const meta=index<200,i=meta?index:index-200;return ['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts'].map(metric=>({date:filters.to,dataset:'traffic',metric,value:metric==='sessions'?meta?(i===0?4964:50):(i===0?150:30):metric==='converting_sessions'?meta?(i===0?154:2):(i===0?3:0):metric==='atc_sessions'?10:metric==='checkouts'?5:1,population:'human_public_landing_page_sessions',definition:'shopify_human_public_landing_page_traffic',currency:null,dimensions:{page:filters.page,source:'social',utm_source:meta?'facebook':'snapchat',utm_campaign:`campaign-${index}`,market:'US',device:'mobile'},sourceId:'shopify-traffic',retrievedAt:'2026-10-12T10:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'} as Observation));}).flat();
 const record=queryClient(client,rows,[],filters);return {rows,context:buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],filters)};}
it('supplies exact rendered channel totals from all 234 segments before either evidence cap',()=>{
 const {context}=fixture(),visual=(context.clients[0] as any).visualBreakdowns.traffic.current;
 expect(context.clients[0].datasetDetails.traffic.rows).toHaveLength(80);expect(visual.scope.filters).toEqual(filters);expect(visual.scope.timezone).toBe(client.timezone);expect(visual.cuts.traffic_channel.groupCount).toBe(2);
 const meta=visual.cuts.traffic_channel.rows.find((row:any)=>row.dimensions.traffic_channel==='Meta · UTM'),snap=visual.cuts.traffic_channel.rows.find((row:any)=>row.dimensions.traffic_channel==='snapchat · UTM');
 expect(meta.metrics).toMatchObject({sessions:14914,converting_sessions:552});expect(meta.summary.cvr).toBe(552/14914);expect(snap.metrics).toMatchObject({sessions:1140,converting_sessions:3});expect(snap.summary.cvr).toBe(3/1140);
 const projection=buildChatModelContext(context,'Compare Meta and Snapchat for this landing page'),cut=(projection.context.clients[0] as any).visualBreakdowns.traffic.current.cuts.traffic_channel;
 const groups=cut.rows.map((reference:any)=>(projection.evidenceRows as any)[reference.evidenceRowId]);expect(groups.some((row:any)=>row.metrics.sessions===14914&&row.metrics.converting_sessions===552)).toBe(true);expect(groups.some((row:any)=>row.metrics.sessions===1140&&row.metrics.converting_sessions===3)).toBe(true);expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(80000);
});
it('bounds named aggregate groups independently while preserving the complete group count',()=>{
 const {context}=fixture(),before=JSON.stringify(context),projection=buildChatModelContext(context,'What happened in campaign-233?'),cut=(projection.context.clients[0] as any).visualBreakdowns.traffic.current.cuts.utm_campaign;
 expect(cut.groupCount).toBe(234);expect(cut.omitted).toBe(234-cut.returnedSegmentCount);expect(cut.rows.length).toBeLessThanOrEqual(6);expect(cut.rows.map((reference:any)=>(projection.evidenceRows as any)[reference.evidenceRowId]).some((row:any)=>row.dimensions.utm_campaign==='campaign-233')).toBe(true);expect(JSON.stringify(context)).toBe(before);
});
it('keeps an unavailable qualified rate unavailable in exact aggregate evidence',()=>{
 const {rows}=fixture();const mismatched=rows.map(row=>row.metric==='converting_sessions'?{...row,population:'different_population'}:row),record=queryClient(client,mismatched,[],filters),context=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],filters),visual=(context.clients[0] as any).visualBreakdowns.traffic.current;
 expect(visual.cuts.traffic_channel.rows.every((row:any)=>row.summary.cvr===null)).toBe(true);
});
it('never invents rendered aggregates for an older frozen snapshot that lacks them',()=>{
 const {context}=fixture();delete (context.clients[0] as any).visualBreakdowns;context.clients[0].selectedReview={storeDate:filters.to,revision:1};const projection=buildChatModelContext(context,'Compare Meta and Snapchat');expect((projection.context.clients[0] as any).visualBreakdowns).toBeUndefined();
});

it('uses the displayed subscription comparison rather than relabelling the four-week renewal benchmark as the previous day',()=>{
 const scope={...filters,from:'2026-10-12',to:'2026-10-12',view:'subscriptions',page:''};
 const rows:Observation[]=[['2026-10-12',1854,109,3426],['2026-10-11',2803,180,2985],['2026-09-14',10000,613,1]].flatMap(([date,orders,cancelled,calendar])=>[{date,dataset:'subscriptions',metric:'recurring_orders',value:orders},{date,dataset:'subscriptions',metric:'recurring_cancelled_orders',value:cancelled},{date,dataset:'subscriptionEvents',metric:'subscription_cancellation_events',value:calendar}].map(r=>({...r,date:String(date),value:Number(r.value),dimensions:{},population:r.dataset,definition:r.dataset,currency:null,sourceId:'subscriptions',retrievedAt:'2026-10-13T12:00:00Z',coverageThrough:'2026-10-13T22:00:00Z',quality:'complete'} as Observation)));
 const record=queryClient(client,rows,[],scope),context=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],scope),projection=buildChatModelContext(context,'What are the displayed cancellation counts and rates versus the previous day?'),visual=(projection.context.clients[0] as any).visualBreakdowns?.subscriptions;
 expect(visual.range).toEqual({from:'2026-10-12',to:'2026-10-12'});expect(visual.comparisonRange).toEqual({from:'2026-10-11',to:'2026-10-11'});
 expect(visual.current.metrics).toMatchObject({subscription_cancellation_events:3426,recurring_cancelled_orders:109,recurring_orders:1854,cancellation_rate:109/1854});
 expect(visual.previous.metrics).toMatchObject({subscription_cancellation_events:2985,recurring_cancelled_orders:180,recurring_orders:2803,cancellation_rate:180/2803});
 expect(context.clients[0].subscriptions.comparison.cancellationRate).toBe(.0613);expect(visual.previous.metrics.cancellation_rate).not.toBe(.0613);
});
it('binds displayed Shopify revenue to its own selected-view totals instead of the commerce efficiency headline',()=>{
 const scope={...filters,view:'revenue',page:''};const rows=[{date:scope.to,dataset:'overview',metric:'revenue',value:98000,definition:'web_nonrecurring_excl_tax_shipping'},{date:scope.to,dataset:'revenue',metric:'revenue',value:148000,definition:'shopify_net_sales'},{date:scope.to,dataset:'revenue',metric:'orders',value:5000,definition:'shopify_net_sales'},{date:'2026-10-10',dataset:'revenue',metric:'revenue',value:150000,definition:'shopify_net_sales'},{date:'2026-10-10',dataset:'revenue',metric:'orders',value:6000,definition:'shopify_net_sales'}].map(r=>({...r,dimensions:{},population:r.dataset,currency:r.metric==='revenue'?'USD':null,sourceId:r.dataset,retrievedAt:'2026-10-12T10:00:00Z',coverageThrough:'2026-10-12T22:00:00Z',quality:'complete'} as Observation));
 const record=queryClient(client,rows,[],scope),context=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],scope),projection=buildChatModelContext(context,'What net sales and AOV are displayed in this view?'),selected=(projection.context.clients[0] as any).selectedView;
 expect(context.clients[0].metrics.revenue).toBe(98000);expect(selected.dataset).toBe('revenue');expect(selected.current.metrics).toMatchObject({revenue:148000,orders:5000});expect(selected.current.summary.aov).toBe(29.6);expect(selected.comparison.metrics.revenue).toBe(150000);
});
