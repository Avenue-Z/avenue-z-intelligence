import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
import {Ga4Workspace,Ga4WorkspaceView,Ga4DashboardCache,ga4ReportUrl,ga4TrendSeries,loadGa4Dashboard,prefetchGa4Dashboard} from '../../components/analytics/ga4-workspace';
import type {Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
import type {QueryFilters} from '../../lib/analytics/contracts';

const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',compare:'previous',mode:'partial',market:'',source:'',device:'',page:'',stream:'',view:'web-analytics'};
const stats={sessions:120,engagedSessions:80,purchases:4,revenue:80},previous={sessions:100,engagedSessions:70,purchases:5,revenue:100};
const missing={sessions:null,engagedSessions:null,purchases:null,revenue:null};
const shift=(date:string,days:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
const model:Ga4Dashboard={
 from:filters.from,to:filters.to,comparison:{from:'2026-10-15',to:'2026-10-15'},propertyId:'292550743',timezone:'America/New_York',currency:'USD',latestCapturedAt:'2026-10-16T17:15:00Z',matchedThroughHour:11,
 current:stats,previous,daily:Array.from({length:30},(_,index)=>{const date=shift(filters.to,index-29);return {date,comparisonDate:shift(date,-1),current:index===28?missing:index===27?{...stats,sessions:0}:stats,previous};}),
 pages:[{label:'/sleep',current:stats,previous}],sources:[{label:'google',current:stats,previous}],markets:[{label:'US',current:stats,previous}],devices:[{label:'mobile',current:stats,previous}],
 coverage:{requestedDays:1,capturedDays:1,missingDates:[],availableFrom:'2026-09-17',availableTo:filters.to},
 filterOptions:{markets:['US'],sources:['google'],devices:['mobile'],pages:['/sleep']},
 quality:{sampled:false,thresholded:false,dataLossFromOtherRow:false,restricted:false,truncated:false},
};
const render=(data=model)=>renderToStaticMarkup(createElement(Ga4WorkspaceView,{model:data,filters,update:()=>{}}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

it('requests only the cached report API with comparison and cohort filters while removing page query strings',()=>{
 const url=new URL(ga4ReportUrl({...filters,compare:'custom',compareFrom:'2026-10-01',compareTo:'2026-10-02',market:'US',source:'google / paid',device:'mobile',page:'/sleep?x=1',stream:'unsupported'}),'https://app.example');
 expect(url.pathname).toBe('/api/integrations/ga4/beam/reports');
 expect(Object.fromEntries(url.searchParams)).toEqual({from:'2026-10-16',to:'2026-10-16',mode:'partial',compare:'custom',compareFrom:'2026-10-01',compareTo:'2026-10-02',market:'US',source:'google / paid',device:'mobile',page:'/sleep'});
});

it('gives a one-day KPI seven actual context dates and preserves missing values and the supplied comparison dates',()=>{
 const result=ga4TrendSeries(model,7);
 expect(result.series.map(row=>row.date)).toEqual(['2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16']);
 expect(result.series.map(row=>row.sessions)).toEqual([120,120,120,120,0,null,120]);
 expect(result.comparisonSeries.map(row=>row.date)).toEqual(['2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15']);
 expect(ga4TrendSeries(model,30).series).toHaveLength(30);
});

it('renders measured GA4 KPIs and favorable/unfavorable comparisons without calling purchases a conversion rate',()=>{
 const html=render();
 expect(html).toMatch(/SESSIONS<\/span><strong>120<\/strong>/);
 expect(html).toMatch(/GA4-ATTRIBUTED PURCHASES<\/span><strong>4<\/strong>/);
 expect(html).toMatch(/GA4-ATTRIBUTED REVENUE<\/span><strong>\$80<\/strong>/);
 expect(html).toContain('Increased +20.0% vs yesterday');expect(html).toContain('Decreased -20.0% vs yesterday');
 expect(html).toContain('data-tone="favorable"');expect(html).toContain('data-tone="unfavorable"');
 expect(html).toContain('Shopify remains the business sales source');expect(html).not.toMatch(/CVR|conversion rate/i);
});

it('renders true zero and missing metrics distinctly and keeps unavailable prior values neutral',()=>{
 const html=render({...model,current:{...stats,sessions:0,purchases:null},previous:{...previous,sessions:null}});
 expect(html).toMatch(/SESSIONS<\/span><strong>0<\/strong>/);
 expect(html).toMatch(/GA4-ATTRIBUTED PURCHASES<\/span><strong>—<\/strong>/);
 expect(html).toContain('— vs yesterday');
});

it('keeps source USD revenue correctly labeled when the client currency differs',()=>{
 const html=renderToStaticMarkup(createElement(Ga4WorkspaceView,{model,filters,update:()=>{},currency:'EUR'}));
 expect(html).toMatch(/GA4-ATTRIBUTED REVENUE<\/span><strong>\$80<\/strong>/);expect(html).not.toContain('€80');
 expect(html).toContain('GA4 currency: USD');
});

it('offers seven/thirty day trend context, metric selection, comparison and table controls',()=>{
 const html=render();expect(html).toContain('7 days');expect(html).toContain('30 days');
 expect(html).toContain('aria-label="Web analytics trend metric"');expect(html).toContain('GA4-attributed purchases');
 expect(html).toContain('Compare period');expect(html).toContain('aria-label="GA4 daily trend display"');expect(html).toContain('Chart + table');
 expect(html).toContain('2026-10-10 – 2026-10-16');expect(html).toContain('missing values are gaps');
});

it('shows matched landing-page cohorts, breakdown navigation and visible global cohort filters',()=>{
 const html=render();expect(html).toContain('Landing-page sessions');expect(html).toContain('Landing-page attributed purchases');
 expect(html).toContain('aria-label="Traffic breakdown"');expect(html).toContain('Sources');expect(html).toContain('Markets');expect(html).toContain('Devices');
 for(const label of ['Country','Source','Device','Landing page'])expect(html).toContain(`aria-label="GA4 ${label}"`);
 expect(html).toContain('/sleep');expect(html).toContain('value="US"');
 expect(html).toContain('color:var(--az-blue)">Current</span>');expect(html).toContain('color:var(--az-purple)">yesterday</span>');
 expect(html.match(/Increased \+20.0% vs yesterday/g)).toHaveLength(3);
});

it('uses a single New York freshness/cutoff line and only displays actual report-quality flags',()=>{
 const html=render();expect(html).toContain('11:00 AM');expect(html).toContain('America/New_York');expect(html).toContain('GA4 typically lags 2–6 hours');expect(html).not.toContain('Privacy thresholds');
 const flagged=render({...model,quality:{...model.quality,thresholded:true,sampled:true}});
 expect(flagged).toContain('Privacy thresholds');expect(flagged).toContain('Sampled data');expect(flagged).not.toContain('Restricted metrics');
});

it('distinguishes a partial today awaiting a completed GA hour from closed historical days',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T17:30:00Z'));
 const waiting={...model,matchedThroughHour:null,current:missing,previous:missing};
 expect(render(waiting)).toContain('Awaiting a completed GA hour');expect(render(waiting)).not.toContain('Closed days');
 expect(render({...waiting,from:'2026-10-15',to:'2026-10-15'})).toContain('Closed days');
});

it('shows one simple pending state before the first capture without fabricated KPI zeros',()=>{
 const html=render({...model,current:missing,previous:missing,latestCapturedAt:null,coverage:{...model.coverage,capturedDays:0,missingDates:[filters.to],availableFrom:null,availableTo:null}});
 expect(html).toContain('First GA4 capture pending');expect(html).not.toContain('stat-card');expect(html).not.toContain('notice');
 const initial=renderToStaticMarkup(createElement(Ga4Workspace,{filters,update:()=>{}}));expect(initial).toContain('Loading web analytics');
});

it('retains stale cache data after thirty seconds and bounds cache entries to eight selections',()=>{
 const cache=new Ga4DashboardCache();cache.write('first',model,0);
 expect(cache.read('first',29999)).toEqual({model,stale:false});expect(cache.read('first',30000)).toEqual({model,stale:true});
 for(let index=0;index<8;index++)cache.write(`selection-${index}`,model,index+1);
 expect(cache.read('first',30000)).toBeNull();expect(cache.read('selection-7',30000)?.model).toBe(model);
});

it('loads the protected API as same-origin JSON while blocking redirects',async()=>{
 const fetcher:typeof fetch=async(input,init)=>{expect(String(input)).toBe(ga4ReportUrl(filters));expect(init?.credentials).toBe('same-origin');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');return Response.json(model);};
 await expect(loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,fetcher)).resolves.toEqual(model);
});

it.each([401,403,500])('provides a safe retryable API failure for HTTP %i',async status=>{
 await expect(loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,async()=>new Response('private-provider-secret',{status}))).rejects.toThrow(status===500?'Web analytics could not be refreshed. Try again.':'Sign in again to view Beam web analytics.');
});

it('bounds both fetch and body reads to fifteen seconds even when a transport ignores abort',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|null|undefined;
 const pending=loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,async(_url,init)=>{signal=init?.signal;return new Promise<Response>(()=>{});});
 const rejection=expect(pending).rejects.toThrow('Web analytics took too long. Try again.');
 await vi.advanceTimersByTimeAsync(15000);await rejection;expect(signal?.aborted).toBe(true);
 const stream=new ReadableStream<Uint8Array>({start(){}}),body=loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,async()=>new Response(stream));
 const bodyRejection=expect(body).rejects.toThrow('Web analytics took too long. Try again.');await vi.advanceTimersByTimeAsync(15000);await bodyRejection;
});

