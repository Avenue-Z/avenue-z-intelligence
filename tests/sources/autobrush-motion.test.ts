import {describe,expect,it} from 'vitest';
import type {Client,SourceBatch} from '../../lib/analytics/contracts';
import {fetchAutobrushMotionSource,autobrushMotionQualification} from '../../lib/sources/autobrush-motion';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';

const client={id:'autobrush',timezone:'America/New_York',currency:'USD'} as Client;
const connection={id:'autobrush-motion',clientId:'autobrush'};
const window={from:'2026-10-21',to:'2026-10-21'};
const now=new Date('2026-10-22T16:00:00Z');
const organization='699496be6f1a754daac7f10e',workspace='6ac52fac7231e870caa82acb',account='401761026978213';
const auth=()=>({contractVersion:'v1',status:'success',data:{organizations:[{id:organization,workspaces:[{id:workspace}]}]}});
const aggregate=(ids=['10','11'],date=window.from)=>({date_start:`${date}T00:00:00.000Z`,adIds:ids,spend:10,impressions:100,clicks_all:10});
function ad(id='10',spend=4){return {ad:{dataSourceFacebookId:account,adId:id,adName:'Autobrush_Creative_20261021',adsetId:'20',adsetName:'Parents_25+',campaignId:'30',campaignName:'Autobrush Purchase'},insights:{spend,impressions:spend*10,clicks_all:spend}};}
function report(offset=0,next:string|null=null,date=window.from){return {contractVersion:'v1',status:'success',nextCursor:next,data:{data:{insightsResult:{reportPercentCompletion:100,lastCachedTime:'2026-10-22T09:00:00Z',pagination:{totalCount:2,offset,pageSize:1,nextOffset:next?offset+1:null},data:{insights:[ad(String(10+offset),offset?6:4)],aggregatedInsights:aggregate(undefined,date)}}}}};}
function emptyLiveReport(){return {contractVersion:'v1',status:'success',nextCursor:null,data:{data:{insightsResult:{reportPercentCompletion:100,isLiveData:true,cacheHit:true,pagination:{totalCount:0,pageSize:25,offset:0,nextOffset:null},data:{insights:[]}}}}};}
function nameReport(offset=0,next:string|null=null){
 const response=report(offset,next),r=response.data.data.insightsResult,adIds=offset?['11']:['10','12'];
 return {...response,data:{data:{insightsResult:{...r,isLiveData:false,cacheHit:true,data:{insights:[{...r.data.insights[0],groupKey:`name-${offset}`,adIds,numberAds:adIds.length,insights:{...r.data.insights[0].insights,adIds}}],aggregatedInsights:aggregate(['10','11','12'])}}}}};
}
// Keep Motion's actual MCP initialize/notification/tool envelope, replacing only
// network I/O. Every fixture is consumed by the real MCP parser and adapter.
function transport(payloads:unknown[]){
 const calls:{tool:string;args:Record<string,unknown>}[]=[];
 const fetcher=(async(_input,init)=>{
  const body=JSON.parse(String(init?.body));
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  calls.push({tool:body.params.name,args:body.params.arguments});
  if(!payloads.length)throw Error('Unexpected extra Motion request');
  return Response.json({jsonrpc:'2.0',id:2,result:{structuredContent:payloads.shift()}});
 }) as typeof fetch;
 return {calls,fetcher};
}
async function fetchReport(payloads:unknown[],options:{dateWindow?:typeof window;at?:Date;source?:typeof connection & {reportingTimezone?:string};brand?:Client}={}){
 const io=transport(payloads);
 const batch=await fetchAutobrushMotionSource(options.source??connection,options.brand??client,options.dateWindow??window,'fixture-motion-token',io.fetcher,Date.now()+10000,options.at??now);
 return {batch,calls:io.calls};
}

