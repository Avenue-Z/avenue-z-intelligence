import {runtimePlatform} from '@avenue/runtime';
import type {AccessScope,Observation} from '../analytics/contracts';
import {queryClient} from '../analytics/query';
import {shiftDate,todayIn} from '../analytics/windows';
import {getStore} from './access';
import {withAnalyticsMemory} from './analytics-memory';
import {publicCompanyWorkspaceSizeError} from './company-workspace-bridge';
import {csv} from './export';
import {authorize} from './policy';
import {parseFilters} from './workspace';
export type ClientEvidencePurpose='evidence'|'export';
const responseLimit=4*1024*1024;
function exportRows(rows:Observation[]){return rows.map(row=>({date:row.date,dataset:row.dataset,metric:row.metric,value:row.value,definition:row.definition,population:row.population,currency:row.currency,...Object.fromEntries(Object.entries(row.dimensions).map(([key,value])=>['dimension_'+key,value])),source:row.sourceId,retrievedAt:row.retrievedAt,coverageThrough:row.coverageThrough,quality:row.quality}));}
/** Keep the exact displayed dataset, source precedence and store-day cutoff.
 * Dense observation reads belong on the native host, inside its memory lease.
 */
export async function clientEvidenceJSON(scope:AccessScope,clientId:string,params:URLSearchParams,purpose:ClientEvidencePurpose):Promise<string>{
 authorize(scope,clientId);
 if(runtimePlatform!=='vercel')throw Error('Company data service unavailable');
 const filters=parseFilters(params),segment=params.get('segment');
 if(purpose==='evidence'&&(!segment||segment.length>4000))throw Error('Choose a valid segment');
 const dataset=filters.view==='overview'?'funnels':filters.view;
 return withAnalyticsMemory(async()=>{
  const store=getStore(),client=(await store.clients(scope.organizationId)).find(client=>client.id===clientId);
  if(!client)throw Error('Client access denied');
  if(!params.has('from')&&!params.has('to'))filters.from=filters.to=filters.mode==='partial'?todayIn(client.timezone):shiftDate(todayIn(client.timezone),-1);
  const [observations,connections]=await Promise.all([store.observations(scope.organizationId,clientId,filters,false,undefined,{datasets:[dataset],dimensions:true,includePriorWeek:false}),store.connections(scope.organizationId,clientId)]);
  const analytics=queryClient(client,observations,connections,filters,{preparedDatasets:[dataset]});
  const rows=analytics.evidence.filter(row=>row.dataset===dataset&&(purpose==='export'||JSON.stringify(Object.entries(row.dimensions).sort())===segment));
  const payload=JSON.stringify(purpose==='export'?{csv:csv(exportRows(rows))}:{rows});
  if(new TextEncoder().encode(payload).byteLength>responseLimit)throw Error(publicCompanyWorkspaceSizeError);
  return payload;
 });
}
export function clientEvidenceFailure(error:unknown,purpose:ClientEvidencePurpose){
 const denied=error instanceof Error&&/access|Sign in/.test(error.message),large=error instanceof Error&&error.message===publicCompanyWorkspaceSizeError;
 return Response.json({error:large?publicCompanyWorkspaceSizeError:denied?`${purpose==='export'?'Export':'Evidence'} access denied`:`${purpose==='export'?'Export':'Evidence'} unavailable. Please retry.`},{status:large?413:denied?403:400,headers:{'Cache-Control':'no-store'}});
}
