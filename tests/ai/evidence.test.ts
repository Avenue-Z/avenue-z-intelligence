import {it,expect} from 'vitest';
import {evidenceDetailRows,supplementalReviewEvidence,closedTrafficReviewCuts} from '../../lib/ai/evidence';
import clients from '../../data/initial-clients.json';
import {FunnelRollupAccumulator} from '../../lib/analytics/funnel-rollup';
import type {Observation} from '../../lib/analytics/contracts';
const client=clients[0] as any;
const filters={from:'2026-10-08',to:'2026-10-08',view:'overview',mode:'partial',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
const row=(date:string,dataset:string,metric:string,value:number,dimensions:Record<string,string>={}):Observation=>({date,dataset,metric,value,dimensions,definition:'qualified definition',population:dataset,currency:['revenue','spend','recurring_revenue'].includes(metric)?client.currency:null,sourceId:'shopify',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:'2026-10-09T04:00:00Z',quality:'complete'});
it('aggregates complete closed traffic cuts before the detail cap and preserves the dated scope',()=>{
 const traffic=Array.from({length:85},(_,i)=>row('2026-10-07','traffic','sessions',10,{market:'US',device:i%2?'mobile':'desktop',source:'social',utm_source:'meta',utm_campaign:`campaign-${i}`}));
 const cuts=closedTrafficReviewCuts(traffic,client,filters);
 expect(cuts?.storeDate).toBe('2026-10-07');expect(cuts?.countries.rows[0].summary.sessions).toBe(850);expect(cuts?.devices.rows.reduce((n,r)=>n+(r.summary.sessions??0),0)).toBe(850);
 expect(cuts?.sources).toMatchObject({segmentCount:85,returnedSegmentCount:80,omitted:5});
 expect(cuts?.countries.rows[0].provenance[0].observationCount).toBe(85);
 expect(closedTrafficReviewCuts(traffic.map(r=>({...r,date:'2026-10-08'})),client,filters)).toBeNull();
});
it('keeps last closed detail dated and separate from intraday current evidence',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','funnels','sessions',1600,{page:'/offer',market:'US'}),row('2026-10-07','funnels','converting_sessions',32,{page:'/offer',market:'US'})],[],filters);
 expect(e.priorClosedDetail.datasets.funnels.storeDate).toBe('2026-10-07');
 expect(e.priorClosedDetail.datasets.funnels.scopeLabel).toContain('Closed-day reference');
 expect(e.priorClosedDetail.datasets.funnels.rows[0].summary.cvr).toBe(.02);
 expect(e.priorClosedDetail.datasets.funnels.rows[0].provenance[0]).toMatchObject({date:'2026-10-07',sourceId:'shopify',quality:'complete'});
 expect(e.sources.some(s=>s.id===e.priorClosedDetail.datasets.funnels.sourceId)).toBe(true);
});
it('does not turn absent closed comparisons into zeros and separates renewal order volume from AOV',()=>{
 const rows=[row('2026-10-07','subscriptions','recurring_revenue',120),row('2026-10-07','subscriptions','recurring_orders',4),row('2026-10-06','subscriptions','recurring_revenue',100),row('2026-10-06','subscriptions','recurring_orders',5)];
 const e=supplementalReviewEvidence(client,rows,[],filters);
 expect(e.closedPriorDay.previousDay.metrics.revenue).toBeNull();
 expect(e.dailyRenewals.find(d=>d.storeDate==='2026-10-07')).toMatchObject({revenue:120,orders:4,aov:30,comparison:{revenue:100,orders:5,aov:20},decomposition:{ordersChange:-.2,aovChange:.5,revenueChange:.2}});
});
it('keeps platform UTC spend out of store-day channel MER evidence',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','media','spend',50,{channel:'meta'}),row('2026-10-07','media','platform_spend',90,{channel:'applovin',reporting_timezone:'UTC'})],[],filters);
 expect(e.spendChannelTrend[0].channels).toHaveLength(1);expect(e.spendChannelTrend[0].channels[0]).toMatchObject({channel:'meta',spend:50});
});
it('includes the selected closed day in seven-day renewal and spend appendices but excludes a partial current day',()=>{
 const rows=['2026-10-01','2026-10-02','2026-10-08'].flatMap(date=>[row(date,'subscriptions','recurring_revenue',100),row(date,'subscriptions','recurring_orders',4),row(date,'media','spend',20,{channel:'meta'})]);
 const closed=supplementalReviewEvidence(client,rows,[],{...filters,mode:'closed'}),partial=supplementalReviewEvidence(client,rows,[],filters);
 expect(closed.dailyRenewals.map(day=>day.storeDate)).toEqual(['2026-10-02','2026-10-08']);expect(closed.spendChannelTrend.map(day=>day.storeDate)).toEqual(['2026-10-02','2026-10-08']);
 expect(partial.dailyRenewals.map(day=>day.storeDate)).toEqual(['2026-10-01','2026-10-02']);expect(partial.spendChannelTrend.map(day=>day.storeDate)).toEqual(['2026-10-01','2026-10-02']);expect(closed.sources.some(source=>source.id==='closed-renewals:kind-patches:2026-10-08')).toBe(true);
});
it('preserves weekday and previous closed-day periods independently',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','overview','revenue',120),row('2026-10-06','overview','revenue',100),row('2026-09-30','overview','revenue',80)],[],filters);
 expect(e.closedPriorDay.current.storeDate).toBe('2026-10-07');expect(e.closedPriorDay.previousDay.storeDate).toBe('2026-10-06');expect(e.closedPriorDay.sameWeekday.storeDate).toBe('2026-09-30');
 expect(e.closedPriorDay.arithmetic.previousDay.revenueChange).toBeCloseTo(.2);expect(e.closedPriorDay.arithmetic.sameWeekday.revenueChange).toBeCloseTo(.5);
});

