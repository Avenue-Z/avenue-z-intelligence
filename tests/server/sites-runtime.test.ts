import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({bindings:{DB:null,TURSO_DATABASE_URL:'libsql://runtime-fixture.invalid',TURSO_AUTH_TOKEN:'test-only'},clients:[] as {close:()=>void}[],guardDatabaseReads:false,databaseReads:0}));
vi.mock('cloudflare:workers',()=>({env:state.bindings}));
// Exercise the production wrapper and SQL adapter against real isolated SQLite
// databases; replace only the remote transport factory to avoid network I/O.
vi.mock('@libsql/client/web',async()=>{const {createClient}=await import('@libsql/client');return {createClient:()=>{const client=createClient({url:'file::memory:'});state.clients.push(client);return client;}};});
vi.mock('@avenue/runtime',async()=>{const runtime=await import('../../lib/server/runtime');return {...runtime,env:new Proxy(runtime.env,{get(target,key){if(key==='DB'&&state.guardDatabaseReads&&++state.databaseReads>1)throw Error('Database binding evaluated twice in one Store creation');return Reflect.get(target,key);}})};});
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:async()=>null}));
import {getStore} from '../../lib/server/access';
beforeEach(()=>{state.databaseReads=0;state.guardDatabaseReads=false;});
afterEach(()=>{for(const client of state.clients)client.close();state.clients.length=0;});
it('creates separate Sites SDK clients rather than carrying a prior request database into another Store',async()=>{
 const first=getStore();await first.run('CREATE TABLE request_owner(value TEXT)');await first.run('INSERT INTO request_owner VALUES(?)','first request');
 const second=getStore();expect(await second.first("SELECT name FROM sqlite_master WHERE name='request_owner'")).toBeNull();expect(await first.first('SELECT value FROM request_owner')).toEqual({value:'first request'});
 expect(first.db.allowCrossRequestCoalescing).toBe(false);expect(second.db.allowCrossRequestCoalescing).toBe(false);
});
it('reads the Sites database binding once while creating a usable Store',async()=>{
 state.guardDatabaseReads=true;const store=getStore();await store.run('CREATE TABLE request_owner(value INTEGER)');await store.run('INSERT INTO request_owner VALUES(7)');expect(await store.first('SELECT value FROM request_owner')).toEqual({value:7});
});
