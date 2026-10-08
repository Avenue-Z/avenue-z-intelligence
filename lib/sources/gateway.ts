import type {Client,Connection,SourceBatch} from '../analytics/contracts';
import {validateBatch,safeSourceUrl} from './qualification';
export async function fetchGateway(connection:Connection,client:Client,window:{from:string;to:string},secret:string,fetcher:typeof fetch=fetch,deadline=Date.now()+40000):Promise<SourceBatch> {
  const rows:SourceBatch['rows']=[],keys=new Set<string>();let cursor:string|null=null,first:SourceBatch|null=null;
  for(let page=0;page<10;page++){
    if(Date.now()>=deadline)throw new Error('Source synchronization deadline reached');
    const response=await fetcher(safeSourceUrl(connection.endpoint),{method:'POST',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now()))),headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({clientId:client.id,timezone:client.timezone,currency:client.currency,...window,cursor})});
    if(!response.ok)throw new Error(`Source returned HTTP ${response.status}`);
    const text=await response.text();if(text.length>6000000)throw new Error('Source page exceeds 6 MB');
    const data=validateBatch(JSON.parse(text),client.id);
    if(data.timezone!==client.timezone)throw new Error('Timezone mismatch');if(data.currency!==client.currency)throw new Error('Currency mismatch');
    if(first&&(data.grain!==first.grain||JSON.stringify([...data.channels].sort())!==JSON.stringify([...first.channels].sort())||data.coverageThrough!==first.coverageThrough))throw new Error('Coverage changed during pagination');
    first??=data;
    for(const r of data.rows){if(r.date<window.from||r.date>window.to)throw new Error('Observation outside requested window');const key=JSON.stringify([r.date,r.dataset,r.metric,Object.entries(r.dimensions).sort()]);if(keys.has(key))throw new Error('Duplicate aggregate grain');keys.add(key);rows.push(r);}
    if(rows.length>50000)throw new Error('Source batch exceeds 50,000 rows');
    first.complete=first.complete&&data.complete;cursor=data.nextCursor??null;
    if(!cursor)return {...first,rows,nextCursor:null};
  }
  throw new Error('Pagination did not complete within 10 pages');
}