it('aborts obsolete requests promptly and sanitizes invalid API payloads',async()=>{
 const controller=new AbortController(),pending=loadGa4Dashboard(ga4ReportUrl(filters),controller.signal,async()=>new Promise<Response>(()=>{}));
 const rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejection;
 await expect(loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,async()=>Response.json({error:'private-provider-secret'}))).rejects.toThrow('Web analytics could not be refreshed. Try again.');
});

it('cancels a late obsolete response before consuming its body',async()=>{
 const controller=new AbortController();let deliver:(response:Response)=>void=()=>{},canceled=false;
 const pending=loadGa4Dashboard(ga4ReportUrl(filters),controller.signal,async()=>new Promise<Response>(resolve=>{deliver=resolve;}));
 const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
 const stream=new ReadableStream<Uint8Array>({start(source){source.enqueue(new TextEncoder().encode(JSON.stringify(model)));source.close();},cancel(){canceled=true;}});
 deliver(new Response(stream));await Promise.resolve();await Promise.resolve();expect(canceled).toBe(true);
});

it('deduplicates safe tab prefetch and supplies the next render from the shared bounded cache',async()=>{
 const selected={...filters,from:'2026-10-12',to:'2026-10-12'},data={...model,from:selected.from,to:selected.to};
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json(data));vi.stubGlobal('fetch',fetcher);
 await Promise.all([prefetchGa4Dashboard(selected),prefetchGa4Dashboard(selected)]);expect(fetcher).toHaveBeenCalledOnce();
 const html=renderToStaticMarkup(createElement(Ga4Workspace,{filters:selected,update:()=>{}}));expect(html).toContain('GA4-ATTRIBUTED PURCHASES');expect(html).not.toContain('Loading web analytics');
 await prefetchGa4Dashboard(selected);expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps a failed tab prefetch quiet and allows a later retry',async()=>{
 const selected={...filters,from:'2026-10-13',to:'2026-10-13'},fetcher=vi.fn<typeof fetch>(async()=>{throw Error('private-provider-message');});vi.stubGlobal('fetch',fetcher);
 await expect(prefetchGa4Dashboard(selected)).resolves.toBeUndefined();await expect(prefetchGa4Dashboard(selected)).resolves.toBeUndefined();expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects incomplete filter options instead of crashing after an apparently successful load',async()=>{
 await expect(loadGa4Dashboard(ga4ReportUrl(filters),new AbortController().signal,async()=>Response.json({...model,filterOptions:{}}))).rejects.toThrow('Web analytics could not be refreshed. Try again.');
});
