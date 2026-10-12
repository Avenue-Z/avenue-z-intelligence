import {aggregateExplorerRows,explorerMetric,type ExplorerGroup,type ExplorerMetric,type ExplorerRow} from './traffic-explorer';
export const TRAFFIC_BREAKDOWNS=['traffic_channel','source','utm_source','utm_medium','utm_campaign','device','market'] as const;
export const TRAFFIC_CHART_METRICS:ExplorerMetric[]=['sessions','converting_sessions','cvr','atc','checkoutCompletion'];
type Breakdown={groups:ExplorerGroup[];groupCount:number;omitted:number};
export type TrafficFrame={dataset:'traffic'|'funnels';totals:ExplorerGroup|null;pages:ExplorerGroup[];breakdowns:Record<string,Breakdown>;segmentCount:number};
export type TrafficExplorer={version:1;current:TrafficFrame;comparison:TrafficFrame};
const rank=(groups:ExplorerGroup[],metric:ExplorerMetric)=>groups.filter(group=>explorerMetric(group,metric)!==null).sort((a,b)=>explorerMetric(b,metric)!-explorerMetric(a,metric)!||a.label.localeCompare(b.label));
function frame(rows:ExplorerRow[],dataset:'traffic'|'funnels'):TrafficFrame{
 const breakdowns:Record<string,Breakdown>={};
 for(const dimension of TRAFFIC_BREAKDOWNS){const all=aggregateExplorerRows(rows,dimension),retained=new Set<ExplorerGroup>();
  for(const metric of TRAFFIC_CHART_METRICS)for(const group of rank(all,metric).slice(0,20))retained.add(group);
  for(const group of rank(all,'sessions').slice(0,100))retained.add(group);
  const groups=[...retained].sort((a,b)=>(b.metrics.sessions??-1)-(a.metrics.sessions??-1)||a.label.localeCompare(b.label));
  breakdowns[dimension]={groups,groupCount:all.length,omitted:all.length-groups.length};
 }
 return {dataset,totals:aggregateExplorerRows(rows,'all')[0]??null,pages:aggregateExplorerRows(rows,'page').sort((a,b)=>(b.metrics.sessions??-1)-(a.metrics.sessions??-1)||a.label.localeCompare(b.label)),breakdowns,segmentCount:rows.length};
}
/** Every rate/count is pooled over the entire prepared leaf dataset before a
 * ranking is bounded. Leaf page/market/device/UTM combinations never leave the
 * server. All page aggregates remain searchable; metric-specific top 20s and
 * the top 100 session segments remain exact within each breakdown. */
export function compactTrafficExplorer(current:ExplorerRow[],comparison:ExplorerRow[],dataset:'traffic'|'funnels'):TrafficExplorer{return {version:1,current:frame(current,dataset),comparison:frame(comparison,dataset)};}
