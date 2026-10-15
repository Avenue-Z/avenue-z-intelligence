import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope,Client,Connection,SourceBatch} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
import {fingerprint} from '../../lib/reviews/build';
import {dayWindow} from '../../lib/analytics/windows';
import {readRecentWritingCapture,type ArchiveReader} from '../../lib/jobs/archive-materialization-retention';
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']},now=Date.parse('2026-10-15T13:35:00Z'),retrievedAt='2026-10-15T13:07:00Z',window={from:'2026-10-15',to:'2026-10-15'};
let sqlite:DatabaseSync,store:Store,client:Client,source:Connection,batch:SourceBatch,id:string,archive:string;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{const s={sql,values:[] as SQLInputValue[],bind(...values:unknown[]){s.values=values as SQLInputValue[];return s;},async all(){return {results:sqlite.prepare(sql).all(...s.values)};},async first(){return sqlite.prepare(sql).get(...s.values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...s.values).changes)}};}};return s;};
 store=new Store({prepare,async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}});
 client={...initial[0],version:1} as Client;
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections VALUES('source','o','kind-patches','Traffic','kind-shopify-traffic','https://example.com','PRIVATE',60,1,'2026-10-15T12:10:00Z','2026-10-15T12:00:00Z',NULL,1)");
 source=(await store.connections('o','kind-patches'))[0];
 batch={clientId:client.id,timezone:client.timezone,currency:client.currency,grain:'hourly',channels:[],dimensions:['page'],complete:true,coverageThrough:'2026-10-15T13:00:00Z',rows:Array.from({length:1001},(_,n)=>({date:window.from,dataset:'traffic',metric:'sessions',value:n+1,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:`/page-${n}`},start:'2026-10-15T12:00:00Z',end:'2026-10-15T13:00:00Z',sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}))};
 await store.saveQualification('o',client.id,source.id,1,1,{clientId:client.id,queryId:'kind-shopify-traffic:hourly-v2',timezone:client.timezone,currency:client.currency,hourlyGrain:true,channels:[],requiredChannels:[],dimensions:['page'],requiredDimensions:['page'],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent public landing-page reconciliation',profiles:[{dataset:'traffic',metric:'sessions',definition:batch.rows[0].definition,population:batch.rows[0].population,currency:null,dimensions:['page'],hourly:true}]},scope.actorId);
 const hash=await fingerprint(batch);id=`o:${client.id}:${source.id}:${hash}`;archive=JSON.stringify(batch);
 await store.run('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)',id,'o',client.id,source.id,retrievedAt,batch.coverageThrough,1,'writing',`snapshots/${id}.json`);
 for(const row of batch.rows.slice(0,500))await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,row.date,JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]),JSON.stringify({...row,sourceId:source.id,channels:[],retrievedAt,coverageThrough:batch.coverageThrough}));
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
const reader:ArchiveReader=async key=>({pathname:key,text:archive,bytes:new TextEncoder().encode(archive).byteLength,etag:'immutable'});
const read=(options:{readArchive?:ArchiveReader;deadline?:number}={})=>readRecentWritingCapture(store,scope,source,client,window,{deadline:now+700000,readArchive:reader,...options});

