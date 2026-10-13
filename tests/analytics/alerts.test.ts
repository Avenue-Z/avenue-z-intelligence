import {it,expect,vi} from 'vitest';
import {buildAlertQueue} from '../../lib/analytics/alerts';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
const filters={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''} as const;
const client={id:'a',name:'Client A',timezone:'UTC',currency:'USD',config:{spendChannels:['meta'],revenueDefinition:'web',incidents:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}} as any;
function record(quality='complete'){
 const rows=['2026-10-06','2026-10-07'].flatMap(date=>[['revenue',date.endsWith('07')?110:100],['spend',date.endsWith('07')?20:10],['new_orders',10]].map(([metric,value])=>({date,metric,value,dataset:'overview',definition:'web',population:'web_orders',currency:metric==='new_orders'?null:'USD',dimensions:{},sourceId:'s',retrievedAt:'2026-10-08T00:00:00Z',channels:['meta'],coverageThrough:'2026-10-08T00:00:00Z',quality})));
 return {...queryClient(client,rows as any,[],filters),findings:[]} as any;
}
it('raises a business action when qualified spend outpaces revenue',()=>{
 const queue=buildAlertQueue([record()],filters);
 expect(queue).toHaveLength(1);expect(queue[0].category).toBe('Spend efficiency');expect(queue[0].evidence.length).toBeGreaterThan(1);expect(queue[0].nextStep).toMatch(/campaign|channel/);expect(queue[0].evidence.some(x=>x.includes('2026-10-06:overview:revenue'))).toBe(true);
});
it('shows the latest daily review separately from a historical chart selection when requested',()=>{
 const r=record('historical');r.reviews=[{id:'new',storeDate:'2026-10-12',createdAt:'2026-10-12T13:00:00Z',current:true,payload:{type:'ai',filters:{...filters,from:'2026-10-12',to:'2026-10-12',mode:'partial'},actions:[{title:'Inspect current source dilution',detail:'Today’s traffic mix shifted',nextStep:'Compare source cohorts',severity:'investigate',impact:null,sourceIds:['selection:a'],existingFindingId:null}]}}];
 const queue=buildAlertQueue([r],filters,{includeLatestReview:true});expect(queue).toHaveLength(1);expect(queue[0].period).toMatchObject({from:'2026-10-12',to:'2026-10-12',mode:'partial'});expect(queue[0].basis).toContain('2026-10-12');
});
it('provides readable supporting figures instead of hundreds of row identifiers',()=>{
 const a=buildAlertQueue([record()],filters)[0];expect(a.figures.find(x=>x.label==='Revenue')).toMatchObject({current:110,previous:100});expect(a.figures.find(x=>x.label==='Spend')).toMatchObject({current:20,previous:10});expect(a.period).toMatchObject({from:filters.from,to:filters.to});
});
it('keeps AI recommendations source-linked, date-scoped and resolved after tracking',()=>{const r=record('historical');r.reviews=[{id:'rev',storeDate:filters.to,current:true,payload:{type:'ai',filters,actions:[{title:'Investigate offer alignment',detail:'Dated evidence',nextStep:'Review the campaign audience',severity:'investigate',impact:30,sourceIds:['review:original']}]}}];let queue=buildAlertQueue([r],filters);expect(queue).toHaveLength(1);expect(queue[0].evidence[1]).toContain('/reviews/rev');r.findings=[{id:'tracked',title:queue[0].title,detail:'Dated evidence',severity:'investigate',status:'closed',owner:'',evidence:queue[0].evidence}];expect(buildAlertQueue([r],filters)).toEqual([]);expect(buildAlertQueue([{...r,findings:[]}],{...filters,from:'2026-10-06',to:'2026-10-06'})).toEqual([]);});
it('suppresses incompatible AI scope and duplicate deterministic recommendations, including closed copies',()=>{const r=record(),signal=buildAlertQueue([r],filters)[0];r.reviews=[{id:'rev',storeDate:filters.to,current:true,payload:{type:'ai',filters,actions:[{title:signal.title,detail:'Same budget issue',nextStep:'Review budgets',severity:'act',impact:null,sourceIds:['s']}]}}];expect(buildAlertQueue([r],filters)).toHaveLength(1);r.findings=[{id:'closed',title:signal.title,status:'closed',evidence:signal.evidence}];expect(buildAlertQueue([r],filters)).toEqual([]);const historical={...record('historical'),reviews:r.reviews};for(const f of [{...filters,mode:'partial'},{...filters,market:'DE'},{...filters,page:'/another'}])expect(buildAlertQueue([historical],f as any)).toEqual([]);});
it('does not turn unavailable sources or historical imports into performance alerts',()=>{
 const empty={...queryClient(client,[],[],filters),findings:[]} as any;
 expect(buildAlertQueue([empty,record('historical')],filters)).toEqual([]);
});
it('requires complete current and benchmark coverage for conversion signals',()=>{
 const r=record('historical');
 const row={date:'2026-10-07',quality:'complete',coverageThrough:'2026-10-08T00:00:00Z',sourceId:'s',dataset:'funnels',metric:'sessions',population:'human_sessions',dimensions:{page:'/lp'},value:1000} as any;
 r.actions=[{key:'lp',dimensions:{page:'/lp'},summary:{sessions:1000,cvr:.01},benchmark:.03,benchmarkReason:'Own previous period',opportunity:20,evidence:[row,{...row,metric:'converting_sessions',value:10}],benchmarkEvidence:[{...row,date:'2026-10-06'},{...row,date:'2026-10-06',metric:'converting_sessions',value:30}]}];
 expect(buildAlertQueue([r],filters)).toHaveLength(1);
 r.actions[0].benchmarkEvidence[0].coverageThrough=null;expect(buildAlertQueue([r],filters)).toEqual([]);
});
it('keeps a tracked signal once and respects its closed status on the same evidence',()=>{
 const r=record(),signal=buildAlertQueue([r],filters)[0];
 r.findings=[{id:'tracked',clientId:'a',title:'Assigned action',detail:'Check paid campaigns',severity:'act',status:'investigating',owner:'Media lead',evidence:signal.evidence,version:1,updatedAt:'2026-10-08T00:00:00Z'}];
 expect(buildAlertQueue([r],filters)).toHaveLength(1);expect(buildAlertQueue([r],filters)[0].owner).toBe('Media lead');
 r.findings[0].status='closed';expect(buildAlertQueue([r],filters)).toEqual([]);
});
it('uses an imported action’s explicit next step while preserving its owner and status',()=>{
 const r=record('historical'),finding={id:'imported',clientId:'a',title:'Review subscription cancellations',detail:'Cancellation volume rose.\nNext step: Split cancellations by signup cohort and cancellation reason.',severity:'investigate',status:'investigating',owner:'Retention lead',evidence:['https://claude.ai/artifact/original'],version:3,updatedAt:'2026-10-08T00:00:00Z'};
 r.findings=[finding];const original=JSON.stringify(finding),alert=buildAlertQueue([r],filters)[0];
 expect(alert.nextStep).toBe('Split cancellations by signup cohort and cancellation reason.');
 expect(alert).toMatchObject({owner:'Retention lead',status:'investigating',finding});expect(JSON.stringify(finding)).toBe(original);
});
it('omits a generic drawer instruction when a tracked action has no source-backed next step',()=>{
 const r=record('historical');r.findings=[{id:'tracked',clientId:'a',title:'Monitor recurring refunds',detail:'Refunds remain elevated.',severity:'investigate',status:'open',owner:'',evidence:[],version:1,updatedAt:'2026-10-08T00:00:00Z'}];
 expect(buildAlertQueue([r],filters)[0].nextStep).toBe('');
});
it('prefers the latest recorded recheck next step over the original imported instruction',()=>{
 const r=record('historical');r.findings=[{id:'tracked',clientId:'a',title:'Check acquisition mix',detail:'Next step: Inspect source cohorts.',severity:'investigate',status:'open',owner:'Media lead',evidence:[],version:2,updatedAt:'2026-10-08T00:00:00Z',latestCheck:{reviewId:'latest',storeDate:'2026-10-12',checkedAt:'2026-10-12T12:00:00Z',detail:'Updated evidence',nextStep:'Review yesterday’s campaign changes.',severity:'investigate',sourceIds:['source']}}];
 expect(buildAlertQueue([r],filters)[0].nextStep).toBe('Review yesterday’s campaign changes.');
});
it('keeps live page alerts on each client’s captured store date without weakening fixed-date scope',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T23:05:00Z'));try{
  const selected={...filters,from:'2026-10-14',to:'2026-10-14',mode:'partial' as const,period:'today' as const},stockholm={...client,timezone:'Europe/Stockholm'},connections=[{id:'shop',provider:'gateway',enabled:true,coverageThrough:'2026-10-13T23:00:00Z'}] as any;
  const rows=[['2026-10-13','2026-10-12',30],['2026-10-14','2026-10-13',10]].flatMap(([date,utcDate,conversions])=>['sessions','converting_sessions'].map(metric=>({date:String(date),dataset:'funnels',metric,value:metric==='sessions'?1000:Number(conversions),definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/lp',market:'US'},sourceId:'shop',retrievedAt:'2026-10-13T23:00:00Z',coverageThrough:'2026-10-13T23:00:00Z',quality:'complete',start:`${utcDate}T22:00:00Z`,end:`${utcDate}T23:00:00Z`}))) as any;
  const r={...workspacePresentation(queryClient(stockholm,rows,connections,selected,{preparedDatasets:['overview','funnels']}),selected),findings:[],reviews:[]} as any,global={...selected,from:'2026-10-13',to:'2026-10-13'};
  expect(r.qualifiedPageAlerts).toHaveLength(1);
  expect(buildAlertQueue([r],global)).toHaveLength(1);expect(buildAlertQueue([r],global)[0].period).toMatchObject({from:'2026-10-14',to:'2026-10-14'});
  const {period:_period,...fixed}=global;expect(buildAlertQueue([r],fixed)).toEqual([]);
 }finally{vi.useRealTimers();}
});
it('qualifies matched page evidence when a next-midnight capture completes both store days',()=>{
 const selected={...filters,mode:'partial' as const},stockholm={...client,timezone:'Europe/Stockholm'},connections=[{id:'shop',provider:'gateway',enabled:true,coverageThrough:'2026-10-07T22:00:00Z'}] as any;
 const rows=['2026-10-06','2026-10-07'].flatMap(date=>['sessions','converting_sessions'].map(metric=>({date,dataset:'funnels',metric,value:metric==='sessions'?1000:date===selected.to?10:30,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/lp',market:'US'},sourceId:'shop',retrievedAt:'2026-10-07T22:00:00Z',coverageThrough:'2026-10-07T22:00:00Z',quality:'complete',start:`${date}T21:00:00Z`,end:`${date}T22:00:00Z`}))) as any;
 const r={...workspacePresentation(queryClient(stockholm,rows,connections,selected,{preparedDatasets:['overview','funnels']}),selected),findings:[],reviews:[]} as any;
 expect(r.cutoff).toBe('2026-10-07T22:00:00Z');expect(r.details[0].summary.cvr).toBe(.01);
 expect(buildAlertQueue([r],selected)).toHaveLength(1);expect(buildAlertQueue([r],selected)[0].figures[1]).toMatchObject({current:.01,previous:.03});
});
it('does not suppress a new period because a previous signal was closed',()=>{
 const r=record(),signal=buildAlertQueue([r],filters)[0];
 r.findings=[{id:'closed',clientId:'a',title:'Past action',detail:'Done',severity:'act',status:'closed',owner:'Media',evidence:signal.evidence,version:1,updatedAt:'2026-10-08T00:00:00Z'}];
 expect(buildAlertQueue([r],{...filters,from:'2026-10-06',to:'2026-10-06'})).toHaveLength(1);
});

function conversionRecord(f:any,dates:string[],missingHour=false){
 const rows=dates.flatMap(date=>[0,1,2].filter(hour=>!missingHour||hour!==1).flatMap(hour=>['sessions','converting_sessions'].map(metric=>({date,metric,value:metric==='sessions'?1000:date>=f.from?10:30,dataset:'funnels',definition:'us_human',population:'human_sessions',currency:null,dimensions:{page:'/lp',market:'US'},sourceId:'shop',retrievedAt:'2026-10-08T03:00:00Z',quality:'complete',coverageThrough:'2026-10-08T03:00:00Z',...(f.mode==='partial'?{start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`}:{} )}))));
 // Closed-day snapshots contain one row per metric, rather than repeated hourly rows.
 const data=f.mode==='closed'?rows.filter((_,i)=>i%6<2):rows;
 return {...queryClient(client,data as any,f.mode==='partial'?[{enabled:true,coverageThrough:'2026-10-07T03:00:00Z'} as any]:[],f),findings:[]} as any;
}
it('does not alert from missing days in the selected or comparison window',()=>{
 const f={...filters,from:'2026-10-06',to:'2026-10-07'};
 const r=conversionRecord(f,['2026-10-04','2026-10-06']);
 expect(r.actions.length).toBeGreaterThan(0);
 expect(buildAlertQueue([r],f)).toEqual([]);
 expect(buildAlertQueue([conversionRecord(f,['2026-10-04','2026-10-05','2026-10-06','2026-10-07'])],f)).toHaveLength(1);
});
it('rejects an internal missing hour even when both endpoints reach the cutoff',()=>{
 const f={...filters,mode:'partial'} as any;
 const dates=['2026-10-06','2026-10-07'];
 expect(buildAlertQueue([conversionRecord(f,dates)],f)).toHaveLength(1);
 expect(buildAlertQueue([conversionRecord(f,dates,true)],f)).toEqual([]);
});
it('requires sessions and conversions to cover matching intervals',()=>{
 const f={...filters,mode:'partial'} as any,r=conversionRecord(f,['2026-10-06','2026-10-07']);
 r.actions[0].evidence=r.actions[0].evidence.filter((x:any)=>x.metric!=='converting_sessions'||!x.start.includes('01:00'));
 expect(buildAlertQueue([r],f)).toEqual([]);
});
it('uses reconciled public-page coverage for sparse hours without accepting a generic hourly gap',()=>{
 const f={...filters,mode:'partial'} as any,r=conversionRecord(f,['2026-10-06','2026-10-07'],true);
 for(const a of r.actions)for(const row of [...a.evidence,...a.benchmarkEvidence]){row.definition='shopify_human_public_landing_pages';row.population='human_public_landing_page_sessions';}
 expect(buildAlertQueue([r],f)).toHaveLength(1);
});
