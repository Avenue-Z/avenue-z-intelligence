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
