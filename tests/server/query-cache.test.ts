import {expect,it} from 'vitest';
import {QueryCache} from '../../lib/server/query-cache';
it('evicts serialized data when the byte budget is reached before the entry count',async()=>{
 const cache=new QueryCache<string>({ttlMs:60000,maxEntries:10,maxBytes:250,maxEntryBytes:200});let loads=0;const load=async()=>{loads++;return 'x'.repeat(60);};
 await cache.get('one',load);await cache.get('two',load);expect(await cache.get('one',load)).toHaveLength(60);expect(loads).toBe(3);
});
it('does not retain a response larger than the per-entry memory allowance',async()=>{
 const cache=new QueryCache<string>({ttlMs:60000,maxEntries:10,maxBytes:1000,maxEntryBytes:200});let loads=0;const load=async()=>{loads++;return 'x'.repeat(200);};
 await cache.get('large',load);await cache.get('large',load);expect(loads).toBe(2);
});
it('shares one failing load and retries cleanly instead of caching the error',async()=>{
 const cache=new QueryCache<string>({ttlMs:60000,maxEntries:10,maxBytes:1000,maxEntryBytes:200});let loads=0;const failing=async()=>{loads++;throw Error('Source read failed');};
 const results=await Promise.allSettled([cache.get('one',failing),cache.get('one',failing)]);expect(results.map(result=>result.status)).toEqual(['rejected','rejected']);expect(loads).toBe(1);
 expect(await cache.get('one',async()=>{loads++;return 'fresh';})).toBe('fresh');expect(loads).toBe(2);
});
it('loads a fresh request when cross-request promise sharing is disabled and an earlier request was abandoned',async()=>{
 const cache=new QueryCache<string>({ttlMs:60000,maxEntries:10,maxBytes:1000,maxEntryBytes:200,coalesce:false});
 void cache.get('one',()=>new Promise<string>(()=>{}));
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const fresh=await Promise.race([cache.get('one',async()=> 'fresh'),new Promise<string>((_,reject)=>{timer=setTimeout(()=>reject(Error('Joined abandoned request')),30);})]);expect(fresh).toBe('fresh');expect(await cache.get('one',async()=>{throw Error('Ready cache was lost');})).toBe('fresh');}
 finally{clearTimeout(timer);}
});
