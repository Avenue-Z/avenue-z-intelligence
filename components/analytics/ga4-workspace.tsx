'use client';
import {useEffect,useState} from 'react';
import {Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import type {QueryFilters} from '../../lib/analytics/contracts';
import type {Ga4Dashboard} from '../../lib/analytics/ga4-dashboard';
import {ga4Profile,type Ga4ClientId} from '../../lib/analytics/ga4-profile';
import {ga4PageLabel} from '../../lib/analytics/ga4-page-privacy';
import {money,number,timestamp} from '../../lib/analytics/display';
import {todayIn} from '../../lib/analytics/windows';
import {ComparisonStat,MetricComparison,comparisonLabel} from './metric-comparison';
import {MetricVisualization} from './metric-visualization';

type Props={filters:QueryFilters;update:(changes:Record<string,string>)=>void;currency?:string;clientId?:Ga4ClientId};
type Metric='sessions'|'purchases'|'revenue';
type Group=Ga4Dashboard['pages'][number];
const labels={sessions:'Sessions',purchases:'GA4-attributed purchases',revenue:'GA4-attributed revenue'};
const unavailable='Web analytics could not be refreshed. Try again.';
class Ga4LoadError extends Error{}
export function ga4ReportUrl(filters:QueryFilters,clientId:Ga4ClientId='beam'){ga4Profile(clientId);const query=new URLSearchParams();for(const key of ['from','to','mode','compare','compareFrom','compareTo','market','source','device','page','period'] as const)if(filters[key])query.set(key,key==='page'?ga4PageLabel(filters[key]):filters[key]);return `/api/integrations/ga4/${clientId}/reports?${query}`;}
export function ga4TrendSeries(model:Ga4Dashboard,days:7|30){const points=model.daily.slice(-days);return {series:points.map(point=>({date:point.date,...point.current})),comparisonSeries:points.map(point=>({date:point.comparisonDate,...point.previous}))};}
export class Ga4DashboardCache{
 private entries=new Map<string,{model:Ga4Dashboard;receivedAt:number}>();
 read(key:string,now=Date.now()){const value=this.entries.get(key);return value?{model:value.model,stale:now-value.receivedAt>=30000}:null;}
 write(key:string,model:Ga4Dashboard,now=Date.now()){this.entries.delete(key);this.entries.set(key,{model,receivedAt:now});while(this.entries.size>8)this.entries.delete(this.entries.keys().next().value!);}
}
const cache=new Ga4DashboardCache(),prefetches=new Map<string,Promise<void>>();
export async function loadGa4Dashboard(url:string,signal:AbortSignal,fetcher:typeof fetch=fetch,clientId:Ga4ClientId='beam'):Promise<Ga4Dashboard>{
 const profile=ga4Profile(clientId);
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined,onAbort:()=>void=()=>{};
 if(signal.aborted)throw new DOMException('Request canceled','AbortError');
 const canceled=new Promise<never>((_resolve,reject)=>{onAbort=()=>{controller.abort();reject(new DOMException('Request canceled','AbortError'));};signal.addEventListener('abort',onAbort,{once:true});});
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(new Ga4LoadError('Web analytics took too long. Try again.'));controller.abort();},15000);});
 const perform=async()=>{
  const response=await fetcher(url,{signal:controller.signal,credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'}});
  if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new DOMException('Request canceled','AbortError');}
  if(!response.ok)throw new Ga4LoadError(response.status===401||response.status===403?`Sign in again to view ${profile.name} web analytics.`:unavailable);
  if(response.redirected||!response.body)throw new Ga4LoadError(unavailable);
  reader=response.body.getReader();const parts:Uint8Array[]=[];let length=0;
  for(;;){const chunk=await reader.read();if(controller.signal.aborted)throw new DOMException('Request canceled','AbortError');if(chunk.done)break;length+=chunk.value.byteLength;if(length>2000000)throw new Ga4LoadError(unavailable);parts.push(chunk.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!data||data.propertyId!==profile.propertyId||(clientId==='autobrush'&&(data.clientId!==clientId||data.streamId!==profile.streamId||data.timezone!==profile.timezone||data.currency!==profile.currency))||!data.current||!data.previous||!data.coverage||!data.filterOptions||!['daily','pages','sources','markets','devices'].every(key=>Array.isArray(data[key]))||!['markets','sources','devices','pages'].every(key=>Array.isArray(data.filterOptions[key])&&data.filterOptions[key].every((value:unknown)=>typeof value==='string')))throw new Ga4LoadError(unavailable);
  return data as Ga4Dashboard;
 };
 try{return await Promise.race([perform(),timeout,canceled]);}
 catch(error){if(signal.aborted)throw new DOMException('Request canceled','AbortError');throw error instanceof Ga4LoadError?error:new Ga4LoadError(unavailable);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);controller.abort();void reader?.cancel().catch(()=>{});}
}
export function prefetchGa4Dashboard(filters:QueryFilters,clientId:Ga4ClientId='beam'):Promise<void>{
 const key=ga4ReportUrl(filters,clientId);if(cache.read(key)?.stale===false)return Promise.resolve();const pending=prefetches.get(key);if(pending)return pending;if(prefetches.size>=8)return Promise.resolve();
 const work=loadGa4Dashboard(key,new AbortController().signal,fetch,clientId).then(model=>{cache.write(key,model);}).catch(()=>{}).finally(()=>{prefetches.delete(key);});prefetches.set(key,work);return work;
}
export function Ga4Workspace({filters,update,currency,clientId='beam'}:Props){
 const key=ga4ReportUrl(filters,clientId),[retry,setRetry]=useState(0),[result,setResult]=useState(()=>({key,model:cache.read(key)?.model??null,error:'',loading:true}));
 useEffect(()=>{
  const controller=new AbortController();
  async function reload(force=false){
   const saved=cache.read(key);if(!force&&saved&&!saved.stale){setResult({key,model:saved.model,error:'',loading:false});return;}
   setResult(previous=>({key,model:previous.key===key?previous.model:saved?.model??null,error:'',loading:true}));
   try{const model=await loadGa4Dashboard(key,controller.signal,fetch,clientId);if(!controller.signal.aborted){cache.write(key,model);setResult({key,model,error:'',loading:false});}}
   catch(error){if(!controller.signal.aborted)setResult(previous=>({...previous,key,error:error instanceof Error?error.message:unavailable,loading:false}));}
  }
  const onRefresh=()=>void reload(true);window.addEventListener('avenuez-ga4-refresh',onRefresh);
  const initial=setTimeout(()=>void reload(retry>0),0),refresh=setInterval(()=>void reload(true),60_000);
  return ()=>{controller.abort();clearTimeout(initial);clearInterval(refresh);window.removeEventListener('avenuez-ga4-refresh',onRefresh);};
 },[key,retry,clientId]);
 const shown=result.key===key?result:{key,model:cache.read(key)?.model??null,error:'',loading:true};
 return <div aria-busy={shown.loading}>{shown.error&&<div className="panel"><div className="panel-heading" role="alert"><p>{shown.error}{shown.model?' Showing the last captured view.':''}</p><button type="button" className="small-button" onClick={()=>setRetry(value=>value+1)}>Retry</button></div></div>}{shown.model?<Ga4WorkspaceView model={shown.model} filters={filters} update={update} currency={currency}/>:!shown.error?<section className="panel"><div className="empty-state" role="status"><h3>Loading web analytics…</h3><p>Reading captured GA4 reports.</p></div></section>:null}</div>;
}