it('labels channel totals as incomplete observed-day totals when MTD dates are missing',()=>{const e=supplementalReviewEvidence(client,[row('2026-10-07','media','spend',50,{channel:'meta'})],[],filters);const mtd=e.channelMonthToDate.find(d=>d.dataset==='media')!;expect(mtd.from).toBe('2026-10-01');expect(mtd.to).toBe('2026-10-07');expect(mtd.fullElapsedDayCoverage).toBe(false);expect(mtd.missingDates).toContain('2026-10-01');expect(mtd.rows[0].metrics.spend).toBe(50);});

it('compresses hourly provenance without changing numeric totals, scopes, gaps or observation tallies',()=>{
 const hourly=Array.from({length:24},(_,hour)=>({...row('2026-10-07','media','spend',hour+1,{channel:'meta'}),sourceId:'hourly-media',definition:'store_hour_paid_spend',population:'paid_media',start:`2026-10-07T${String(hour).padStart(2,'0')}:00:00Z`,end:hour===23?'2026-10-08T00:00:00Z':`2026-10-07T${String(hour+1).padStart(2,'0')}:00:00Z`}));
 const compact=evidenceDetailRows(hourly),r=compact.rows[0],p=r.provenance[0];
 expect(r.metrics.spend).toBe(300);expect(r.summary.spend).toBe(300);expect(compact).toMatchObject({observationCount:24,returnedSegmentCount:1,returnedObservationCount:24,omittedObservationCount:0});
 expect(r.provenance).toHaveLength(1);expect(p).toMatchObject({date:'2026-10-07',dataset:'media',metric:'spend',sourceId:'hourly-media',definition:'store_hour_paid_spend',population:'paid_media',currency:client.currency,quality:'complete',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:'2026-10-09T04:00:00Z',observationCount:24,intervalObservationCount:24,withoutIntervalCount:0,observedIntervals:[{start:'2026-10-07T00:00:00Z',end:'2026-10-08T00:00:00Z',intervalCount:24,intervalMilliseconds:3600000}]});
 const legacy=hourly.map(e=>({date:e.date,start:e.start,end:e.end,sourceId:e.sourceId,definition:e.definition,population:e.population,currency:e.currency,retrievedAt:e.retrievedAt,coverageThrough:e.coverageThrough,quality:e.quality}));expect(JSON.stringify(r.provenance).length).toBeLessThan(JSON.stringify(legacy).length*.2);
 const gap=evidenceDetailRows(hourly.filter((_,i)=>i!==12)).rows[0].provenance[0];expect(gap.observedIntervals).toHaveLength(2);expect(gap.observationCount).toBe(23);expect(gap.observedIntervals[0].end).toBe('2026-10-07T12:00:00Z');expect(gap.observedIntervals[1].start).toBe('2026-10-07T13:00:00Z');
});
it('keeps partial quality and unknown coverage distinct from complete hourly evidence',()=>{
 const timed={...row('2026-10-07','media','spend',5,{channel:'meta'}),start:'2026-10-07T00:00:00Z',end:'2026-10-07T01:00:00Z'};
 const details=evidenceDetailRows([timed,{...timed,start:'2026-10-07T01:00:00Z',end:'2026-10-07T02:00:00Z',quality:'partial',coverageThrough:null}],80);
 expect(details.rows[0].provenance).toHaveLength(2);expect(details.rows[0].provenance.find(p=>p.quality==='partial')).toMatchObject({coverageThrough:null,observationCount:1});
});

