import type {detailRows} from './query';
import {sourceMarket} from '../sources/kind-patches';
type Detail=ReturnType<typeof detailRows>[number];
/** Prepare once for a dataset's candidates. Array order remains authoritative
 * for matching peers/prior rows and stable ties within the top-five family. */
export function benchmarkLookup(current:Detail[],previous:Detail[],market:string){
 const marketOf=(r:Detail)=>r.dimensions.market?sourceMarket(r.dimensions.market):'',target=sourceMarket(market);
 const context=(r:Detail)=>JSON.stringify(['page','source','device','stream'].map(key=>r.dimensions[key]??'')),familyKey=(family:string,market:string)=>JSON.stringify([family,market]);
 const peers=new Map<string,Detail>(),prior=new Map<string,Detail>(),firstPrior=new Map<string,Detail>(),families=new Map<string,Detail[]>();
 for(const row of previous){if(!firstPrior.has(row.key))firstPrior.set(row.key,row);if(row.summary.cvr!==null&&!prior.has(row.key))prior.set(row.key,row);}
 for(const row of current){if(row.summary.cvr===null)continue;const rowMarket=marketOf(row);
  if(rowMarket===target){const key=context(row);if(!peers.has(key))peers.set(key,row);}
  if(row.dimensions.family&&row.summary.sessions!==null){const key=familyKey(row.dimensions.family,rowMarket),group=families.get(key);if(group)group.push(row);else families.set(key,[row]);}
 }
 for(const [key,rows] of families)families.set(key,rows.sort((a,b)=>b.summary.sessions!-a.summary.sessions!).slice(0,5));
 return {
  previous:(key:string)=>firstPrior.get(key),
  choose(row:Detail){const rowMarket=marketOf(row),peer=rowMarket&&rowMarket!==target?peers.get(context(row)):undefined;
   if(peer)return {cvr:peer.summary.cvr,reason:'Same page in benchmark market',reference:peer};
   const own=prior.get(row.key);if(own)return {cvr:own.summary.cvr,reason:'Own previous period',reference:own};
   const comparable=row.dimensions.family?families.get(familyKey(row.dimensions.family,rowMarket))?.filter(r=>r.key!==row.key).sort((a,b)=>a.summary.cvr!-b.summary.cvr!)[0]:undefined;
   return comparable?{cvr:comparable.summary.cvr,reason:'Weakest comparable top-five page',reference:comparable}:{cvr:null,reason:'No comparable benchmark',reference:null};
  }
 };
}
export function chooseBenchmark(row:Detail,current:Detail[],previous:Detail[],market:string){
  // Compare canonical values without rewriting saved evidence or client config.
  const marketOf=(r:Detail)=>r.dimensions.market?sourceMarket(r.dimensions.market):'',target=sourceMarket(market),rowMarket=marketOf(row);
  const sameContext=(r:Detail)=>['page','source','device','stream'].every(k=>(r.dimensions[k]??'')===(row.dimensions[k]??''));
  const peer=rowMarket&&rowMarket!==target?current.find(r=>marketOf(r)===target&&sameContext(r)&&r.summary.cvr!==null):undefined;
  if(peer)return {cvr:peer.summary.cvr,reason:'Same page in benchmark market',reference:peer};
  const own=previous.find(r=>r.key===row.key&&r.summary.cvr!==null);if(own)return {cvr:own.summary.cvr,reason:'Own previous period',reference:own};
  const family=row.dimensions.family;const comparable=family?current.filter(r=>r.dimensions.family===family&&marketOf(r)===rowMarket&&r.summary.cvr!==null&&r.summary.sessions!==null).sort((a,b)=>b.summary.sessions!-a.summary.sessions!).slice(0,5).filter(r=>r.key!==row.key).sort((a,b)=>a.summary.cvr!-b.summary.cvr!)[0]:undefined;
  return comparable?{cvr:comparable.summary.cvr,reason:'Weakest comparable top-five page',reference:comparable}:{cvr:null,reason:'No comparable benchmark',reference:null};
}
