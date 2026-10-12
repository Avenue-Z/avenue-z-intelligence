import {it,expect} from 'vitest';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import initial from '../../data/initial-clients.json';
import type {Client,Connection} from '../../lib/analytics/contracts';
const client=initial[0] as Client,source={provider:'kind-triple-whale-summary',endpoint:'https://api.triplewhale.com/api/v2/summary-page/get-data'} as Connection;
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
const summary=[{id:'facebookAds',metricId:'fb_ads_spend',services:['facebook-ads'],type:'currency',values:{current:100}},{id:'googleAds',metricId:'ga_adCost',services:['google-ads'],type:'currency',values:{current:20}},{id:'tiktokAds',metricId:'tiktok_spend',services:['tiktok-ads'],type:'currency',values:{current:0}},{id:'snapchatAds',metricId:'totalSnapchatSpend',services:['snapchat-ads'],type:'currency',values:{current:0}},{id:'applovinSpend',metricId:'applovinSpend',services:['applovin'],type:'currency',values:{current:5}}];
it('exposes independent closed-day summary versus SQL spend without gating differences or overwriting headline spend',async()=>{
 const fetcher:typeof fetch=async(url,options)=>{const body=JSON.parse(String(options?.body));if(String(url).includes('summary-page')){expect(body.period).toEqual({start:'2026-10-11',end:'2026-10-11'});expect(new Headers(options?.headers).get('x-api-key')).toBe('private');return Response.json({metrics:summary});}return Response.json([{event_date:'2026-10-11',channel:'facebook-ads',spend:99.75},{event_date:'2026-10-11',channel:'google-ads',spend:20.25},{event_date:'2026-10-11',channel:'applovin',spend:5}]);};
 const batch=await fetchKindSource(source,client,{from:'2026-08-01',to:'2026-10-12'},secret,fetcher,Date.now()+10000,new Date('2026-10-12T12:00:00Z'));
 expect(batch.rows).toHaveLength(15);expect(batch.rows.some(r=>r.metric==='spend'||r.dataset==='overview')).toBe(false);
 expect(batch.rows.find(r=>r.metric==='summary_spend_delta'&&r.dimensions.channel==='meta')).toMatchObject({value:.25,date:'2026-10-11',dimensions:{reporting_timezone:'Europe/Stockholm'}});
 expect(batch.coverageThrough).toBe('2026-10-11T22:00:00Z');
});
it('rejects missing or duplicate connected-channel summary metrics rather than inventing a zero',async()=>{
 const fetcher:typeof fetch=async url=>String(url).includes('summary-page')?Response.json({metrics:summary.slice(1)}):Response.json([]);
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,fetcher)).rejects.toThrow('summary');
 const duplicate:typeof fetch=async url=>String(url).includes('summary-page')?Response.json({metrics:[...summary,summary[0]]}):Response.json([]);
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,duplicate)).rejects.toThrow('summary');
});
