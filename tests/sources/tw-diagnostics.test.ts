import {expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import {normalizeTwDiagnostics,twDiagnosticsQueries} from '../../lib/sources/tw-diagnostics';
import {fetchKindSource,effectiveKindWindow} from '../../lib/sources/kind-fetch';
import {KIND_SOURCES,kindQualification,type Raw} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import type {Client,Connection} from '../../lib/analytics/contracts';
import {sourceDates} from '../../lib/sources/kind-patches';
import {validateConnection} from '../../lib/server/configuration';
const client=initial[0] as Client,date='2026-10-11',window={from:date,to:date},now=new Date('2026-10-12T12:00:00Z');
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
function fixture(){
 const base={event_date:date,shop_timezone:client.timezone},streams:Raw[]=[
  {...base,event_hour:10,is_subscription_order:1,is_first_order_in_subscription:1,tagged_recurring:0,row_count:2,orders:2,revenue:100,units:3},
  {...base,event_hour:11,is_subscription_order:0,is_first_order_in_subscription:0,tagged_recurring:0,row_count:3,orders:3,revenue:150,units:4},
  {...base,event_hour:12,is_subscription_order:null,is_first_order_in_subscription:null,tagged_recurring:0,row_count:1,orders:1,revenue:40,units:1},
  {...base,event_hour:13,is_subscription_order:1,is_first_order_in_subscription:0,tagged_recurring:1,row_count:2,orders:2,revenue:60,units:6}
 ],daily:Raw[]=[{...base,row_count:10,all_orders:10,all_revenue:500,all_units:30,web_orders:6,web_revenue:290,web_units:8,recurring_orders:2,recurring_revenue:60,recurring_units:6,recurring_flag_orders:2,recurring_refund_money:8,recurring_billed_revenue:80,orders_with_promo:1,revenue_with_promo:0,orders_without_promo:9,revenue_without_promo:500,promo_zero_orders:1,promo_cancelled_orders:1,promo_units:10,promo_cancelled_units:10}],currencies:Raw[]=[{...base,currency:'USD',row_count:1,renewal_orders:1,renewal_units:2,renewal_refund_money:3,renewal_billed_revenue:30},{...base,currency:'EUR',row_count:1,renewal_orders:1,renewal_units:4,renewal_refund_money:5,renewal_billed_revenue:50}];return {streams,daily,currencies};
}
it('separates first/one-time/unknown web orders from tagged renewals and exposes honest billed/refund and promo cohorts',()=>{
 const input=fixture(),batch=normalizeTwDiagnostics(input,client,window,now),sum=(metric:string,stream:string)=>batch.rows.filter(row=>row.dataset==='orderStreams'&&row.metric===metric&&row.dimensions.order_stream===stream).reduce((total,row)=>total+(row.value??0),0);
 expect(sum('orders','first_subscription')).toBe(2);expect(sum('orders','one_time')).toBe(3);expect(sum('orders','unclassified')).toBe(1);expect(sum('recurring_orders','recurring_renewal')).toBe(2);expect(sum('revenue','recurring_renewal')).toBe(0);
 expect(batch.rows.filter(row=>row.dataset==='renewalDiagnostics'&&row.metric==='renewal_refund_money').map(row=>[row.dimensions.reported_currency,row.currency,row.value])).toEqual([['USD','USD',3],['EUR','USD',5]]);
 expect(batch.rows.find(row=>row.dataset==='orderHygiene'&&row.metric==='promo_zero_orders')).toMatchObject({value:1,dimensions:{promo_code:'ONBRAND',store_date:date}});expect(batch.rows.find(row=>row.metric==='promo_cancelled_units')?.value).toBe(10);expect(batch.rows.every(row=>row.dimensions.store_date===row.date)).toBe(true);expect(batch.rows.some(row=>row.dataset==='overview'||row.dataset==='revenue')).toBe(false);
 const qualification=requireQualifiedSource(kindQualification(batch,'kind-triple-whale-diagnostics'),client);expect(validateRegisteredBatch(batch,qualification)).toBe(batch);expect(JSON.stringify(batch)).not.toContain('order_id');
});
it('measures whole-store AOV including ONBRAND against the store excluding that code, retaining code-only zero orders separately',()=>{
 const input=fixture();Object.assign(input.daily[0],{row_count:5774,all_orders:5774,all_revenue:148051.42254,all_units:30000,orders_with_promo:24,revenue_with_promo:0,orders_without_promo:5750,revenue_without_promo:148051.42254,promo_zero_orders:24,promo_cancelled_orders:21,promo_units:15700,promo_cancelled_units:14300});
 const batch=normalizeTwDiagnostics(input,client,window,now),value=(metric:string)=>batch.rows.find(row=>row.dataset==='orderHygiene'&&row.metric===metric)!.value!;
 expect(value('orders_with_promo')).toBe(5774);expect(value('revenue_with_promo')).toBe(148051.42254);expect(value('orders_without_promo')).toBe(5750);expect(value('promo_orders')).toBe(24);expect(value('promo_zero_orders')).toBe(24);expect(value('revenue_with_promo')/value('orders_with_promo')).toBeCloseTo(25.64105,5);expect(value('revenue_without_promo')/value('orders_without_promo')).toBeCloseTo(25.748073,5);
 expect(validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,'kind-triple-whale-diagnostics'),client))).toBe(batch);
});
it('rejects duplicate aggregates, repeated order rows, inconsistent stream totals and unconfirmed dates',()=>{
 for(const mutate of [(input:ReturnType<typeof fixture>)=>input.streams.push({...input.streams[0]}),(input:ReturnType<typeof fixture>)=>input.daily[0].row_count++,(input:ReturnType<typeof fixture>)=>input.streams[0].revenue++,(input:ReturnType<typeof fixture>)=>input.daily.splice(0)]){const input=fixture();mutate(input);expect(()=>normalizeTwDiagnostics(input,client,window,now)).toThrow();}
});
it('keeps missing web flags unclassified and fails inconsistent recurring flags instead of coercing unknown to false',()=>{
 const input=fixture();input.streams[3].is_subscription_order=null;expect(()=>normalizeTwDiagnostics(input,client,window,now)).toThrow('flags');const independent=fixture();independent.daily[0].recurring_flag_orders=1;expect(()=>normalizeTwDiagnostics(independent,client,window,now)).toThrow('flags');
});
it('reconciles renewal currency groups and promo complements while retaining valid zero-renewal days',()=>{
 const input=fixture();input.currencies[0].renewal_refund_money++;expect(()=>normalizeTwDiagnostics(input,client,window,now)).toThrow('reconcile');const promo=fixture();promo.daily[0].orders_without_promo--;expect(()=>normalizeTwDiagnostics(promo,client,window,now)).toThrow('reconcile');
 const empty=fixture();empty.streams=[];empty.currencies=[];for(const key of Object.keys(empty.daily[0]))if(!['event_date','shop_timezone'].includes(key))empty.daily[0][key]=0;const batch=normalizeTwDiagnostics(empty,client,window,now);expect(batch.rows.every(row=>row.value===0)).toBe(true);expect(batch.rows.filter(row=>row.dataset==='renewalDiagnostics')).toHaveLength(4);
});
it('checks store timezone and completed local hours and bounds the initial window to sixty days',()=>{
 const input=fixture();input.streams[0].shop_timezone='UTC';expect(()=>normalizeTwDiagnostics(input,client,window,now)).toThrow('timezone');const partial=fixture();for(const rows of Object.values(partial))for(const row of rows)row.event_date='2026-10-12';partial.streams[0].event_hour=14;expect(()=>normalizeTwDiagnostics(partial,client,{from:'2026-10-12',to:'2026-10-12'},now)).toThrow('hour');
 const source={provider:'kind-triple-whale-diagnostics'} as Connection;expect(effectiveKindWindow(source,client,{from:'2026-01-01',to:'2026-10-12'},now)).toEqual({from:'2026-08-14',to:'2026-10-12'});
});
it('uses only bounded server-side aggregate SQL and the verified fixed connection identity',async()=>{
 const input=fixture(),queries=twDiagnosticsQueries(client,window,now),source=KIND_SOURCES.find(source=>source.provider==='kind-triple-whale-diagnostics') as Connection,seen:string[]=[];
 expect(queries).toHaveLength(3);for(const query of queries){expect(query).toContain('LIMIT 50000');expect(query).toContain('COUNT(DISTINCT');expect(query).not.toMatch(/SELECT\s+(?:\*|order_id)/i);}const fetcher:typeof fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));expect(body.currency).toBe('USD');expect(body.period).toEqual({startDate:date,endDate:date});seen.push(body.query);return Response.json(body.query.includes('GROUP BY event_date,event_hour')?input.streams:body.query.includes('GROUP BY event_date,shop_timezone,currency')?input.currencies:input.daily);};
 const batch=await fetchKindSource(source,client,window,secret,fetcher,Date.now()+10000,now);expect(batch.rows.length).toBeGreaterThan(0);expect(seen).toHaveLength(3);
});
it('keeps a full sixty-day initial capture below the registered observation bound and preserves completed-hour partial data',()=>{
 const base=fixture(),range={from:'2026-08-13',to:'2026-10-11'},input={streams:[] as Raw[],daily:[] as Raw[],currencies:[] as Raw[]};for(const date of sourceDates(range))for(const key of ['streams','daily','currencies'] as const)input[key].push(...base[key].map(row=>({...row,event_date:date})));const batch=normalizeTwDiagnostics(input,client,range,now);expect(batch.rows.length).toBeLessThan(50000);expect(new Set(batch.rows.map(row=>row.date)).size).toBe(60);expect(validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,'kind-triple-whale-diagnostics'),client))).toBe(batch);
 const partial=fixture();for(const rows of Object.values(partial))for(const row of rows)row.event_date='2026-10-12';const current=normalizeTwDiagnostics(partial,client,{from:'2026-10-12',to:'2026-10-12'},now);expect(current.coverageThrough).toBe('2026-10-12T12:00:00Z');expect(current.rows.filter(row=>row.dataset==='orderStreams').every(row=>Date.parse(row.end!)<=Date.parse(current.coverageThrough!))).toBe(true);
});
it('registers only the fixed diagnostics endpoint and shared server credential identity',()=>{
 const def=KIND_SOURCES.find(source=>source.provider==='kind-triple-whale-diagnostics')!,input={...def,clientId:client.id,secretRef:'SOURCE_KIND_PATCHES_SCRIPT'};expect(validateConnection(input).provider).toBe(def.provider);expect(()=>validateConnection({...input,endpoint:'https://other.example.com'})).toThrow('identity');expect(()=>validateConnection({...input,secretRef:'SOURCE_OTHER'})).toThrow('identity');
});