it('recovers the exact recent immutable capture without changing facts, health, or pointers',async()=>{
 const old=await store.all('SELECT * FROM observations ORDER BY rowKey'),health=await store.all('SELECT * FROM connections'),result=await read();
 expect(result).toEqual({batch,hash:id.split(':').at(-1),retrievedAt});
 expect(await store.all('SELECT * FROM observations ORDER BY rowKey')).toEqual(old);expect(await store.all('SELECT * FROM connections')).toEqual(health);expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(await store.first('SELECT status FROM snapshots WHERE id=?',id)).toEqual({status:'writing'});
});
it('finishes original facts before publishing while preserving every original retrieval timestamp',async()=>{
 const frozen=await read();expect(frozen).not.toBeNull();const original=store.db.batch,health=await store.all('SELECT * FROM connections');let facts=0;
 store.db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){facts+=JSON.parse(String((statements[0] as unknown as {values:unknown[]}).values[1])).length;expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(await store.all('SELECT * FROM connections')).toEqual(health);}return original(statements);};
 await store.persistBatch('o',source.id,frozen!.batch,frozen!.hash,frozen!.retrievedAt,window,{publicationDeadline:now+700000,factPageSize:500});
 expect(facts).toBe(501);expect(await store.first('SELECT status FROM snapshots WHERE id=?',id)).toEqual({status:'ready'});expect(await store.first('SELECT snapshotId FROM current_snapshots')).toEqual({snapshotId:id});
 expect(await store.first("SELECT count(*) n FROM observations WHERE snapshotId=? AND json_extract(payload,'$.retrievedAt')<>?",id,retrievedAt)).toEqual({n:0});
});
it.each(['source-version','client-version','qualification-version','disabled','ready','stale','future-retrieval','future-cutoff','coverage-after-retrieval','closed-partial','wrong-day','wrong-profile','bad-hash','bad-path','archived','half-hour','newer-pointer'] as const)('rejects %s without publishing or deleting any evidence',async reason=>{
 if(reason==='source-version')await store.run('UPDATE connections SET version=2');
 if(reason==='client-version')await store.run('UPDATE clients SET version=2');
 if(reason==='qualification-version')await store.run('UPDATE qualifications SET connectionVersion=2');
 if(reason==='disabled')await store.run('UPDATE connections SET enabled=0');
 if(reason==='ready')await store.run("UPDATE snapshots SET status='ready'");
 if(reason==='stale')await store.run("UPDATE snapshots SET retrievedAt='2026-10-15T11:34:59Z'");
 if(reason==='future-retrieval')await store.run("UPDATE snapshots SET retrievedAt='2026-10-15T14:00:00Z'");
 if(reason==='coverage-after-retrieval')await store.run("UPDATE snapshots SET retrievedAt='2026-10-15T12:59:00Z'");
 if(reason==='future-cutoff')await store.run("UPDATE snapshots SET coverageThrough='2026-10-15T14:00:00Z'");
 if(reason==='closed-partial')window.from=window.to='2026-10-14';
 if(reason==='wrong-day'||reason==='wrong-profile'||reason==='half-hour'){
  const changed=reason==='wrong-day'?{...batch,rows:batch.rows.map(row=>({...row,date:'2026-10-14'}))}:reason==='wrong-profile'?{...batch,rows:batch.rows.map(row=>({...row,definition:'other'}))}:{...batch,coverageThrough:'2026-10-15T12:30:00Z',rows:batch.rows.map(row=>({...row,start:'2026-10-15T12:00:00Z',end:'2026-10-15T12:30:00Z'}))};
  archive=JSON.stringify(changed);const next=`o:${client.id}:${source.id}:${await fingerprint(changed)}`;await store.run('UPDATE snapshots SET id=?,objectKey=?,coverageThrough=? WHERE id=?',next,`snapshots/${next}.json`,changed.coverageThrough,id);
 }
 if(reason==='bad-hash')archive=JSON.stringify({...batch,rows:[]});
 if(reason==='bad-path')await store.run("UPDATE snapshots SET objectKey='other-path'");
 if(reason==='archived')await store.run('INSERT INTO audit VALUES(?,?,?,?,?,?,?)',`archive-materialization:${id}`,'o',client.id,'operator','snapshot.materialization.archive_verified','{}',new Date().toISOString());
 if(reason==='newer-pointer')await store.run('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId,publishedAt) VALUES(?,?,?,?,?,?)','o',client.id,source.id,window.from,'newer-ready-snapshot','2026-10-15T13:10:00Z');
 const facts=await store.all('SELECT * FROM observations ORDER BY rowKey'),pointers=await store.all('SELECT * FROM current_snapshots');try{expect(await read()).toBeNull();expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointers);expect(await store.all('SELECT * FROM observations ORDER BY rowKey')).toEqual(facts);}finally{window.from=window.to='2026-10-15';}
});
it('reads at most one candidate archive and rejects source configuration changing during that read',async()=>{
 const readArchive=vi.fn<ArchiveReader>(async(key,deadline)=>{const r=await reader(key,deadline);await store.run('UPDATE connections SET version=2');return r;});
 expect(await read({readArchive})).toBeNull();expect(readArchive).toHaveBeenCalledOnce();
});
it('falls back when private archive access fails and never reads an archive without remaining budget',async()=>{
 expect(await read({readArchive:async()=>{throw Error('Private archive unavailable');}})).toBeNull();const readArchive=vi.fn(reader);expect(await read({deadline:now,readArchive})).toBeNull();expect(readArchive).not.toHaveBeenCalled();
});
it('accepts a fully covered historical store day and rejects partial historical coverage',async()=>{
 const historical='2026-10-14',day=dayWindow(historical,client.timezone);batch={...batch,coverageThrough:day.end,rows:batch.rows.map(row=>({...row,date:historical,start:day.start,end:new Date(Date.parse(day.start)+3600000).toISOString()}))};
 const hash=await fingerprint(batch),key=`o:${client.id}:${source.id}:${hash}`;archive=JSON.stringify(batch);await store.run('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)',key,'o',client.id,source.id,retrievedAt,batch.coverageThrough,1,'writing',`snapshots/${key}.json`);
 expect(await readRecentWritingCapture(store,scope,source,client,{from:historical,to:historical},{deadline:now+700000,readArchive:reader})).toMatchObject({hash,retrievedAt});
});
