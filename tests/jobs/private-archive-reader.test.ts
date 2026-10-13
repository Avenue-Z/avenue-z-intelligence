import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';
import {fingerprint} from '../../lib/reviews/build';
const state=vi.hoisted(()=>({text:'',bytes:0,getSize:0,headTag:'"stored-content"',getTag:'W/"stored-content"',wrongPath:false}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'private-test-token'}));
vi.mock('@vercel/blob',()=>({head:async(key:string)=>({pathname:key,size:state.bytes,etag:state.headTag}),get:async(key:string)=>({statusCode:200,blob:{pathname:state.wrongPath?'another-archive':key,size:state.getSize,etag:state.getTag},stream:new ReadableStream<Uint8Array>({start(controller){const bytes=new TextEncoder().encode(state.text),cut=Math.floor(bytes.length/2);controller.enqueue(bytes.slice(0,cut));controller.enqueue(bytes.slice(cut));controller.close();}})})}));
import {pruneArchivedMaterializations} from '../../lib/jobs/archive-materialization-retention';
const scope:AccessScope={organizationId:'o',actorId:'history-scheduler',role:'service',permittedClientIds:['kind-patches']};
let sqlite:DatabaseSync,store:Store,oldId:string,currentId:string;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T18:00:00Z');state.getSize=0;state.headTag='"stored-content"';state.getTag='W/"stored-content"';state.wrongPath=false;
 sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});const client={...initial[0],version:1};
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 const batch=(value:number):SourceBatch=>({clientId:client.id,timezone:client.timezone,currency:client.currency,grain:'hourly',channels:[],dimensions:[],complete:true,coverageThrough:'2026-10-13T10:00:00Z',rows:[{date:'2026-10-13',dataset:'revenue',metric:'revenue',population:'sales',value,definition:'qualified',currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete',start:'2026-10-13T09:00:00Z',end:'2026-10-13T10:00:00Z'}]});
 const old=batch(40);state.text=JSON.stringify(old);state.bytes=new TextEncoder().encode(state.text).byteLength;oldId=await store.persistBatch('o','source',old,await fingerprint(old),'2026-10-13T10:00:00Z');
 const current=batch(90);currentId=await store.persistBatch('o','source',current,await fingerprint(current),'2026-10-13T11:00:00Z');
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
const prune=()=>pruneArchivedMaterializations(store,scope,{maxSnapshots:1,maxRows:2000,deadline:Date.now()+60000});
it.each([0,10])('verifies exact stored bytes and hash through a chunked/compressed GET with transfer size %s and equivalent weak ETag',async size=>{
 state.getSize=size;const current=await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId),metadata=await store.all('SELECT * FROM snapshots');
 expect((await prune()).rowsDeleted).toBe(1);expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId)).toEqual(current);expect(await store.all('SELECT * FROM snapshots')).toEqual(metadata);expect(await store.first("SELECT COUNT(*) n FROM audit WHERE action='snapshot.materialization.archive_verified'")).toEqual({n:1});
});
it.each(['changed-etag','missing-etag','wrong-path','short-stream','oversized-stream','wrong-hash'])('retains every fact when the private archive has %s',async invalid=>{
 if(invalid==='changed-etag')state.getTag='W/"different-content"';if(invalid==='missing-etag')state.getTag='';if(invalid==='wrong-path')state.wrongPath=true;
 if(invalid==='short-stream')state.text=state.text.slice(0,-1);if(invalid==='oversized-stream')state.text+=' ';if(invalid==='wrong-hash')state.text=state.text.replace('"value":40','"value":41');
 const facts=await store.all('SELECT * FROM observations');expect((await prune()).rowsDeleted).toBe(0);expect(await store.all('SELECT * FROM observations')).toEqual(facts);expect(await store.first('SELECT COUNT(*) n FROM audit')).toEqual({n:0});
});
