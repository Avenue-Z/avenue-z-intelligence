import {expect,it} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
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