it('keeps sparse funnel rollup bounds explicit with unknown continuity and counts the represented hourly observations',()=>{
 const accumulator=new FunnelRollupAccumulator({timezone:'UTC'}),base={...row('2026-10-07','funnels','sessions',10,{page:'/offer',market:'US'}),definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',start:'2026-10-07T00:00:00Z',end:'2026-10-07T01:00:00Z'};
 accumulator.add(base);accumulator.add({...base,value:7,start:'2026-10-07T04:00:00Z',end:'2026-10-07T05:00:00Z'});
 const rolled=accumulator.finish(),details=evidenceDetailRows(rolled),provenance=details.rows[0].provenance[0];
 expect(details.rows[0].metrics.sessions).toBe(17);expect(details).toMatchObject({storedObservationCount:1,observationCount:2,returnedStoredObservationCount:1,returnedObservationCount:2,omittedObservationCount:0});
 expect(provenance).toMatchObject({aggregation:'hourly_public_page_funnel_rollup',contributionCount:2,storedObservationCount:1,observationCount:2,intervalObservationCount:0,observedIntervals:[],contributedBounds:[{start:'2026-10-07T00:00:00Z',end:'2026-10-07T05:00:00Z',contributionCount:2,continuity:'unknown'}]});
 const mixed=evidenceDetailRows([...rolled,{...base,value:3,start:'2026-10-07T06:00:00Z',end:'2026-10-07T07:00:00Z'}]);
 expect(mixed.rows[0].metrics.sessions).toBe(20);expect(mixed.observationCount).toBe(3);expect(mixed.storedObservationCount).toBe(2);expect(mixed.rows[0].provenance).toHaveLength(2);expect(mixed.rows[0].provenance.reduce((sum,p)=>sum+p.observationCount,0)).toBe(mixed.observationCount);
 expect(mixed.rows[0].provenance.find(p=>!p.aggregation)?.observedIntervals).toEqual([{start:'2026-10-07T06:00:00Z',end:'2026-10-07T07:00:00Z',intervalCount:1,intervalMilliseconds:3600000}]);
});
it('keeps omitted rollup contribution counts coherent with the returned segment limit',()=>{
 const accumulator=new FunnelRollupAccumulator({timezone:'UTC'}),base={...row('2026-10-07','funnels','sessions',10,{page:'/offer',market:'US'}),definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions'};
 for(let hour=0;hour<3;hour++){const start=`2026-10-07T0${hour}:00:00Z`,end=`2026-10-07T0${hour+1}:00:00Z`;accumulator.add({...base,start,end});if(hour<2)accumulator.add({...base,value:1,dimensions:{page:'/other',market:'US'},start,end});}
 const details=evidenceDetailRows(accumulator.finish(),1);
 expect(details).toMatchObject({segmentCount:2,returnedSegmentCount:1,omitted:1,storedObservationCount:2,returnedStoredObservationCount:1,omittedStoredObservationCount:1,observationCount:5,returnedObservationCount:3,omittedObservationCount:2});
 expect(details.rows[0].provenance.reduce((sum,p)=>sum+p.observationCount,0)).toBe(details.returnedObservationCount);
});
