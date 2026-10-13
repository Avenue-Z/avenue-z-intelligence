import {expect,it} from 'vitest';
import {hourlyTrafficQueries,normalizeHourlyTraffic,HOURLY_TRAFFIC_GROUP_LIMIT} from '../../lib/sources/shopify-hourly-traffic';
import initial from '../../data/initial-clients.json';
import type {Client} from '../../lib/analytics/contracts';
const client=initial[0] as Client,date='2026-10-13',window={from:date,to:date},now=new Date('2026-10-13T15:45:00Z'); // 17:45 Stockholm
const counts={sessions:100,sessions_with_cart_additions:20,sessions_that_reached_checkout:10,sessions_that_completed_checkout:5};
const row={day:date,hour_of_day:16,landing_page_path:'/pages/glp?email=private',session_country:'United States',session_device_type:'Mobile',referrer_source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'Fall',...counts};
const input={detail:[row],hourly:[{day:date,hour_of_day:16,...counts}],daily:[{day:date,...counts}]};

it('preserves exact public traffic dimensions with real hourly intervals through the last full store hour',()=>{
 const batch=normalizeHourlyTraffic(input,client,window,now);
 expect(batch.rows).toHaveLength(5);expect(batch.grain).toBe('hourly');expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');
 expect(batch.rows.find(r=>r.metric==='sessions')).toMatchObject({dataset:'traffic',value:100,start:'2026-10-13T14:00:00Z',end:'2026-10-13T15:00:00Z',dimensions:{page:'/pages/glp',market:'US',device:'Mobile',source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'Fall'},definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',currency:null});
 expect(batch.rows.find(r=>r.metric==='completed_checkouts')?.value).toBe(5);
});
it('builds three identically filtered, bounded public-page queries with hourly detail and independent authorities',()=>{
 const queries=hourlyTrafficQueries(date,client.timezone,now);
 expect(queries.detail).toContain('GROUP BY day,hour_of_day,landing_page_path,session_country,session_device_type,referrer_source,utm_source,utm_medium,utm_campaign');
 expect(queries.hourly).toContain('GROUP BY day,hour_of_day SINCE');expect(queries.daily).toContain('GROUP BY day SINCE');
 for(const query of Object.values(queries)){expect(query).toContain('hour_of_day < 17');expect(query).toContain("human_or_bot_session = 'human'");expect(query).toContain("landing_page_path NOT STARTS WITH '/tools/recurring'");expect(query).toContain(`LIMIT ${HOURLY_TRAFFIC_GROUP_LIMIT+1}`);}
 for(const query of Object.values(hourlyTrafficQueries('2026-10-12',client.timezone,now)))expect(query).not.toContain('hour_of_day <');
 expect(()=>hourlyTrafficQueries('2026-10-14',client.timezone,new Date('2026-10-13T22:45:00Z'))).toThrow('first complete store hour');
});
it('rejects unclosed, malformed, duplicate, negative, mismatched and incomplete hourly detail before publication',()=>{
 expect(()=>normalizeHourlyTraffic({...input,detail:[{...row,hour_of_day:17}]},client,window,now)).toThrow('last full store hour');
 expect(()=>normalizeHourlyTraffic({...input,detail:[{...row,hour_of_day:null}]},client,window,now)).toThrow('hour');
 expect(()=>normalizeHourlyTraffic({...input,detail:[row,row]},client,window,now)).toThrow('Duplicate');
 expect(()=>normalizeHourlyTraffic({...input,hourly:[...input.hourly,...input.hourly]},client,window,now)).toThrow('Duplicate');
 expect(()=>normalizeHourlyTraffic({...input,detail:[{...row,sessions:-1}]},client,window,now)).toThrow('count');
 expect(()=>normalizeHourlyTraffic({...input,daily:[]},client,window,now)).toThrow('independent daily');
 expect(()=>normalizeHourlyTraffic({...input,hourly:[{...input.hourly[0],sessions:101}]},client,window,now)).toThrow('reconcile');
 expect(()=>normalizeHourlyTraffic({...input,daily:[{...input.daily[0],sessions:101}]},client,window,now)).toThrow('reconcile');
 expect(()=>normalizeHourlyTraffic({...input,detail:Array(HOURLY_TRAFFIC_GROUP_LIMIT+1).fill(row)},client,window,now)).toThrow('row limit');
});
it('requires hourly reconciliation even when whole-day counts still match',()=>{
 const detail=[row,{...row,hour_of_day:15}],hourly=[{day:date,hour_of_day:16,...counts,sessions:90},{day:date,hour_of_day:15,...counts,sessions:110}],daily=[{day:date,...Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n*2]))}];
 expect(()=>normalizeHourlyTraffic({detail,hourly,daily},client,window,now)).toThrow('reconcile');
});
it('redacts attribution and merges equivalent private labels only within the same hour without dropping counts',()=>{
 const detail=[{...row,utm_campaign:'person@example.com'},{...row,utm_campaign:'another@example.com',landing_page_path:'/pages/glp?customer=private'}],double=Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n*2]));
 const batch=normalizeHourlyTraffic({detail,hourly:[{day:date,hour_of_day:16,...double}],daily:[{day:date,...double}]},client,window,now);
 expect(batch.rows).toHaveLength(5);expect(batch.rows[0]).toMatchObject({value:200,dimensions:{utm_campaign:'[private]',page:'/pages/glp'}});
 expect(()=>normalizeHourlyTraffic({...input,detail:[{...row,landing_page_path:'/checkout/private'}]},client,window,now)).toThrow('Private landing page');
});
it('keeps a confirmed zero day empty instead of inventing dimensional zero rows',()=>{
 const batch=normalizeHourlyTraffic({detail:[],hourly:[],daily:[{day:date,...Object.fromEntries(Object.keys(counts).map(key=>[key,0]))}]},client,window,now);
 expect(batch.rows).toEqual([]);expect(batch.dimensions).toHaveLength(7);expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');
 expect(()=>normalizeHourlyTraffic({...input,daily:[]},client,window,now)).toThrow();
});
it('preserves the full 2-hour repeated DST bucket and rejects nonexistent spring hours',()=>{
 const setup=(day:string,hour:number)=>({detail:[{...row,day,hour_of_day:hour}],hourly:[{day,hour_of_day:hour,...counts}],daily:[{day,...counts}]});
 const fall='2026-10-25',batch=normalizeHourlyTraffic(setup(fall,2),client,{from:fall,to:fall},new Date('2026-10-26T12:00:00Z'));
 expect(Date.parse(batch.rows[0].end!)-Date.parse(batch.rows[0].start!)).toBe(7200000);
 const spring='2026-03-29';expect(()=>normalizeHourlyTraffic(setup(spring,2),client,{from:spring,to:spring},new Date('2026-03-30T12:00:00Z'))).toThrow('skipped local hour');
 expect(()=>normalizeHourlyTraffic(setup(fall,2),client,{from:fall,to:fall},new Date('2026-10-25T01:30:00Z'))).toThrow('last full store hour');
});
it('accepts more than the old 9,999 daily groups without relaxing non-traffic source bounds',()=>{
 const detail=Array.from({length:12666},(_,i)=>({...row,utm_campaign:`campaign ${i}`})),totals=Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n*detail.length]));
 const batch=normalizeHourlyTraffic({detail,hourly:[{day:date,hour_of_day:16,...totals}],daily:[{day:date,...totals}]},client,window,now);
 expect(batch.rows).toHaveLength(63330);expect(batch.rows.filter(r=>r.metric==='sessions').reduce((sum,r)=>sum+r.value!,0)).toBe(1266600);
});
