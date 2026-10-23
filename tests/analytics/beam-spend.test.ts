import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {buildBeamSpend,beamSpendChartContext,beamCreativeRows} from '../../lib/analytics/beam-spend';
import {BeamSpendWorkspace} from '../../components/analytics/beam-spend-workspace';

const client:Client={id:'beam',name:'Beam',slug:'beam',timezone:'America/New_York',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:['Meta'],recurringLabel:'Loop',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'media'};
function spend(date:string,amount:number):Observation{return {date,dataset:'media',metric:'platform_spend',value:amount,population:'motion_meta_account_report',dimensions:{channel:'meta',provider_as_of:'2026-10-08T12:00:00Z',reporting_timezone:'provider_account_timezone_unverified'},definition:'motion_meta_account_spend_provider_date_cached',currency:'USD',sourceId:'beam-motion',retrievedAt:'2026-10-08T12:05:00Z',coverageThrough:null,quality:'complete'};}
function record(rows:Observation[],selected=filters){return {...workspacePresentation(queryClient(client,rows,[],selected,{prepareAllViews:true}),selected),reviews:[],findings:[],note:{body:'',version:0}};}

it('reads the full Meta account platform total with its actual provider-date comparison and cache time',()=>{
 const result=buildBeamSpend(record([spend(filters.to,500),spend('2026-10-06',400)]),filters,new Date('2026-10-08T14:00:00Z'));
 expect(result.current).toMatchObject({spend:500,reportedDays:1,expectedDays:1,complete:true,closed:true});expect(result.previous.spend).toBe(400);expect(result.comparable).toBe(true);expect(result.asOf).toBe('2026-10-08T12:00:00Z');
});

it('keeps captured spend visible while withholding period comparisons when a report date is missing',()=>{
 const selected={...filters,from:'2026-10-05'},result=buildBeamSpend(record([spend('2026-10-05',500),spend('2026-10-07',400)],selected),selected);
 expect(result.current).toMatchObject({spend:900,reportedDays:2,expectedDays:3,complete:false});expect(result.comparable).toBe(false);
});

it('rejects overlapping daily spend scopes rather than adding platform and matched spend',()=>{
 const row=spend(filters.to,500),base=record([row,{...row,metric:'spend',value:800}]);
 expect(buildBeamSpend(base,filters).current.spend).toBeNull();
});

it('shows cached in-progress report values without inventing same-hour spend or MER',()=>{
 const base=record([spend(filters.to,500),spend('2026-10-06',400)]),result=buildBeamSpend(base,filters,new Date('2026-10-07T16:00:00Z'));
 expect(result.current.spend).toBe(500);expect(result.current.closed).toBe(false);expect(result.comparable).toBe(false);
 const html=renderToStaticMarkup(createElement(BeamSpendWorkspace,{record:base,filters,update:()=>{}}));
 expect(html).toContain('META PLATFORM SPEND');expect(html).toContain('$500');expect(html).toContain('Motion report dates');expect(html).toContain('Cached');expect(html).not.toContain('MER');expect(html).not.toContain('spend efficiency verdict');
});

it('uses distinct media context and real comparison dates for 7 and 30 day charts',()=>{
 const base=record([spend('2026-10-07',500),spend('2026-10-06',400),spend('2026-10-01',300)]),result=beamSpendChartContext(base,filters,'7d');
 expect(result.from).toBe('2026-10-01');expect(result.comparisonFrom).toBe('2026-09-30');expect(result.current.find(row=>row.date==='2026-10-01')?.spend).toBe(300);
 expect(beamSpendChartContext(base,filters,'30d').from).toBe('2026-09-08');
});

it('groups ad delivery within its own Motion population and retains actual prior ad values',()=>{
 const ad=(date:string,id:string,amount:number,impressions:number,clicks:number)=>['motion_ad_spend','motion_ad_impressions','motion_ad_clicks'].map((metric,index)=>({...spend(date,amount),dataset:'creatives',metric,value:[amount,impressions,clicks][index],dimensions:{...spend(date,amount).dimensions,ad_id:id,ad:`Ad ${id}`,adset_id:'set-1',adset:'Prospecting',campaign_id:'campaign-1',campaign:'New customers'}}));
 const base=record([spend(filters.to,500),spend('2026-10-06',400),...ad(filters.to,'1',300,1000,20),...ad(filters.to,'2',200,2000,30),...ad('2026-10-06','1',100,800,10)]),group=beamCreativeRows(base,'campaign')[0];
 expect(group).toMatchObject({name:'New customers',spend:500,impressions:3000,clicks:50,cpc:10});expect(group.ctr).toBeCloseTo(50/3000);
 expect(beamCreativeRows(base,'ad',true)[0]).toMatchObject({name:'Ad 1',spend:100});expect(buildBeamSpend(base,filters).current.spend).toBe(500);
 const html=renderToStaticMarkup(createElement(BeamSpendWorkspace,{record:base,filters,update:()=>{}}));
 expect(html).toContain('Ad 1');expect(html).toContain('New customers');expect(html).toContain('Impressions');expect(html).toContain('All clicks');expect(html).not.toContain('Return on ad spend');
});
