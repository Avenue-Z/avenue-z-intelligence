import {describe,expect,it} from 'vitest';
import {buildGa4Dashboard,parseGa4DashboardFilters} from '../../lib/analytics/ga4-dashboard';
import type {QueryFilters} from '../../lib/analytics/contracts';
import type {Ga4Report,Ga4ReportRow} from '../../lib/sources/ga4-data';
import type {Ga4CachedReport} from '../../lib/server/ga4-report-cache';

const now=Date.parse('2026-10-16T17:45:00Z'),capturedAt='2026-10-16T17:30:00Z';
const metrics=['sessions','engagedSessions','ecommercePurchases','purchaseRevenue'];
const detailDimensions=['dateHour','landingPage','countryId','deviceCategory','sessionSource','sessionMedium','sessionCampaignName'];
const filters:QueryFilters={from:'2026-10-15',to:'2026-10-15',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'ga4'};
const counts=(sessions:number,engagedSessions=0,purchases=0,revenue=0)=>({sessions,engagedSessions,ecommercePurchases:purchases,purchaseRevenue:revenue});
function row(date:string,hour:number,sessions:number,dimensions:Record<string,string>={}):Ga4ReportRow{return {dimensions:{dateHour:date.replaceAll('-','')+String(hour).padStart(2,'0'),...dimensions},metrics:counts(sessions,sessions/2,1,sessions*10)};}
function detail(date:string,hour:number,sessions:number,dimensions:Record<string,string>={}):Ga4ReportRow{return row(date,hour,sessions,{landingPage:'/dream',countryId:'US',deviceCategory:'desktop',sessionSource:'google',sessionMedium:'organic',sessionCampaignName:'(organic)',...dimensions});}
function report(dimensions:string[],rows:Ga4ReportRow[]):Ga4Report{return {rows,rowCount:rows.length,dimensionHeaders:dimensions.map(name=>({name})),metricHeaders:metrics.map(name=>({name,type:name==='purchaseRevenue'?'TYPE_CURRENCY':'TYPE_INTEGER'})),metadata:{timeZone:'America/New_York',currencyCode:'USD'}};}
function day(date:string,sessions=100,hours=[row(date,8,20),row(date,9,80)],details=[detail(date,8,20),detail(date,9,80)]):Ga4CachedReport[]{return [
 {storeDate:date,kind:'total',capturedAt,report:report([],[{dimensions:{},metrics:counts(sessions,60,5,900)}])},
 {storeDate:date,kind:'hourly',capturedAt,report:report(['dateHour'],hours)},
 {storeDate:date,kind:'detail',capturedAt,report:report(detailDimensions,details)},
];}
const current=day('2026-10-15'),previous=day('2026-10-14',80);
const nullSummary={sessions:null,engagedSessions:null,purchases:null,revenue:null},zeroSummary={sessions:0,engagedSessions:0,purchases:0,revenue:0};

