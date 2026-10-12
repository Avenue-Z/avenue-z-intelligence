import {detailRows,summarize,type ClientAnalytics} from './query';
import type {QueryFilters,Observation} from './contracts';
// Table aggregates remain complete. Individual observations are retrieved by
// the authorized evidence endpoint instead of repeated in every browser prop.
export function workspacePresentation(a:ClientAnalytics,f:QueryFilters){
 const light=(rows:ClientAnalytics['details'])=>rows.map(r=>({...r,evidence:[] as Observation[]}));
 return {...a,opportunities:[] as ClientAnalytics['opportunities'],
  details:light(a.details),
  viewMetrics:f.view==='overview'?a.metrics:summarize(a.evidence.filter(r=>r.dataset===f.view)),
  revenueMix:light(detailRows(a.evidence.filter(r=>r.dataset==='revenue'))),
  experimentDetails:light(detailRows(a.evidence.filter(r=>r.dataset==='experiments'))),
  evidence:a.evidence.filter(r=>r.dataset==='overview'),
  comparisonEvidence:a.comparisonEvidence.filter(r=>r.dataset==='overview')};
}
