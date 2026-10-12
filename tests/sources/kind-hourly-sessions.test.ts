import {expect,it} from 'vitest';
import {normalizeHourlySessions,kindQualification,KIND_SOURCES,sanitizePage} from '../../lib/sources/kind-patches';
import {fetchKindSource,effectiveKindWindow} from '../../lib/sources/kind-fetch';
import {validateConnection} from '../../lib/server/configuration';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';

const client={...initial[0],version:1} as any;
const values={sessions:10,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
const day='2026-10-12',window={from:day,to:day},now=new Date('2026-10-12T03:45:00Z'); // 05:45 Stockholm
const input={hourly:[{day,hour_of_day:1,...values}],daily:[{day,...values}],pages:[{day,hour_of_day:1,landing_page_path:'/pages/glp?email=private',session_country:'United States',...values}],pageDaily:[{day,...values}]};
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});

it('registers the hourly provider without changing existing provider indices',()=>{
 expect(KIND_SOURCES.slice(0,7).map(s=>s.provider)).toEqual(['kind-triple-whale','kind-shopify-sales','kind-shopify-funnels','kind-shopify-products','kind-meta','kind-applovin','kind-recharge']);
 expect(()=>validateConnection({clientId:client.id,name:'Hourly sessions',provider:'kind-shopify-hourly',endpoint:KIND_SOURCES[2].endpoint,secretRef:'SOURCE_KIND_PATCHES_SCRIPT',pollMinutes:30})).not.toThrow();
});
it('fills hourly overview zeros only after independent human counts reconcile',()=>{
 const batch=normalizeHourlySessions(input,client,window,now);
 expect(batch.grain).toBe('hourly');expect(batch.coverageThrough).toBe('2026-10-12T03:00:00Z');
 const sessions=batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='sessions');
 expect(sessions.map(r=>r.value)).toEqual([0,10,0,0,0]);expect(sessions[0].start).toBe('2026-10-11T22:00:00Z');
 expect(batch.rows.find(r=>r.dataset==='funnels'&&r.metric==='sessions')?.dimensions).toEqual({page:'/pages/glp',market:'US'});
 expect(batch.rows.filter(r=>r.metric==='completed_checkouts').reduce((s,r)=>s+r.value!,0)).toBe(2);
 const q=requireQualifiedSource(kindQualification(batch,'kind-shopify-hourly'),client);
 expect(q.hourlyGrain).toBe(true);expect(q.profiles.every(p=>p.hourly)).toBe(true);expect(()=>validateRegisteredBatch(batch,q)).not.toThrow();
});
it('rejects missing, mismatched or duplicated authority before making zero buckets',()=>{
 expect(()=>normalizeHourlySessions({...input,daily:[]},client,window,now)).toThrow(/independent daily/i);
 expect(()=>normalizeHourlySessions({...input,daily:[{day,...values,sessions:11}]},client,window,now)).toThrow(/reconcile/i);
 expect(()=>normalizeHourlySessions({...input,hourly:[...input.hourly,...input.hourly]},client,window,now)).toThrow(/duplicate/i);
 expect(()=>normalizeHourlySessions({...input,pageDaily:[{day,...values,sessions:11}]},client,window,now)).toThrow(/reconcile/i);
 expect(()=>normalizeHourlySessions({...input,hourly:[{day,hour_of_day:1,...values,sessions:-1}]},client,window,now)).toThrow(/count/i);
});
it('redacts token-like public slugs without treating them as excluded private routes',()=>{
 const pages=[{...input.pages[0],landing_page_path:'/products/a-product-with-a-long-public-slug'}];
 expect(normalizeHourlySessions({...input,pages},client,window,now).rows.find(r=>r.dataset==='funnels')?.dimensions.page).toBe('/products/[private]');
 expect(()=>normalizeHourlySessions({...input,pages:[{...input.pages[0],landing_page_path:'/checkout/123/cn/token'}]},client,window,now)).toThrow(/private landing page/i);
});
it('preserves repeated-hour aggregates and skips nonexistent local hours',()=>{
 const autumn='2026-10-25',spring='2026-03-29';
 const fixtures=(date:string,hour:number)=>({hourly:[{day:date,hour_of_day:hour,...values}],daily:[{day:date,...values}],pages:[],pageDaily:[{day:date,sessions:0,sessions_with_cart_additions:0,sessions_that_reached_checkout:0,sessions_that_completed_checkout:0}]});
 const a=normalizeHourlySessions(fixtures(autumn,2),client,{from:autumn,to:autumn},new Date('2026-10-26T12:00:00Z'));
 const repeated=a.rows.find(r=>r.metric==='sessions'&&r.value===10)!;expect(Date.parse(repeated.end!)-Date.parse(repeated.start!)).toBe(7200000);expect(a.rows.filter(r=>r.metric==='sessions')).toHaveLength(24);
 const s=normalizeHourlySessions(fixtures(spring,3),client,{from:spring,to:spring},new Date('2026-03-30T12:00:00Z'));
 expect(s.rows.filter(r=>r.metric==='sessions')).toHaveLength(23);
 expect(()=>normalizeHourlySessions(fixtures(spring,2),client,{from:spring,to:spring},new Date('2026-03-30T12:00:00Z'))).toThrow(/skipped/i);
 const partial=normalizeHourlySessions(fixtures(autumn,1),client,{from:autumn,to:autumn},new Date('2026-10-25T01:30:00Z'));
 expect(partial.coverageThrough).toBe('2026-10-25T00:00:00Z');expect(partial.rows.filter(r=>r.metric==='sessions')).toHaveLength(2);
});
it('redacts singular checkout and private recurring/account routes',()=>{
 for(const [path,want] of [['/checkout/123/cn/short-token?key=abc','/checkout/[private]'],['/checkouts/token','/checkouts/[private]'],['/cart/c/token','/cart/c/[private]'],['/tools/recurring/token','/tools/recurring/[private]'],['/a/account/token','/a/account/[private]']])expect(sanitizePage(path)).toBe(want);
});
it('reads independently filtered hourly totals and bounded public page detail through the last full store hour',async()=>{
 const source={...KIND_SOURCES[2],provider:'kind-shopify-hourly'} as any;
 const queries:string[]=[];
 const fetcher:typeof fetch=async(_url,opts)=>{
  const q=JSON.parse(String(opts?.body)).query;if(q.includes('ianaTimezone'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});
  const query=JSON.parse(q.match(/shopifyqlQuery\(query: ("(?:[^"\\]|\\.)*")\)/)![1]);queries.push(query);
  const rows=query.includes('landing_page_path,session_country')?input.pages:query.includes('landing_page_path NOT')?input.pageDaily:query.includes('GROUP BY day,hour_of_day')?input.hourly:input.daily;
  return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:Object.keys(rows[0]).map(name=>({name,dataType:'INTEGER'})),rows}}}});
 };
 const batch=await fetchKindSource(source,client,window,secret,fetcher,Date.now()+45000,now);
 expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='sessions').reduce((s,r)=>s+r.value!,0)).toBe(10);
 expect(queries).toHaveLength(4);expect(queries.every(q=>q.includes("human_or_bot_session = 'human'")&&q.includes('hour_of_day < 5'))).toBe(true);
 expect(queries.every(q=>!(/\bday </.test(q)))).toBe(true);
 expect(queries.filter(q=>q.includes('landing_page_path NOT')).every(q=>q.includes("NOT STARTS WITH '/checkout'")&&q.includes("NOT STARTS WITH '/cart/c'"))).toBe(true);
 expect(effectiveKindWindow(source,client,{from:day,to:'2026-10-15'},now)).toEqual(window);
});
