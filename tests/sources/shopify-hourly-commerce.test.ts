import {expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import {fetchShopifyHourlyCommerce,normalizeShopifyHourlyCommerce,shopifyHourlyCommerceQueries,shopifyCumulativeOrderQuery,type ShopifyCumulativeOrders} from '../../lib/sources/shopify-hourly-commerce';
import {kindQualification} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';

const client={...initial[0],version:1} as any,date='2026-10-13',w={from:date,to:date},now=new Date('2026-10-13T15:45:00Z');
const raw={day:date,sales_channel:'Online Store',net_sales:30,gross_sales:40,discounts:-7,returns:-3,orders:2};
const input={hourly:[{...raw,hour_of_day:2}],daily:[raw]};

it('queries identical store-hour scopes for channel and product revenue without changing definitions',async()=>{
 const q=shopifyHourlyCommerceQueries('sales',w,client.timezone,now);
 expect(q.hourly).toContain('WHERE hour_of_day < 17 GROUP BY day,hour_of_day,sales_channel');expect(q.daily).toContain('WHERE hour_of_day < 17 GROUP BY day,sales_channel');
 const queries:string[]=[];const batch=await fetchShopifyHourlyCommerce('sales',client,w,async query=>{queries.push(query);return query.includes('day,hour_of_day')?input.hourly:input.daily;},now);
 expect(queries).toEqual([q.hourly,q.daily]);expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');expect(batch.grain).toBe('hourly');
 expect(batch.rows.filter(row=>row.metric==='revenue').map(row=>row.value)).toEqual([0,0,30,...Array(14).fill(0)]);
 expect(batch.rows.find(row=>row.metric==='revenue'&&row.value===30)).toMatchObject({definition:'shopify_net_sales_all_channels',population:'shopify_sales',currency:'USD',dimensions:{stream:'Online Store'},start:'2026-10-13T00:00:00Z',end:'2026-10-13T01:00:00Z'});
 expect(batch.rows.find(row=>row.metric==='refunds'&&row.value!==0)?.value).toBe(3);
 const qualification=requireQualifiedSource(kindQualification(batch,'kind-shopify-sales'),client);expect(qualification.profiles.every(profile=>profile.hourly)).toBe(true);expect(()=>validateRegisteredBatch(batch,qualification)).not.toThrow();
});
it('preserves product order overlap while reconciling each product-channel group independently',()=>{
 const a={...raw,product_title_at_time_of_sale:'Dream Mag'},b={...raw,net_sales:20,gross_sales:20,discounts:0,returns:0,product_title_at_time_of_sale:'GLP'};
 const batch=normalizeShopifyHourlyCommerce('products',{hourly:[{...a,hour_of_day:2},{...b,hour_of_day:3}],daily:[a,b]},client,w,now);
 expect(batch.rows.filter(row=>row.metric==='orders').reduce((sum,row)=>sum+row.value!,0)).toBe(4);
 expect(batch.rows.every(row=>row.population==='shopify_product_sales'&&row.definition==='shopify_product_net_sales_orders_may_overlap')).toBe(true);
 expect(batch.dimensions).toEqual(['product','stream']);
 expect(()=>normalizeShopifyHourlyCommerce('products',{hourly:[{...a,hour_of_day:2},{...b,hour_of_day:3}],daily:[{...a,net_sales:31},{...b,net_sales:19}]},client,w,now)).toThrow(/reconcile/i);
});
it('deduplicates orders spanning multiple hours using independent cumulative period counts',async()=>{
 const repeated={hourly:[{...raw,hour_of_day:2},{...raw,hour_of_day:3,net_sales:10,gross_sales:10,discounts:0,returns:0,orders:1}],daily:[{...raw,net_sales:40,gross_sales:50}]};
 const cuts:ShopifyCumulativeOrders=Array.from({length:16},(_,index)=>({beforeHour:index+1,rows:index+1>2?[{day:date,sales_channel:raw.sales_channel,orders:2}]:[]}));
 expect(()=>normalizeShopifyHourlyCommerce('sales',repeated,client,w,now)).toThrow(/unique cumulative order cuts required/i);
 const batch=normalizeShopifyHourlyCommerce('sales',{...repeated,cumulativeOrders:cuts},client,w,now),orders=batch.rows.filter(row=>row.metric==='orders');
 expect(orders.map(row=>row.value)).toEqual([0,0,2,...Array(14).fill(0)]);expect(orders.reduce((sum,row)=>sum+row.value!,0)).toBe(2);
 expect(batch.rows.filter(row=>row.metric==='revenue').reduce((sum,row)=>sum+row.value!,0)).toBe(40);
 const queries:string[]=[];const fetched=await fetchShopifyHourlyCommerce('sales',client,w,async query=>{queries.push(query);if(query.includes('SHOW net_sales'))return query.includes('day,hour_of_day')?repeated.hourly:repeated.daily;const hour=Number(query.match(/hour_of_day < (\d+)/)![1]);return hour>2?[{day:date,sales_channel:raw.sales_channel,orders:2}]:[];},now);
 expect(fetched.rows.filter(row=>row.metric==='orders').reduce((sum,row)=>sum+row.value!,0)).toBe(2);expect(queries).toHaveLength(19);
 expect(queries.at(-1)).toBe(shopifyCumulativeOrderQuery('sales',date,17));
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...repeated,cumulativeOrders:cuts.slice(1)},client,w,now)).toThrow(/incomplete/i);
 const declining=cuts.map(cut=>cut.beforeHour===4?{...cut,rows:[{day:date,sales_channel:raw.sales_channel,orders:1}]}:cut);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...repeated,cumulativeOrders:declining},client,w,now)).toThrow(/monotonically/i);
});
it('rejects stale cumulative order cuts rather than claiming an exact cutoff after provider adjustments',async()=>{
 const repeated={hourly:[{...raw,hour_of_day:2},{...raw,hour_of_day:3,net_sales:0,gross_sales:0,discounts:0,returns:0,orders:1}],daily:[raw]};
 await expect(fetchShopifyHourlyCommerce('sales',client,w,async query=>{if(query.includes('SHOW net_sales'))return query.includes('day,hour_of_day')?repeated.hourly:repeated.daily;const hour=Number(query.match(/hour_of_day < (\d+)/)![1]);return hour>2?[{day:date,sales_channel:raw.sales_channel,orders:hour===17?3:2}]:[];},now)).rejects.toThrow(/provider updates/i);
});
it('rejects incomplete, duplicated, out-of-window and missing data before publishing zeros',()=>{
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,daily:[]},client,w,now)).toThrow(/missing a group/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,daily:[{...raw,orders:3}]},client,w,now)).toThrow(/orders.*reconcile/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,hourly:[...input.hourly,...input.hourly]},client,w,now)).toThrow(/duplicate/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,daily:[raw,raw]},client,w,now)).toThrow(/duplicate/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,hourly:[{...input.hourly[0],hour_of_day:17}]},client,w,now)).toThrow(/last complete/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,hourly:[{...input.hourly[0],day:'2026-10-12'}]},client,w,now)).toThrow(/outside/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,hourly:[{...input.hourly[0],orders:null}]},client,w,now)).toThrow(/missing/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{hourly:[],daily:[]},client,w,now)).toThrow(/no groups/i);
 expect(()=>normalizeShopifyHourlyCommerce('sales',{...input,hourly:Array(10000).fill(input.hourly[0])},client,w,now)).toThrow(/incomplete/i);
});
it('keeps historical full-day cuts complete and supports zero activity only with independent evidence',()=>{
 const q=shopifyHourlyCommerceQueries('sales',w,client.timezone,new Date('2026-10-14T10:00:00Z'));expect(q.hourly).not.toContain('WHERE');
 const batch=normalizeShopifyHourlyCommerce('sales',input,client,w,new Date('2026-10-14T10:00:00Z'));expect(batch.coverageThrough).toBe('2026-10-13T22:00:00Z');expect(batch.rows.filter(row=>row.metric==='orders')).toHaveLength(24);
 const zero={...raw,net_sales:0,gross_sales:0,discounts:0,returns:0,orders:0};expect(normalizeShopifyHourlyCommerce('sales',{hourly:[],daily:[zero]},client,w,now).rows.every(row=>row.value===0)).toBe(true);
 expect(()=>shopifyHourlyCommerceQueries('sales',{from:'2026-10-12',to:date},client.timezone,now)).toThrow(/one store day/i);
 expect(()=>shopifyHourlyCommerceQueries('sales',{from:'2026-10-15',to:'2026-10-15'},client.timezone,now)).toThrow(/beyond/i);
 expect(()=>shopifyHourlyCommerceQueries('sales',w,client.timezone,new Date('2026-10-12T22:15:00Z'))).toThrow(/first complete/i);
});
it('handles the repeated DST hour as one completed two-hour bucket and rejects skipped hours',()=>{
 const autumn='2026-10-25',spring='2026-03-29';
 const fixture=(day:string,hour_of_day:number)=>({hourly:[{...raw,day,hour_of_day}],daily:[{...raw,day}]});
 const repeated=normalizeShopifyHourlyCommerce('sales',fixture(autumn,2),client,{from:autumn,to:autumn},new Date('2026-10-26T12:00:00Z')).rows.find(row=>row.metric==='orders'&&row.value===2)!;
 expect(Date.parse(repeated.end!)-Date.parse(repeated.start!)).toBe(7200000);
 const partial=normalizeShopifyHourlyCommerce('sales',fixture(autumn,1),client,{from:autumn,to:autumn},new Date('2026-10-25T01:30:00Z'));expect(partial.coverageThrough).toBe('2026-10-25T00:00:00Z');expect(partial.rows.filter(row=>row.metric==='orders')).toHaveLength(2);
 const skipped=normalizeShopifyHourlyCommerce('sales',fixture(spring,3),client,{from:spring,to:spring},new Date('2026-03-30T12:00:00Z'));expect(skipped.rows.filter(row=>row.metric==='orders')).toHaveLength(23);
 expect(()=>normalizeShopifyHourlyCommerce('sales',fixture(spring,2),client,{from:spring,to:spring},new Date('2026-03-30T12:00:00Z'))).toThrow(/skipped/i);
});
