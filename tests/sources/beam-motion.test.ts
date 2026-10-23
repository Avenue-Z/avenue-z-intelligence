import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Client} from '../../lib/analytics/contracts';
import {fetchBeamMotionSource,beamMotionQualification,BEAM_MOTION_ORGANIZATION,BEAM_MOTION_WORKSPACE,BEAM_META_ACCOUNT} from '../../lib/sources/beam-motion';
import {motionMcpCall} from '../../lib/sources/motion-mcp';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';
vi.mock('../../lib/sources/motion-mcp',()=>({motionMcpCall:vi.fn()}));
const call=vi.mocked(motionMcpCall),client={id:'beam',timezone:'America/New_York',currency:'USD'} as Client,connection={id:'beam-motion',clientId:'beam'},now=new Date('2026-10-16T18:00:00Z');
const auth={contractVersion:'v1',status:'success',data:{organizations:[{id:BEAM_MOTION_ORGANIZATION,workspaces:[{id:BEAM_MOTION_WORKSPACE}]}]}};
function report(offset=0,next:string|null=null,date='2026-10-15'){
 const ad={ad:{dataSourceFacebookId:BEAM_META_ACCOUNT,adId:String(10+offset),adName:'Test ad',adsetId:'20',adsetName:'Set',campaignId:'30',campaignName:'Campaign'},insights:{spend:offset?6:4,impressions:offset?60:40,clicks_all:offset?6:4}};
 return {contractVersion:'v1',status:'success',nextCursor:next,data:{data:{insightsResult:{reportPercentCompletion:100,lastCachedTime:'2026-10-16T04:46:00Z',pagination:{totalCount:2,offset,pageSize:1,nextOffset:next?offset+1:null},data:{insights:[ad],aggregatedInsights:{date_start:`${date}T00:00:00.000Z`,adIds:['10','11'],spend:10,impressions:100,clicks_all:10}}}}}};
}
beforeEach(()=>call.mockReset());
// Reduced from the Oct 20 provider response: the adId cache was empty while
// name groups included several underlying ads and an independent account sum.
function emptyLiveReport(){return {contractVersion:'v1',status:'success',nextCursor:null,data:{data:{insightsResult:{reportPercentCompletion:100,isLiveData:true,cacheHit:true,pagination:{totalCount:0,pageSize:25,offset:0,nextOffset:null},data:{insights:[]}}}}};}
function nameReport(offset=0,next:string|null=null){
 const response=report(offset,next),row=response.data.data.insightsResult.data.insights[0],adIds=offset?['11']:['10','12'];
 return {...response,data:{data:{insightsResult:{...response.data.data.insightsResult,isLiveData:false,cacheHit:true,data:{insights:[{...row,groupKey:`name-${offset}`,adIds,numberAds:adIds.length,ads:[],insights:{...row.insights,adIds}}],aggregatedInsights:{...response.data.data.insightsResult.data.aggregatedInsights,adIds:['10','11','12']}}}}}};
}
function closedIntradayReports(){
 const primary=[report(0,'primary-next','2026-10-16'),report(1,null,'2026-10-16')],names=[nameReport(0,'names-next'),nameReport(1)];
 for(const response of primary)response.data.data.insightsResult.lastCachedTime='2026-10-16T16:14:33.827Z';
 for(const response of names){const r=response.data.data.insightsResult;r.lastCachedTime='2026-10-17T04:46:00Z';r.data.aggregatedInsights.date_start='2026-10-16T00:00:00.000Z';r.data.aggregatedInsights.spend=20;r.data.insights[0].insights.spend*=2;}
 return {primary,names};
}
describe('Beam Motion daily reporting',()=>{
 it.each([false,true])('replaces a fully validated intraday primary cache before publishing closed-date totals (verified timezone %s)',async(verified)=>{
  const {primary,names}=closedIntradayReports();call.mockResolvedValueOnce(auth);for(const response of [...primary,...names])call.mockResolvedValueOnce(response);
  const batch=await fetchBeamMotionSource({...connection,...verified?{reportingTimezone:client.timezone}:{}},client,{from:'2026-10-16',to:'2026-10-16'},'test-token',fetch,Date.now()+10000,new Date('2026-10-20T14:00:00Z'));
  expect(batch.rows.find(r=>r.dataset==='media')).toMatchObject({value:20,quality:'complete',dimensions:{provider_as_of:'2026-10-17T04:46:00.000Z',reporting_timezone:verified?client.timezone:'provider_account_timezone_unverified'}});
  expect(batch.rows.some(r=>r.dataset==='creatives')).toBe(false);expect(batch.coverageThrough).toBe(verified?'2026-10-17T04:00:00Z':null);
  expect(call.mock.calls.slice(1).map(c=>c[2].groupBy)).toEqual(['adId','adId','name','name']);
  expect(call.mock.calls[3][2]).not.toHaveProperty('cursor');
  expect(validateRegisteredBatch(batch,beamMotionQualification(batch))).toEqual(batch);
 });
 it('rejects a stale name cache after a complete but intraday closed-date primary',async()=>{
  const {primary,names}=closedIntradayReports();for(const response of names)response.data.data.insightsResult.lastCachedTime='2026-10-16T23:00:00Z';
  call.mockResolvedValueOnce(auth);for(const response of [...primary,...names])call.mockResolvedValueOnce(response);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-16',to:'2026-10-16'},'test-token',fetch,Date.now()+10000,new Date('2026-10-20T14:00:00Z'))).rejects.toThrow('name-group cache predates');
  expect(call.mock.calls.slice(1).map(c=>c[2].groupBy)).toEqual(['adId','adId','name','name']);
 });
 it.each(['account','pagination','reconciliation'])('preserves %s failures instead of recovering an invalid intraday primary',async(reason)=>{
  const {primary,names}=closedIntradayReports(),last=primary[1].data.data.insightsResult;
  if(reason==='account')last.data.insights[0].ad.dataSourceFacebookId='9';if(reason==='pagination')last.pagination.nextOffset=2;if(reason==='reconciliation')last.data.insights[0].insights.spend=5;
  call.mockResolvedValueOnce(auth);for(const response of [...primary,...names])call.mockResolvedValueOnce(response);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-16',to:'2026-10-16'},'test-token',fetch,Date.now()+10000,new Date('2026-10-20T14:00:00Z'))).rejects.toThrow(/Motion/);
  expect(call.mock.calls.slice(1).map(c=>c[2].groupBy)).toEqual(['adId','adId']);
 });
 it('recovers only account spend from complete name groups when the adId cache has the known empty live shape',async()=>{
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(report(0,'next')).mockResolvedValueOnce(report(1));
  const original=await fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now),registered=beamMotionQualification(original);
  call.mockReset();call.mockResolvedValueOnce(auth).mockResolvedValueOnce(emptyLiveReport()).mockResolvedValueOnce(nameReport(0,'names-next')).mockResolvedValueOnce(nameReport(1));
  const batch=await fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now);
  expect(batch.rows).toHaveLength(1);expect(batch.rows[0]).toMatchObject({dataset:'media',metric:'platform_spend',value:10,definition:'motion_meta_account_spend_provider_date_cached',population:'motion_meta_account_report',dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-16T04:46:00.000Z'}});
  expect(batch.coverageThrough).toBeNull();expect(batch.grain).toBe('daily');expect(batch.rows.some(row=>row.dataset==='creatives'||row.dataset==='overview')).toBe(false);
  expect(call.mock.calls[2][2]).toMatchObject({groupBy:'name'});expect(call.mock.calls[3][2]).toMatchObject({groupBy:'name',cursor:'names-next'});
  expect(validateRegisteredBatch(batch,registered)).toEqual(batch);
  expect(beamMotionQualification(batch).profiles.every(profile=>profile.dataset==='media')).toBe(true);
  expect(beamMotionQualification(batch).reconciliationEvidence).toContain('Name-group');
 });
 it.each(['duplicate-group','overlap','missing-member','extra-member','representative','insight-members','group-size','wrong-account','spend','changed-cache','changed-count-aggregate','changed-aggregate-members','changed-aggregate-date','old-cache'])('rejects %s name-group fallback evidence',async(reason)=>{
  const first=nameReport(0,'names-next'),second=nameReport(1),a=first.data.data.insightsResult,b=second.data.data.insightsResult;
  if(reason==='duplicate-group')b.data.insights[0].groupKey=a.data.insights[0].groupKey;
  if(reason==='overlap'){b.data.insights[0].adIds=['11','12'];b.data.insights[0].insights.adIds=['11','12'];b.data.insights[0].numberAds=2;}
  if(reason==='missing-member'){a.data.insights[0].adIds=['10'];a.data.insights[0].insights.adIds=['10'];a.data.insights[0].numberAds=1;}
  if(reason==='extra-member'){a.data.insights[0].adIds=['10','13'];a.data.insights[0].insights.adIds=['10','13'];}
  if(reason==='representative')a.data.insights[0].ad.adId='99';
  if(reason==='insight-members')a.data.insights[0].insights.adIds=['10','13'];
  if(reason==='group-size')a.data.insights[0].numberAds=3;
  if(reason==='wrong-account')b.data.insights[0].ad.dataSourceFacebookId='9';
  if(reason==='spend')b.data.insights[0].insights.spend=5;
  if(reason==='changed-cache')b.lastCachedTime='2026-10-16T05:00:00Z';
  if(reason==='changed-count-aggregate')b.data.aggregatedInsights.impressions=101;
  if(reason==='changed-aggregate-members')b.data.aggregatedInsights.adIds=['10','11','13'];
  if(reason==='changed-aggregate-date')b.data.aggregatedInsights.date_start='2026-10-14T00:00:00.000Z';
  if(reason==='old-cache')a.lastCachedTime=b.lastCachedTime='2026-10-15T23:00:00Z';
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(emptyLiveReport()).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now)).rejects.toThrow(/Motion/);
 });
 it.each(['not-live','not-cache-hit','nonempty','unfinished-pagination','unexpected-cursor'])('does not conceal a %s adId failure with grouped fallback',async(reason)=>{
  const placeholder=emptyLiveReport(),r=placeholder.data.data.insightsResult;
  if(reason==='not-live')r.isLiveData=false;if(reason==='not-cache-hit')r.cacheHit=false;
  if(reason==='nonempty')Object.assign(r.data,{insights:report().data.data.insightsResult.data.insights});
  if(reason==='unfinished-pagination')Object.assign(r.pagination,{nextOffset:1});
  if(reason==='unexpected-cursor')Object.assign(placeholder,{nextCursor:'unexpected'});
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(placeholder);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now)).rejects.toThrow(/Motion/);
  expect(call).toHaveBeenCalledTimes(2);
 });
 it('reads all ad pages and uses independent full-account spend, preserving unverified provider timezone',async()=>{
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(report(0,'next')).mockResolvedValueOnce(report(1));
  const batch=await fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now);
  expect(batch.coverageThrough).toBeNull();expect(batch.grain).toBe('daily');expect(batch.rows.filter(r=>r.dataset==='overview')).toEqual([]);
  expect(batch.rows.find(r=>r.metric==='platform_spend')).toMatchObject({value:10,dimensions:{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-16T04:46:00.000Z'}});
  expect(batch.rows.filter(r=>r.metric==='motion_ad_spend').map(r=>r.value)).toEqual([4,6]);
  expect(call.mock.calls[2][2]).toMatchObject({cursor:'next',groupBy:'adId',limit:25,includeNorthbeam:false});
  expect(validateRegisteredBatch(batch,beamMotionQualification(batch))).toEqual(batch);
 });
 it('emits closed-day Meta-only headline spend only with independently verified store timezone',async()=>{
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(report(0,'next')).mockResolvedValueOnce(report(1));
  const batch=await fetchBeamMotionSource({...connection,reportingTimezone:client.timezone},client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now);
  expect(batch.coverageThrough).toBe('2026-10-16T04:00:00Z');expect(batch.rows.find(r=>r.dataset==='overview')).toMatchObject({metric:'spend',value:10,definition:'motion_meta_only_spend_closed_store_day'});
 });
 it('retains current-day cached platform spend without inventing hourly coverage',async()=>{
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(report(0,'next','2026-10-16')).mockResolvedValueOnce(report(1,null,'2026-10-16'));
  const batch=await fetchBeamMotionSource({...connection,reportingTimezone:client.timezone},client,{from:'2026-10-16',to:'2026-10-16'},'test-token',fetch,Date.now()+10000,now);
  expect(batch.coverageThrough).toBeNull();expect(batch.rows.find(r=>r.metric==='platform_spend')).toMatchObject({value:10,quality:'partial'});expect(batch.rows.every(r=>!r.start&&!r.end)).toBe(true);
 });
 it.each(['duplicate','aggregate','count','account','date','missing-cursor','changed-cache'])('rejects %s incomplete or changed reporting',async(reason)=>{
  const first=report(0,'next'),second=report(1);const a=second.data.data.insightsResult;
  if(reason==='duplicate')a.data.insights[0].ad.adId='10';if(reason==='aggregate')a.data.aggregatedInsights.spend=11;if(reason==='count')a.pagination.totalCount=3;if(reason==='account')a.data.insights[0].ad.dataSourceFacebookId='9';if(reason==='date')first.data.data.insightsResult.data.aggregatedInsights.date_start='2026-10-14T00:00:00.000Z';if(reason==='missing-cursor')delete (first as {nextCursor?:string|null}).nextCursor;if(reason==='changed-cache')a.lastCachedTime='2026-10-16T05:00:00Z';
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now)).rejects.toThrow(/Motion/);
 });
 it('rejects pagination that reconciles counts but omits full-account spend',async()=>{
  const second=report(1);second.data.data.insightsResult.data.insights[0].insights.spend=5;
  call.mockResolvedValueOnce(auth).mockResolvedValueOnce(report(0,'next')).mockResolvedValueOnce(second);
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now)).rejects.toThrow('reconcile');
 });
 it('rejects another workspace before requesting any report',async()=>{
  call.mockResolvedValueOnce({...auth,data:{organizations:[]}});
  await expect(fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now)).rejects.toThrow('Beam workspace');expect(call).toHaveBeenCalledTimes(1);
 });
});

