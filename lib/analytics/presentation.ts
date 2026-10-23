import {detailRows,summarize,type ClientAnalytics} from './query';
import type {QueryFilters,Observation} from './contracts';
import {compactTrafficExplorer} from './traffic-presentation';
import {qualifiedConversionAlerts,type BusinessAlert} from './alerts';
// Table aggregates remain complete. Individual observations are retrieved by
// the authorized evidence endpoint instead of repeated in every browser prop.
export function workspacePresentation(a:ClientAnalytics,f:QueryFilters){
 const light=(rows:ClientAnalytics['details'])=>rows.map(r=>({...r,evidence:[] as Observation[]}));
 const dataset=f.view==='overview'?'funnels':f.view;
 const traffic=a.views.traffic?.details??(dataset==='traffic'?a.details:[]),funnels=a.views.funnels?.details??(dataset==='funnels'?a.details:[]),trafficDataset=traffic.length?'traffic' as const:'funnels' as const;
 const hasTraffic=a.preparedDatasets.includes('traffic')||a.preparedDatasets.includes('funnels');
 const trafficExplorer=hasTraffic?compactTrafficExplorer(trafficDataset==='traffic'?traffic:funnels,detailRows(a.comparisonEvidence.filter(row=>row.dataset===trafficDataset)),trafficDataset):undefined;
 const qualifiedPageAlerts=qualifiedConversionAlerts({...a,actions:a.views.funnels?.actions??(dataset==='funnels'?a.actions:[])},f).map(alert=>{const action=(a.views.funnels?.actions??a.actions).find(action=>alert.key.endsWith(`:${action.key}`)),params=new URLSearchParams({...f,view:'traffic',...action?.dimensions.page?{page:action.dimensions.page}:{},...action?.dimensions.market?{market:action.dimensions.market}:{}});return {...alert,evidence:[alert.key,`/clients/${encodeURIComponent(a.client.id)}?${params}`]};});
 const views=Object.fromEntries(Object.entries(a.views).filter(([key])=>key!==dataset).map(([key,v])=>[key,{details:key==='traffic'||key==='funnels'&&f.view==='traffic'?[]:light(v.details),actions:[] as ClientAnalytics['actions'],viewMetrics:v.viewMetrics}]));
 const comparisonDetailDatasets=new Set(['revenue','markets','products','media','creatives','orderStreams','renewalDiagnostics','orderHygiene']);
 if(f.view==='overview')comparisonDetailDatasets.add('funnels');
 const comparisonViews=Object.fromEntries([...new Set(a.preparedDatasets)].map(name=>{const rows=a.comparisonEvidence.filter(row=>row.dataset===name);return [name,{viewMetrics:summarize(rows),details:comparisonDetailDatasets.has(name)?light(detailRows(rows)):[] as ClientAnalytics['details']}];}));
 const experimentDays=new Map<string,Observation[]>();for(const row of a.evidence)if(row.dataset==='experiments'){const values=experimentDays.get(row.date);if(values)values.push(row);else experimentDays.set(row.date,[row]);}
 const experimentDailyDetails=[...experimentDays].sort(([a],[b])=>a.localeCompare(b)).map(([date,rows])=>({date,details:light(detailRows(rows))}));
 const sourceQuality={historical:a.evidence.some(row=>row.quality==='historical'),partial:a.evidence.some(row=>row.quality==='partial'),estimated:a.evidence.some(row=>row.quality==='estimated'),count:a.selectedCount};
 const efficiencyEvidence=[`/clients/${encodeURIComponent(a.client.id)}?${new URLSearchParams({...f,view:'media'})}`,...[...a.evidence,...a.comparisonEvidence].filter(row=>row.dataset==='overview'&&['revenue','spend','new_orders'].includes(row.metric)).slice(0,98).map(row=>`${row.sourceId}:${row.date}:${row.dataset}:${row.metric}:${JSON.stringify(row.dimensions)}`)];
 return {...a,opportunities:[] as ClientAnalytics['opportunities'],actions:[] as ClientAnalytics['actions'],
  ...({qualifiedPageAlerts} as {qualifiedPageAlerts?:BusinessAlert[]}),
  ...({sourceQuality} as {sourceQuality?:typeof sourceQuality}),
  ...({efficiencyEvidence} as {efficiencyEvidence?:string[]}),
  ...trafficExplorer?{trafficExplorer}:{},
  views,
  ...Object.keys(comparisonViews).length?{comparisonViews}:{},
  details:dataset==='traffic'||dataset==='funnels'&&f.view==='funnels'?[] as ClientAnalytics['details']:light(a.details),
  viewMetrics:f.view==='overview'?a.metrics:a.datasetMetrics,
  viewPriorMetrics:f.view==='overview'?a.prior:summarize(a.comparisonEvidence.filter(row=>row.dataset===dataset)),
  experimentDetails:light(detailRows(a.evidence.filter(r=>r.dataset==='experiments'))),
  ...experimentDailyDetails.length?{experimentDailyDetails}:{},
  evidence:[] as Observation[],
  comparisonEvidence:[] as Observation[]};
}
