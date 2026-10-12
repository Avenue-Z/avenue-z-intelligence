import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import type {QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
function database(){
 // Keep the per-day migration absent to verify durable range-cache SQL fallback.
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&!f.startsWith('0008_')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const queries:string[]=[],batches:{sql:string;values:unknown[]}[][]=[];
 const connect=()=>{const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,get values(){return values;},bind(...input:unknown[]){values=input;return statement;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values as any[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as any[]);return {meta:{changes:Number(result.changes)}};}};return statement;};return {prepare,async batch(statements:ReturnType<typeof prepare>[]){batches.push(statements.map(statement=>({sql:statement.sql,values:statement.values})));sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};};
 return {sqlite,connect,queries,batches};
}
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',mode:'closed',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function batch(clientId='a',value=42):SourceBatch{return {clientId,timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-07',dataset:'overview',metric:'revenue',value,currency:'USD',definition:'web',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]};}
function observationReads(queries:string[]){return queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;}
it('reuses exact captured observations from a new database adapter without source row reads',async()=>{
 const {connect,queries}=database(),store=new Store(connect());await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');const first=await store.observations('o','a',filters),reads=observationReads(queries);
 expect(await new Store(connect()).observations('o','a',filters)).toEqual(first);expect(observationReads(queries)).toBe(reads);
});
it('bypasses a durable entry when a source refresh publishes a new pointer',async()=>{
 const {connect,queries}=database(),s=new Store(connect());await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await s.observations('o','a',filters);const before=observationReads(queries);
 await new Store(connect()).persistBatch('o','source',batch('a',99),'two','2026-10-08T01:00:00Z');expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(99);expect(observationReads(queries)).toBeGreaterThan(before);
});
it('keeps durable entries isolated by organization and client before decoding',async()=>{
 const {connect,sqlite}=database(),s=new Store(connect());for(const [org,client,value] of [['o','a',42],['outside','a',99],['o','b',7]] as const){await s.persistBatch(org,'source',batch(client,value),'one','2026-10-08T00:00:00Z');await s.observations(org,client,filters);}
 expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(42);expect((await new Store(connect()).observations('outside','a',filters))[0].value).toBe(99);expect((await new Store(connect()).observations('o','b',filters))[0].value).toBe(7);expect(sqlite.prepare('SELECT COUNT(*) AS n FROM observation_cache_entries').get()?.n).toBe(3);
});
it('repairs corrupt derived chunks through a source read',async()=>{
 const {connect,queries,sqlite}=database(),s=new Store(connect());await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await s.observations('o','a',filters);sqlite.exec("UPDATE observation_cache_chunks SET payload='corrupt'");const before=observationReads(queries);
 expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(42);expect(observationReads(queries)).toBeGreaterThan(before);expect(sqlite.prepare("SELECT status FROM observation_cache_entries").get()?.status).toBe('ready');
});
it('fails open when the cache migration is absent or a cache write fails',async()=>{
 const {connect,sqlite}=database(),s=new Store(connect());await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');sqlite.exec('DROP TABLE observation_cache_chunks; DROP TABLE observation_cache_entries');expect((await s.observations('o','a',filters))[0].value).toBe(42);
});
it('bounds chunk responses and write batches, and retains at most twenty-four entries per client',async()=>{
 const {connect,sqlite,batches}=database(),s=new Store(connect()),rows=Array.from({length:1800},(_,index)=>({...batch().rows[0],dimensions:{page:`/${index}-${'x'.repeat(500)}`}}));await s.persistBatch('o','source',{...batch(),rows},'large','2026-10-08T00:00:00Z');const first=await s.observations('o','a',filters);
 expect(await new Store(connect()).observations('o','a',filters)).toEqual(first);const stored=sqlite.prepare('SELECT payload FROM observation_cache_chunks').all();expect(stored.length).toBeGreaterThan(4);for(const row of stored)expect(Buffer.byteLength(String(row.payload))).toBeLessThanOrEqual(256*1024);
 for(const writes of batches.filter(statements=>statements[0]?.sql.startsWith('INSERT INTO observation_cache_chunks'))){expect(writes.length).toBeLessThanOrEqual(4);expect(Buffer.byteLength(JSON.stringify(writes))).toBeLessThan(1024*1024);}
 for(let day=1;day<=30;day++)await new Store(connect()).observations('o','a',{...filters,from:`2026-10-${String(day).padStart(2,'0')}`,to:`2026-10-${String(day).padStart(2,'0')}`});expect(sqlite.prepare('SELECT COUNT(*) AS n FROM observation_cache_entries').get()?.n).toBe(24);expect(sqlite.prepare('SELECT COUNT(*) AS n FROM observation_cache_chunks c WHERE NOT EXISTS (SELECT 1 FROM observation_cache_entries e WHERE e.organizationId=c.organizationId AND e.clientId=c.clientId AND e.cacheKey=c.cacheKey AND e.generation=c.generation)').get()?.n).toBe(0);
});
it('stops warming before source reads when its dedicated deadline has passed',async()=>{
 const {connect,queries}=database(),s=new Store(connect());await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await expect(s.observations('o','a',filters,false,{deadline:Date.now()-1})).rejects.toThrow('budget elapsed');expect(observationReads(queries)).toBe(0);
});
it('does not publish incomplete staged chunks after a cache write failure',async()=>{
 const {connect,sqlite}=database(),db=connect(),s=new Store(db);await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');const batchWrite=db.batch;db.batch=async statements=>{if(statements.some(statement=>statement.sql.startsWith('INSERT INTO observation_cache_chunks')))throw Error('Cache unavailable');return batchWrite(statements);};
 expect((await s.observations('o','a',filters))[0].value).toBe(42);expect(sqlite.prepare('SELECT COUNT(*) AS n FROM observation_cache_entries').get()?.n).toBe(0);expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(42);
});
it('refreshes ready-cache recency only during native warming without re-reading source facts',async()=>{
 const {connect,sqlite,queries}=database(),s=new Store(connect());await s.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await s.observations('o','a',filters);
 const first=sqlite.prepare('SELECT generation FROM observation_cache_entries').get();sqlite.exec("UPDATE observation_cache_entries SET createdAt='2000-01-01T00:00:00Z'");const before=observationReads(queries);
 await new Store(connect()).observations('o','a',filters,false,{deadline:Date.now()+60000});expect(observationReads(queries)).toBe(before);expect(sqlite.prepare('SELECT generation FROM observation_cache_entries').get()).toEqual(first);expect(String(sqlite.prepare('SELECT createdAt FROM observation_cache_entries').get()?.createdAt)).not.toBe('2000-01-01T00:00:00Z');
 sqlite.exec("UPDATE observation_cache_entries SET createdAt='2000-01-01T00:00:00Z'");await new Store(connect()).observations('o','a',filters);expect(sqlite.prepare('SELECT createdAt FROM observation_cache_entries').get()?.createdAt).toBe('2000-01-01T00:00:00Z');
});
