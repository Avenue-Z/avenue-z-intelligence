import {expect,it} from 'vitest';
import {normalizeTwHourlyMarkets} from '../../lib/sources/tw-hourly-markets';
import {effectiveKindWindow,kindSourceDates,fetchKindSource} from '../../lib/sources/kind-fetch';
import {kindQualification,KIND_SOURCES} from '../../lib/sources/kind-patches';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
const client={...initial[0],version:1} as any,date='2026-10-13',w={from:date,to:date},now=new Date('2026-10-13T15:35:00Z');
const core={event_date:date,event_hour:2,revenue:40,orders:2,new_orders:1},country={...core,billing_country_code:'GB'},input={hourly:[country],daily:[{event_date:date,billing_country_code:'GB',revenue:40,orders:2,new_orders:1}],commerceHourly:[core]};
it('retains the exact web nonrecurring cohort with independently confirmed hourly market zeros',()=>{
 const rows=normalizeTwHourlyMarkets(input,client,w,'2026-10-13T15:00:00Z');
 expect(rows.filter(row=>row.metric==='revenue')).toHaveLength(17);expect(rows.filter(row=>row.metric==='revenue').reduce((sum,row)=>sum+row.value!,0)).toBe(40);
 expect(rows.find(row=>row.metric==='revenue'&&row.value===40)).toMatchObject({population:'web_nonrecurring',definition:'web_nonrecurring_excl_tax_shipping',currency:'USD',dimensions:{market:'UK'},start:'2026-10-13T00:00:00Z',end:'2026-10-13T01:00:00Z'});
 expect(rows.every(row=>Date.parse(row.end!)<=Date.parse('2026-10-13T15:00:00Z'))).toBe(true);
});
it('checks hourly markets against their independent day aggregate and the headline cohort before publishing',()=>{
 expect(()=>normalizeTwHourlyMarkets({...input,daily:[{...input.daily[0],orders:3}]},client,w,'2026-10-13T15:00:00Z')).toThrow(/reconcile/i);
 expect(()=>normalizeTwHourlyMarkets({...input,commerceHourly:[{...core,new_orders:2}]},client,w,'2026-10-13T15:00:00Z')).toThrow(/reconcile/i);
 expect(()=>normalizeTwHourlyMarkets({...input,hourly:[country,country]},client,w,'2026-10-13T15:00:00Z')).toThrow(/duplicate/i);
 expect(()=>normalizeTwHourlyMarkets({...input,daily:[]},client,w,'2026-10-13T15:00:00Z')).toThrow(/missing/i);
});
it('collapses documented country aliases without inventing or duplicating orders',()=>{
 const split={hourly:[{...country,revenue:10,orders:1,new_orders:0},{...country,billing_country_code:'UK',revenue:30,orders:1,new_orders:1}],daily:[{event_date:date,billing_country_code:'GB',revenue:10,orders:1,new_orders:0},{event_date:date,billing_country_code:'UK',revenue:30,orders:1,new_orders:1}],commerceHourly:[core]};
 expect(normalizeTwHourlyMarkets(split,client,w,'2026-10-13T15:00:00Z').filter(row=>row.metric==='orders').reduce((sum,row)=>sum+row.value!,0)).toBe(2);
});
it('refreshes today and all supported benchmark cuts without capping explicit historical one-day requests',()=>{
 const sales=KIND_SOURCES[1] as any;
 expect(kindSourceDates(sales,client,{from:'2026-10-07',to:date},now)).toEqual([date,'2026-10-12','2026-10-06','2026-09-15','2026-09-13']);
 expect(effectiveKindWindow(KIND_SOURCES[3] as any,client,{from:'2026-08-13',to:'2026-08-13'},now)).toEqual({from:'2026-08-13',to:'2026-08-13'});
 expect(kindSourceDates(KIND_SOURCES[3] as any,client,{from:'2026-08-13',to:'2026-08-13'},now)).toEqual(['2026-08-13']);
 expect(kindSourceDates(KIND_SOURCES[10] as any,client,{from:'2026-10-07',to:date},now)).toEqual([date]);
 expect(kindSourceDates(KIND_SOURCES[5] as any,client,{from:'2026-10-07',to:date},now)).toEqual([date,'2026-10-12','2026-10-06','2026-09-15']);
 expect(effectiveKindWindow(sales,client,{from:'2026-10-12',to:date},new Date('2026-10-12T22:35:00Z')).to).toBe('2026-10-12');
});
it.each(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'])('%s refreshes the last completed store day during the first calendar hour',provider=>{
 const source={provider} as any,current={from:'2026-10-14',to:'2026-10-14'};
 const midnight=new Date('2026-10-13T22:35:00Z');
 expect(effectiveKindWindow(source,client,current,midnight)).toEqual({from:'2026-10-13',to:'2026-10-13'});
 expect(kindSourceDates(source,client,current,midnight)).toEqual(['2026-10-13']);
 expect(effectiveKindWindow(source,client,current,new Date('2026-10-13T23:00:00Z'))).toEqual(current);
 expect(effectiveKindWindow(source,client,{from:'2026-10-12',to:'2026-10-12'},midnight)).toEqual({from:'2026-10-12',to:'2026-10-12'});
});
it.each(['current','closed'])('wires %s country-hour queries into the provider source and qualified contract',async period=>{
 const requestedDate=period==='closed'?'2026-10-07':date,window={from:requestedDate,to:requestedDate},sourceInput={hourly:input.hourly.map(row=>({...row,event_date:requestedDate})),daily:input.daily.map(row=>({...row,event_date:requestedDate}))},commerce={...core,event_date:requestedDate};
 const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'}),queries:string[]=[];
 const fetcher:typeof fetch=async(_url,options)=>{const request=JSON.parse(String(options?.body)),query=request.query;queries.push(query);expect(request.period).toEqual({startDate:requestedDate,endDate:requestedDate});const rows=query.includes('billing_country_code')?(query.includes('GROUP BY event_date,event_hour')?sourceInput.hourly:sourceInput.daily):query.includes('Subscription Recurring Order')&&query.includes(' AS recurring_revenue')?[]:query.includes('ads_table')?[{event_date:requestedDate,...query.includes('event_hour,channel')?{event_hour:2}:{},channel:'facebook-ads',spend:10}]:[{...commerce,...query.includes('GROUP BY event_date,event_hour')?{shop_timezone:client.timezone}:{event_hour:undefined}}];return Response.json(rows);};
 const batch=await fetchKindSource(KIND_SOURCES[0] as any,client,window,secret,fetcher,Date.now()+180000,now);
 expect(queries).toHaveLength(7);expect(queries.some(query=>query.includes('GROUP BY event_date,event_hour,billing_country_code'))).toBe(true);
 const qualification=kindQualification(batch,'kind-triple-whale');expect(qualification.profiles.filter(profile=>profile.dataset==='markets').every(profile=>profile.hourly)).toBe(true);expect(()=>validateRegisteredBatch(batch,qualification)).not.toThrow();
 expect(batch.rows.filter(row=>row.dataset==='markets'&&row.metric==='orders').reduce((sum,row)=>sum+row.value!,0)).toBe(2);
 expect(batch.rows.every(row=>row.date===requestedDate)).toBe(true);expect(batch.rows.filter(row=>row.dataset==='markets'&&row.metric==='orders')).toHaveLength(period==='closed'?24:3);
 if(period==='closed')expect(batch).toMatchObject({complete:true,grain:'hourly',coverageThrough:'2026-10-07T22:00:00Z'});
});
