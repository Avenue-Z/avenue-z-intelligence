import {it,expect} from 'vitest';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import {kindQualification} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import type {Client,Connection} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
const client=initial[0] as Client,source={provider:'kind-meta-performance',endpoint:'https://graph.facebook.com'} as Connection;
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
const ad={date_start:'2026-10-11',date_stop:'2026-10-11',ad_id:'1',ad_name:'GLP video',campaign_id:'10',campaign_name:'GLP prospecting',spend:'100',impressions:'2000',clicks:'50',actions:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'5'},{action_type:'purchase',value:'6'}],action_values:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'300'}]};
it('completes per-ad pagination and records account-attributed pixel outcomes without duplicate headline spend',async()=>{
 const fetcher:typeof fetch=async url=>{const u=new URL(String(url));if(!u.pathname.endsWith('/insights'))return Response.json({currency:'USD',timezone_name:'Europe/Stockholm'});expect(u.searchParams.get('use_account_attribution_setting')).toBe('true');expect(JSON.parse(u.searchParams.get('time_range')!)).toEqual({since:'2026-10-11',until:'2026-10-11'});if(u.searchParams.get('level')==='account')return Response.json({data:[{date_start:'2026-10-11',date_stop:'2026-10-11',spend:'200',impressions:'4000',clicks:'100'}]});return Response.json(u.searchParams.has('after')?{data:[{...ad,ad_id:'2',ad_name:'GLP image'}]}:{data:[ad],paging:{next:'https://graph.facebook.com/next',cursors:{after:'cursor'}}});};
 const batch=await fetchKindSource(source,client,{from:'2026-08-01',to:'2026-10-12'},secret,fetcher,Date.now()+10000,new Date('2026-10-12T12:00:00Z'));
 expect(batch.rows).toHaveLength(10);expect([...new Set(batch.rows.map(r=>r.dataset))]).toEqual(['creatives']);expect(batch.rows.some(r=>r.metric==='spend'||r.metric==='revenue'||r.dataset==='overview')).toBe(false);
 expect(batch.rows.find(r=>r.metric==='meta_ad_pixel_purchases'&&r.dimensions.ad_id==='1')).toMatchObject({value:5,dimensions:{ad:'GLP video',campaign:'GLP prospecting',attribution:'account',reporting_timezone:'Europe/Stockholm'}});
 expect(batch.coverageThrough).toBe('2026-10-11T22:00:00Z');expect(()=>validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,source.provider),client))).not.toThrow();
});
it('fails incomplete duplicate pages and account-total reconciliation mismatches',async()=>{
 const fetcher:typeof fetch=async url=>{const u=new URL(String(url));if(!u.pathname.endsWith('/insights'))return Response.json({currency:'USD',timezone_name:'Europe/Stockholm'});if(u.searchParams.get('level')==='account')return Response.json({data:[{date_start:'2026-10-11',date_stop:'2026-10-11',spend:'200',impressions:'4000',clicks:'100'}]});return Response.json({data:[ad]});};
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,fetcher)).rejects.toThrow('reconcile');
 const duplicate:typeof fetch=async url=>{const u=new URL(String(url));if(!u.pathname.endsWith('/insights'))return Response.json({currency:'USD',timezone_name:'Europe/Stockholm'});return Response.json({data:u.searchParams.get('level')==='account'?[ad]:[ad,ad]});};
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,duplicate)).rejects.toThrow('Duplicate');
});
it('leaves missing purchase reporting unknown and redacts private ad labels',async()=>{
 const fetcher:typeof fetch=async url=>{const u=new URL(String(url));if(!u.pathname.endsWith('/insights'))return Response.json({currency:'USD',timezone_name:'Europe/Stockholm'});if(u.searchParams.get('level')==='account')return Response.json({data:[{...ad,actions:undefined,action_values:undefined}]});return Response.json({data:[{...ad,ad_name:'person@example.com',actions:undefined,action_values:undefined}]});};
 const batch=await fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,fetcher);expect(batch.rows.find(r=>r.metric==='meta_ad_pixel_purchases')).toMatchObject({value:null,dimensions:{ad:'[private]'}});expect(batch.rows.find(r=>r.metric==='meta_ad_pixel_purchase_value')?.value).toBeNull();
});