describe('cached GA4 dashboard',()=>{
 it('retains every complete group for platform pagination without changing bounded dashboard defaults',()=>{
  const pages=Array.from({length:245},(_,index)=>`/page-${String(index).padStart(3,'0')}-`+'界'.repeat(1500));
  const reports=[...day('2026-10-15',50000,undefined,pages.map((landingPage,index)=>detail('2026-10-15',8,500-index,{landingPage,sessionSource:`source-${index}`}))),...day('2026-10-14',40000,undefined,pages.map((landingPage,index)=>detail('2026-10-14',8,400-index,{landingPage,sessionSource:`source-${index}`})))];
  const full=buildGa4Dashboard(reports,filters,{nowMs:now,completeGroups:true}),bounded=buildGa4Dashboard(reports,filters,{nowMs:now});
  expect(full.pages).toHaveLength(245);expect(full.sources).toHaveLength(245);expect(full.pages.at(-1)).toMatchObject({label:pages[244],current:{sessions:256},previous:{sessions:156}});
  expect(full.groupCounts).toMatchObject({pages:245,sources:245});expect(full.current).toEqual(bounded.current);expect(full.previous).toEqual(bounded.previous);expect(full.current.sessions).toBe(50000);
  expect(bounded.pages.length).toBeLessThanOrEqual(200);expect(bounded.sources.length).toBeLessThanOrEqual(100);expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(950000);
  expect(full.filterOptions.pages.length).toBeLessThanOrEqual(200);
 });
 it('uses independent totals for the selected and actual prior period, while grouping only detail',()=>{
  const reports=day('2026-10-15',100,undefined,[detail('2026-10-15',8,40),detail('2026-10-15',9,30,{sessionSource:'facebook',landingPage:'/glow',countryId:'CA',deviceCategory:'mobile'})]);
  const result=buildGa4Dashboard([...reports,...previous],filters,{nowMs:now});
  expect(result.current).toEqual({sessions:100,engagedSessions:60,purchases:5,revenue:900});expect(result.previous.sessions).toBe(80);
  expect(result.sources.find(group=>group.label==='google')?.current.sessions).toBe(40);
  expect(result.sources.find(group=>group.label==='facebook')?.current.sessions).toBe(30);
  expect(result.daily).toHaveLength(30);expect(result.daily.at(-1)).toMatchObject({date:'2026-10-15',comparisonDate:'2026-10-14',current:{sessions:100},previous:{sessions:80}});
  expect(result).toMatchObject({propertyId:'292550743',timezone:'America/New_York',currency:'USD',latestCapturedAt:capturedAt,matchedThroughHour:null,coverage:{requestedDays:1,capturedDays:1,missingDates:[],availableFrom:'2026-10-14',availableTo:'2026-10-15'}});
 });
 it('applies exact raw country/source/device/page filters together and retains raw group labels',()=>{
  const reports=day('2026-10-15',999,undefined,[detail('2026-10-15',8,40),detail('2026-10-15',9,30,{sessionSource:'facebook'}),detail('2026-10-15',10,10,{countryId:'CA'})]);
  const result=buildGa4Dashboard(reports,{...filters,market:'US',source:'google',device:'desktop',page:'/dream'},{nowMs:now});
  expect(result.current).toEqual({sessions:40,engagedSessions:20,purchases:1,revenue:400});expect(result.pages).toEqual([{label:'/dream',current:{sessions:40,engagedSessions:20,purchases:1,revenue:400},previous:nullSummary}]);
  expect(result.filterOptions.sources).toContain('facebook');expect(result.filterOptions.markets).toContain('CA');
 });
 it('distinguishes captured zero matching rows from an absent day',()=>{
  const empty=day('2026-10-15',0,[],[]);empty[0].report.rows=[];empty[0].report.rowCount=0;
  expect(buildGa4Dashboard(empty,filters,{nowMs:now}).current).toEqual(zeroSummary);
  expect(buildGa4Dashboard(current,{...filters,source:'never-observed'},{nowMs:now}).current).toEqual(zeroSummary);
  const missing=buildGa4Dashboard([],filters,{nowMs:now});expect(missing.current).toEqual(nullSummary);expect(missing.previous).toEqual(nullSummary);expect(missing.coverage.missingDates).toEqual(['2026-10-15']);
 });
 it('withholds period and group totals if any selected or comparison day is missing',()=>{
  const result=buildGa4Dashboard([...current,...day('2026-10-13')],{...filters,from:'2026-10-14'},{nowMs:now});
  expect(result.current).toEqual(nullSummary);expect(result.previous).toEqual(nullSummary);expect(result.coverage).toMatchObject({requestedDays:2,capturedDays:1,missingDates:['2026-10-14']});
  expect(result.pages[0].current).toEqual(nullSummary);expect(result.daily.find(point=>point.date==='2026-10-14')?.current).toEqual(nullSummary);
 });
 it('matches today and every context comparison to the exclusive latest reported GA hour',()=>{
  const today=day('2026-10-16',999,[row('2026-10-16',8,30),row('2026-10-16',9,500)],[detail('2026-10-16',8,30),detail('2026-10-16',9,500)]);
  const result=buildGa4Dashboard([...today,...current,...previous],{...filters,from:'2026-10-16',to:'2026-10-16',mode:'partial'},{nowMs:now});
  expect(result.matchedThroughHour).toBe(9);expect(result.current.sessions).toBe(30);expect(result.previous.sessions).toBe(20);
  expect(result.daily.find(point=>point.date==='2026-10-15')).toMatchObject({current:{sessions:20},previous:{sessions:20}});
  expect(result.sources[0].current.sessions).toBe(30);
 });
 it('caps the exclusive GA cutoff at the server store hour and applies it to filtered detail',()=>{
  const today=day('2026-10-16',999,[row('2026-10-16',8,30),row('2026-10-16',12,500)],[detail('2026-10-16',8,30),detail('2026-10-16',9,500)]);
  const result=buildGa4Dashboard([...today,...current],{...filters,from:'2026-10-16',to:'2026-10-16',mode:'partial',source:'google'},{nowMs:Date.parse('2026-10-16T13:45:00Z')});
  expect(result.matchedThroughHour).toBe(9);expect(result.current.sessions).toBe(30);expect(result.previous.sessions).toBe(20);
 });
 it('keeps earlier period days complete and clips only the last selected/comparison days, while chart context remains matched-hour',()=>{
  const today=day('2026-10-16',999,[row('2026-10-16',8,30),row('2026-10-16',9,500)],[detail('2026-10-16',8,30),detail('2026-10-16',9,500)]),older=day('2026-10-13',60,[row('2026-10-13',8,10),row('2026-10-13',9,50)],[detail('2026-10-13',8,10),detail('2026-10-13',9,50)]),selected={...filters,from:'2026-10-15',to:'2026-10-16',mode:'partial' as const};
  const reports=[...today,...current,...previous,...older],result=buildGa4Dashboard(reports,selected,{nowMs:now});
  expect(result.current.sessions).toBe(130);expect(result.previous.sessions).toBe(80);expect(result.pages[0].current.sessions).toBe(130);expect(result.pages[0].previous.sessions).toBe(80);
  expect(result.daily.find(point=>point.date==='2026-10-15')).toMatchObject({current:{sessions:20},previous:{sessions:10}});
  const filtered=buildGa4Dashboard(reports,{...selected,source:'google'},{nowMs:now});expect(filtered.current.sessions).toBe(130);expect(filtered.previous.sessions).toBe(80);
 });
 it('keeps overlapping calendar dates separate when one is a complete selected day and the final matched comparison day',()=>{
  const today=day('2026-10-16',999,[row('2026-10-16',8,30),row('2026-10-16',9,500)]),selected={...filters,from:'2026-10-15',to:'2026-10-16',mode:'partial' as const,compare:'custom' as const,compareFrom:'2026-10-14',compareTo:'2026-10-15'},result=buildGa4Dashboard([...today,...current,...previous],selected,{nowMs:now});
  expect(result.current.sessions).toBe(130);expect(result.previous.sessions).toBe(100);
  expect(result.pages[0].current.sessions).toBe(120);expect(result.pages[0].previous.sessions).toBe(120);
 });
 it('retains unknown multi-day totals when no final completed hour exists',()=>{
  const result=buildGa4Dashboard([...day('2026-10-16',999,[]),...current,...previous,...day('2026-10-13',60)],{...filters,from:'2026-10-15',to:'2026-10-16',mode:'partial'},{nowMs:now});
  expect(result.current).toEqual(nullSummary);expect(result.previous).toEqual(nullSummary);expect(result.pages[0].current).toEqual(nullSummary);expect(result.pages[0].previous).toEqual(nullSummary);
 });
 it.each([{hours:[]},{hours:[row('2026-10-16',0,0)]}])('does not invent an intraday total when no completed GA hour is available',({hours})=>{
  const result=buildGa4Dashboard([...day('2026-10-16',100,hours),...current],{...filters,from:'2026-10-16',to:'2026-10-16',mode:'partial'},{nowMs:now});
  expect(result.matchedThroughHour).toBeNull();expect(result.current).toEqual(nullSummary);expect(result.previous).toEqual(nullSummary);expect(result.daily.at(-1)?.current).toEqual(nullSummary);
 });
 it('keeps seven-day comparison offsets consistent in the thirty-day context',()=>{
  const selected={...filters,from:'2026-10-09'},result=buildGa4Dashboard([...current,...previous],selected,{nowMs:now});
  expect(result.comparison).toEqual({from:'2026-10-02',to:'2026-10-08'});expect(result.daily.at(-1)?.comparisonDate).toBe('2026-10-08');expect(result.current).toEqual(nullSummary);
 });
 it('uses coherent bundle metadata to serve context totals without loading context detail bodies',()=>{
  const reports=[...current,...previous],availableDays=reports.map(({storeDate,kind,capturedAt})=>({storeDate,kind,capturedAt}));
  const result=buildGa4Dashboard(reports.filter(item=>!(item.storeDate==='2026-10-14'&&item.kind==='detail')),filters,{nowMs:now,availableDays});
  expect(result.daily.find(point=>point.date==='2026-10-14')?.current.sessions).toBe(80);expect(result.current.sessions).toBe(100);
  const filtered=buildGa4Dashboard(reports.filter(item=>!(item.storeDate==='2026-10-14'&&item.kind==='detail')),{...filters,source:'google'},{nowMs:now,availableDays});expect(filtered.previous).toEqual(nullSummary);
 });
 it('rejects incomplete or mixed-version daily bundles and ignores reports outside thirty-day retention',()=>{
  const mixed=current.map(item=>item.kind==='detail'?{...item,capturedAt:'2026-10-16T16:30:00Z'}:item),result=buildGa4Dashboard([...mixed,...day('2026-09-01')],filters,{nowMs:now});
  expect(result.current).toEqual(nullSummary);expect(result.coverage.availableFrom).toBeNull();
  expect(buildGa4Dashboard(current.filter(item=>item.kind!=='detail'),filters,{nowMs:now}).current).toEqual(nullSummary);
 });
 it('reports actual retained quality flags without fabricating user counts or conversion rates',()=>{
  const reports=day('2026-10-15');reports[0].report.metadata={...reports[0].report.metadata,subjectToThresholding:true,dataLossFromOtherRow:true,samplingMetadatas:[{samplesReadCount:'10',samplingSpaceSize:'100'}],schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'sessions',restrictedMetricTypes:['REVENUE_DATA']}]},dataTruncationReasons:[{reason:'OTHER'}]};
  const result=buildGa4Dashboard(reports,filters,{nowMs:now});expect(result.quality).toEqual({sampled:true,thresholded:true,dataLossFromOtherRow:true,restricted:true,truncated:true});expect(result.current).not.toHaveProperty('users');expect(result.current).not.toHaveProperty('cvr');
 });
 it('bounds high-cardinality groups and options after computing full totals, retaining original counts and exact selected labels',()=>{
  const pages=Array.from({length:500},(_,index)=>'/'+String(index).padStart(4,'0')+'-'+'x'.repeat(2042)),rows=pages.map((landingPage,index)=>detail('2026-10-15',8,index===499?2:1000-index*2,{landingPage,sessionSource:`source-${String(index).padStart(3,'0')}-`+'s'.repeat(501)})),reports=day('2026-10-15',12345,undefined,rows);
  const result=buildGa4Dashboard(reports,filters,{nowMs:now});
  expect(result.current.sessions).toBe(12345);expect(result.daily.at(-1)?.current.sessions).toBe(12345);
  expect(result.pages.length).toBeLessThanOrEqual(200);expect(result.sources.length).toBeLessThanOrEqual(100);expect(result.filterOptions.pages.length).toBeLessThanOrEqual(200);expect(result.filterOptions.sources.length).toBeLessThanOrEqual(100);
  expect(result.groupCounts).toMatchObject({pages:500,sources:500});expect(result.filterOptionCounts).toMatchObject({pages:500,sources:500});expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1000000);
  expect(result.filterOptions.pages[0]).toBe(pages[0]);
  const selected=buildGa4Dashboard(reports,{...filters,page:pages[499]},{nowMs:now});expect(selected.current.sessions).toBe(2);expect(selected.filterOptions.pages).toContain(pages[499]);expect(selected.pages[0].label).toBe(pages[499]);
 });
 it('enforces the byte budget for multibyte labels while retaining a selected low-volume identity verbatim',()=>{
  const pages=Array.from({length:500},(_,index)=>'/'+String(index).padStart(4,'0')+'-'+'界'.repeat(1500)+'x'.repeat(542)),reports=day('2026-10-15',12345,undefined,pages.map((landingPage,index)=>detail('2026-10-15',8,index===499?2:1000-index*2,{landingPage})));
  const result=buildGa4Dashboard(reports,filters,{nowMs:now});
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(950000);expect(result.pages.length+result.filterOptions.pages.length).toBeLessThan(400);expect(result.pages[0].label).toBe(pages[0]);expect(result.current.sessions).toBe(12345);expect(result.groupCounts?.pages).toBe(500);
  const selected=buildGa4Dashboard(reports,{...filters,page:pages[499]},{nowMs:now});expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(950000);expect(selected.filterOptions.pages).toContain(pages[499]);expect(selected.pages[0].label).toBe(pages[499]);expect(selected.current.sessions).toBe(2);expect(selected.filterOptionCounts?.pages).toBe(500);
 });
 it('ranks filter options by selected and prior volume rather than alphabetical labels',()=>{
  const result=buildGa4Dashboard([...day('2026-10-15',100,undefined,[detail('2026-10-15',8,20,{landingPage:'/a'}),detail('2026-10-15',8,2,{landingPage:'/z'})]),...day('2026-10-14',500,undefined,[detail('2026-10-14',8,500,{landingPage:'/z'})])],filters,{nowMs:now});
  expect(result.filterOptions.pages).toEqual(['/z','/a']);expect(result.pages[0].label).toBe('/a');expect(result.current.sessions).toBe(100);expect(result.previous.sessions).toBe(500);
 });
 it('retains the current leading groups even when hundreds of prior-only groups have much larger prior volume',()=>{
  const reports=[...day('2026-10-15',2,undefined,[detail('2026-10-15',8,2,{landingPage:'/z-current',sessionSource:'z-current'})]),...day('2026-10-14',100000,undefined,Array.from({length:201},(_,index)=>detail('2026-10-14',8,100000,{landingPage:`/prior-${index}`,sessionSource:`prior-${index}`})))],result=buildGa4Dashboard(reports,filters,{nowMs:now});
  expect(result.pages[0]).toMatchObject({label:'/z-current',current:{sessions:2}});expect(result.sources[0]).toMatchObject({label:'z-current',current:{sessions:2}});expect(result.groupCounts).toMatchObject({pages:202,sources:202});expect(result.pages).toHaveLength(200);expect(result.sources).toHaveLength(100);
 });
});

describe('GA4 dashboard query bounds',()=>{
 it('defaults to the New York current day with a previous-day comparison',()=>{
  expect(parseGa4DashboardFilters(new URLSearchParams(),Date.parse('2026-10-17T02:00:00Z'))).toMatchObject({from:'2026-10-16',to:'2026-10-16',compare:'previous',mode:'partial'});
 });
 it.each(['from=2026-10-01&to=2026-10-31','from=2026-02-30&to=2026-03-01','from=2026-10-17&to=2026-10-17','stream=Online+Store','compare=custom&compareFrom=2026-10-01&compareTo=2026-10-04','from=2026-10-15&from=2026-10-14','device=mobile%00','compare=unknown'])('rejects an unsafe or unsupported request: %s',query=>{
  expect(()=>parseGa4DashboardFilters(new URLSearchParams(query),now)).toThrow();
 });
});
