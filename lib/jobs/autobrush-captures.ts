import type {AccessScope,Client,Connection} from '../analytics/contracts';
import type {Store} from '../server/store';
import {autobrushSourceDates,fetchAutobrushSource} from '../sources/autobrush-fetch';
import {readRecentWritingCapture,type ArchiveReader} from './archive-materialization-retention';
export async function* fetchAutobrushCaptures(source:Connection,client:Client,w:{from:string;to:string},store:Store,scope:AccessScope,secret:(key:string)=>string|null,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date(),readArchive?:ArchiveReader){
 for(const date of autobrushSourceDates(source,client,w,now)){
  const window={from:date,to:date},frozen=await readRecentWritingCapture(store,scope,source,client,window,{deadline,readArchive});
  if(frozen)yield {batch:frozen.batch,window,resumedCapture:{hash:frozen.hash,retrievedAt:frozen.retrievedAt}};
  else yield {batch:await fetchAutobrushSource(source,client,window,store,scope.organizationId,secret,fetcher,deadline,now),window};
 }
}