describe('Motion provider-owned marketing labels',()=>{
 async function labels(adNames:Partial<ReturnType<typeof report>['data']['data']['insightsResult']['data']['insights'][number]['ad']>){
  const first=report(0,'next');Object.assign(first.data.data.insightsResult.data.insights[0].ad,adNames);call.mockResolvedValueOnce(auth).mockResolvedValueOnce(first).mockResolvedValueOnce(report(1));return fetchBeamMotionSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'test-token',fetch,Date.now()+10000,now);
 }
 it('preserves actual long ad, ad set and campaign names with dates, IDs and underscores',async()=>{
  const names={adName:'MelissaParrella_Product_20261013_trybe=7cccd2f0',adsetName:'Kids_Purchase_TrybeUGC_Interest-Parents(1-8)_25+_7DC',campaignName:'Adv_BeamKids_Purchase_20261013_120227717418630257'},batch=await labels(names),ad=batch.rows.find(row=>row.metric==='motion_ad_spend')!;
  expect(ad.dimensions).toMatchObject({ad:names.adName,adset:names.adsetName,campaign:names.campaignName,ad_id:'10',adset_id:'20',campaign_id:'30'});expect(ad.value).toBe(4);
 });
 it('removes control characters and email addresses without redacting surrounding marketing copy',async()=>{
  const batch=await labels({adName:'  Dream\u0000 Launch\ncreator@example.com - Copy  ',adsetName:'Kids\u202e_25+_7DC',campaignName:'Campaign team+ads@beam.example | October'}),ad=batch.rows.find(row=>row.metric==='motion_ad_spend')!;
  expect(ad.dimensions.ad).toBe('Dream Launch [private] - Copy');expect(ad.dimensions.adset).toBe('Kids _25+_7DC');expect(ad.dimensions.campaign).toBe('Campaign [private] | October');expect(JSON.stringify(ad.dimensions)).not.toContain('@');
 });
 it('bounds provider labels while preserving ordinary long copy and omitting untargeted provider metadata',async()=>{
  const name='LongCreativeAssetName_20261013_Glow_Launch - Copy',batch=await labels({adName:name,adsetName:'Marketing copy '.repeat(100),campaignName:'October Growth & Product Launch'}),ad=batch.rows.find(row=>row.metric==='motion_ad_spend')!;
  expect(ad.dimensions.ad).toBe(name);expect(ad.dimensions.adset.length).toBeLessThanOrEqual(300);expect(ad.dimensions.adset).toMatch(/^Marketing copy/);expect(Object.keys(ad.dimensions).sort()).toEqual(['ad','ad_id','adset','adset_id','campaign','campaign_id','channel','provider_as_of','reporting_timezone']);expect(validateRegisteredBatch(batch,beamMotionQualification(batch))).toEqual(batch);
 });
});
