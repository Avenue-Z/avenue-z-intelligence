import {expect,it} from 'vitest';
import type {Observation} from '../../lib/analytics/contracts';
import {FunnelRollupAccumulator} from '../../lib/analytics/funnel-rollup';

const row={date:'2026-10-12',dataset:'funnels',metric:'sessions',value:10,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/pages/glp',market:'US'},sourceId:'shopify-hourly',retrievedAt:'2026-10-12T08:10:00Z',coverageThrough:'2026-10-12T14:00:00Z',quality:'complete',start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'} as Observation;
function compact(rows:Observation[],options={timezone:'Europe/Stockholm'} as {timezone:string;cutoffClock?:string}){const a=new FunnelRollupAccumulator(options);for(const r of rows)a.add(r);return a.finish();}

it('sums exact contributed counts and bounds without manufacturing gap or day coverage',()=>{
 const later={...row,value:7,start:'2026-10-12T02:00:00Z',end:'2026-10-12T03:00:00Z',retrievedAt:'2026-10-12T08:20:00Z'};
 const result=compact([later,row]);
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({value:17,start:'2026-10-11T22:00:00Z',end:'2026-10-12T03:00:00Z',contributionCount:2,aggregation:'hourly_public_page_funnel_rollup',sourceId:'shopify-hourly',coverageThrough:'2026-10-12T14:00:00Z',retrievedAt:'2026-10-12T08:20:00Z'});
 expect(row.value).toBe(10);expect(later.start).toBe('2026-10-12T02:00:00Z');expect(compact([])).toEqual([]);
});
it('applies the same store clock to each comparison date before summing',()=>{
 const current={...row,start:'2026-10-12T02:00:00Z',end:'2026-10-12T03:00:00Z'};
 const currentLate={...current,value:90,start:'2026-10-12T03:00:00Z',end:'2026-10-12T04:00:00Z'};
 const prior={...current,date:'2026-10-11',value:7,start:'2026-10-11T02:00:00Z',end:'2026-10-11T03:00:00Z'};
 const priorLate={...prior,value:80,start:'2026-10-11T03:00:00Z',end:'2026-10-11T04:00:00Z'};
 const result=compact([current,currentLate,prior,priorLate],{timezone:'Europe/Stockholm',cutoffClock:'05:00'});
 expect(result.map(r=>[r.date,r.value,r.end,r.contributionCount])).toEqual([['2026-10-12',10,'2026-10-12T03:00:00Z',1],['2026-10-11',7,'2026-10-11T03:00:00Z',1]]);
});
it('matches DST wall clocks and keeps a repeated-hour bucket indivisible',()=>{
 const autumn={...row,date:'2026-10-25',value:12,start:'2026-10-25T00:00:00Z',end:'2026-10-25T02:00:00Z',coverageThrough:'2026-10-25T03:00:00Z'};
 const prior={...autumn,date:'2026-10-24',value:8,start:'2026-10-24T00:00:00Z',end:'2026-10-24T01:00:00Z'};
 const late={...autumn,value:99,start:'2026-10-25T02:00:00Z',end:'2026-10-25T03:00:00Z'};
 expect(compact([autumn,prior,late],{timezone:'Europe/Stockholm',cutoffClock:'03:00'}).map(r=>[r.date,r.value,r.end])).toEqual([['2026-10-25',12,'2026-10-25T02:00:00Z'],['2026-10-24',8,'2026-10-24T01:00:00Z']]);
 expect(compact([autumn],{timezone:'Europe/Stockholm',cutoffClock:'02:00'})).toEqual([]);
 const spring={...row,date:'2026-03-29',value:4,start:'2026-03-29T00:00:00Z',end:'2026-03-29T01:00:00Z',coverageThrough:'2026-03-29T03:00:00Z'};
 const springPrior={...spring,date:'2026-03-28',value:3,start:'2026-03-28T00:00:00Z',end:'2026-03-28T01:00:00Z'};
 expect(compact([spring,springPrior],{timezone:'Europe/Stockholm',cutoffClock:'02:00'}).map(r=>r.value)).toEqual([4,3]);
});
it('isolates sources, dimensions, metrics and coverage while preserving null counts',()=>{
 const nullable={...row,value:null,start:'2026-10-11T23:00:00Z',end:'2026-10-12T00:00:00Z'};
 const variants=[{...row,sourceId:'other-source',value:2},{...row,dimensions:{...row.dimensions,market:'CA'},value:3},{...row,metric:'atc_sessions',value:4},{...row,coverageThrough:'2026-10-12T13:00:00Z',value:5},{...row,currency:'USD',value:6}];
 const result=compact([row,nullable,...variants]);expect(result).toHaveLength(6);expect(result[0].value).toBeNull();expect(result[0].contributionCount).toBe(2);expect(result.slice(1).map(r=>r.value)).toEqual([2,3,4,5,6]);
});
it('passes uncertain coverage, grains, populations and other datasets through unchanged',()=>{
 const raw=[{...row,coverageThrough:null},{...row,start:undefined,end:undefined},{...row,population:'unverified_humans'},{...row,quality:'partial' as const},{...row,dataset:'overview'},{...row,dataset:'media'},{...row,dataset:'subscriptions'},{...row,metric:'reported_conversion_rate',value:.1},{...row,start:'2026-10-11T22:30:00Z'},{...row,end:'2026-10-12T00:00:00Z'},{...row,sourceId:''},{...row,dimensions:{page:'/pages/glp',market:'US',device:'mobile'}}];
 const result=compact(raw,{timezone:'Europe/Stockholm',cutoffClock:'00:00'});expect(result).toEqual(raw);for(let i=0;i<raw.length;i++)expect(result[i]).toBe(raw[i]);
});
it('preserves raw input when a requested cutoff clock is unknown or invalid',()=>{
 expect(compact([row],{timezone:'Europe/Stockholm',cutoffClock:'unknown'})).toEqual([row]);
 expect(compact([row],{timezone:'Europe/Stockholm',cutoffClock:''})).toEqual([row]);
});
