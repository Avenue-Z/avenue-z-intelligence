import type {detailRows} from './query';
type Detail=ReturnType<typeof detailRows>[number];
export function chooseBenchmark(row:Detail,current:Detail[],previous:Detail[],market:string){
  const sameContext=(r:Detail)=>['page','source','device','stream'].every(k=>(r.dimensions[k]??'')===(row.dimensions[k]??''));
  const peer=row.dimensions.market&&row.dimensions.market!==market?current.find(r=>r.dimensions.market===market&&sameContext(r)&&r.summary.cvr!==null):undefined;
  if(peer)return {cvr:peer.summary.cvr,reason:'Same page in benchmark market',reference:peer};
  const own=previous.find(r=>r.key===row.key&&r.summary.cvr!==null);if(own)return {cvr:own.summary.cvr,reason:'Own previous period',reference:own};
  const family=row.dimensions.family;const comparable=family?current.filter(r=>r.dimensions.family===family&&r.dimensions.market===row.dimensions.market&&r.summary.cvr!==null&&r.summary.sessions!==null).sort((a,b)=>b.summary.sessions!-a.summary.sessions!).slice(0,5).filter(r=>r.key!==row.key).sort((a,b)=>a.summary.cvr!-b.summary.cvr!)[0]:undefined;
  return comparable?{cvr:comparable.summary.cvr,reason:'Weakest comparable top-five page',reference:comparable}:{cvr:null,reason:'No comparable benchmark',reference:null};
}
