import type {AccessScope,Client,Connection} from '../analytics/contracts';
import type {Store} from '../server/store';
import {beamSourceDates,fetchBeamSource} from '../sources/beam-fetch';
import {readRecentWritingCapture,type ArchiveReader} from './archive-materialization-retention';

/** Finish a qualified immutable single-day capture before querying a changing
 * provider. Each replay carries only its own original archive provenance. */
export async function* fetchBeamCaptures(source:Connection,client:Client,w:{from:string;to:string},store:Store,scope:AccessScope,secret:(name:string)=>string|null,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date(),readArchive?:ArchiveReader){
 for(const date of beamSourceDates(source,client,w,now)){
  const window={from:date,to:date},frozen=await readRecentWritingCapture(store,scope,source,client,window,{deadline,readArchive});
  if(frozen)yield {batch:frozen.batch,window,resumedCapture:{hash:frozen.hash,retrievedAt:frozen.retrievedAt}};
  else yield {batch:await fetchBeamSource(source,client,window,store,scope.organizationId,secret,fetcher,deadline,now),window};
 }
}
