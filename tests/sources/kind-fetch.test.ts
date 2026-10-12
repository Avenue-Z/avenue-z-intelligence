import {it,expect} from 'vitest';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import {KIND_SOURCES} from '../../lib/sources/kind-patches';
import initial from '../../data/initial-clients.json';
import type {Client,Connection} from '../../lib/analytics/contracts';
const client=initial[0] as Client,w={from:'2026-10-07',to:'2026-10-08'},secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
it('will not forward the credential bundle to an edited endpoint or another client',async()=>{const source={...KIND_SOURCES[4],clientId:client.id,endpoint:'https://attacker.example'} as any;let requests=0;await expect(fetchKindSource(source,client,w,secret,async()=>{requests++;return Response.json({});})).rejects.toThrow('endpoint');expect(requests).toBe(0);await expect(fetchKindSource({...source,...KIND_SOURCES[4]}, {...client,id:'beam'},w,secret)).rejects.toThrow('Kind Patches');});
it('records Recharge current active customers without relabeling them subscriptions or historical dates',async()=>{const source=KIND_SOURCES[6] as any;const result=await fetchKindSource(source,client,w,secret,async url=>Response.json(String(url).endsWith('/store')?{store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}}:{count:12345}));expect(result.rows[0].metric).toBe('active_customers');expect(result.rows[0].value).toBe(12345);expect(result.rows[0].date).not.toBe('2026-10-07');});
it('rejects cross-store Recharge responses and redacts provider error bodies',async()=>{await expect(fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async()=>Response.json({store:{platform_domain:'other.myshopify.com'}}))).rejects.toThrow('identity');await expect(fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async()=>new Response('private-token',{status:403}))).rejects.toThrow('HTTP 403');});
it('honors a provider rate-limit retry for read-only requests without returning an empty success',async()=>{let count=0;const result=await fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async url=>{if(count++===0)return new Response('',{status:429,headers:{'Retry-After':'0'}});return Response.json(String(url).endsWith('/store')?{store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}}:{count:50});});expect(result.rows[0].value).toBe(50);expect(count).toBe(3);});

it('keeps private customer routes out of daily public-page funnels while preserving authoritative human totals',async()=>{
 const routes=['/pages/glp','/checkout/token','/checkouts/token','/orders/token','/account','/cart/c/token','/tools/recurring/portal','/a/account/login'];
 const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:'Europe/Stockholm',currencyCode:'USD',myshopifyDomain:'bright-patches.myshopify.com'}}});
  const exclusions=[...String(query).matchAll(/landing_page_path NOT STARTS WITH '([^']+)'/g)].map(m=>m[1]);const selected=routes.filter(path=>!exclusions.some(prefix=>path.startsWith(prefix)));
  const counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
  const rows=query.includes('GROUP BY day,landing_page_path')?selected.map(path=>({day:'2026-10-07',landing_page_path:path,session_country:'United States',...counts})):[{day:'2026-10-07',...Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n*selected.length]))}];return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});
 };
 const batch=await fetchKindSource(KIND_SOURCES[2] as Connection,client,{from:'2026-10-07',to:'2026-10-07'},secret,fetcher,Date.now()+10000,new Date('2026-10-08T12:00:00Z'));
 expect(batch.rows.filter(r=>r.dataset==='funnels'&&r.metric==='sessions').map(r=>r.dimensions.page)).toEqual(['/pages/glp']);
 expect(batch.rows.find(r=>r.dataset==='overview'&&r.metric==='sessions')?.value).toBe(56);
});

it('rejects private routes returned by a provider despite the daily public-page filter',async()=>{
 const counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
 const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:'Europe/Stockholm',currencyCode:'USD',myshopifyDomain:'bright-patches.myshopify.com'}}});const rows=[{day:'2026-10-07',...counts,...query.includes('GROUP BY day,landing_page_path')?{landing_page_path:'/a/account/customer',session_country:'United States'}:{}}];return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});};
 await expect(fetchKindSource(KIND_SOURCES[2] as Connection,client,{from:'2026-10-07',to:'2026-10-07'},secret,fetcher)).rejects.toThrow('Private landing page');
});
