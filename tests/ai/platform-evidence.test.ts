import {describe,expect,it} from 'vitest';
import {buildAIContext} from '../../lib/ai/context';
import {buildPlatformEvidence} from '../../lib/ai/platform-evidence';
import {queryClient} from '../../lib/analytics/query';
import {buildGa4AIView} from '../../lib/ai/ga4-context';
import type {Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
import type {Client,Connection,Observation} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';

const client=clients[0] as Client;
type ContextClient=ReturnType<typeof buildAIContext>['clients'][number];
type RecordInput=Parameters<typeof buildAIContext>[0][number];
const filters={from:'2026-10-15',to:'2026-10-15',view:'traffic',mode:'closed',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
function facts(date:string,dimensions:Record<string,string>,values:Record<string,number|null>,dataset='traffic',population='human_public_sessions'):Observation[]{
 return Object.entries(values).map(([metric,value])=>({date,dataset,metric,value,dimensions,definition:population,population,currency:['revenue','spend'].includes(metric)?client.currency:null,sourceId:'shopify',retrievedAt:'2026-10-16T12:00:00Z',coverageThrough:'2026-10-16T04:00:00Z',quality:'complete'}));
}
function context(rows:Observation[],brand:Client=client){
 const result=queryClient(brand,rows,[],filters);
 return buildAIContext([{...result,note:{body:'Account scope note'},findings:[],reviews:[]} as unknown as RecordInput],filters);
}
const cohort=()=>[
 ...Array.from({length:100},(_,i)=>['2026-10-15','2026-10-14'].flatMap(date=>facts(date,{page:`/large-${i}`,market:'US',source:'search'},{sessions:1000+i,converting_sessions:date==='2026-10-15'?90:100}))).flat(),
 ...facts('2026-10-15',{page:'/small-worst',market:'CA',source:'social'},{sessions:2,converting_sessions:0}),
 ...facts('2026-10-14',{page:'/small-worst',market:'CA',source:'social'},{sessions:2,converting_sessions:1})
];

describe('platform analytical evidence',()=>{
 it('ranks the complete cohort before applying pagination, including a decline outside the 80-row detail preview',()=>{
  const input=context(cohort()),before=JSON.stringify(input);
  expect(input.clients[0].datasetDetails.traffic.omitted).toBe(21);
  const result=buildPlatformEvidence(input,{breakdown:'page',limit:2},'query-one'),table=result.clients[0].tables.page;
  expect(table).toMatchObject({fullCohort:true,rankingComplete:true,totalGroups:101,returnedGroups:2,omittedGroups:99,offset:0,metric:'cvr',sort:'decline'});
  expect(table.rows[0]).toMatchObject({dimension:'/small-worst',current:{metrics:{sessions:2},summary:{cvr:0}},previous:{summary:{cvr:.5}},change:{relative:-1,percentagePoints:-50},estimatedConvertingSessionGap:1});
  expect(table.rows[0].qualification).toMatch(/descriptive|significance/i);
  const second=buildPlatformEvidence(input,{breakdown:'page',limit:2,offset:2},'query-two').clients[0].tables.page;
  expect(second.rows.map(row=>row.dimension)).not.toContain('/small-worst');
  expect(second).toMatchObject({totalGroups:101,returnedGroups:2,offset:2,omittedGroups:99,hasMore:true});
  expect(JSON.stringify(input)).toBe(before);
 });

 it('pairs stable labels across different source segments and preserves weighted prepared rates',()=>{
  const rows=[
   ...facts('2026-10-15',{page:'/offer',market:'US',source:'search'},{sessions:900,converting_sessions:9}),
   ...facts('2026-10-15',{page:'/offer',market:'US',source:'social'},{sessions:100,converting_sessions:10}),
   ...facts('2026-10-14',{page:'/offer',market:'US',source:'email'},{sessions:100,converting_sessions:10}),
   ...facts('2026-10-14',{page:'/offer',market:'CA',source:'social'},{sessions:100,converting_sessions:30})
  ];
  const row=buildPlatformEvidence(context(rows),{breakdown:'page'},'weighted').clients[0].tables.page.rows[0];
  expect(row.current?.metrics.sessions).toBe(1000);expect(row.current?.summary.cvr).toBe(.019);expect(row.previous?.summary.cvr).toBe(.2);
  expect(row.change.relative).toBeCloseTo(-.905);expect(row.change.percentagePoints).toBeCloseTo(-18.1);expect(row.estimatedConvertingSessionGap).toBeCloseTo(181);
 });

 it('keeps unavailable population-qualified rates null despite present counts',()=>{
  const rows=[...facts('2026-10-15',{page:'/mixed',market:'US'},{sessions:100}),...facts('2026-10-15',{page:'/mixed',market:'US'},{converting_sessions:50},'traffic','different_population'),...facts('2026-10-14',{page:'/mixed',market:'US'},{sessions:100,converting_sessions:20})];
  const row=buildPlatformEvidence(context(rows),{breakdown:'page'},'mixed').clients[0].tables.page.rows[0];
  expect(row.current?.metrics.converting_sessions).toBe(50);expect(row.current?.summary.cvr).toBeNull();expect(row.change.relative).toBeNull();expect(row.change.percentagePoints).toBeNull();expect(row.estimatedConvertingSessionGap).toBeNull();
 });

 it('retains current-only, previous-only and zero-baseline groups without inventing zero changes',()=>{
  const rows=[...facts('2026-10-15',{page:'/new'},{sessions:100,converting_sessions:20}),...facts('2026-10-14',{page:'/gone'},{sessions:100,converting_sessions:10}),...facts('2026-10-15',{page:'/zero'},{sessions:100,converting_sessions:20}),...facts('2026-10-14',{page:'/zero'},{sessions:100,converting_sessions:0})];
  const table=buildPlatformEvidence(context(rows),{breakdown:'page'},'unknown').clients[0].tables.page;
  expect(table.totalGroups).toBe(3);
  expect(table.rows.find(row=>row.dimension==='/new')).toMatchObject({previous:null,baselineStatus:'missing',change:{relative:null,percentagePoints:null}});
  expect(table.rows.find(row=>row.dimension==='/gone')).toMatchObject({current:null,change:{relative:null}});
  expect(table.rows.find(row=>row.dimension==='/zero')).toMatchObject({baselineStatus:'zero',change:{relative:null,percentagePoints:20}});
 });

 it('returns separate complete market and page rankings for all and scopes both periods',()=>{
  const result=buildPlatformEvidence(context(cohort()),{breakdown:'all'},'both'),tables=result.clients[0].tables;
  expect(Object.keys(tables)).toEqual(['market','page']);expect(tables.market.rows[0].dimension).toBe('CA');
  expect(tables.page.scope).toMatchObject({current:{filters:{from:'2026-10-15',to:'2026-10-15'},cutoff:null,timezone:client.timezone},comparison:{filters:{from:'2026-10-14',to:'2026-10-14'}}});
  expect(tables.page.rows).toHaveLength(20);
 });

 it('namespaces all citations across repeated queries and brands while retaining valid source entries',()=>{
  const input=context(cohort()),other=context(cohort(), {...client,id:'other-brand',name:'Other Brand'});
  const a=buildPlatformEvidence(input,{breakdown:'page',limit:1},'lookup:one'),b=buildPlatformEvidence(input,{breakdown:'page',limit:1},'lookup:two'),c=buildPlatformEvidence(other,{},'lookup:one');
  expect(new Set([...a.sources,...b.sources,...c.sources].map(source=>source.id)).size).toBe(a.sources.length+b.sources.length+c.sources.length);
  const ids=new Set(a.sources.map(source=>source.id));
  const inspect=(value:unknown,key='')=>{if(Array.isArray(value)){value.forEach(item=>inspect(item,key));return;}if(value&&typeof value==='object'){Object.entries(value).forEach(([name,item])=>inspect(item,name));return;}if((/sourceId$/i.test(key)||/sourceIds$/i.test(key))&&typeof value==='string')expect(ids.has(value)).toBe(true);};
  inspect(a.clients);expect(a.clients[0].sourceId).not.toBe(input.clients[0].sourceId);
 });

 it('keeps authoritative totals, trend scope, fixed saved reviews and explicit preview omissions compactly',()=>{
  const input=context([...cohort(),...Array.from({length:90},(_,i)=>facts('2026-10-15',{product:`Product ${i}`},{revenue:i+1,orders:1},'products')).flat()]);
  input.clients[0].selectedReview={storeDate:'2026-10-01',revision:3};
  input.clients[0].sourceReviews=[{sourceId:'review:fixed',storeDate:'2026-10-01',revision:3,scopeLabel:'Fixed saved report',payload:{text:'Saved report',filters:{...filters,to:'2026-10-01'}}} as unknown as ContextClient['sourceReviews'][number]];
  input.sources.push({id:'review:fixed',label:'Saved report',url:'/review/fixed'});
  input.clients[0].selectedView.dailyChart={dataset:'traffic',current:[{date:'2026-10-13',metrics:{sessions:40},summary:{cvr:null}}],comparison:[],scope:{sourceId:input.clients[0].sourceId,timezone:client.timezone,filters,cutoff:null},instruction:'Historical chart, not selected totals'} as unknown as NonNullable<ContextClient['selectedView']['dailyChart']>;
  const result=buildPlatformEvidence(input,{breakdown:'all'},'compact'),projected=result.clients[0];
  expect(projected.selectedView.current).toEqual(input.clients[0].selectedView.current);
  expect(projected.selectedView.dailyChart?.current[0]).toMatchObject({date:'2026-10-13',metrics:{sessions:40},summary:{cvr:null}});
  expect(projected.selectedReview).toMatchObject({storeDate:'2026-10-01',revision:3});expect(projected.sourceReviews[0]).toMatchObject({storeDate:'2026-10-01',scopeLabel:'Fixed saved report'});
  expect(projected.datasets.products.current).toMatchObject({fullCohort:false,segmentCount:90,availablePreviewGroups:80,sourceOmittedGroups:10});
  expect(projected.datasets.products.current?.qualification).toMatch(/preview|complete/i);
  expect(JSON.stringify(result).length).toBeLessThan(100_000);expect(JSON.stringify(result)).not.toContain('provenance');
  expect(projected).not.toHaveProperty('details');expect(projected.visualBreakdowns).not.toHaveProperty('traffic');
 });

 it('uses supplied full traffic totals outside the selected view and bounds growth/value pagination',()=>{
  const input=context(cohort());input.clients[0].selectedView.dataset='overview';
  const result=buildPlatformEvidence(input,{breakdown:'source',metric:'sessions',sort:'value',limit:500,offset:-3},'bounded');
  expect(result.options).toMatchObject({limit:50,offset:0});
  expect(result.clients[0].datasets.traffic.totals?.current?.metrics.sessions).toBe(104952);
  const table=result.clients[0].tables.source;expect(table.rows[0]).toMatchObject({dimension:'search',current:{metrics:{sessions:104950}}});
  const growth=buildPlatformEvidence(input,{breakdown:'page',metric:'sessions',sort:'growth',limit:1},'growth').clients[0].tables.page;
  expect(growth.rows[0].dimension).toBe('/large-0');expect(growth.rows[0].change.relative).toBe(0);
 });

 it('ranks converting-session impact across the full cohort before the preview cap and row limit',()=>{
  const input=context([...cohort(),...facts('2026-10-15',{page:'/medium-impact',market:'UK'},{sessions:300,converting_sessions:0}),...facts('2026-10-14',{page:'/medium-impact',market:'UK'},{sessions:300,converting_sessions:60})]);
  expect(input.clients[0].datasetDetails.traffic.rows.some(row=>row.dimensions.page==='/medium-impact')).toBe(false);
  const table=buildPlatformEvidence(input,{breakdown:'page',sort:'impact',limit:1},'impact').clients[0].tables.page;
  expect(table).toMatchObject({totalGroups:102,rankingComplete:true,sort:'impact'});expect(table.rows[0]).toMatchObject({dimension:'/medium-impact',estimatedConvertingSessionGap:60});
 });

 it('retains the exact rendered subscription comparison and daily event ledger alongside the distinct four-week benchmark',()=>{
  const scope={...filters,from:'2026-10-12',to:'2026-10-12',view:'subscriptions'};
  const rows=[...facts('2026-10-12',{}, {recurring_orders:1854,recurring_cancelled_orders:109},'subscriptions','subscriptions'),...facts('2026-10-11',{}, {recurring_orders:2803,recurring_cancelled_orders:180},'subscriptions','subscriptions'),...facts('2026-10-12',{}, {subscription_cancellation_events:3426,new_subscriptions:100,same_day_subscription_cancellation_events:10},'subscriptionEvents','events'),...facts('2026-10-11',{}, {subscription_cancellation_events:2985,new_subscriptions:200,same_day_subscription_cancellation_events:5},'subscriptionEvents','events')];
  const record=queryClient(client,rows,[],scope),input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],scope),projected=buildPlatformEvidence(input,{breakdown:'all'},'subscriptions').clients[0];
  const visual=projected.visualBreakdowns.subscriptions!;
  expect(visual.range).toEqual({from:'2026-10-12',to:'2026-10-12'});expect(visual.comparisonRange).toEqual({from:'2026-10-11',to:'2026-10-11'});
  expect(visual.current.metrics).toMatchObject({recurring_orders:1854,recurring_cancelled_orders:109,cancellation_rate:109/1854,subscription_cancellation_events:3426,same_day_cancellation_rate:.1});
  expect(visual.previous.metrics).toMatchObject({recurring_orders:2803,cancellation_rate:180/2803,subscription_cancellation_events:2985,same_day_cancellation_rate:.025});
  expect(projected.subscriptions).toEqual(input.clients[0].subscriptions);
  expect(projected.strategyDiagnoses?.calendarCancellations).toMatchObject({current:{rows:[{date:'2026-10-12',cancellations:3426}]},comparison:{rows:[{date:'2026-10-11',cancellations:2985}]}});
 });

 it('preserves the selected revenue history and hourly comparison rather than replacing them with daily aggregates',()=>{
  const input=context([]);
  input.clients[0].monthToDate={from:'2026-10-01',to:'2026-10-15',fullElapsedDayCoverage:false,missingDates:['2026-10-03'],qualification:'Observed dates only; complete MTD is unavailable.'};
  Object.assign(input.clients[0].selectedView,{dataset:'revenue',history:[{date:'2026-10-13',metrics:{revenue:100}}],hourlyChart:{current:[{date:'2026-10-15',hour:3,metrics:{revenue:20}}],comparison:[{date:'2026-10-14',hour:3,metrics:{revenue:30}}]}});
  const clientProjection=buildPlatformEvidence(input,{},'hours').clients[0],projected=clientProjection.selectedView;
  expect(projected.history).toEqual([{date:'2026-10-13',metrics:{revenue:100}}]);expect(projected.hourlyChart).toEqual({current:[{date:'2026-10-15',hour:3,metrics:{revenue:20}}],comparison:[{date:'2026-10-14',hour:3,metrics:{revenue:30}}]});
  expect(clientProjection.monthToDate).toMatchObject({fullElapsedDayCoverage:false,missingDates:['2026-10-03'],qualification:'Observed dates only; complete MTD is unavailable.'});
 });

 it('does not claim a complete comparison ranking when a period or declared traffic groups are missing',()=>{
  const missing=context(facts('2026-10-15',{page:'/only-current'},{sessions:100,converting_sessions:10}));
  expect(buildPlatformEvidence(missing,{breakdown:'page'},'missing').clients[0].tables.page).toMatchObject({fullCohort:false,rankingComplete:false});
  const capped=context(cohort()),cut=capped.clients[0].visualBreakdowns.traffic.current!.cuts.page;cut.rows=cut.rows.slice(0,80);
  expect(buildPlatformEvidence(capped,{breakdown:'page'},'capped').clients[0].tables.page).toMatchObject({fullCohort:false,rankingComplete:false});
 });

 it('distinguishes observations returned here from the upstream detail preview omission',()=>{
  const input=context(Array.from({length:90},(_,i)=>facts('2026-10-15',{product:`Product ${i}`},{revenue:i+1,orders:1},'products')).flat());
  input.clients[0].selectedView.dataset='products';
  const preview=buildPlatformEvidence(input,{limit:20},'counts').clients[0].datasets.products.current;
  expect(preview).toMatchObject({observationCount:180,availablePreviewObservationCount:160,sourceOmittedObservationCount:20,returnedObservationCount:40,omittedObservationCount:140});
 });

 it('retains the comparison store date and its own same-hour cutoff in partial-period ranks',()=>{
  const scope={...filters,mode:'partial' as const},rows=['2026-10-15','2026-10-14'].flatMap(date=>facts(date,{page:'/offer',market:'US'},{sessions:100,converting_sessions:date===scope.to?10:20}).map(row=>({...row,start:`${date}T08:00:00Z`,end:`${date}T09:00:00Z`})));
  const connections=[{id:'traffic',provider:'kind-shopify-traffic',enabled:true,coverageThrough:'2026-10-15T13:00:00Z'}] as Connection[],record=queryClient(client,rows,connections,scope),input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],scope);
  const table=buildPlatformEvidence(input,{breakdown:'page'},'cutoff').clients[0].tables.page;
  expect(table.scope.current).toMatchObject({filters:{from:'2026-10-15',to:'2026-10-15'},cutoff:'2026-10-15T13:00:00Z',window:{end:'2026-10-15T13:00:00Z'}});
  expect(table.scope.comparison).toMatchObject({filters:{from:'2026-10-14',to:'2026-10-14'},cutoff:'2026-10-14T13:00:00Z',window:{end:'2026-10-14T13:00:00Z'}});
  expect(table.rows[0].change.relative).toBe(-.5);
 });

 it('ranks and paginates a complete nontraffic dataset beyond the former preview cap using stable dimensions',()=>{
  const scope={...filters,view:'products'},rows=Array.from({length:120},(_,i)=>['2026-10-15','2026-10-14'].flatMap(date=>facts(date,{product:`Product ${i}`},{revenue:i===119?(date==='2026-10-15'?1:1000):1000+i,orders:1},'products'))).flat();
  const record=queryClient(client,rows,[],scope),input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[]}],scope,undefined,true);
  const first=buildPlatformEvidence(input,{metric:'revenue',limit:1},'products-first').clients[0].tables.products;
  expect(first).toMatchObject({dataset:'products',totalGroups:120,rankingComplete:true,fullCohort:true,returnedGroups:1});
  expect(first.rows[0]).toMatchObject({dimensions:{product:'Product 119'},current:{metrics:{revenue:1}},previous:{metrics:{revenue:1000}},change:{relative:-.999}});
  const later=buildPlatformEvidence(input,{metric:'revenue',sort:'value',limit:5,offset:100},'products-later').clients[0];
  expect(later.datasets.products.current).toMatchObject({fullCohort:true,availablePreviewGroups:120,sourceOmittedGroups:0,returnedGroups:5});
  expect(later.tables.products).toMatchObject({totalGroups:120,returnedGroups:5,offset:100,hasMore:true});
  expect(later.tables.products.rows[0].current?.metrics.revenue).toBe(1018);
 });

 it('ranks complete GA4 groups before pagination while preserving GA4 populations and never deriving CVR or MER',()=>{
  const input=context([]),groups=Array.from({length:120},(_,i)=>({label:`/ga4-${i}`,current:{sessions:i===119?1:1000+i,engagedSessions:20,purchases:1,revenue:10},previous:{sessions:1000+i,engagedSessions:20,purchases:2,revenue:20}}));
  input.clients[0].selectedView.dataset='ga4';
  input.clients[0].ga4View={available:true,sourceId:'ga4:brand',scope:{filters:{...filters,view:'ga4'},from:filters.from,to:filters.to,comparison:{from:'2026-10-14',to:'2026-10-14'},timezone:client.timezone,currency:client.currency,latestCapturedAt:'2026-10-16T12:00:00Z',matchedThroughHour:null},current:{sessions:123,purchases:4,revenue:50},previous:{sessions:200,purchases:5,revenue:70},coverage:{requestedDays:1,capturedDays:1,missingDates:[]},quality:{sampled:false},pages:{groupCount:120,backendReturnedGroupCount:120,backendOmitted:0,returnedGroupCount:120,omitted:0,groups},sources:{groupCount:0,groups:[],omitted:0},markets:{groupCount:0,groups:[],omitted:0},devices:{groupCount:0,groups:[],omitted:0},instruction:'GA4 attributed purchases are separate from Shopify orders.'} as unknown as NonNullable<ContextClient['ga4View']>;
  input.sources.push({id:'ga4:brand',label:'GA4 snapshot',url:'/ga4'});
  const first=buildPlatformEvidence(input,{breakdown:'page',metric:'sessions',limit:1,question:'Which GA4 landing page lost sessions?'},'ga4').clients[0];
  expect(first.tables.page).toMatchObject({dataset:'ga4',totalGroups:120,fullCohort:true,rankingComplete:true,returnedGroups:1});expect(first.tables.page.rows[0]).toMatchObject({dimension:'/ga4-119',current:{metrics:{sessions:1}},previous:{metrics:{sessions:1119}}});
  expect(first.ga4View?.available&&first.ga4View.current).toEqual({sessions:123,purchases:4,revenue:50});expect(first.ga4View).not.toHaveProperty('pages.groups');expect(first.tables.page.rows[0].estimatedConvertingSessionGap).toBeNull();
  const later=buildPlatformEvidence(input,{breakdown:'page',metric:'purchases',sort:'value',offset:100,limit:5,question:'GA4 purchases by page'},'ga4-later').clients[0];
  expect(later.tables.page).toMatchObject({returnedGroups:5,offset:100,totalGroups:120});
  const invalid=buildPlatformEvidence(input,{breakdown:'page',metric:'cvr',question:'What is GA4 CVR?'},'ga4-cvr').clients[0].tables.page;
  expect(invalid.rankingComplete).toBe(false);expect(invalid.rows.every(row=>row.change.current===null&&row.estimatedConvertingSessionGap===null)).toBe(true);
 });

 it('keeps traffic retrieval compact by excluding unrelated recurring diagnostics and saved-report detail tables',()=>{
  const input=context(cohort());input.clients[0].subscriptions={...input.clients[0].subscriptions,unrelatedRows:Array.from({length:1000},(_,i)=>({date:i,revenue:i,qualification:'Repeated renewal evidence'}))} as unknown as ContextClient['subscriptions'];
  input.clients[0].sourceReviews=[{sourceId:'review:large',storeDate:'2026-10-01',revision:1,scopeLabel:'Fixed saved report',payload:{headlines:['Dated claim'],sections:[{tables:[{rows:Array.from({length:1000},()=>['Repeated historical row'])}]}]}} as unknown as ContextClient['sourceReviews'][number]];
  const projected=buildPlatformEvidence(input,{breakdown:'all',sort:'impact',question:'Which markets and landing pages performed worst day over day?'},'focused').clients[0];
  expect(projected).not.toHaveProperty('subscriptions');expect(projected.visualBreakdowns).not.toHaveProperty('subscriptions');expect(projected).not.toHaveProperty('strategyDiagnoses');expect(projected.sourceReviews[0].payload).not.toHaveProperty('sections');
  expect(JSON.stringify(projected).length).toBeLessThan(60_000);expect(projected.warnings).toEqual(input.clients[0].warnings);
 });
});