describe('Autobrush Motion provider-date reporting',()=>{
 it('reads all nine pages and reconciles 205 ads to independent account totals',async()=>{
  const ids=Array.from({length:205},(_,i)=>String(1000+i));
  const pages=Array.from({length:9},(_,page)=>{
   const offset=page*25,hasNext=page<8;
   return {contractVersion:'v1',status:'success',nextCursor:hasNext?`page-${page+1}`:null,data:{data:{insightsResult:{reportPercentCompletion:100,lastCachedTime:'2026-10-22T09:00:00Z',pagination:{totalCount:205,offset,pageSize:25,nextOffset:hasNext?offset+25:null},data:{insights:ids.slice(offset,offset+25).map(id=>ad(id,1)),aggregatedInsights:{...aggregate(ids),spend:205,impressions:2050,clicks_all:205}}}}}};
  });
  const {batch,calls}=await fetchReport([auth(),...pages]);
  expect(batch.rows.find(row=>row.dataset==='media')).toMatchObject({date:'2026-10-21',metric:'platform_spend',value:205,currency:'USD',sourceId:'autobrush-motion'});
  expect(batch.rows.filter(row=>row.metric==='motion_ad_spend')).toHaveLength(205);
  expect(batch.rows.filter(row=>row.metric==='motion_ad_impressions').reduce((sum,row)=>sum+row.value!,0)).toBe(2050);
  expect(calls).toHaveLength(10);
  expect(calls[1]).toEqual({tool:'get_creative_insights',args:{organizationId:organization,workspaceId:workspace,insightType:'SPEND',datePreset:'CUSTOM',startDate:'2026-10-21',endDate:'2026-10-21',withAggregatedInsights:true,includeCreativeUrls:false,includeNorthbeam:false,insightGroups:['defaultKpiMetrics'],groupBy:'adId',limit:25}});
  expect(calls[9].args).toMatchObject({cursor:'page-8',groupBy:'adId'});
  expect(validateRegisteredBatch(batch,autobrushMotionQualification(batch))).toEqual(batch);
 });
 it('retains a seven-hour-old provider cache without store-day, hourly or MER coverage claims',async()=>{
  const {batch}=await fetchReport([auth(),report(0,'next'),report(1)]);
  expect(batch).toMatchObject({clientId:'autobrush',timezone:'America/New_York',currency:'USD',grain:'daily',complete:true,coverageThrough:null});
  expect(batch.rows).toHaveLength(7);
  expect(batch.rows.every(row=>row.coverageThrough===null&&!row.start&&!row.end)).toBe(true);
  expect(batch.rows.every(row=>row.dimensions.reporting_timezone==='provider_account_timezone_unverified'&&row.dimensions.provider_as_of==='2026-10-22T09:00:00.000Z')).toBe(true);
  expect(batch.rows.some(row=>row.dataset==='overview'||row.metric==='spend'||/mer/i.test(row.metric))).toBe(false);
  const qualification=autobrushMotionQualification(batch);
  expect(qualification).toMatchObject({clientId:'autobrush',queryId:'autobrush-motion:provider-calendar-day-v1',hourlyGrain:false,paginationComplete:true,reconciled:true});
  expect(qualification.profiles.every(profile=>!profile.hourly)).toBe(true);
  expect(qualification.reconciliationEvidence).toContain('Account timezone remains unverified');
 });
 it('preserves current-day partial figures and leaves the absent later hours unknown',async()=>{
  const {batch}=await fetchReport([auth(),report(0,'next','2026-10-22'),report(1,null,'2026-10-22')],{dateWindow:{from:'2026-10-22',to:'2026-10-22'}});
  expect(batch.rows.find(row=>row.dataset==='media')).toMatchObject({date:'2026-10-22',value:10,quality:'partial',coverageThrough:null});
  expect(batch.rows.every(row=>!row.start&&!row.end&&row.value!==0)).toBe(true);
 });
 it.each(['connection-client','client','timezone','currency','timezone-opt-in'])('rejects %s changes before reading provider data',async(reason)=>{
  const source={...connection},brand={...client},io=transport([]);
  if(reason==='connection-client')source.clientId='beam';
  if(reason==='client')brand.id='beam';
  if(reason==='timezone')brand.timezone='America/Los_Angeles';
  if(reason==='currency')brand.currency='CAD';
  await expect(fetchAutobrushMotionSource(reason==='timezone-opt-in'?{...source,reportingTimezone:'America/New_York'}:source,brand,window,'fixture-motion-token',io.fetcher,Date.now()+10000,now)).rejects.toThrow(/Motion.*(identity|timezone)/);
  expect(io.calls).toEqual([]);
 });
 it.each(['organization','workspace','workspace-under-another-org'])('rejects the wrong %s before requesting a report',async(reason)=>{
  const authorization=auth(),org=authorization.data.organizations[0];
  if(reason==='organization')org.id='681244cb525792672d188127';
  if(reason==='workspace')org.workspaces[0].id='681244fa7b5bf830fcc1443c';
  if(reason==='workspace-under-another-org'){org.workspaces=[];authorization.data.organizations.push({id:'other',workspaces:[{id:workspace}]});}
  const io=transport([authorization]);
  await expect(fetchAutobrushMotionSource(connection,client,window,'fixture-motion-token',io.fetcher,Date.now()+10000,now)).rejects.toThrow('Autobrush workspace');
  expect(io.calls.map(call=>call.tool)).toEqual(['get_auth_context']);
 });
 it('recovers only account spend from fully reconciled name groups after the known empty ad cache',async()=>{
  const {batch,calls}=await fetchReport([auth(),emptyLiveReport(),nameReport(0,'next'),nameReport(1)]);
  expect(batch.rows).toHaveLength(1);
  expect(batch.rows[0]).toMatchObject({dataset:'media',metric:'platform_spend',value:10,coverageThrough:null});
  expect(calls.slice(1).map(call=>call.args.groupBy)).toEqual(['adId','name','name']);
  expect(autobrushMotionQualification(batch).profiles.map(profile=>profile.dataset)).toEqual(['media']);
  expect(autobrushMotionQualification(batch).reconciliationEvidence).toContain('Name-group');
 });
 it('replaces a fully validated intraday closed-date cache without treating the later cache as coverage',async()=>{
  const first=report(0,'primary-next'),second=report(1),names=[nameReport(0,'names-next'),nameReport(1)];
  first.data.data.insightsResult.lastCachedTime=second.data.data.insightsResult.lastCachedTime='2026-10-21T21:00:00Z';
  const {batch,calls}=await fetchReport([auth(),first,second,...names]);
  expect(batch.rows).toHaveLength(1);
  expect(batch.rows[0].dimensions.provider_as_of).toBe('2026-10-22T09:00:00.000Z');
  expect(batch.coverageThrough).toBeNull();
  expect(calls.slice(1).map(call=>call.args.groupBy)).toEqual(['adId','adId','name','name']);
  expect(calls[3].args).not.toHaveProperty('cursor');
 });
 it.each(['wrong-account','spend','impressions','overlap','missing-member','group-size','representative','insight-members','changed-cache','old-cache'])('rejects %s group evidence rather than publishing a partial account total',async(reason)=>{
  const first=nameReport(0,'next'),second=nameReport(1),a=first.data.data.insightsResult,b=second.data.data.insightsResult;
  if(reason==='wrong-account')b.data.insights[0].ad.dataSourceFacebookId='289851516154147';
  if(reason==='spend')b.data.insights[0].insights.spend=5;
  if(reason==='impressions')b.data.insights[0].insights.impressions=59;
  if(reason==='overlap'){b.data.insights[0].adIds=['11','12'];b.data.insights[0].insights.adIds=['11','12'];b.data.insights[0].numberAds=2;}
  if(reason==='missing-member'){a.data.insights[0].adIds=['10'];a.data.insights[0].insights.adIds=['10'];a.data.insights[0].numberAds=1;}
  if(reason==='group-size')a.data.insights[0].numberAds=3;
  if(reason==='representative')a.data.insights[0].ad.adId='99';
  if(reason==='insight-members')a.data.insights[0].insights.adIds=['10','13'];
  if(reason==='changed-cache')b.lastCachedTime='2026-10-22T10:00:00Z';
  if(reason==='old-cache')a.lastCachedTime=b.lastCachedTime='2026-10-21T23:00:00Z';
  await expect(fetchReport([auth(),emptyLiveReport(),first,second])).rejects.toThrow(/Motion/);
 });
 it.each(['account','duplicate','spend','impressions','clicks','offset','missing-cursor','aggregate-members','aggregate-date','aggregate-count','cache'])('rejects %s pagination or reconciliation failures',async(reason)=>{
  const first=report(0,'next'),second=report(1),r=second.data.data.insightsResult;
  if(reason==='account')r.data.insights[0].ad.dataSourceFacebookId='289851516154147';
  if(reason==='duplicate')r.data.insights[0].ad.adId='10';
  if(reason==='spend')r.data.insights[0].insights.spend=5;
  if(reason==='impressions')r.data.insights[0].insights.impressions=59;
  if(reason==='clicks')r.data.insights[0].insights.clicks_all=5;
  if(reason==='offset')r.pagination.offset=0;
  if(reason==='missing-cursor')delete(first as {nextCursor?:string|null}).nextCursor;
  if(reason==='aggregate-members')r.data.aggregatedInsights.adIds=['10','12'];
  if(reason==='aggregate-date')r.data.aggregatedInsights.date_start='2026-10-20T00:00:00.000Z';
  if(reason==='aggregate-count')r.data.aggregatedInsights.impressions=99;
  if(reason==='cache')r.lastCachedTime='2026-10-22T10:00:00Z';
  await expect(fetchReport([auth(),first,second])).rejects.toThrow(/Motion/);
 });
 it('does not replace an invalid intraday account with fallback data',async()=>{
  const first=report(0,'next'),second=report(1),io=transport([auth(),first,second]);
  first.data.data.insightsResult.lastCachedTime=second.data.data.insightsResult.lastCachedTime='2026-10-21T21:00:00Z';
  second.data.data.insightsResult.data.insights[0].ad.dataSourceFacebookId='9';
  await expect(fetchAutobrushMotionSource(connection,client,window,'fixture-motion-token',io.fetcher,Date.now()+10000,now)).rejects.toThrow(/Motion/);
  expect(io.calls.map(call=>call.args.groupBy)).toEqual([undefined,'adId','adId']);
 });
 it('never converts an empty live-cache placeholder into a zero current-day observation',async()=>{
  await expect(fetchReport([auth(),emptyLiveReport(),emptyLiveReport()],{dateWindow:{from:'2026-10-22',to:'2026-10-22'}})).rejects.toThrow(/Motion/);
 });
 it.each([{from:'2026-10-23',to:'2026-10-23'},{from:'2026-10-22',to:'2026-10-21'},{from:'2026-02-30',to:'2026-03-01'}])('rejects invalid or future source dates %j',async(dateWindow)=>{
  await expect(fetchReport([],{dateWindow})).rejects.toThrow(/Motion.*(date|window)/);
 });
 it('rejects a future provider cache timestamp',async()=>{
  const first=report(0,'next');first.data.data.insightsResult.lastCachedTime='2026-10-23T09:00:00Z';
  await expect(fetchReport([auth(),first])).rejects.toThrow('future');
 });
 it('keeps provider-owned creative names while removing private email and controls',async()=>{
  const first=report(0,'next');first.data.data.insightsResult.data.insights[0].ad.adName='Autobrush_20261021\u0000 Parent\ncreator@example.com - Copy';
  const {batch}=await fetchReport([auth(),first,report(1)]);
  expect(batch.rows.find(row=>row.metric==='motion_ad_spend')?.dimensions).toMatchObject({ad:'Autobrush_20261021 Parent [private] - Copy',ad_id:'10',adset:'Parents_25+',campaign:'Autobrush Purchase'});
 });
 it('refuses qualifications that claim store-day spend, hourly intervals or coverage',async()=>{
  const {batch}=await fetchReport([auth(),report(0,'next'),report(1)]);
  for(const changed of [
   {...batch,clientId:'beam'},
   {...batch,timezone:'America/Los_Angeles'},
   {...batch,rows:[]},
   {...batch,coverageThrough:'2026-10-22T04:00:00Z'},
   {...batch,rows:[{...batch.rows[0],dataset:'overview',metric:'spend'}]},
   {...batch,rows:[{...batch.rows[0],start:'2026-10-21T04:00:00Z',end:'2026-10-21T05:00:00Z'}]},
   {...batch,rows:[{...batch.rows[0],dimensions:{...batch.rows[0].dimensions,reporting_timezone:'America/New_York'}}]},
  ] as SourceBatch[])expect(()=>autobrushMotionQualification(changed)).toThrow(/Motion/);
 });
});
