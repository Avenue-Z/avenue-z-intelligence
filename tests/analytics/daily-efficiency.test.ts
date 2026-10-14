import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Connection,Observation,QueryFilters} from '../../lib/analytics/contracts';
const client:Client={id:'test',name:'Test',slug:'test',timezone:'UTC',currency:'USD',color:'#416bc3',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web_nonrecurring',spendChannels:['meta','google'],recurringLabel:'Recurring',minSessions:100,minOpportunity:10,maxActions:5,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',view:'media',mode:'closed',compare:'previous',market:'',source:'',page:'',stream:'',device:''};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-10-12T12:00:00Z');});afterEach(()=>vi.useRealTimers());
function rows(date:string):Observation[]{return [{metric:'revenue',value:100,definition:'web_nonrecurring',population:'web',currency:'USD'},{metric:'spend',value:50,definition:'all_paid_media',population:'paid',currency:'USD'},{metric:'new_orders',value:10,definition:'web_nonrecurring',population:'web',currency:null}].map(row=>({...row,date,dataset:'overview',dimensions:{},channels:['meta','google'],sourceId:'qualified',retrievedAt:'2026-10-12T12:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'}));}
const daily=(current:Observation[],previous=rows('2026-10-10'))=>queryClient(client,[...current,...previous],[],filters,{prepareAllViews:true});
it('preserves MER only for a qualified daily revenue, spend and new-order scope',()=>{
 const result=daily(rows(filters.to));expect(result.datasetSeries.overview[0].summary.mer).toBe(2);expect(result.comparisonDatasetSeries.overview[0].summary.mer).toBe(2);
});
it.each(['channel','definition','quality','coverage','new_orders'])('withholds daily MER when %s qualification is missing',reason=>{
 let current=rows(filters.to);
 if(reason==='channel')current=current.map(row=>({...row,channels:['meta']}));
 if(reason==='definition')current=current.map(row=>row.metric==='revenue'?{...row,definition:'all_store_sales'}:row);
 if(reason==='quality')current=current.map(row=>row.metric==='spend'?{...row,quality:'partial'}:row);
 if(reason==='coverage')current=current.map(row=>row.metric==='spend'?{...row,coverageThrough:'2026-10-11T13:00:00Z'}:row);
 if(reason==='new_orders')current=current.filter(row=>row.metric!=='new_orders');
 const result=daily(current);expect(result.series.find(point=>point.date===filters.to)?.mer).toBeNull();expect(result.datasetSeries.overview[0].summary.mer).toBeNull();expect(result.comparisonDatasetSeries.overview[0].summary.mer).toBe(2);
});
function partialConnection():Connection{return {id:'tw',clientId:client.id,name:'TW',provider:'kind-triple-whale',endpoint:'https://example.test',secretRef:'secret',pollMinutes:30,enabled:true,lastSuccess:'2026-10-12T13:00:00Z',coverageThrough:'2026-10-12T13:00:00Z',error:null,version:1};}
it('qualifies both matched partial-day MER points against their own normalized cutoff',()=>{
 const hourly=['2026-10-11','2026-10-12'].flatMap(date=>Array.from({length:13},(_,hour)=>rows(date).map(row=>({...row,start:`${date}T${String(hour).padStart(2,'0')}:00:00Z`,end:`${date}T${String(hour+1).padStart(2,'0')}:00:00Z`,coverageThrough:'2026-10-12T13:00:00Z'}))).flat());
 const result=queryClient(client,hourly,[partialConnection()],{...filters,from:'2026-10-12',to:'2026-10-12',mode:'partial'},{prepareAllViews:true});expect(result.datasetSeries.overview[0].summary.mer).toBe(2);expect(result.comparisonDatasetSeries.overview[0].summary.mer).toBe(2);
});
it('keeps daily-only market totals in closed history without recasting them as matched-hour live values',()=>{
 const market:Observation={...rows('2026-10-10')[0],dataset:'markets',dimensions:{market:'US'},value:990};
 const result=queryClient(client,[...rows(filters.to),market],[partialConnection()],{...filters,mode:'partial',view:'markets'},{prepareAllViews:true});expect(result.datasetHistorySeries.markets[0].summary.revenue).toBeNull();
 expect(queryClient(client,[market],[],{...filters,view:'markets'},{prepareAllViews:true}).datasetHistorySeries.markets[0].summary.revenue).toBe(990);
});
it('matches prior-day market history to the same live hour instead of retaining later orders',()=>{
 const market:Observation={...rows('2026-10-10')[0],dataset:'markets',dimensions:{market:'US'},value:100,start:'2026-10-10T09:00:00Z',end:'2026-10-10T10:00:00Z'};
 const late={...market,value:200,start:'2026-10-10T18:00:00Z',end:'2026-10-10T19:00:00Z'};
 const result=queryClient(client,[...rows(filters.to),market,late],[partialConnection()],{...filters,mode:'partial',view:'markets'},{prepareAllViews:true});expect(result.datasetHistorySeries.markets[0].summary.revenue).toBe(100);
});

it('qualifies closed periods using each independently captured day end',()=>{
 const capture=(date:string)=>rows(date).map(row=>({...row,coverageThrough:new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString()}));
 const result=queryClient(client,['2026-10-08','2026-10-09','2026-10-10','2026-10-11'].flatMap(capture),[],{...filters,from:'2026-10-10'},{prepareAllViews:true});
 expect(result.verdict.spendComparison).not.toBe('unavailable');expect(result.metrics.mer).toBe(2);
});
it('includes full earlier days and matches only the final day of a multi-day intraday period',()=>{
 const hourly=['2026-10-08','2026-10-09','2026-10-10','2026-10-11'].flatMap(date=>Array.from({length:24},(_,hour)=>rows(date).map(row=>({...row,start:`${date}T${String(hour).padStart(2,'0')}:00:00Z`,end:new Date(Date.parse(`${date}T00:00:00Z`)+(hour+1)*3600000).toISOString(),coverageThrough:'2026-10-12T13:00:00Z'}))).flat());
 const result=queryClient(client,hourly,[partialConnection()],{...filters,from:'2026-10-10',to:'2026-10-11',mode:'partial'},{prepareAllViews:true});
 expect(result.metrics.revenue).toBe(3700);expect(result.prior.revenue).toBe(3700);expect(result.verdict.spendComparison).not.toBe('unavailable');
});
it('retains authoritative closed daily observations before the final partial day',()=>{
 const earlier=['2026-10-08','2026-10-10'].flatMap(date=>rows(date).map(row=>({...row,coverageThrough:new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString()})));
 const final=['2026-10-09','2026-10-11'].flatMap(date=>rows(date).map(row=>({...row,start:`${date}T00:00:00Z`,end:`${date}T13:00:00Z`,coverageThrough:'2026-10-12T13:00:00Z'})));
 const result=queryClient(client,[...earlier,...final],[partialConnection()],{...filters,from:'2026-10-10',to:'2026-10-11',mode:'partial'},{prepareAllViews:true});
 expect(result.metrics.revenue).toBe(200);expect(result.prior.revenue).toBe(200);expect(result.datasetSeries.overview[0].summary.revenue).toBe(100);expect(result.verdict.spendComparison).not.toBe('unavailable');
});
