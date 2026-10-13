import {expect,it} from 'vitest';
import {TrendRollupAccumulator} from '../../lib/analytics/trend-rollup';
import {queryClient,sumMetric} from '../../lib/analytics/query';
import {observationCodec} from '../../lib/server/observation-codec';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-12',to:'2026-10-12',compare:'previous',mode:'closed',view:'traffic',market:'',source:'',device:'',page:'',stream:''};
const base:Observation={date:'2026-10-10',dataset:'traffic',metric:'sessions',value:10,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/a',market:'US',device:'mobile',source:'meta',utm_source:'meta',utm_medium:'paid',utm_campaign:'one'},sourceId:'hourly',retrievedAt:'2026-10-11T01:00:00Z',coverageThrough:'2026-10-11T00:00:00Z',quality:'complete',start:'2026-10-10T00:00:00Z',end:'2026-10-10T01:00:00Z',channels:['meta']};
function compact(rows:Observation[],f=filters){const accumulator=new TrendRollupAccumulator(f);for(const row of rows)accumulator.add(row);return accumulator.finish();}
it('collapses inactive segment IDs and hourly observations into exact daily count cohorts',()=>{
 const rows=Array.from({length:6},(_,hour)=>['a','b'].flatMap(page=>['sessions','converting_sessions'].map(metric=>({...base,metric,value:metric==='sessions'?(page==='a'?100:10):(page==='a'?1:2),dimensions:{...base.dimensions,page:`/${page}`,utm_campaign:`${page}-${hour}`},start:`2026-10-10T0${hour}:00:00Z`,end:`2026-10-10T0${hour+1}:00:00Z`})))).flat();
 const result=compact(rows);expect(result).toHaveLength(2);expect(result.map(row=>[row.metric,row.value,row.dimensions])).toEqual([['sessions',660,{}],['converting_sessions',18,{}]]);
 expect(result[0]).toMatchObject({start:'2026-10-10T00:00:00Z',end:'2026-10-10T06:00:00Z',contextOnly:true});expect(rows[0].value).toBe(100);expect(rows[0].dimensions.page).toBe('/a');
 const client:Client={id:'c',slug:'c',name:'C',version:1,timezone:'UTC',currency:'USD',color:'#4368c4',config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:[],recurringLabel:'Recurring',minSessions:10,minOpportunity:1,maxActions:4,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
 const point=queryClient(client,result,[],filters,{preparedDatasets:['traffic']}).trendDatasetSeries.traffic.find(day=>day.date==='2026-10-10');expect(point?.summary.sessions).toBe(660);expect(point?.summary.cvr).toBe(18/660);
});
it('keeps wrong-market and unsupported missing-dimension evidence separate from the selected cohort',()=>{
 const result=compact([base,{...base,value:20,dimensions:{...base.dimensions,market:'Canada'}},{...base,value:30,dimensions:{page:'/a'}}],{...filters,market:'US'});
 expect(result.map(row=>[row.dimensions,row.value])).toEqual([[{market:'US'},10],[{market:'CA'},20],[{},30]]);
});
it('normalizes active page and market dimensions while dropping inactive product and UTM IDs',()=>{
 const result=compact([{...base,dimensions:{...base.dimensions,page:'https://store.test/a?utm_secret=private',market:'United States',product:'legacy-1'}},base],{...filters,market:'US',page:'/a'});
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({dimensions:{market:'US',page:'/a'},value:20});
});
it('does not combine differing source, population, currency, quality or channel contracts',()=>{
 const variants=[base,{...base,sourceId:'other'},{...base,population:'bots'},{...base,currency:'CAD'},{...base,quality:'historical' as const},{...base,channels:['google']}];
 expect(compact(variants)).toHaveLength(6);
});
it('withholds overlapping daily and hourly contracts instead of doubling the reported day',()=>{
 const result=compact([base,{...base,value:100,start:undefined,end:undefined}]);
 expect(result).toHaveLength(2);expect(result.map(row=>row.value)).toEqual([null,null]);expect(sumMetric(result,'sessions')).toBeNull();
});
it('never adds or averages multiple reported rates after collapsing segment IDs',()=>{
 const rate={...base,metric:'reported_conversion_rate',value:.01},other={...rate,value:.2,dimensions:{...base.dimensions,page:'/b'}};
 expect(compact([rate])[0].value).toBe(.01);expect(compact([rate,other])).toHaveLength(1);expect(compact([rate,other])[0].value).toBeNull();
});
it('preserves zero, null poisoning, finite currency totals and conservative metadata bounds',()=>{
 const later={...base,value:0,retrievedAt:'2026-10-11T02:00:00Z',coverageThrough:'2026-10-10T23:00:00Z',start:'2026-10-10T03:00:00Z',end:'2026-10-10T04:00:00Z'};
 expect(compact([{...base,value:0},later])[0]).toMatchObject({value:0,retrievedAt:later.retrievedAt,coverageThrough:later.coverageThrough,start:base.start,end:later.end});
 expect(compact([base,{...later,value:null}])[0].value).toBeNull();expect(compact([base,{...later,coverageThrough:null}])[0].coverageThrough).toBeNull();
 const money={...base,dataset:'products',metric:'revenue',currency:'USD',value:10.25};expect(compact([money,{...money,value:4.5}])[0].value).toBe(14.75);
 expect(compact([{...money,value:Number.MAX_VALUE},{...money,value:Number.MAX_VALUE}])[0].value).toBeNull();expect(compact([])).toEqual([]);
});
it('retains numerator and denominator observations independently rather than aggregating their ratios',()=>{
 const first={...base,metric:'reported_rate',value:.1,numerator:1,denominator:10},second={...first,value:.2,numerator:2,denominator:10};
 expect(compact([first,second]).map(row=>[row.value,row.numerator,row.denominator])).toEqual([[.1,1,10],[.2,2,10]]);
});
it('retains context flags and metadata through the observation cache codec',()=>{
 const compacted=compact([base,{...base,value:2,start:'2026-10-10T02:00:00Z',end:'2026-10-10T03:00:00Z'}]);
 expect(observationCodec.decode(observationCodec.encode(compacted))).toEqual(compacted);
});
