import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {ga4RunReport,type Ga4Report} from '../../lib/sources/ga4-data';
import {loadGa4Reports,saveGa4DayReports,type Ga4CachedReport} from '../../lib/server/ga4-report-cache';
import {createGa4DashboardHandler} from '../../lib/server/ga4-dashboard';
import {parseGa4DashboardFilters,type Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
import {buildGa4AIView} from '../../lib/ai/ga4-context';
import {Ga4WorkspaceView,ga4ReportUrl} from '../../components/analytics/ga4-workspace';
import type {Store} from '../../lib/server/store';

const property='274489308',stream='2635677328',date='2026-10-21',capturedAt='2026-10-22T12:00:00Z';
const privatePages=['/123456/orders/order-token-alpha/authenticate','/123456/orders/order-token-beta/authenticate','/a/loop_subscriptions/customer/customer-1001/subscription/subscription-7001','/account/login?return_url=/account/customer-1001','/cart/c/cart-token-123?key=cart-secret'];
const publicPages=['/products/complete-sonic-brush-bundle-with-extra-replacement-brush-heads-and-travel-case','/blogs/brush-guides/how-to-build-a-healthier-daily-brushing-routine-for-your-entire-family'];
const pages=[...privatePages,...publicPages],metricNames=['sessions','engagedSessions','ecommercePurchases','purchaseRevenue'];
const metricHeaders=metricNames.map(name=>({name,type:name==='purchaseRevenue'?'TYPE_CURRENCY':'TYPE_INTEGER'}));
const detailDimensions=['dateHour','landingPage','countryId','deviceCategory','sessionSource','sessionMedium','sessionCampaignName','streamId'];
const filters=parseGa4DashboardFilters(new URLSearchParams({from:date,to:date,mode:'closed'}),Date.parse(capturedAt),'autobrush');
const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases)db.close();databases.length=0;});
function report(kind:'total'|'hourly'|'detail'):Ga4Report{
 const dimensionHeaders=(kind==='total'?['streamId']:kind==='hourly'?['dateHour','streamId']:detailDimensions).map(name=>({name}));
 const rows=(kind==='detail'?pages:['total']).map((page,index)=>({dimensions:Object.fromEntries(dimensionHeaders.map(({name})=>[name,({dateHour:'2026102108',landingPage:page,countryId:'US',deviceCategory:'mobile',sessionSource:'google',sessionMedium:'organic',sessionCampaignName:'(organic)',streamId:stream} as Record<string,string>)[name]])),metrics:kind==='detail'?{sessions:index+1,engagedSessions:index+1,ecommercePurchases:1,purchaseRevenue:(index+1)*10}:{sessions:28,engagedSessions:28,ecommercePurchases:7,purchaseRevenue:280}}));
 return {rows,rowCount:rows.length,dimensionHeaders,metricHeaders,metadata:{timeZone:'America/Los_Angeles',currencyCode:'USD',subjectToThresholding:true}};
}
function day():Ga4CachedReport[]{return (['total','hourly','detail'] as const).map(kind=>({storeDate:date,kind,capturedAt,report:report(kind)}));}
function database(){
 const db=new DatabaseSync(':memory:');databases.push(db);db.exec(readFileSync('drizzle/0011_ga4_report_cache.sql','utf8'));
 const store:Pick<Store,'all'|'run'>={async all<T>(sql:string,...args:unknown[]){return db.prepare(sql).all(...args as SQLInputValue[]) as T[];},async run(sql,...args){return {meta:{changes:Number(db.prepare(sql).run(...args as SQLInputValue[]).changes)}};}};
 return {db,store};
}
function providerPayload(paths:string[],offset=0,total=paths.length){return {rowCount:total,dimensionHeaders:detailDimensions.map(name=>({name})),metricHeaders,metadata:{timeZone:'America/Los_Angeles',currencyCode:'USD'},rows:paths.map((page,index)=>({dimensionValues:detailDimensions.map(name=>({value:({dateHour:'2026102108',landingPage:page,countryId:'US',deviceCategory:'mobile',sessionSource:'google',sessionMedium:'organic',sessionCampaignName:'(organic)',streamId:stream} as Record<string,string>)[name]})),metricValues:[offset+index+1,offset+index+1,1,(offset+index+1)*10].map(value=>({value:String(value)}))}))};}
const privateIdentifiers=/order-token|customer-1001|subscription-7001|cart-token|cart-secret|123456/;

