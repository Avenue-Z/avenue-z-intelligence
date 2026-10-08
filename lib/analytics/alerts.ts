import {dayWindow} from './windows';
import type {QueryFilters,Finding,Observation} from './contracts';
import type {Workspace} from '../server/workspace';
export type BusinessAlert={key:string;clientId:string;clientName:string;title:string;detail:string;nextStep:string;category:string;severity:string;status:string;owner:string;evidence:string[];basis:string;impact:number|null;finding?:Finding};
const delta=(n:number|null)=>n===null?'unavailable':`${n>=0?'+':''}${(n*100).toFixed(1)}%`;
const refs=(rows:Observation[])=>rows.map(r=>`${r.sourceId}:${r.date}:${r.dataset}:${r.metric}:${JSON.stringify(r.dimensions)}`);
export function buildAlertQueue(records:Workspace['clients'],filters:QueryFilters):BusinessAlert[]{
 const result:BusinessAlert[]=[];
 for(const r of records){
  const base={clientId:r.client.id,clientName:r.client.name,status:'open',owner:''};
  const scope=JSON.stringify([filters.from,filters.to,filters.mode,filters.compare,filters.market,filters.stream,filters.source,filters.device,filters.page]);
  const generated:BusinessAlert[]=[];
  if(r.verdict.growth==='inefficient'&&r.verdict.spendComparison!=='unavailable'){
   const key=`signal:efficiency:${r.client.id}:${scope}`;
   generated.push({...base,key,title:'Review paid media efficiency',detail:`Revenue ${delta(r.verdict.rd)} versus spend ${delta(r.verdict.sd)}. Cost per new-customer order is ${r.verdict.cost?.toFixed(2)??'unavailable'} ${r.client.currency}, versus ${r.verdict.previousCost?.toFixed(2)??'unavailable'} in the comparison period.`,nextStep:'Inspect channel and campaign changes, then review budgets against new-customer acquisition cost.',category:'Spend efficiency',severity:'act',basis:'Qualified source evidence',impact:null,evidence:[key,...refs([...r.evidence,...r.comparisonEvidence].filter(x=>x.dataset==='overview'))].slice(0,100)});
  }
  for(const a of r.actions){
   if(!a.evidence.length||!a.benchmarkEvidence.length||[...a.evidence,...a.benchmarkEvidence].some(x=>x.quality!=='complete'||!x.coverageThrough||Date.parse(x.coverageThrough)<Date.parse(x.end??dayWindow(x.date,r.client.timezone).end)))continue;
   const key=`signal:conversion:${r.client.id}:${scope}:${a.key}`;
   generated.push({...base,key,title:`Review ${a.dimensions.page||'segment'} conversion`,detail:`${a.summary.sessions?.toLocaleString()} sessions at ${((a.summary.cvr??0)*100).toFixed(2)}% CVR, versus ${((a.benchmark??0)*100).toFixed(2)}%. ${a.benchmarkReason}. Estimated gap: ${a.opportunity?.toFixed(0)} orders at this traffic volume.`,nextStep:'Compare source and device mix, offer, pricing, localisation and cart evidence before choosing a change.',category:'Conversion opportunity',severity:'investigate',basis:'Qualified source evidence',impact:a.opportunity,evidence:[key,...refs([...a.evidence,...a.benchmarkEvidence])].slice(0,100)});
  }
  for(const signal of generated){if(!r.findings.some(f=>f.evidence.includes(signal.key)))result.push(signal);}
  for(const f of r.findings){if(f.status==='closed')continue;const historical=f.evidence.some(e=>e.startsWith('https://claude.ai/artifact/'));result.push({...base,key:f.id,title:f.title,detail:f.detail,nextStep:'Open the action to review evidence, assign an owner and update its status.',category:historical?'Daily review action':'Team follow-up',severity:f.severity,status:f.status,owner:f.owner,evidence:f.evidence,basis:historical?'Imported Claude review':'Tracked by the team',impact:null,finding:f});}
 }
 const rank:Record<string,number>={act:0,investigate:1,watch:2};
 return result.sort((a,b)=>(rank[a.severity]??1)-(rank[b.severity]??1)||(b.impact??0)-(a.impact??0));
}