it('uses the analytical selection citation for provider provenance instead of duplicate source chips',()=>{
 const input=context(cohort()),result=buildPlatformEvidence(input,{breakdown:'all',question:'Which markets and landing pages declined?'},'canonical');
 const selection=result.sources.filter(source=>source.url.includes('/clients/'));
 expect(selection).toHaveLength(1);expect(result.clients[0].tables.market.scope.current).toMatchObject({contributingSourceIds:[selection[0].id]});
});

it('preserves Autobrush provider-date scope and qualified spend change for platform-wide questions',()=>{
 const auto=clients.find(brand=>brand.id==='autobrush') as Client,input=context([],auto),reporting=input.clients[0].providerReporting!;
 expect(reporting).toBeDefined();const projected=buildPlatformEvidence(input,{question:'Compare all platforms'},'autobrush-scope').clients[0];
 expect(projected).toHaveProperty('providerReporting',reporting);expect(projected.providerReporting?.subscriptionsEnabled).toBe(false);expect(projected.providerReporting?.motion.qualifiedSpendChange).toEqual(reporting.motion.qualifiedSpendChange);expect(projected.providerReporting?.instruction).toContain('unverified account timezone');expect(projected.providerReporting?.instruction).toContain('Never publish matched MER');expect(projected).not.toHaveProperty('beamReporting');
});