it('removes private paths from provider ingestion while retaining public long slugs, totals and website identity',async()=>{
 const result=await ga4RunReport('test-access',property,{from:date,to:date,dimensions:detailDimensions,metrics:metricNames,streamId:stream},async()=>Response.json(providerPayload(pages)));
 expect(JSON.stringify(result)).not.toMatch(privateIdentifiers);
 expect(result.rows.map(row=>row.dimensions.landingPage)).toEqual(['/[private]',...publicPages]);
 expect(result.rows[0].metrics).toEqual({sessions:15,engagedSessions:15,ecommercePurchases:5,purchaseRevenue:150});
 expect(result.rows.reduce((sum,row)=>sum+row.metrics.sessions,0)).toBe(28);expect(result.rows.every(row=>row.dimensions.streamId===stream)).toBe(true);
});
it('fully paginates before collapsing private dimension collisions',async()=>{
 const offsets:number[]=[];
 const result=await ga4RunReport('test-access',property,{from:date,to:date,dimensions:detailDimensions,metrics:metricNames,streamId:stream},async(_url,init)=>{const offset=Number(JSON.parse(String(init?.body)).offset);offsets.push(offset);const count=Math.min(1000,1001-offset);return Response.json(providerPayload(Array.from({length:count},(_,index)=>`/orders/order-token-${offset+index}/authenticate`),offset,1001));});
 expect(offsets).toEqual([0,1000]);expect(result.rowCount).toBe(1);expect(result.rows[0].dimensions.landingPage).toBe('/[private]');
 expect(result.rows[0].metrics.sessions).toBe(501501);expect(JSON.stringify(result)).not.toContain('order-token');
});
it('makes existing cached private pages safe for read API, UI and AI without rewriting or dropping captured totals',async()=>{
 const {db,store}=database();for(const item of day())db.prepare('INSERT INTO ga4_report_cache VALUES(?,?,?,?,?,?,?)').run('org','autobrush',property,date,item.kind,gzipSync(JSON.stringify(item.report)).toString('base64'),capturedAt);
 const read=createGa4DashboardHandler({store:()=>store,scope:async()=>({organizationId:'org',actorId:'reader',role:'analyst',permittedClientIds:['autobrush']}),secret:key=>key==='SOURCE_AUTOBRUSH_GA4'?JSON.stringify({clientId:'test.apps.googleusercontent.com',clientSecret:'test-only',propertyId:property}):null,now:()=>Date.parse(capturedAt)},'autobrush');
 const response=await read(new Request(`https://app.example/api/integrations/ga4/autobrush/reports?from=${date}&to=${date}&mode=closed`));expect(response.status).toBe(200);
 const text=await response.text();expect(text).not.toMatch(privateIdentifiers);const model=JSON.parse(text) as Ga4Dashboard;
 expect(model.current).toEqual({sessions:28,engagedSessions:28,purchases:7,revenue:280});expect(model.pages.find(page=>page.label==='/[private]')?.current.sessions).toBe(15);expect(model.filterOptions.pages).toEqual(expect.arrayContaining(publicPages));expect(model.streamId).toBe(stream);expect(model.quality.thresholded).toBe(true);
 const html=renderToStaticMarkup(createElement(Ga4WorkspaceView,{model,filters:{...filters,page:privatePages[0]},update:()=>{}})),ai=buildGa4AIView(model,{...filters,page:privatePages[0]},'Compare landing pages',true,'autobrush');
 expect(html).not.toMatch(privateIdentifiers);expect(JSON.stringify(ai)).not.toMatch(privateIdentifiers);expect(JSON.stringify(ai)).toContain(publicPages[1]);expect(ai.scope.streamId).toBe(stream);
 const loaded=await loadGa4Reports(store,'org',property,date,date);expect(JSON.stringify(loaded)).not.toMatch(privateIdentifiers);
 const selected=await read(new Request(`https://app.example/api/integrations/ga4/autobrush/reports?from=${date}&to=${date}&mode=closed&page=${encodeURIComponent(privatePages[0])}`));expect(selected.status).toBe(200);const bucket=await selected.json() as Ga4Dashboard;
 expect(bucket.current).toEqual({sessions:15,engagedSessions:15,purchases:5,revenue:150});expect(bucket.filterOptions.pages).toContain('/[private]');expect(JSON.stringify(bucket)).not.toMatch(privateIdentifiers);
});
it('persists only safe buckets and normalizes a selected private page without leaking it in a UI request',async()=>{
 const {db,store}=database();await saveGa4DayReports(store,'org',property,day());const payload=db.prepare("SELECT payload FROM ga4_report_cache WHERE kind='detail'").get()!.payload as string;
 expect(gunzipSync(Buffer.from(payload,'base64')).toString()).not.toMatch(privateIdentifiers);
 const selected=parseGa4DashboardFilters(new URLSearchParams({from:date,to:date,page:privatePages[0]}),Date.parse(capturedAt),'autobrush');expect(selected.page).toBe('/[private]');
 expect(ga4ReportUrl({...filters,page:privatePages[0]},'autobrush')).not.toMatch(privateIdentifiers);
});
it.each(['/987654/orders/short/authenticate','/a/loop_subscriptions/customer/123/subscription/456','/apps/loop_subscriptions/customer/123','/account/login','/cart/abc123','/%39%38%37%36%35%34/%6frders/short/authenticate','/%2539%2538%2537%2536%2535%2534/%256frders/short/authenticate','https://store.example/987654/orders/short/authenticate?key=private','/en-us/987654/ACCOUNT/login','/tools/recurring/customer/123','/pages/customer@example.test/welcome','/pages/customer%40example.test/welcome'])('redacts the complete private route %s into one stable bucket',async page=>{
 const result=await ga4RunReport('test-access',property,{from:date,to:date,dimensions:detailDimensions,metrics:metricNames,streamId:stream},async()=>Response.json(providerPayload([page])));
 expect(result.rows[0].dimensions.landingPage).toBe('/[private]');
});
it('does not fabricate pooled rates when private paths collide in a nonadditive provider report',async()=>{
 const dimensions=['landingPage'],metric='bounceRate';
 await expect(ga4RunReport('test-access',property,{from:date,to:date,dimensions,metrics:[metric]},async()=>Response.json({rowCount:2,dimensionHeaders:[{name:'landingPage'}],metricHeaders:[{name:metric,type:'TYPE_FLOAT'}],metadata:{timeZone:'America/Los_Angeles'},rows:privatePages.slice(0,2).map(page=>({dimensionValues:[{value:page}],metricValues:[{value:'0.5'}]}))}))).rejects.toThrow();
});
it('preserves the last good cache when redacted labels expand a report beyond the 16 MiB decoded bound',async()=>{
 const {db,store}=database();await saveGa4DayReports(store,'org',property,day());
 const replacement=day().map(item=>({...item,capturedAt:'2026-10-22T13:00:00Z'})),detail=replacement.find(item=>item.kind==='detail')!.report;
 detail.rows=[{...detail.rows[0],dimensions:{...detail.rows[0].dimensions,landingPage:'/cart'}}];detail.rowCount=1;detail.metadata.padding='';
 detail.metadata.padding='x'.repeat(16*1024*1024-1-Buffer.byteLength(JSON.stringify(detail)));
 expect(Buffer.byteLength(JSON.stringify(detail))).toBe(16*1024*1024-1);
 await expect(saveGa4DayReports(store,'org',property,replacement)).rejects.toThrow();
 expect(db.prepare('SELECT DISTINCT capturedAt FROM ga4_report_cache').all()).toEqual([{capturedAt}]);
 expect(await loadGa4Reports(store,'org',property,date,date)).toHaveLength(3);
});
