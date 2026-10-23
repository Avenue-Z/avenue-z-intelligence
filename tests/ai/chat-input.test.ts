import {describe,expect,it} from 'vitest';
import {buildAIContext} from '../../lib/ai/context';
import {buildChatModelContext} from '../../lib/ai/chat-input';
import {queryClient} from '../../lib/analytics/query';
import {evidenceDetailRows} from '../../lib/ai/evidence';
import {shiftDate} from '../../lib/analytics/windows';
import {chatObservationSelection} from '../../lib/ai/chat-scope';
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
function overviewTrafficFixture(){
 const context=fixture(),c=context.clients[0];context.filters={...filters,view:'overview',mode:'partial'};
 c.selectedView={...c.selectedView,dataset:'overview',scope:{...c.selectedView.scope,cutoff:'2026-10-07T19:00:00Z',definitions:['beam_shopify_online_store_net_sales','shopify_human_us_sessions'],populations:['beam_shopify_online_store_sales','human_us_online_store_sessions']},current:{metrics:{online_store_revenue:9413.37,sessions:9125,converting_sessions:193},summary:{cvr:193/9125}},comparison:{metrics:{online_store_revenue:12058.41,sessions:10380,converting_sessions:247},summary:{cvr:247/10380}}} as any;
 const period=(previous:boolean)=>({scope:{filters:{...context.filters,from:previous?'2026-10-06':'2026-10-07',to:previous?'2026-10-06':'2026-10-07'},timezone:'America/New_York',cutoff:previous?'2026-10-06T19:00:00Z':'2026-10-07T19:00:00Z',sourceId:'selection:beam'},cuts:Object.fromEntries(['all','page','source','device','market','utm_source','utm_medium','utm_campaign','traffic_channel'].map(dimension=>{const length=dimension==='all'?1:20;return [dimension,{groupCount:length,segmentCount:length,returnedSegmentCount:length,omitted:0,sourceId:'selection:beam',rows:Array.from({length},(_,index)=>({key:`${previous}:${dimension}:${index}`,dimensions:{[dimension]:dimension==='all'?'All':`${dimension}-${index}`},metrics:{sessions:previous?10380:9125,converting_sessions:previous?247:193},summary:{cvr:previous?247/10380:193/9125},provenance:[],aggregateSourceId:'selection:beam',contributingSegmentCount:350}))}];})),instruction:'Exact full-population rendered aggregates; never reconstruct totals from preview rows.'});
 c.visualBreakdowns.traffic={current:period(false),comparison:period(true)} as any;return context;
}
function populatedOverviewHistory(){
 const context=overviewTrafficFixture(),selected=context.clients[0].selectedView,range={from:shiftDate(filters.to,-29),to:filters.to,comparisonFrom:shiftDate(filters.to,-30),comparisonTo:shiftDate(filters.to,-1)},chart:NonNullable<typeof selected.dailyChart>={dataset:'overview',defaultRange:{from:shiftDate(filters.to,-6),to:filters.to,comparisonFrom:shiftDate(filters.to,-7),comparisonTo:shiftDate(filters.to,-1)},range,scope:{sourceId:selected.scope.sourceId,timezone:selected.scope.timezone,currency:selected.scope.currency,filters:context.filters,cutoff:selected.scope.cutoff},current:[],comparison:[],instruction:'Exact historical daily chart points, with matched comparison dates and zeros retained.'};selected.dailyChart=chart;
 const metrics={online_store_orders:248,online_store_revenue:12552.789999999999,orders:2186,revenue:104228.88000000002,atc_sessions:641,checkouts:484,completed_checkouts:252,converting_sessions:252,sessions:9569},summary={revenue:104228.88000000002,orders:2186,spend:null,sessions:9569,cvr:252/9569,aov:104228.88000000002/2186,mer:null,newOrders:null,recurringRevenue:null,atc:641/9569,checkoutCompletion:252/484};
 chart.current=Array.from({length:30},(_,index)=>({date:shiftDate(filters.to,index-29),metrics:{...metrics,online_store_orders:index===0?0:248},summary:{...summary}}));chart.comparison=Array.from({length:30},(_,index)=>({date:shiftDate(filters.to,index-30),metrics:{...metrics},summary:{...summary}}));return context;
}