it('projects GA4’s LA hour-three evidence without the native New York cutoff or commerce frame',()=>{
 const auto=clients.find(c=>c.id==='autobrush') as Client,scope={...filters,from:'2026-10-22',to:'2026-10-22',view:'ga4',mode:'partial'} as const,record=queryClient(auto,[],[],scope),now='2026-10-22T13:18:00Z',nativeCutoff='2026-10-22T13:00:00Z',current={sessions:486,engagedSessions:200,purchases:3,revenue:100},previous={sessions:546,engagedSessions:250,purchases:4,revenue:120},groups=[{label:'US',current,previous}],model:Ga4Dashboard={from:scope.from,to:scope.to,comparison:{from:'2026-10-21',to:'2026-10-21'},propertyId:'274489308',streamId:'2635677328',clientId:'autobrush',timezone:'America/Los_Angeles',currency:'USD',latestCapturedAt:now,matchedThroughHour:3,current,previous,coverage:{requestedDays:1,capturedDays:1,missingDates:[],availableFrom:scope.from,availableTo:scope.to},daily:[],pages:[],sources:[],markets:groups,devices:[],filterOptions:{markets:['US'],sources:[],pages:[],devices:[]},quality:{sampled:false,thresholded:false,restricted:false,truncated:false,dataLossFromOtherRow:false}};
 record.cutoff=nativeCutoff;const ga4View=buildGa4AIView(model,scope,'GA4 US sessions today',true,'autobrush'),input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[],ga4View}],scope),before=JSON.stringify(input),result=buildPlatformEvidence(input,{breakdown:'market',metric:'sessions',question:'GA4 US sessions today'},'ga4-clock').clients[0];
 expect(result.ga4View).toMatchObject({scope:{timezone:'America/Los_Angeles',matchedThroughHour:3,latestCapturedAt:now},current:{sessions:486},previous:{sessions:546}});expect(result.tables.market.scope.current).toMatchObject({timezone:'America/Los_Angeles',matchedThroughHour:3});expect(result.tables.market.rows[0].change.relative).toBeCloseTo(-.10989010989);
 expect(result.client.timezone).toBe('America/Los_Angeles');expect(result.reportTiming).toMatchObject({timezone:'America/Los_Angeles',matchedThroughHour:3});expect(result.cutoff).toBeNull();expect(result.selectedView.scope).toMatchObject({timezone:'America/Los_Angeles',matchedThroughHour:3});expect(JSON.stringify(result)).not.toContain(nativeCutoff);expect(JSON.stringify(result)).not.toContain('09:00');expect(result).not.toHaveProperty('spendVerdict');expect(result).not.toHaveProperty('providerReporting');expect(JSON.stringify(input)).toBe(before);
});
it('keeps unavailable GA4 evidence unknown without leaking a native client cutoff',()=>{
 const auto=clients.find(c=>c.id==='autobrush') as Client,scope={...filters,view:'ga4'},record=queryClient(auto,[],[],scope);record.cutoff='2026-10-15T13:00:00Z';const input=buildAIContext([{...record,note:{body:''},findings:[],reviews:[],ga4View:buildGa4AIView(null,scope,'GA4',false,'autobrush')}],scope),result=buildPlatformEvidence(input,{question:'GA4 today'},'ga4-missing').clients[0];expect(result.ga4View?.available).toBe(false);expect(result.cutoff).toBeNull();expect(JSON.stringify(result)).not.toContain(record.cutoff);
});
