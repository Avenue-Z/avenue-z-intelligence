import {expect,it} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Connection,Observation,QueryFilters} from '../../lib/analytics/contracts';
const client:Client={id:'test',name:'Test client',slug:'test',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['FR','DE'],benchmarkMarket:'FR',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'FR',stream:'',source:'',device:'',page:'',mode:'closed',view:'markets'};
const row=(market:string,metric='revenue',value=100,date=filters.to):Observation=>({date,dataset:'markets',metric,value,dimensions:{market},definition:'web',population:'web_orders',currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'});

it('combines compatible legacy name and ISO metrics under one canonical market filter and option',()=>{
 const named=row('France'),canonical=row('FR','orders',5),germany=row('Germany'),unknown=row('Unrecognized Territory');
 const a=queryClient(client,[named,canonical,germany,unknown],[],filters);
 expect(a.datasetMetrics).toMatchObject({revenue:100,orders:5,aov:20});
 expect(a.details).toHaveLength(1);
 expect(a.details[0].dimensions.market).toBe('FR');
 expect(a.availableDimensions.market).toEqual(['DE','FR','Unrecognized Territory']);
 expect(a.evidence).toContain(canonical);
 expect(named.dimensions.market).toBe('France');
});

it('preserves a saved country-name filter without mutating the caller scope',()=>{
 const f={...filters,market:'France'},a=queryClient(client,[row('FR'),row('France','orders',5)],[],f);
 expect(a.datasetMetrics).toMatchObject({revenue:100,orders:5});
 expect(a.comparison.market).toBe('FR');
 expect(f.market).toBe('France');
});

it('does not clone already canonical public-page observations',()=>{
 const canonical={...row('FR','sessions',100),dataset:'funnels',definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',dimensions:{page:'/pages/glp',market:'FR'}};
 const a=queryClient(client,[canonical],[],{...filters,view:'funnels'});
 expect(a.evidence[0]).toBe(canonical);
 expect(a.details[0].metrics.sessions).toBe(100);
});

it('keeps overlapping aliases visible as unavailable rather than silently deduplicating or summing counts',()=>{
 const canonical={...row('FR','sessions',100),dataset:'funnels',definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',dimensions:{page:'/pages/glp',market:'FR'}};
 const named={...canonical,value:200,dimensions:{...canonical.dimensions,market:'France'}};
 const a=queryClient(client,[canonical,named],[],{...filters,view:'funnels'});
 expect(a.evidence).toHaveLength(2);
 expect(a.evidence.map(r=>r.value)).toEqual([100,200]);
 expect(a.datasetMetrics.sessions).toBeNull();
 expect(a.availableDimensions.market).toEqual(['FR']);
});

it('offers dimensions from the selected and comparison periods rather than unrelated trend history',()=>{
 const selected={...row('FR'),dimensions:{market:'FR',source:'Meta'}},otherMarket=row('US'),comparison={...row('CA','revenue',80,'2026-09-30'),dimensions:{market:'CA',source:'TikTok'}},history={...row('Germany / Spain / Mexico / NL','orders',8,'2026-10-01'),quality:'historical' as const,dimensions:{market:'Germany / Spain / Mexico / NL',source:'Archived source'}},intervening=row('Mexico / Ireland / other','orders',38,'2026-10-06'),operational=row('ZZ','active_customers');
 const observations=[selected,otherMarket,comparison,history,intervening,operational],original=JSON.stringify(observations);
 const a=queryClient(client,observations,[],{...filters,compare:'weekday',source:'Meta'});
 expect(a.availableDimensions.market).toEqual(['CA','FR','US']);
 expect(a.availableDimensions.source).toEqual(['Meta','TikTok']);
 expect(JSON.stringify(observations)).toBe(original);
});

it('retains genuine historical aggregate market options when their dates are selected or compared',()=>{
 const aggregate={...row('Germany / Spain / Mexico / NL','orders',8,'2026-10-06'),quality:'historical' as const},priorAggregate={...row('Mexico / Ireland / other','orders',38,'2026-10-01'),quality:'historical' as const};
 const a=queryClient(client,[aggregate,priorAggregate,row('US')],[],{...filters,from:'2026-10-06',to:'2026-10-06',compare:'custom',compareFrom:'2026-10-01',compareTo:'2026-10-01',market:''});
 expect(a.availableDimensions.market).toEqual(['Germany / Spain / Mexico / NL','Mexico / Ireland / other']);
 expect(a.evidence).toContain(aggregate);
 expect(a.comparisonEvidence).toContain(priorAggregate);
});

const coverage=(through:string|null):Connection=>({id:'source',clientId:client.id,name:'Commerce',provider:'kind-triple-whale',endpoint:'',secretRef:'',pollMinutes:60,enabled:true,lastSuccess:through,coverageThrough:through,error:null,version:1});
const hourly=(market:string,date:string,end:string):Observation=>({...row(market,'revenue',100,date),end});

it('offers intraday dimensions only through the matched current and comparison store hour',()=>{
 const observations=[hourly('FR','2026-10-07','2026-10-07T12:00:00Z'),hourly('DE','2026-10-07','2026-10-07T13:00:00Z'),hourly('CA','2026-10-06','2026-10-06T12:00:00Z'),hourly('MX','2026-10-06','2026-10-06T13:00:00Z'),row('AU'),row('IE','revenue',100,'2026-10-06')];
 const a=queryClient(client,observations,[coverage('2026-10-07T12:35:00Z')],{...filters,mode:'partial'});
 expect(a.availableDimensions.market).toEqual(['CA','FR']);
 expect(a.cutoff).toBe('2026-10-07T12:00:00Z');
});

it('retains last-hour dimensions from both store days at a next-midnight capture',()=>{
 const stockholm={...client,timezone:'Europe/Stockholm'},observations=[hourly('FR','2026-10-07','2026-10-07T22:00:00Z'),hourly('CA','2026-10-06','2026-10-06T22:00:00Z'),hourly('MX','2026-10-06','2026-10-06T23:00:00Z')];
 const a=queryClient(stockholm,observations,[coverage('2026-10-07T22:00:00Z')],{...filters,mode:'partial'});
 expect(a.availableDimensions.market).toEqual(['CA','FR']);
 expect(a.cutoff).toBe('2026-10-07T22:00:00Z');
});

it('does not offer intraday dimensions without confirmed contributing coverage',()=>{
 const a=queryClient(client,[hourly('FR','2026-10-07','2026-10-07T12:00:00Z')],[coverage(null)],{...filters,mode:'partial'});
 expect(a.availableDimensions.market).toEqual([]);
});