describe('fast scoped chat model input',()=>{
 it.each([
  ['Show the report today.',true],
  ['Summarize the report the team saved yesterday.',true],
 ['Report for yesterday.',true],
 ['Report from yesterday.',true],
  ['Please report revenue and orders for today.',false]
 ])('retains live saved-report prose only for a report reference: %s',(question,reportRequested)=>{
  const context=fixture(true),c=context.clients[0];c.selectedReview=null;c.selectedObservationCount=1;
  const projection=buildChatModelContext(context,question),shown=projection.context.clients[0];
  expect(shown.sourceReviews.length>0).toBe(reportRequested);if(reportRequested)expect(shown.sourceReviews[0].sourceId).toBe('review:fixed');expect(projection.context.sources).toEqual(context.sources);
 });

 it('fits a KP selected-day cancellation answer without unrelated reports or historical chart dates',()=>{
  const context=populatedOverviewHistory(),c=context.clients[0];context.filters={...context.filters,view:'subscriptions'};
  c.client={...c.client,id:'kind-patches',name:'Kind Patches',timezone:'Europe/Stockholm'};c.selectedView.dataset='subscriptions';
  const chart=c.selectedView.dailyChart!;chart.dataset='subscriptions';chart.calendarCancellations={current:chart.current.map(point=>({...point,metrics:{subscription_cancellation_events:0}})),comparison:chart.comparison.map(point=>({...point,metrics:{subscription_cancellation_events:15}}))};
  const ledger={current:{metrics:{new_subscriptions:100,same_day_subscription_cancellation_events:0,same_day_cancellation_rate:0},coverage:{same_day_cancellation_rate:{reportedDays:1,totalDays:1}}},previous:{metrics:{new_subscriptions:200,same_day_subscription_cancellation_events:10,same_day_cancellation_rate:.05},coverage:{same_day_cancellation_rate:{reportedDays:1,totalDays:1}}},range:{from:filters.from,to:filters.to},comparisonRange:{from:'2026-10-06',to:'2026-10-06'},scope:{sourceId:'selection:kind-patches',timezone:'Europe/Stockholm',mode:'partial',cutoff:'2026-10-07T12:00:00Z'},instruction:'Exact selected creation-cohort cancellation events divided by new subscriptions; previous is yesterday at the same completed store hour.'};
  c.visualBreakdowns.subscriptions=ledger as unknown as typeof c.visualBreakdowns.subscriptions;c.sourceReviews=fixture(true).clients[0].sourceReviews;
  const report=c.sourceReviews[0].payload,table={title:'Dated table',scope:'Fixed historical reporting period',columns:['Page','Sessions'],rows:Array.from({length:200},(_,index)=>[`/pages/observed-${index}`,'100']),sourceIds:['review:fixed']};report.sections=Array.from({length:8},(_,index)=>({title:`Dated report section ${index}`,paragraphs:['Historical selected-period source evidence. '.repeat(30),'Separate prior reporting period and qualification. '.repeat(30)],bullets:[],tables:index===5?Array.from({length:30},()=>table):[]}));c.priorSourceReviews=Array.from({length:3},(_,index)=>({...c.sourceReviews[0],sourceId:`review:prior-${index}`}));
  const before=JSON.stringify(context),projection=buildChatModelContext(context,"Verification: state the selected brand, date and comparison cutoff, then report the same-day cancellation rate and yesterday's value shown in this view. Keep it brief and cite the saved evidence."),shown=projection.context.clients[0];
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);expect(shown.visualBreakdowns.subscriptions).toEqual(ledger);
  expect(shown.sourceReviews).toEqual([]);expect(shown.priorSourceReviews).toEqual([]);expect(shown.selectedView.dailyChart).toBeUndefined();
  for(const key of ['scope','current','comparison'] as const)expect(shown.selectedView[key]).toEqual(c.selectedView[key]);expect(shown.reportTiming).toEqual(c.reportTiming);expect(shown.warnings).toEqual(c.warnings);expect(projection.context.sources).toEqual(context.sources);
  for(const path of ['current','comparison','calendarCancellations.current','calendarCancellations.comparison'])expect(projection.chatPreview.collections.find(value=>value.path===`clients[0].selectedView.dailyChart.${path}`)).toMatchObject({availableRows:30,includedRows:0,omittedRows:30});
  expect(JSON.stringify(context)).toBe(before);
 });
 it('keeps every KP subscription and calendar chart point, comparison date and zero when history is requested',()=>{
  const context=populatedOverviewHistory(),c=context.clients[0];context.filters={...context.filters,view:'subscriptions'};c.client={...c.client,id:'kind-patches'};const chart=c.selectedView.dailyChart!;chart.calendarCancellations={current:chart.current.map(point=>({...point,metrics:{subscription_cancellation_events:0}})),comparison:chart.comparison.map(point=>({...point,metrics:{subscription_cancellation_events:15}}))};
  const sparse=(points:typeof chart.current)=>points.map(point=>({...point,summary:Object.fromEntries(Object.entries(point.summary).filter(([,value])=>value!==null&&value!==undefined))})),shown=buildChatModelContext(context,'Show the same-day cancellation trend over the last 14 days.').context.clients[0].selectedView.dailyChart!;
  for(const period of ['current','comparison'] as const){expect(shown[period]).toEqual(sparse(chart[period]));expect(shown.calendarCancellations![period]).toEqual(sparse(chart.calendarCancellations[period]));}expect(shown.calendarCancellations!.current[0].metrics.subscription_cancellation_events).toBe(0);
 });

 it('keeps exact overview sales and matched US conversion totals while explicitly omitting unrequested Traffic cuts',()=>{
  const context=overviewTrafficFixture();(context.clients[0].visualBreakdowns.traffic!.comparison!.cuts.page.rows[0].dimensions as Record<string,string>).page='/articles/who-made-this-and-are/product/store/7195374583863';
  const before=JSON.stringify(context),original=context.clients[0],projection=buildChatModelContext(context,'For this view, give Online Store net sales and US human-session conversion versus yesterday. Are those compared through the same store hour?'),shown=projection.context.clients[0],traffic=shown.visualBreakdowns.traffic as any;
  expect(Object.keys(traffic.current.cuts)).toEqual(['all']);expect(Object.keys(traffic.comparison.cuts)).toEqual(['all']);
  for(const key of ['scope','current','comparison'] as const)expect(shown.selectedView[key]).toEqual(original.selectedView[key]);expect(shown.reportTiming).toEqual(original.reportTiming);expect(shown.spendVerdict).toEqual(original.spendVerdict);expect(projection.context.sources).toEqual(context.sources);
  for(const period of ['current','comparison']){expect(traffic[period].scope).toEqual((original.visualBreakdowns.traffic as any)[period].scope);const row=projection.evidenceRows[traffic[period].cuts.all.rows[0].evidenceRowId];expect(row.metrics.sessions).toBe(period==='current'?9125:10380);expect(row.metrics.converting_sessions).toBe(period==='current'?193:247);}
  const omitted=projection.chatPreview.collections.filter(value=>/visualBreakdowns\.traffic\.(?:current|comparison)\.cuts\.(?!all\.)/.test(value.path));expect(omitted).toHaveLength(16);expect(omitted.every(value=>value.availableRows===20&&value.includedRows===0&&value.omittedRows===20)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);expect(JSON.stringify(context)).toBe(before);
 });
 it('retains requested overview landing-page and source breakdowns',()=>{
  const context=overviewTrafficFixture(),legacy={storeDate:'2026-10-06',sourceId:'closed-traffic:beam:2026-10-06',pages:context.clients[0].datasetDetails.traffic};context.clients[0].traffic=legacy as any;
  const projection=buildChatModelContext(context,'Which landing page or traffic source explains the conversion change?'),traffic=projection.context.clients[0].visualBreakdowns.traffic as any;
  expect(traffic.current.cuts.page.rows.length).toBeGreaterThan(0);expect(traffic.comparison.cuts.source.rows.length).toBeGreaterThan(0);
  expect(traffic.current.cuts.device).toBeUndefined();expect(projection.context.clients[0].traffic).toBeUndefined();expect(context.clients[0].traffic).toEqual(legacy);
  expect(projection.chatPreview.collections.find(value=>value.path==='clients[0].traffic.pages.rows')).toMatchObject({availableRows:12,includedRows:0,omittedRows:12});
  expect(projection.chatPreview.collections.some(value=>value.path.includes('.visualBreakdowns.traffic.current.cuts.page.')&&value.includedRows>0)).toBe(true);
  expect(buildChatModelContext(context,'Which landing page or source needs attention in the closed prior day?').context.clients[0].traffic).toBeDefined();
 });
 it('retains a specifically named market even without a breakdown keyword',()=>{
  const context=overviewTrafficFixture();context.clients[0].visualBreakdowns.traffic!.current!.cuts.market.rows[0].dimensions.market='FR';
  const projection=buildChatModelContext(context,'Compare France conversion versus yesterday');
  expect(projection.context.clients[0].visualBreakdowns.traffic!.current!.cuts.market.rows.length).toBeGreaterThan(0);
  expect(resolvedRows(projection).some(row=>row.dimensions.market==='FR')).toBe(true);
 });
 it('omits unrequested fully populated Beam chart history with exact dated omission counts',()=>{
  const context=populatedOverviewHistory(),before=JSON.stringify(context),projection=buildChatModelContext(context,'For this view, give Online Store net sales and US conversion versus yesterday through the same store hour.'),shown=projection.context.clients[0];
  expect(shown.selectedView.dailyChart).toBeUndefined();for(const key of ['scope','current','comparison'] as const)expect(shown.selectedView[key]).toEqual(context.clients[0].selectedView[key]);
  expect(shown.reportTiming).toEqual(context.clients[0].reportTiming);expect(projection.context.sources).toEqual(context.sources);expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(80000);
  for(const period of ['current','comparison'])expect(projection.chatPreview.collections.find(c=>c.path===`clients[0].selectedView.dailyChart.${period}`)).toMatchObject({availableRows:30,includedRows:0,omittedRows:30});
  expect(projection.chatPreview.omittedFields.some(field=>field.path==='clients[0].selectedView.dailyChart')).toBe(true);expect(JSON.stringify(context)).toBe(before);
 });
 it('retains every loaded Beam history date and zero for chart, last 14 days and past 2 weeks questions',()=>{
  const context=populatedOverviewHistory(),chart=context.clients[0].selectedView.dailyChart!,sparse=(rows:typeof chart.current)=>rows.map(row=>({...row,metrics:Object.fromEntries(Object.entries(row.metrics).filter(([,value])=>value!==null&&value!==undefined)),summary:Object.fromEntries(Object.entries(row.summary).filter(([,value])=>value!==null&&value!==undefined))}));
  for(const question of ['Show the full 30-day chart and its comparison.','What is the daily trend?','How did revenue change over the last 14 days?','How did revenue change over the past 2 weeks?','Show the weekly revenue trend.']){expect(chatObservationSelection('overview',question,'beam').trendDatasets.length).toBeGreaterThan(0);const projected=buildChatModelContext(context,question).context.clients[0].selectedView.dailyChart!;expect(projected).toBeDefined();expect(projected.current).toEqual(sparse(chart.current));expect(projected.comparison).toEqual(sparse(chart.comparison));expect(projected.current[0].metrics.online_store_orders).toBe(0);}
 });
 it('does not load unrelated Traffic detail from stopwords or a repeated short number in a chart question',()=>{
  const context=populatedOverviewHistory();context.clients[0].datasetDetails.traffic.rows[0].dimensions.page='/articles/the-and-are/unrelated-product';context.clients[0].datasetDetails.traffic.rows[1].dimensions.utm_campaign='offer_30_30';
  const projection=buildChatModelContext(context,'Show the full 30-day chart and its comparison.');
  expect(projection.context.clients[0].datasetDetails.traffic).toBeUndefined();expect(projection.context.clients[0].selectedView.dailyChart!.current).toHaveLength(30);
 });
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
