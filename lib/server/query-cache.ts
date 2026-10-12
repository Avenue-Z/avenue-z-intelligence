type Entry={payload:string;expiresAt:number;bytes:number};
type CacheOptions={ttlMs:number;maxEntries:number;maxBytes:number;maxEntryBytes:number;coalesce?:boolean};
type Codec<T>={encode:(value:T)=>string;decode:(payload:string)=>T};

/** Serialized entries keep memory bounded and give every caller its own data.
 * This cache is an optional warm-instance optimization, never a freshness or
 * authorization boundary. Callers must validate their source version first.
 */
export class QueryCache<T> {
 private entries=new Map<string,Entry>();
 private pending=new Map<string,Promise<string>>();
 private bytes=0;
 constructor(private options:CacheOptions,private codec:Codec<T>={encode:JSON.stringify,decode:JSON.parse}){}
 private remove(key:string){const entry=this.entries.get(key);if(entry){this.bytes-=entry.bytes;this.entries.delete(key);}}
 async get(key:string,load:()=>Promise<T>):Promise<T>{
  return this.getEncoded(key,async()=>this.codec.encode(await load()));
 }
 async getEncoded(key:string,load:()=>Promise<string>):Promise<T>{
  const now=Date.now();
  for(const [cachedKey,entry] of this.entries)if(entry.expiresAt<=now)this.remove(cachedKey);
  const cached=this.entries.get(key);
  if(cached){this.entries.delete(key);this.entries.set(key,cached);return this.codec.decode(cached.payload);}
  const current=this.options.coalesce===false?undefined:this.pending.get(key);if(current)return this.codec.decode(await current);
  const work=(async()=>{
   const payload=await load(),bytes=2*(key.length+payload.length);
   if(bytes<=this.options.maxEntryBytes&&bytes<=this.options.maxBytes){
    this.remove(key);
    while(this.entries.size>=this.options.maxEntries||this.bytes+bytes>this.options.maxBytes){const oldest=this.entries.keys().next().value;if(oldest===undefined)break;this.remove(oldest);}
    this.entries.set(key,{payload,bytes,expiresAt:Date.now()+this.options.ttlMs});this.bytes+=bytes;
   }
   return payload;
  })();
  // Requests outside the bounded coalescing set still load normally.
  const coalesced=this.options.coalesce!==false&&this.pending.size<this.options.maxEntries;
  if(coalesced)this.pending.set(key,work);
  try{return this.codec.decode(await work);}finally{if(coalesced)this.pending.delete(key);}
 }
}