export function Ga4WorkspaceView({model,filters:requestedFilters,update}:Props&{model:Ga4Dashboard}){
 const filters={...requestedFilters,page:ga4PageLabel(requestedFilters.page)};
 const [days,setDays]=useState<7|30>(7),[metric,setMetric]=useState<Metric>('sessions'),[breakdown,setBreakdown]=useState<'sources'|'markets'|'devices'>('sources'),[groupMetric,setGroupMetric]=useState<Metric>('sessions');
 const currency=model.currency,label=comparisonLabel(filters),trend=ga4TrendSeries(model,days),pages=[...model.pages].sort((a,b)=>(b.current.sessions??-1)-(a.current.sessions??-1)).slice(0,8),options=model.filterOptions;
 if(!model.latestCapturedAt&&!model.coverage.availableFrom)return <section className="panel"><div className="empty-state" role="status"><h3>First GA4 capture pending</h3><p>Web analytics will appear after the first scheduled capture.</p></div></section>;
 const cutoff=model.matchedThroughHour===null?(filters.mode==='partial'&&model.to===todayIn(model.timezone)?'Awaiting a completed GA hour':'Closed days'):model.matchedThroughHour===24?'Midnight':`${model.matchedThroughHour%12||12}:00 ${model.matchedThroughHour<12?'AM':'PM'}`;
 const quality=model.quality?Object.entries({sampled:'Sampled data',thresholded:'Privacy thresholds',dataLossFromOtherRow:'Some detail grouped as other',restricted:'Restricted metrics',truncated:'Truncated detail'}).filter(([key])=>model.quality[key as keyof typeof model.quality]).map(([,value])=>value):[];
 return <>
  <section className="panel"><div className="panel-heading"><div><h2>Web analytics</h2><p>GA4-measured traffic · GA4-attributed purchases. Shopify remains the business sales source.</p></div><span className="text-muted">{model.from} – {model.to} · vs {model.comparison.from} – {model.comparison.to} · GA4 currency: {currency}</span></div></section>
  <div className="dimension-filters">{([['market','Country','markets','countries'],['source','Source','sources','sources'],['device','Device','devices','devices'],['page','Landing page','pages','landing pages']] as const).map(([key,title,group,all])=><label key={key}>{title}{(model.filterOptionCounts?.[group]??options[group].length)>options[group].length&&<small className="text-muted"> · top {options[group].length} of {model.filterOptionCounts?.[group]}</small>}<select aria-label={`GA4 ${title}`} value={filters[key]} onChange={event=>update({[key]:event.target.value})}><option value="">All {all}</option>{[...new Set([...options[group],...filters[key]?[filters[key]]:[]])].map(value=><option key={value} value={value}>{value||'(not set)'}</option>)}</select></label>)}</div>
  <div className="stat-grid">{(['sessions','engagedSessions','purchases','revenue'] as const).map(key=><ComparisonStat key={key} title={key==='engagedSessions'?'ENGAGED SESSIONS':labels[key].toUpperCase()} value={key==='revenue'?money(model.current[key],currency):number(model.current[key])} current={model.current[key]} previous={model.previous[key]} unit={key==='revenue'?'currency':'count'} currency={currency} label={label}/>)}</div>
  <div className="inline-controls" style={{flexWrap:'wrap',marginBottom:12}} aria-label="GA4 trend controls">{([7,30] as const).map(value=><button type="button" className="small-button" key={value} aria-pressed={days===value} onClick={()=>setDays(value)}>{value} days</button>)}<label>Metric <select aria-label="Web analytics trend metric" value={metric} onChange={event=>setMetric(event.target.value as Metric)}>{Object.entries(labels).map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label></div>
  <MetricVisualization title="GA4 daily trend" subtitle={`${trend.series[0]?.date??model.from} – ${trend.series.at(-1)?.date??model.to}`} {...trend} metrics={[{key:metric,label:labels[metric],unit:metric==='revenue'?'currency':'count'}]} currency={currency} timezone={model.timezone} currentFrom={trend.series[0]?.date} comparisonFrom={trend.comparisonSeries[0]?.date} comparisonLabel={label} defaultMetrics={[metric]} caption="Captured daily values · missing dates remain gaps." height={260}/>
  <div className="two-columns" style={{gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,360px),1fr))'}}><Ga4Breakdown title="Landing-page sessions" rows={pages} metric="sessions" currency={currency} label={label} select={value=>update({page:value})}/><Ga4Breakdown title="Landing-page attributed purchases" rows={pages} metric="purchases" currency={currency} label={label} select={value=>update({page:value})}/></div>
  <div className="inline-controls" style={{flexWrap:'wrap',marginBottom:12}}><label>Breakdown <select aria-label="Traffic breakdown" value={breakdown} onChange={event=>setBreakdown(event.target.value as typeof breakdown)}><option value="sources">Sources</option><option value="markets">Markets</option><option value="devices">Devices</option></select></label><label>Metric <select aria-label="Traffic breakdown metric" value={groupMetric} onChange={event=>setGroupMetric(event.target.value as Metric)}>{Object.entries(labels).map(([value,title])=><option value={value} key={value}>{title}</option>)}</select></label></div>
  <Ga4Breakdown title={`${breakdown[0].toUpperCase()}${breakdown.slice(1)} · ${labels[groupMetric]}`} rows={model[breakdown]} metric={groupMetric} currency={currency} label={label} select={value=>update({[breakdown==='markets'?'market':breakdown==='devices'?'device':'source']:value})}/>
  <p className="text-muted">Captured {model.latestCapturedAt?timestamp(model.latestCapturedAt,model.timezone):'pending'} · Matched through {cutoff} · {model.timezone} · {model.coverage.capturedDays}/{model.coverage.requestedDays} selected days · GA4 typically lags 2–6 hours{quality.length?` · ${quality.join(' · ')}`:''}</p>
 </>;
}
function Ga4Breakdown({title,rows,metric,currency,label,select}:{title:string;rows:Group[];metric:Metric;currency:string;label:string;select:(value:string)=>void}){
 const [table,setTable]=useState(false),values=rows.slice(0,8).map(row=>({label:row.label,current:row.current[metric],previous:row.previous[metric]})),format=(value:number|null)=>metric==='revenue'?money(value,currency):number(value);
 return <section className="panel"><div className="panel-heading"><div><h2>{title}</h2><p><span style={{color:'var(--az-blue)'}}>Current</span> · <span style={{color:'var(--az-purple)'}}>{label}</span> · same filtered cohort</p></div><button type="button" className="small-button" aria-pressed={table} onClick={()=>setTable(value=>!value)}>{table?'Chart':'Table'}</button></div>{!values.length?<div className="empty-state"><h3>No captured groups for this selection</h3></div>:table?<div className="table-scroll"><table className="data-table"><thead><tr><th>Group</th><th>Current</th><th>Comparison</th><th>Change</th></tr></thead><tbody>{values.map(row=><tr key={row.label}><td><button type="button" className="text-button" onClick={()=>select(row.label)}>{row.label||'(not set)'}</button></td><td>{format(row.current)}</td><td>{format(row.previous)}</td><td><MetricComparison current={row.current} previous={row.previous} unit={metric==='revenue'?'currency':'count'} currency={currency} label={label} baseline={false}/></td></tr>)}</tbody></table></div>:<><div className="chart-wrap" role="img" aria-label={`${title}: current and ${label} comparison bars`}><ResponsiveContainer width="100%" height={Math.max(170,values.length*48)}><BarChart layout="vertical" data={values} margin={{top:8,right:24,left:0,bottom:8}} accessibilityLayer><CartesianGrid stroke="var(--az-chart-grid)" horizontal={false}/><XAxis type="number" tick={{fill:'var(--az-muted)'}} tickFormatter={value=>format(Number(value))} axisLine={false} tickLine={false} fontSize={10}/><YAxis dataKey="label" type="category" width={135} tick={{fill:'var(--az-muted)'}} tickFormatter={value=>String(value).length>23?`${String(value).slice(0,20)}…`:String(value)} axisLine={false} tickLine={false} fontSize={10}/><Tooltip formatter={value=>format(Number(value))} contentStyle={{background:'var(--az-surface)',border:'1px solid var(--az-border)',color:'var(--az-fg)'}}/><Bar dataKey="current" name="Current" fill="var(--az-blue)" barSize={12} isAnimationActive={false} onClick={(_row,index)=>select(values[index].label)}/><Bar dataKey="previous" name={label} fill="var(--az-purple)" fillOpacity={.55} barSize={12} isAnimationActive={false} onClick={(_row,index)=>select(values[index].label)}/></BarChart></ResponsiveContainer></div><div className="inline-controls" style={{padding:'0 17px 14px',flexWrap:'wrap'}}>{values.map(row=><div className="inline-controls" key={row.label}><button className="text-button" type="button" onClick={()=>select(row.label)}>{row.label||'(not set)'}</button><MetricComparison current={row.current} previous={row.previous} unit={metric==='revenue'?'currency':'count'} currency={currency} label={label} baseline={false}/></div>)}</div></>}</section>;
}
