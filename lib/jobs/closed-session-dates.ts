import type {Client,Connection,Observation} from '../analytics/contracts';
import {dayWindow,todayIn} from '../analytics/windows';
import type {Store} from '../server/store';
import type {RegisteredContract} from '../sources/registered-contract';

export async function closedSessionDatesToSkip(store:Pick<Store,'all'>,organizationId:string,client:Client,source:Connection,contract:RegisteredContract,dates:string[],now:Date,automatic=true):Promise<ReadonlySet<string>>{
 const skipped=new Set<string>();
 if(!automatic||!source.lastSuccess||client.id!=='kind-patches'||source.clientId!==client.id||!['kind-shopify-hourly','kind-shopify-funnels'].includes(source.provider)||!contract.hourlyGrain||contract.clientId!==client.id||contract.timezone!==client.timezone||contract.currency!==client.currency)return skipped;
 const today=todayIn(client.timezone,now),closed=dates.filter(date=>date<today&&now.getTime()>=Date.parse(dayWindow(date,client.timezone).end)+90*60000);
 if(!closed.length)return skipped;
 // One indexed first-fact lookup per candidate; complete canonical captures
 // already passed provider reconciliation before their pointer was published.
 const captured=await store.all<{date:string;complete:number;coverageThrough:string|null;publishedAt:string|null;payload:string|null}>(
  `SELECT c.date,s.complete,s.coverageThrough,c.publishedAt,(SELECT o.payload FROM observations o WHERE o.snapshotId=c.snapshotId AND o.date=c.date ORDER BY o.rowKey LIMIT 1) AS payload FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId AND s.sourceId=c.sourceId AND s.status='ready' WHERE c.organizationId=? AND c.clientId=? AND c.sourceId=? AND c.date IN (SELECT value FROM json_each(?))`,
  organizationId,client.id,source.id,JSON.stringify(closed)
 ).catch(()=>[]); // Optional reuse proof must never prevent today's capture.
 for(const capture of captured){
  const window=dayWindow(capture.date,client.timezone),end=Date.parse(window.end),published=Date.parse(capture.publishedAt??'');
  if(!capture.complete||!(Date.parse(capture.coverageThrough??'')>=end)||!(published>=end+90*60000&&published<=now.getTime()))continue;
  let fact:Observation;try{fact=JSON.parse(capture.payload??'null');}catch{continue;}
  if(!fact||fact.sourceId!==source.id||fact.date!==capture.date||fact.quality!=='complete'||typeof fact.value!=='number'||!Number.isInteger(fact.value)||fact.value<0||!(Date.parse(fact.coverageThrough??'')>=end))continue;
  const profile=contract.profiles.find(profile=>profile.dataset===fact.dataset&&profile.metric===fact.metric),start=Date.parse(fact.start??''),through=Date.parse(fact.end??'');
  if(!profile?.hourly||profile.definition!==fact.definition||profile.population!==fact.population||profile.currency!==fact.currency||!fact.dimensions||Array.isArray(fact.dimensions)||typeof fact.dimensions!=='object'||JSON.stringify(Object.keys(fact.dimensions).sort())!==JSON.stringify([...profile.dimensions].sort()))continue;
  if(start!==Date.parse(window.start)||!(through>start&&through-start<=7200000&&through<=end))continue;
  skipped.add(capture.date);
 }
 return skipped;
}
