import {describe,expect,it} from 'vitest';
import {buildAIContext} from '../../lib/ai/context';
import {buildChatModelContext} from '../../lib/ai/chat-input';
import {queryClient} from '../../lib/analytics/query';
import {evidenceDetailRows} from '../../lib/ai/evidence';
import clients from '../../data/initial-clients.json';
const client=clients[1] as any;
const filters={from:'2026-10-07',to:'2026-10-07',view:'traffic',mode:'closed',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
function fixture(large=false){
 const base=queryClient(client,[],[],filters),context=buildAIContext([{...base,note:{body:'Brand notes'},findings:[],reviews:[]}] as any,filters),c=context.clients[0];
 c.metrics={...c.metrics,revenue:0,spend:null};c.warnings=['Matched coverage is unknown; never infer efficiency'];
 for(const dataset of ['traffic','products','subscriptions','subscriptionEvents','media']){
  const rows=Array.from({length:large?150:12},(_,i)=>({date:filters.to,dataset,metric:dataset==='subscriptionEvents'?'subscription_cancellations':'sessions',value:i===149?0:1000-i,dimensions:{page:i===149?'/pages/dream-mag-v5':`/pages/${dataset}-${i}`,market:'US',device:'mobile'},definition:'human_landing_sessions',population:'human_sessions',currency:null,sourceId:`source-${dataset}`,retrievedAt:'2026-10-08T10:00:00Z',coverageThrough:null,quality:'partial'}));
  c.datasetDetails[dataset]=evidenceDetailRows(rows as any,150);c.comparisonDatasetDetails[dataset]=evidenceDetailRows(rows.map(row=>({...row,date:'2026-10-06',value:row.value===0?null:row.value+1})) as any,150);
 }
 c.subscriptions={current:{from:filters.from,to:filters.to,revenue:0,orders:0},comparison:{from:'2026-09-09',to:'2026-09-09',revenue:null,orders:null},contamination:{title:'Renewal pricing incident',note:'Use the clean alternate'},elapsedDays:1} as any;
 if(large){c.notes='Very large source notes '.repeat(9000);c.sourceReviews=[{sourceId:'review:fixed',storeDate:filters.to,revision:2,scopeLabel:'Fixed saved report, authoritative for this selected report',payload:{type:'ai',filters,text:'Saved authoritative report prose '.repeat(10000),summary:['Important dated summary'],kpis:[{label:'Revenue',value:'$0',note:'Fixed report'}],sections:[{title:'Detail tables',paragraphs:['The reporting dates are fixed'],bullets:[],tables:[{title:'Huge table',scope:'Fixed period',columns:['Page','Sessions'],rows:Array.from({length:200},(_,i)=>[`/pages/traffic-${i}`,'100']),sourceIds:['selection:beam']}]}]}}] as any;c.selectedReview={storeDate:filters.to,revision:2};context.sources.push({id:'review:fixed',label:'Fixed report',url:'/clients/beam/reviews/fixed'});}
 return context;
}
function resolvedRows(projection:any){return Object.values(projection.evidenceRows) as any[];}

describe('fast scoped chat model input',()=>{
 it('bounds page-family diagnostics with explicit market and family omission counts',()=>{
  const context=fixture(),mix=context.clients[0].strategyDiagnoses.pageFamilyMix,counts={sessions:100,convertingSessions:5,cvr:.05,sessionShare:.1};
  mix.marketCount=40;mix.markets=Array.from({length:40},(_,index)=>({market:index===39?'FR':`Market ${index}`,currentSessions:100,comparisonSessions:110,decomposition:null,families:Array.from({length:12},(_,i)=>({family:`Observed family ${i}`,current:{...counts},comparison:{...counts}}))}));
  const before=JSON.stringify(context),projection=buildChatModelContext(context,'Which page or offer should we investigate first?'),projected=projection.context.clients[0].strategyDiagnoses.pageFamilyMix as unknown as {marketCount:number;returnedMarketCount:number;omittedMarkets:number;markets:{market:string;familyCount:number;returnedFamilyCount:number;omittedFamilies:number;families:unknown[]}[]};
  expect(projected.marketCount).toBe(40);expect(projected.returnedMarketCount).toBe(projected.markets.length);expect(projected.omittedMarkets).toBe(40-projected.markets.length);expect(projected.markets.length).toBeLessThan(40);
  expect(projected.markets[0].familyCount).toBe(12);expect(projected.markets[0].returnedFamilyCount).toBe(projected.markets[0].families.length);expect(projected.markets[0].omittedFamilies).toBe(12-projected.markets[0].families.length);
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);expect(JSON.stringify(context)).toBe(before);
  const named=buildChatModelContext(context,'Explain the France page-family mix').context.clients[0].strategyDiagnoses.pageFamilyMix;
  expect(named.markets[0].market).toBe('FR');
 });
 it('prioritizes a named campaign and reports bounded diagnostic rows without changing coverage or totals',()=>{
  const context=fixture(),client=context.clients[0],costs=client.strategyDiagnoses.campaignCosts;context.filters={...filters,view:'media'};
  costs.campaignCount=40;costs.rows=Array.from({length:40},(_,index)=>({campaignId:String(index),campaign:index===39?'Dawn special':`Campaign ${index}`,current:{...costs.total.current},comparison:{...costs.total.comparison},changes:{spend:null,clicks:null,impressions:null,cpc:null,cpm:null,ctr:null},explanation:'A matching qualified comparison is unavailable. '.repeat(120)}));
  const projection=buildChatModelContext(context,'Explain the Dawn special campaign CPC chart'),projected=projection.context.clients[0].strategyDiagnoses.campaignCosts;
  expect(projected.rows[0].campaign).toBe('Dawn special');expect(projected.rows.length).toBeLessThan(40);expect(projected.omitted).toBe(40-projected.rows.length);
  expect(projected.total).toEqual(costs.total);expect(projected.currentCoverage).toEqual(costs.currentCoverage);expect(projection.context.clients[0].warnings).toEqual(client.warnings);
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);
  expect(costs.rows).toHaveLength(40);
 });
 it('keeps request-specific chat evidence within 80KB without changing the full evidence snapshot',()=>{
  const context=fixture(true),before=JSON.stringify(context),projection=buildChatModelContext(context,'Why did traffic change?');
  expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(80000);
  expect(JSON.stringify(context)).toBe(before);
  expect(projection.context.filters).toEqual(filters);expect(projection.context.sources).toEqual(context.sources);
  const projected=projection.context.clients[0];expect(projected.metrics.revenue).toBe(0);expect(projected.metrics.spend).toBeNull();expect(projected.warnings).toEqual(context.clients[0].warnings);expect(projected.spendVerdict).toEqual(context.clients[0].spendVerdict);expect(projected.reportTiming).toEqual(context.clients[0].reportTiming);
  expect(projected.selectedReview).toEqual({storeDate:filters.to,revision:2});expect(projected.sourceReviews[0].payload.filters).toEqual(filters);expect(projected.sourceReviews[0].payload.kpis).toEqual(context.clients[0].sourceReviews[0].payload.kpis);
  expect(projection.chatPreview.collections.some(value=>value.omittedRows>0)).toBe(true);expect(projection.chatPreview.text.some(value=>value.omittedCharacters>0)).toBe(true);
 });
 it('prioritizes a specifically requested long-tail page before limiting rows',()=>{
  const projection=buildChatModelContext(fixture(true),'What is happening on Dream Mag v5?');
  const rows=resolvedRows(projection);expect(rows.some(row=>row.dimensions.page==='/pages/dream-mag-v5'&&row.metrics.sessions===0)).toBe(true);
  const cut=projection.context.clients[0].datasetDetails.traffic;expect(cut.segmentCount).toBe(150);expect(cut.omitted).toBe(150-cut.returnedSegmentCount);expect(cut.omittedObservationCount).toBe(150-cut.returnedObservationCount);
 });
 it('adds subscriptions evidence for cancellation questions even when another tab is selected',()=>{
  const projection=buildChatModelContext(fixture(),'How are same-day cancellations doing?'),c=projection.context.clients[0];
  expect(c.subscriptions.current.revenue).toBe(0);expect(c.subscriptions.comparison.revenue).toBeNull();expect(c.subscriptions.contamination?.title).toBe('Renewal pricing incident');expect(c.datasetDetails.subscriptions).toBeDefined();expect(c.datasetDetails.subscriptionEvents).toBeDefined();expect(resolvedRows(projection).some(row=>typeof row.metrics.subscription_cancellations==='number')).toBe(true);
 });
 it('recognizes a named country and a single-word page in an unselected dataset',()=>{
  const context=fixture(true);context.filters={...filters,view:'media'};
  const cut=context.clients[0].datasetDetails.traffic;cut.rows[149]={...cut.rows[149],dimensions:{market:'FR',page:'/pages/DreamMag'}};
  const projection=buildChatModelContext(context,'Show France and DreamMag performance');
  expect(resolvedRows(projection).some(row=>row.dimensions.market==='FR'&&row.dimensions.page==='/pages/DreamMag')).toBe(true);
 });
 it('includes the named page from a closed reference when the current partial day has no page rows',()=>{
  const context=fixture(true);context.filters={...filters,view:'media'};const c=context.clients[0],cut=c.datasetDetails.traffic;
  c.datasetDetails={media:c.datasetDetails.media};c.comparisonDatasetDetails={media:c.comparisonDatasetDetails.media};
  c.priorClosedDetail={instruction:'Closed reference only; not current partial day',datasets:{traffic:{...cut,storeDate:'2026-10-06',comparisonDate:'2026-10-05',sourceId:'closed-reference',scopeLabel:'Closed reference only',window:{start:'2026-10-06T00:00:00Z',end:'2026-10-07T00:00:00Z',timezone:'UTC',durationHours:24},warnings:['Closed reference; not current'],comparison:cut}}} as any;
  const live=queryClient(client,[],[],context.filters,{preparedDatasets:['media']});c.selectedView=buildAIContext([{...live,note:{body:'',version:0},findings:[],reviews:[]}],context.filters).clients[0].selectedView;c.selectedReview=null;
  const projection=buildChatModelContext(context,'What happened on Dream Mag v5?');
  expect(resolvedRows(projection).some(row=>row.dimensions.page==='/pages/dream-mag-v5')).toBe(true);
  expect(projection.context.clients[0].priorClosedDetail?.datasets.traffic?.storeDate).toBe('2026-10-06');
 });
 it('records omitted datasets and refuses to describe a numeric preview as a complete population',()=>{
  const projection=buildChatModelContext(fixture(),'What happened to traffic?');
  expect(projection.chatPreview.omittedFields.some(value=>value.path.endsWith('.datasetDetails.products'))).toBe(true);
  expect(projection.instruction).toMatch(/never.*sum.*preview/i);expect(projection.instruction).toMatch(/absent.*unavailable/i);
  expect(projection.context.clients[0].datasetDetails.products).toBeUndefined();
 });
 it('fails closed when preserved authorization and warning scope alone cannot fit',()=>{
  const context=fixture();context.clients[0].warnings=['Mandatory qualification '.repeat(10000)];
  expect(()=>buildChatModelContext(context,'What happened?')).toThrow(/narrower/i);
 });
});
