import type {Observation,QueryFilters,Review} from './contracts';
import {reviewMatchesScope} from './alerts';

export type PortfolioMediaReport={date:string;spend:number|null;currency:string|null;asOf:string|null;timezone:string|null;quality:Observation['quality'];sourceId:string};

export function isPortfolioScope(params:URLSearchParams){const section=params.get('section');return !params.get('clientId')&&(!section||section==='portfolio');}

/** Exact compact analytics scope shared by portfolio reads and native warming. */
export function portfolioDatasets(clientId:string):string[]{return (clientId==='beam'||clientId==='autobrush')?['overview','funnels','media']:['overview','funnels'];}

/** Funnel alerts use selected/comparison days; only headline series need history. */
export function portfolioObservationSelection(clientId:string){return {datasets:portfolioDatasets(clientId),includePriorWeek:false,includeOperations:false,trendDatasets:(clientId==='beam'||clientId==='autobrush')?['overview','media']:['overview']};}

/** Portfolio navigation retains its date/comparison scope, never a client cut. */
export function canonicalPortfolioFilters(filters:QueryFilters):QueryFilters{
 return {...filters,view:'overview',market:'',source:'',stream:'',device:'',page:''};
}

/** The CEO surface needs the newest dated review and its newest AI priorities;
 * complete review indexes remain available in the archive and action workspace. */
export function portfolioReviewSummaries(reviews:readonly Review[],filters?:QueryFilters):Review[]{
 const current=reviews.filter(review=>review.current).sort((a,b)=>b.storeDate.localeCompare(a.storeDate)||b.revision-a.revision||b.createdAt.localeCompare(a.createdAt));
 const latest=current[0],latestAI=current.find(review=>review.payload.type==='ai');
 const matching=filters?current.filter(review=>review.payload.type==='ai'&&reviewMatchesScope(review.payload.filters,filters)):[],seen=new Set<string>();
 return [...latest?[latest]:[],...latestAI?[latestAI]:[],...matching].filter(review=>{if(seen.has(review.id))return false;seen.add(review.id);return true;});
}

/** Keep exact provider reports distinct; matching dates alone do not establish
 * one complete report. This projection never sums or qualifies spend growth. */
export function compactPortfolioMediaReports(rows:readonly Observation[]):PortfolioMediaReport[]{
 const reports:PortfolioMediaReport[]=[],seen=new Set<string>();
 for(const row of rows){
  if(row.dataset!=='media'||row.metric!=='platform_spend'||row.definition!=='motion_meta_account_spend_provider_date_cached'||row.population!=='motion_meta_account_report'||row.dimensions.channel!=='meta'||row.currency!=='USD')continue;
  const identity=JSON.stringify([row.sourceId,row.date,row.start??null,row.end??null,row.definition,row.population,row.currency,row.value,row.quality,row.retrievedAt,row.coverageThrough,Object.entries(row.dimensions).sort()]);
  if(seen.has(identity))continue;seen.add(identity);
  const asOf=row.dimensions.provider_as_of;
  reports.push({date:row.date,spend:row.value!==null&&Number.isFinite(row.value)?row.value:null,currency:row.currency,asOf:asOf&&Number.isFinite(Date.parse(asOf))?asOf:null,timezone:row.dimensions.reporting_timezone||null,quality:row.quality,sourceId:row.sourceId});
 }
 return reports.sort((a,b)=>a.date.localeCompare(b.date)||a.sourceId.localeCompare(b.sourceId)||(a.asOf??'').localeCompare(b.asOf??''));
}

/** Qualified actions are calculated over the full selected/comparison page
 * cohort first. The executive payload needs those actions, not the leaf table. */
export function compactPortfolioPresentation(frame:ReturnType<typeof import('./presentation').workspacePresentation>):ReturnType<typeof import('./presentation').workspacePresentation>{
 const views=Object.fromEntries(Object.entries(frame.views).map(([name,view])=>[name,name==='traffic'||name==='funnels'?{...view,details:[],actions:[]}:view]));
 const comparisonViews=Object.fromEntries(Object.entries(frame.comparisonViews??{}).map(([name,view])=>[name,name==='traffic'||name==='funnels'?{...view,details:[]}:view]));
 return {...frame,trafficExplorer:undefined,details:[],views,comparisonViews};
}
