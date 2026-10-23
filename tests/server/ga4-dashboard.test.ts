import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import type {Ga4CachedReport} from '../../lib/server/ga4-report-cache';
import type {Ga4ReportRow} from '../../lib/sources/ga4-data';
import type {Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
const cache=vi.hoisted(()=>({load:vi.fn(),days:vi.fn()}));
vi.mock('../../lib/server/ga4-report-cache',()=>({loadGa4Reports:cache.load,ga4CachedDays:cache.days}));
import {createGa4DashboardHandler} from '../../lib/server/ga4-dashboard';

const origin='https://app.example',path='/api/integrations/ga4/beam/reports',now=Date.parse('2026-10-16T17:45:00Z');
const config=JSON.stringify({clientId:'test-ga4-app.apps.googleusercontent.com',clientSecret:'private-ga4-client-secret',propertyId:'292550743'});
const admin:AccessScope={organizationId:'avenue-z',actorId:'google:analyst',role:'analyst',permittedClientIds:['beam']};
const dimensions=['dateHour','landingPage','countryId','deviceCategory','sessionSource','sessionMedium','sessionCampaignName'];
function day(date:string,sessions:number):Ga4CachedReport[]{
 const metrics={sessions,engagedSessions:20,ecommercePurchases:2,purchaseRevenue:90},hour=date.replaceAll('-','')+'08',capturedAt='2026-10-16T17:30:00Z';
 const entry=(kind:Ga4CachedReport['kind'],names:string[],rows:Ga4ReportRow[]):Ga4CachedReport=>({storeDate:date,kind,capturedAt,report:{rows,rowCount:rows.length,dimensionHeaders:names.map(name=>({name})),metricHeaders:Object.keys(metrics).map(name=>({name,type:name==='purchaseRevenue'?'TYPE_CURRENCY':'TYPE_INTEGER'})),metadata:{timeZone:'America/New_York',currencyCode:'USD'}}});
 return [entry('total',[],[{dimensions:{},metrics}]),entry('hourly',['dateHour'],[{dimensions:{dateHour:hour},metrics}]),entry('detail',dimensions,[{dimensions:{dateHour:hour,landingPage:'/dream',countryId:'US',deviceCategory:'desktop',sessionSource:'google',sessionMedium:'organic',sessionCampaignName:'(organic)'},metrics}])];
}
let scope:AccessScope|null,reports:Ga4CachedReport[],store:{all:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.clearAllMocks();scope={...admin};reports=[...day('2026-10-15',100),...day('2026-10-14',80)];store={all:vi.fn()};
 cache.days.mockImplementation(async()=>reports.map(({storeDate,kind,capturedAt})=>({storeDate,kind,capturedAt})));
 cache.load.mockImplementation(async(_store:unknown,_org:string,_property:string,from:string,to:string,options?:{kinds?:string[]})=>reports.filter(report=>report.storeDate>=from&&report.storeDate<=to&&(!options?.kinds||options.kinds.includes(report.kind))));
 vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected outbound provider request'));
});
afterEach(()=>vi.restoreAllMocks());
const handler=(secret=config)=>createGa4DashboardHandler({scope:async()=>scope,store:()=>store,secret:key=>key==='SOURCE_BEAM_GA4'?secret:null,now:()=>now});
const request=(query='from=2026-10-15&to=2026-10-15&mode=closed')=>new Request(`${origin}${path}?${query}`);

