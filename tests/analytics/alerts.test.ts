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
it('does not turn unavailable sources or historical imports into performance alerts',()=>{
 const empty={...queryClient(client,[],[],filters),findings:[]} as any;
 expect(buildAlertQueue([empty,record('historical')],filters)).toEqual([]);
});
it('requires complete current and benchmark coverage for conversion signals',()=>{
 const r=record('historical');
 const row={date:'2026-10-07',quality:'complete',coverageThrough:'2026-10-08T00:00:00Z',sourceId:'s',dataset:'funnels',metric:'sessions',dimensions:{page:'/lp'},value:1000} as any;
 r.actions=[{key:'lp',dimensions:{page:'/lp'},summary:{sessions:1000,cvr:.01},benchmark:.03,benchmarkReason:'Own previous period',opportunity:20,evidence:[row],benchmarkEvidence:[{...row,date:'2026-10-06'}]}];
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
