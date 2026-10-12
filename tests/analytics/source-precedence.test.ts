import {expect,it} from 'vitest';
import type {Observation} from '../../lib/analytics/contracts';
import {preferredObservations} from '../../lib/analytics/source-precedence';
it('uses reconciled closed public-page coverage despite hours with no traffic',()=>{
 const base={date:'2026-10-07',dataset:'funnels',metric:'sessions',definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/offer',market:'US'},quality:'complete',coverageThrough:'2026-10-08T00:00:00Z',retrievedAt:'2026-10-08T01:00:00Z'} as any;
 const old={...base,sourceId:'daily',value:8},fresh={...base,sourceId:'hourly',value:10,start:'2026-10-07T10:00:00Z',end:'2026-10-07T11:00:00Z'};
 expect(preferredObservations([old,fresh],{timezone:'UTC',partial:false})).toEqual([fresh]);
});
const daily={date:'2026-10-12',dataset:'overview',metric:'sessions',value:100,definition:'shopify_human_sessions',population:'human_online_store_sessions',currency:null,dimensions:{},sourceId:'daily',retrievedAt:'2026-10-12T10:00:00Z',coverageThrough:'2026-10-12T22:00:00Z',quality:'complete'} as Observation;
const hourly={...daily,value:10,sourceId:'hourly',start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z',coverageThrough:'2026-10-11T23:00:00Z'};
it('retains full daily Shopify authority when only a partial hourly population is available',()=>{
 expect(preferredObservations([daily,hourly],{timezone:'Europe/Stockholm'})).toEqual([daily]);
 expect(preferredObservations([{...daily,quality:'historical'},hourly],{timezone:'Europe/Stockholm'})).toEqual([{...daily,quality:'historical'}]);
});
it('uses hourly Shopify counts for a partial selection without adding the corresponding daily totals',()=>{
 expect(preferredObservations([daily,hourly],{timezone:'Europe/Stockholm',partial:true})).toEqual([hourly]);
 const other={...daily,population:'bot_sessions'};expect(preferredObservations([other,hourly],{timezone:'Europe/Stockholm',partial:true})).toEqual([other,hourly]);
 const history={...other,quality:'historical'} as Observation;expect(preferredObservations([history,hourly],{timezone:'Europe/Stockholm',partial:true})).toEqual([history,hourly]);
});
it('uses complete hourly Shopify authority only after its store-day intervals cover the whole day',()=>{
 const full={...hourly,end:'2026-10-12T22:00:00Z',coverageThrough:'2026-10-12T22:00:00Z'};
 expect(preferredObservations([daily,full],{timezone:'Europe/Stockholm'})).toEqual([full]);
 const gap=[hourly,{...hourly,start:'2026-10-12T00:00:00Z',end:'2026-10-12T22:00:00Z',coverageThrough:'2026-10-12T22:00:00Z'}];
 expect(preferredObservations([daily,...gap],{timezone:'Europe/Stockholm'})).toEqual([daily]);
 expect(preferredObservations([daily,full],{})).toEqual([daily]);
 expect(preferredObservations([daily,hourly])).toEqual([daily,hourly]);
});
it('deduplicates repeated qualified Shopify intervals by latest retrieval while keeping differing populations',()=>{
 const fresh={...hourly,retrievedAt:'2026-10-12T11:00:00Z',value:12},other={...hourly,population:'other'};
 expect(preferredObservations([hourly,fresh,other],{partial:true,timezone:'Europe/Stockholm'})).toEqual([fresh,other]);
});
it('leaves daily commerce and media authority separate from the Shopify session family',()=>{
 const commerce={...daily,metric:'revenue',definition:'web_nonrecurring_excl_tax_shipping',population:'web_nonrecurring'};
 expect(preferredObservations([commerce,hourly],{partial:true,timezone:'Europe/Stockholm'})).toEqual([commerce,hourly]);
});
