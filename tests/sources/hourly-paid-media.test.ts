import {expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import {metaHourlyDefinition,appLovinHourlyDefinition,normalizeMetaHourlyPerformance,normalizeAppLovinHourlySpend,fetchMetaHourlyPerformance,fetchAppLovinHourlySpend,appLovinUTCWindow} from '../../lib/sources/hourly-paid-media';
const client={...initial[0],version:1} as any,date='2026-10-13',w={from:date,to:date},now=new Date('2026-10-13T15:45:00Z');
const config={META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_ACCESS_TOKEN:'private',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private'} as any;
const hour='02:00:00 - 02:59:59',ad={date_start:date,date_stop:date,hourly_stats_aggregated_by_advertiser_time_zone:hour,ad_id:'1',ad_name:'GLP',campaign_id:'10',campaign_name:'Prospecting',spend:'20',impressions:'1000',clicks:'30',actions:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'3'},{action_type:'purchase',value:'4'}],action_values:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'100'}]},account={date_start:date,date_stop:date,hourly_stats_aggregated_by_advertiser_time_zone:hour,spend:'20',impressions:'1000',clicks:'30'};
it('normalizes actual Meta per-ad hourly values at the last completed store hour and preserves attribution',()=>{
 const unfinished={...ad,hourly_stats_aggregated_by_advertiser_time_zone:'17:00:00 - 17:59:59',spend:'40'};
 const batch=normalizeMetaHourlyPerformance({ads:[ad,unfinished],account:[account,{...account,hourly_stats_aggregated_by_advertiser_time_zone:unfinished.hourly_stats_aggregated_by_advertiser_time_zone,spend:'40'}]},client,w,now);
 expect(batch.grain).toBe('hourly');expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');expect(batch.rows).toHaveLength(5);
 expect(batch.rows.find(row=>row.metric==='meta_ad_pixel_purchases')).toMatchObject({value:3,definition:metaHourlyDefinition,date,start:'2026-10-13T00:00:00Z',end:'2026-10-13T01:00:00Z',dimensions:{attribution:'account',reporting_timezone:'Europe/Stockholm'}});
 expect(batch.rows.some(row=>row.metric==='spend'||row.metric==='revenue')).toBe(false);
 const unknown=normalizeMetaHourlyPerformance({ads:[{...ad,actions:undefined,action_values:undefined}],account:[account]},client,w,now);expect(unknown.rows.find(row=>row.metric==='meta_ad_pixel_purchases')?.value).toBeNull();
});
it('rejects duplicate Meta hours, changed dates, malformed hours and non-reconciled account delivery',()=>{
 expect(()=>normalizeMetaHourlyPerformance({ads:[ad,ad],account:[account]},client,w,now)).toThrow(/duplicate/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[ad],account:[{...account,clicks:'31'}]},client,w,now)).toThrow(/reconcile/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[{...ad,date_stop:'2026-10-12'}],account:[account]},client,w,now)).toThrow(/window/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[{...ad,hourly_stats_aggregated_by_advertiser_time_zone:'02:00:00 - 03:59:59'}],account:[account]},client,w,now)).toThrow(/hour/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[ad],account:[]},client,w,now)).toThrow(/reconcile/i);
});
it('accounts for bounded per-ad penny rounding while rejecting real spend discrepancies',()=>{
 const ads=Array.from({length:10},(_,i)=>({...ad,ad_id:String(i+1),spend:'1.01'})),totals={...account,spend:'10.06',impressions:'10000',clicks:'300'};
 expect(()=>normalizeMetaHourlyPerformance({ads,account:[totals]},client,w,now)).not.toThrow();
 expect(()=>normalizeMetaHourlyPerformance({ads,account:[{...totals,spend:'10.00'}]},client,w,now)).toThrow(/reconcile/i);
});
it('retains action-only ad hours and supports a fully reconciled report above the ordinary 50,000 observation cap',()=>{
 const onlyAction={...ad,spend:0,impressions:0,clicks:0,actions:[{action_type:'offsite_conversion.fb_pixel_purchase',value:2}]};
 const actionBatch=normalizeMetaHourlyPerformance({ads:[onlyAction],account:[{...account,spend:0,impressions:0,clicks:0}]},client,w,now);expect(actionBatch.rows.find(row=>row.metric==='meta_ad_pixel_purchases')?.value).toBe(2);
 const ads=Array.from({length:10001},(_,index)=>({...ad,ad_id:String(index+1)})),totals={...account,spend:200020,impressions:10001000,clicks:300030};
 const expanded=normalizeMetaHourlyPerformance({ads,account:[totals]},client,w,now);expect(expanded.rows).toHaveLength(50005);expect(expanded.rows.filter(row=>row.metric==='meta_ad_pixel_purchases').reduce((sum,row)=>sum+row.value!,0)).toBe(30003);
});
it('accepts omitted conversion-only delivery counts only when independent account counts prove zero',()=>{
 const onlyAction={...ad,spend:0,impressions:undefined,clicks:undefined},zero={...account,spend:0,impressions:0,clicks:0};
 const batch=normalizeMetaHourlyPerformance({ads:[onlyAction],account:[zero]},client,w,now);expect(batch.rows.find(row=>row.metric==='meta_ad_clicks')?.value).toBe(0);expect(batch.rows.find(row=>row.metric==='meta_ad_pixel_purchases')?.value).toBe(3);
 expect(()=>normalizeMetaHourlyPerformance({ads:[onlyAction],account:[{...zero,clicks:1}]},client,w,now)).toThrow(/reconcile/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[{...onlyAction,clicks:null}],account:[zero]},client,w,now)).toThrow(/missing/i);
});
it('bounds independent live report revisions at 0.1% while retaining exact historical delivery reconciliation',()=>{
 const large={...ad,impressions:10000,clicks:2000},revised={...account,impressions:10010,clicks:2002};
 expect(()=>normalizeMetaHourlyPerformance({ads:[large],account:[revised]},client,w,now)).not.toThrow();
 expect(()=>normalizeMetaHourlyPerformance({ads:[large],account:[{...revised,impressions:10011}]},client,w,now)).toThrow(/reconcile/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[large],account:[revised]},client,w,new Date('2026-10-14T10:00:00Z'))).toThrow(/reconcile/i);
});
it('maps AppLovin UTC hours across midnight into the selected store day and independently reconciles spend',()=>{
 const hourly=[{day:'2026-10-12',hour:'21:00',campaign:'GLP',campaign_id_external:'1',country:'US',cost:'99'},{day:'2026-10-12',hour:'22:00',campaign:'GLP',campaign_id_external:'1',country:'US',cost:'10'},{day:date,hour:'14:00',campaign:'Dream',campaign_id_external:'2',country:'GB',cost:'20'},{day:date,hour:'15:00',campaign:'Dream',campaign_id_external:'2',country:'GB',cost:'50'}],totals=hourly.map(({day,hour,cost})=>({day,hour,cost}));
 const batch=normalizeAppLovinHourlySpend({hourly,totals},client,w,now);expect(batch.rows).toHaveLength(2);expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');expect(batch.rows.map(row=>row.value)).toEqual([10,20]);
 expect(batch.rows[0]).toMatchObject({date,metric:'platform_spend',definition:appLovinHourlyDefinition,start:'2026-10-12T22:00:00Z',end:'2026-10-12T23:00:00Z',dimensions:{channel:'applovin',reporting_timezone:'UTC',market:'US'}});expect(batch.rows[1].dimensions.market).toBe('UK');
 expect(()=>normalizeAppLovinHourlySpend({hourly,totals:totals.map(row=>row.hour==='14:00'?{...row,cost:21}:row)},client,w,now)).toThrow(/reconcile/i);
 expect(()=>normalizeAppLovinHourlySpend({hourly:[...hourly,hourly[1]],totals},client,w,now)).toThrow(/duplicate/i);
 expect(appLovinUTCWindow(client,w,now)).toMatchObject({from:'2026-10-12',to:date,through:'2026-10-13T15:00:00Z'});
});
it('preserves both UTC hours in a repeated store hour and excludes a still-open repeated Meta bucket',()=>{
 const day='2026-10-25',historical=new Date('2026-10-26T12:00:00Z'),hours=[{day,hour:'00:00',campaign:'GLP',campaign_id_external:'1',country:'US',cost:10},{day,hour:'01:00',campaign:'GLP',campaign_id_external:'1',country:'US',cost:20}];
 const batch=normalizeAppLovinHourlySpend({hourly:hours,totals:hours.map(({day,hour,cost})=>({day,hour,cost}))},client,{from:day,to:day},historical);expect(batch.rows).toHaveLength(2);expect(batch.rows[0].start).not.toBe(batch.rows[1].start);
 const meta=normalizeMetaHourlyPerformance({ads:[{...ad,date_start:day,date_stop:day}],account:[{...account,date_start:day,date_stop:day}]},client,{from:day,to:day},new Date('2026-10-25T01:30:00Z'));expect(meta.rows).toHaveLength(0);expect(meta.coverageThrough).toBe('2026-10-25T00:00:00Z');
});
it('uses bound authenticated provider endpoints, complete pagination and independent hour totals',async()=>{
 const calls:URL[]=[];const metaFetcher:typeof fetch=async (url,options)=>{const u=new URL(String(url));calls.push(u);expect(u.hostname).toBe('graph.facebook.com');if(options?.method==='POST'){const body=options.body as URLSearchParams;expect(body.get('breakdowns')).toBe('hourly_stats_aggregated_by_advertiser_time_zone');expect(body.get('use_account_attribution_setting')).toBe('true');expect(body.get('fields')).toContain('actions,action_values');return Response.json({report_run_id:'99'});}if(u.pathname.endsWith('/99'))return Response.json({async_status:'Job Completed',async_percent_completion:100});if(u.searchParams.get('level')==='account'){expect(u.searchParams.get('breakdowns')).toBe('hourly_stats_aggregated_by_advertiser_time_zone');return Response.json({data:[{...account,spend:'40',impressions:'2000',clicks:'60'}]});}return Response.json(u.searchParams.has('after')?{data:[{...ad,ad_id:'2'}]}:{data:[ad],paging:{next:'https://untrusted.invalid',cursors:{after:'next'}}});};
 const batch=await fetchMetaHourlyPerformance(client,config,w,metaFetcher,Date.now()+10000,now);expect(batch.rows).toHaveLength(10);expect(calls.filter(url=>url.pathname.endsWith('/99/insights'))).toHaveLength(2);
 const raw={day:date,hour:'14:00',campaign:'Dream',campaign_id_external:'2',country:'US',cost:'20'},appCalls:URL[]=[];const appFetcher:typeof fetch=async url=>{const u=new URL(String(url));appCalls.push(u);expect(u.hostname).toBe('r.applovin.com');return Response.json({code:200,results:u.searchParams.get('columns')==='day,hour,cost'?[{day:date,hour:'14:00',cost:'20'}]:[raw]});};
 const app=await fetchAppLovinHourlySpend(client,config,w,appFetcher,Date.now()+10000,now);expect(app.rows).toHaveLength(1);expect(appCalls).toHaveLength(2);expect(appCalls.every(url=>url.searchParams.get('start')==='2026-10-12'&&url.searchParams.get('end')===date)).toBe(true);
});
it('rejects failed or expired asynchronous conversion reports instead of substituting missing purchase metrics',async()=>{
 const failed:typeof fetch=async (url,options)=>options?.method==='POST'?Response.json({report_run_id:'99'}):String(url).includes('/99?')?Response.json({async_status:'Job Failed'}):Response.json({data:[account]});
 await expect(fetchMetaHourlyPerformance(client,config,w,failed,Date.now()+10000,now)).rejects.toThrow(/asynchronous report failed/i);
 const expired:typeof fetch=async (url,options)=>options?.method==='POST'?Response.json({report_run_id:'99'}):String(url).includes('/99?')?Response.json({async_status:'Job Running',async_percent_completion:100}):Response.json({data:[account]});
 await expect(fetchMetaHourlyPerformance(client,config,w,expired,Date.now()+1000,now)).rejects.toThrow(/did not complete.*deadline/i);
});
it('drops only a settling newest completed Meta bucket and retains the exact earlier coverage boundary',async()=>{
 const latest='16:00:00 - 16:59:59',ads=[{...ad},{...ad,hourly_stats_aggregated_by_advertiser_time_zone:latest}],totals=[{...account},{...account,hourly_stats_aggregated_by_advertiser_time_zone:latest,clicks:50}];
 const fetcher:typeof fetch=async(url,options)=>options?.method==='POST'?Response.json({report_run_id:'99'}):String(url).includes('/99?')?Response.json({async_status:'Job Completed'}):new URL(String(url)).searchParams.get('level')==='account'?Response.json({data:totals}):Response.json({data:ads});
 const batch=await fetchMetaHourlyPerformance(client,config,w,fetcher,Date.now()+10000,now);expect(batch.coverageThrough).toBe('2026-10-13T14:00:00Z');expect(batch.rows).toHaveLength(5);expect(batch.rows.every(row=>row.start==='2026-10-13T00:00:00Z')).toBe(true);
 totals[0].clicks='31';await expect(fetchMetaHourlyPerformance(client,config,w,fetcher,Date.now()+10000,now)).rejects.toThrow(/reconcile/i);
 expect(()=>normalizeMetaHourlyPerformance({ads,account:totals},client,w,now,'2026-10-13T13:00:00Z')).toThrow(/boundary/i);
});
it('exposes the verified earlier AppLovin cutoff when only the newest completed provider hour is still settling',async()=>{
 const hourly=[{day:date,hour:'13:00',campaign:'GLP',country:'US',cost:10},{day:date,hour:'14:00',campaign:'GLP',country:'US',cost:20}],totals=[{day:date,hour:'13:00',cost:10},{day:date,hour:'14:00',cost:15}],fetcher:typeof fetch=async url=>Response.json({code:200,results:new URL(String(url)).searchParams.get('columns')==='day,hour,cost'?totals:hourly});
 const batch=await fetchAppLovinHourlySpend(client,config,w,fetcher,Date.now()+10000,now);expect(batch.coverageThrough).toBe('2026-10-13T14:00:00Z');expect(batch.rows.map(row=>row.value)).toEqual([10]);
 totals[0].cost=9;await expect(fetchAppLovinHourlySpend(client,config,w,fetcher,Date.now()+10000,now)).rejects.toThrow(/reconcile/i);
 expect(()=>normalizeAppLovinHourlySpend({hourly,totals},client,w,now,'2026-10-13T13:00:00Z')).toThrow(/boundary/i);
});
it('defers a settling first AppLovin hour instead of publishing an empty new store day',async()=>{
 const day='2026-10-14',window={from:day,to:day},firstHour={day:date,hour:'22:00',campaign:'GLP',country:'US',cost:10};
 let total=9;const fetcher:typeof fetch=async url=>Response.json({code:200,results:new URL(String(url)).searchParams.get('columns')==='day,hour,cost'?[{day:date,hour:'22:00',cost:total}]:[firstHour]});
 await expect(fetchAppLovinHourlySpend(client,config,window,fetcher,Date.now()+10000,new Date('2026-10-13T23:15:00Z'))).rejects.toMatchObject({name:'AppLovinSettlingHourError',retryAfterMs:300000});
 total=10;const valid=await fetchAppLovinHourlySpend(client,config,window,fetcher,Date.now()+10000,new Date('2026-10-13T23:20:00Z'));
 expect(valid.coverageThrough).toBe('2026-10-13T23:00:00Z');expect(valid.rows).toHaveLength(1);expect(valid.rows[0]).toMatchObject({date:day,value:10,start:'2026-10-13T22:00:00Z',end:'2026-10-13T23:00:00Z'});
 total=9;await expect(fetchAppLovinHourlySpend(client,config,window,fetcher,Date.now()+10000,new Date('2026-10-14T00:15:00Z'))).rejects.toThrow(/does not reconcile/i);
});
it('fails missing, negative, truncated and future data instead of publishing misleading partial totals',()=>{
 expect(()=>normalizeMetaHourlyPerformance({ads:[{...ad,spend:null}],account:[account]},client,w,now)).toThrow(/missing/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:[{...ad,spend:-1}],account:[account]},client,w,now)).toThrow(/invalid/i);
 expect(()=>normalizeMetaHourlyPerformance({ads:Array(40000).fill(ad),account:[account]},client,w,now)).toThrow(/limit/i);
 expect(()=>appLovinUTCWindow(client,{from:'2026-10-14',to:'2026-10-14'},now)).toThrow(/beyond/i);
 expect(()=>normalizeAppLovinHourlySpend({hourly:[{day:date,hour:'14:00',campaign:'Dream',country:'US',cost:null}],totals:[]},client,w,now)).toThrow(/missing/i);
});