it('allows a Beam analyst to read cached data without credential or provider access',async()=>{
 const response=await handler()(request()),body=await response.json();expect(response.status).toBe(200);
 expect(body).toMatchObject({propertyId:'292550743',current:{sessions:100},previous:{sessions:80},comparison:{from:'2026-10-14',to:'2026-10-14'}});
 expect(response.headers.get('cache-control')).toBe('private, max-age=30');expect(JSON.stringify(body)).not.toContain('private-ga4');expect(globalThis.fetch).not.toHaveBeenCalled();
 expect(cache.days.mock.calls[0].slice(1)).toEqual(['avenue-z','292550743','2026-09-17','2026-10-16']);
});
it('returns complete cached groups only for an explicitly configured platform reader',async()=>{
 for(const report of reports)if(report.kind==='detail'){
  report.report.rows=Array.from({length:245},(_,index)=>({dimensions:{...report.report.rows[0].dimensions,landingPage:`/page-${String(index).padStart(3,'0')}`},metrics:{...report.report.rows[0].metrics,sessions:500-index}}));report.report.rowCount=245;
 }
 const platform=createGa4DashboardHandler({scope:async()=>scope,store:()=>store,secret:key=>key==='SOURCE_BEAM_GA4'?config:null,now:()=>now,completeGroups:true});
 const response=await platform(request()),full=await response.json() as Ga4Dashboard,ui=await (await handler()(request())).json() as Ga4Dashboard;
 expect(response.status).toBe(200);expect(full.pages).toHaveLength(245);expect(full.pages[220]).toMatchObject({label:'/page-220',current:{sessions:280},previous:{sessions:280}});
 expect(ui.pages).toHaveLength(200);expect(full.current.sessions).toBe(100);expect(full.previous.sessions).toBe(80);expect(globalThis.fetch).not.toHaveBeenCalled();
 scope={...admin,permittedClientIds:['kind-patches']};expect((await platform(request())).status).toBe(403);
});
it('authorizes every request before consulting cache metadata or a warmed response',async()=>{
 const read=handler();expect((await read(request())).status).toBe(200);cache.days.mockClear();cache.load.mockClear();
 for(const denied of [null,{...admin,permittedClientIds:['kind-patches']}]){scope=denied;expect((await read(request())).status).toBe(403);}
 expect(cache.days).not.toHaveBeenCalled();expect(cache.load).not.toHaveBeenCalled();expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('loads lightweight context reports and only selected/comparison detail bodies for an unfiltered day',async()=>{
 const response=await handler()(request());expect(response.status).toBe(200);
 const detail=cache.load.mock.calls.filter(call=>call[5]?.kinds?.includes('detail')),context=cache.load.mock.calls.filter(call=>call[5]?.kinds?.includes('total'));
 expect(detail).toHaveLength(1);expect(detail[0].slice(3)).toEqual(['2026-10-14','2026-10-15',{kinds:['detail']}]);
 expect(context).toHaveLength(1);expect(context[0].slice(3)).toEqual(['2026-09-17','2026-10-15',{kinds:['total','hourly']}]);
});
it('loads context detail when filters require it, keeping raw GA dimensions exact',async()=>{
 const response=await handler()(request('from=2026-10-15&to=2026-10-15&mode=closed&market=US&source=google&device=desktop&page=%2Fdream')),body=await response.json();
 expect(response.status).toBe(200);expect(body).toMatchObject({current:{sessions:100},pages:[{label:'/dream'}],sources:[{label:'google'}]});
 const detail=cache.load.mock.calls.find(call=>call[5]?.kinds?.includes('detail'));expect(detail?.slice(3)).toEqual(['2026-09-17','2026-10-15',{kinds:['detail']}]);
});
it('clips all cache reads to retention and keeps an older comparison unavailable',async()=>{
 const response=await handler()(request('from=2026-10-15&to=2026-10-15&mode=closed&compare=thirtyDays')),body=await response.json();
 expect(response.status).toBe(200);expect(body).toMatchObject({previous:{sessions:null,revenue:null}});
 for(const call of cache.load.mock.calls){expect(call[3]>='2026-09-17').toBe(true);expect(call[4]<='2026-10-16').toBe(true);expect((Date.parse(call[4])-Date.parse(call[3]))/86400000).toBeLessThan(32);}
});
it('returns unavailable data for an empty cache without treating it as a zero-activity report',async()=>{
 reports=[];const response=await handler()(request()),body=await response.json();expect(response.status).toBe(200);
 expect(body).toMatchObject({current:{sessions:null,purchases:null},coverage:{capturedDays:0,missingDates:['2026-10-15']}});expect(cache.load).not.toHaveBeenCalled();
});
it('reuses a short private response only while the organization, query and captured versions match',async()=>{
 const read=handler();expect((await read(request())).status).toBe(200);const initial=cache.load.mock.calls.length;
 expect((await read(request())).status).toBe(200);expect(cache.load).toHaveBeenCalledTimes(initial);
 reports=reports.map(report=>({...report,capturedAt:'2026-10-16T17:40:00Z'}));expect((await read(request())).status).toBe(200);expect(cache.load.mock.calls.length).toBeGreaterThan(initial);
 const refreshed=cache.load.mock.calls.length;scope={...admin,organizationId:'other-org'};expect((await read(request())).status).toBe(200);expect(cache.load.mock.calls.length).toBeGreaterThan(refreshed);
});
it.each(['from=2026-10-01&to=2026-10-31','from=2026-10-17','stream=Online+Store','from=invalid'])('rejects an invalid date or unsupported scope before cache reads: %s',async query=>{
 const response=await handler()(request(query));expect(response.status).toBe(400);expect(cache.days).not.toHaveBeenCalled();expect(cache.load).not.toHaveBeenCalled();
});
it.each(['',JSON.stringify({clientId:'wrong.apps.googleusercontent.com',clientSecret:'private-ga4-client-secret',propertyId:'123'})])('requires configuration for exactly Beam property 292550743',async secret=>{
 const response=await handler(secret)(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-ga4');expect(cache.days).not.toHaveBeenCalled();
});
it('sanitizes cache errors and never sends a database error or provider credential to the browser',async()=>{
 cache.load.mockRejectedValueOnce(Error('private-ga4-client-secret SQL failure'));const response=await handler()(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-ga4');expect(response.headers.get('cache-control')).toContain('no-store');expect(globalThis.fetch).not.toHaveBeenCalled();
});
