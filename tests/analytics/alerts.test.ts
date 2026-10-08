import {it,expect} from 'vitest';
import {buildAlertQueue} from '../../lib/analytics/alerts';
import {queryClient} from '../../lib/analytics/query';
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
it('keeps AI recommendations source-linked, date-scoped and resolved after tracking',()=>{const r=record('historical');r.reviews=[{id:'rev',storeDate:filters.to,current:true,payload:{type:'ai',actions:[{title:'Investigate offer alignment',detail:'Dated evidence',nextStep:'Review the campaign audience',severity:'investigate',impact:30,sourceIds:['review:original']}]}}];let queue=buildAlertQueue([r],filters);expect(queue).toHaveLength(1);expect(queue[0].evidence[1]).toContain('/reviews/rev');r.findings=[{id:'tracked',title:queue[0].title,detail:'Dated evidence',severity:'investigate',status:'closed',owner:'',evidence:queue[0].evidence}];expect(buildAlertQueue([r],filters)).toEqual([]);expect(buildAlertQueue([{...r,findings:[]}],{...filters,from:'2026-10-06',to:'2026-10-06'})).toEqual([]);});
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
