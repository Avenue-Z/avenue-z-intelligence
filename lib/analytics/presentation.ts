import {detailRows,type ClientAnalytics} from './query';
import type {QueryFilters,Observation} from './contracts';
// Table aggregates remain complete. Individual observations are retrieved by
// the authorized evidence endpoint instead of repeated in every browser prop.
export function workspacePresentation(a:ClientAnalytics,f:QueryFilters){
 const light=(rows:ClientAnalytics['details'])=>rows.map(r=>({...r,evidence:[] as Observation[]}));
 const dataset=f.view==='overview'?'funnels':f.view;
 const views=Object.fromEntries(Object.entries(a.views).filter(([key])=>key!==dataset).map(([key,v])=>[key,{details:light(v.details),actions:v.actions,viewMetrics:v.viewMetrics}]));
 return {...a,opportunities:[] as ClientAnalytics['opportunities'],
  views,
  details:light(a.details),
  viewMetrics:f.view==='overview'?a.metrics:a.datasetMetrics,
  experimentDetails:light(detailRows(a.evidence.filter(r=>r.dataset==='experiments'))),
  evidence:a.evidence.filter(r=>r.dataset==='overview'),
  comparisonEvidence:a.comparisonEvidence.filter(r=>r.dataset==='overview')};
}
