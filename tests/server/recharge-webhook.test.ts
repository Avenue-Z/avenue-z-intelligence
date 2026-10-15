import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {receiveRechargeWebhook} from '../../lib/server/recharge-webhook';
import {POST} from '../../app/api/webhooks/recharge/route';

const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,store:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,runtimePlatform:'vercel'}));
vi.mock('../../lib/server/access',()=>({getStore:state.store}));
const secret='test-client-secret-that-is-not-an-api-token',domain='bright-patches.myshopify.com',now='2026-10-15T16:10:00.000Z',birth='2026-10-15T16:00:00Z';
const payload=(createdAt:unknown=birth,id:unknown=123)=>({subscription:{id,created_at:createdAt,email:'never-store@example.com',customer_id:456,address:{city:'Never store'},order_id:789},customer:{email:'also-never-store@example.com'}});
let sqlite:DatabaseSync,store:Store,getStore:()=>Store;
function delivery(options:{payload?:unknown;raw?:string|Uint8Array;timestamp?:number;headers?:Record<string,string|undefined>}={}){
 const raw=Buffer.from(options.raw??JSON.stringify(options.payload??payload())),timestamp=String(options.timestamp??Math.floor(Date.parse(now)/1000));
 const headers=new Headers({'Content-Type':'application/json','X-Recharge-Webhook-Timestamp':timestamp,'X-Recharge-Webhook-Signature':`t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex')}`,'X-Recharge-External-Platform-Domain':domain,'X-Recharge-Topic':'subscription/created'});
 for(const [key,value] of Object.entries(options.headers??{})){if(value===undefined)headers.delete(key);else headers.set(key,value);}
 return new Request('https://example.com/api/webhooks/recharge',{method:'POST',headers,body:raw});
}
const receive=(request:Request,options:Record<string,unknown>={})=>receiveRechargeWebhook(request,{store:getStore,organizationId:'avenue-z',clientSecret:secret,storeDomain:domain,now:new Date(now),...options});
const records=()=>store.all<{id:string;organizationId:string;clientId:string;actorId:string;action:string;payload:string;createdAt:string}>('SELECT * FROM audit ORDER BY id');
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(now);sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});getStore=vi.fn(()=>store);state.store.mockReset();state.store.mockReturnValue(store);
 for(const key of Object.keys(state.env))delete state.env[key];Object.assign(state.env,{RECHARGE_WEBHOOK_CLIENT_SECRET:secret,RECHARGE_WEBHOOK_STORE_DOMAIN:domain});
 vi.stubEnv('RECHARGE_WEBHOOK_CLIENT_SECRET',undefined);vi.stubEnv('RECHARGE_WEBHOOK_STORE_DOMAIN',undefined);vi.stubEnv('APP_ORGANIZATION_ID',undefined);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();sqlite.close();});

it.each(['subscription/created','subscription/cancelled','subscription/deleted'])('retains only authenticated subscription birth evidence from %s',async topic=>{
 const response=await receive(delivery({headers:{'X-Recharge-Topic':topic}}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
 const rows=await records();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:'recharge-creation:avenue-z:kind-patches:123',organizationId:'avenue-z',clientId:'kind-patches',actorId:'recharge-webhook',action:'recharge.subscription.creation.retained',createdAt:now});
 expect(JSON.parse(rows[0].payload)).toEqual({subscriptionId:'123',createdAt:birth,receivedAt:now,source:'recharge-webhook',topic});expect(JSON.stringify(rows)).not.toMatch(/email|customer_id|address|order_id|Never store/);
});
it('verifies the exact UTF-8 bytes, including whitespace, instead of reserializing JSON',async()=>{
 const raw=' { "subscription": { "id": 123, "created_at": "2026-10-15T16:00:00Z", "ignored": "✓" } }\n';expect((await receive(delivery({raw}))).status).toBe(200);expect(await records()).toHaveLength(1);
});
it('rejects a modified raw body signed for a different representation',async()=>{
 const signed=delivery(),request=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify(payload())+' '});expect((await receive(request)).status).toBe(401);expect(getStore).not.toHaveBeenCalled();expect(await records()).toEqual([]);
});
it.each(['X-Recharge-Webhook-Signature','X-Recharge-Webhook-Timestamp','X-Recharge-External-Platform-Domain'])('rejects missing %s before opening the database',async header=>{
 expect((await receive(delivery({headers:{[header]:undefined}}))).status).toBe(401);expect(getStore).not.toHaveBeenCalled();
});
it.each(['wrong.myshopify.com','https://bright-patches.myshopify.com','bright-patches.myshopify.com.attacker.com','bright-patches.myshopify.com:443'])('rejects the nonmatching store domain %s',async value=>{
 expect((await receive(delivery({headers:{'X-Recharge-External-Platform-Domain':value}}))).status).toBe(401);expect(getStore).not.toHaveBeenCalled();
});
it.each(['','v1='+'a'.repeat(64),'t=1,v1='+'a'.repeat(64),'t=no,v1='+'a'.repeat(64),'t=1792080600,v1=short','t=1792080600,v1='+'z'.repeat(64),'t=1792080600,t=1792080600,v1='+'a'.repeat(64),'t=1792080600,v1='+'a'.repeat(64)+',v1='+'b'.repeat(64)])('rejects a malformed or mismatched signature %s',async signature=>{
 expect((await receive(delivery({headers:{'X-Recharge-Webhook-Signature':signature}}))).status).toBe(401);expect(getStore).not.toHaveBeenCalled();
});
it('ignores a future signature scheme while still requiring the valid v1',async()=>{
 const request=delivery();request.headers.append('X-Recharge-Webhook-Signature','v2=ignored');expect((await receive(request)).status).toBe(200);
});
it.each([-172801,301])('rejects a delivery timestamp offset by %s seconds',async offset=>{
 expect((await receive(delivery({timestamp:Math.floor(Date.parse(now)/1000)+offset}))).status).toBe(401);expect(getStore).not.toHaveBeenCalled();
});
it.each([-172800,300])('accepts the permitted timestamp boundary of %s seconds',async offset=>{
 expect((await receive(delivery({timestamp:Math.floor(Date.parse(now)/1000)+offset,payload:payload('2026-10-12T12:00:00Z')}))).status).toBe(200);
});
it.each(['subscription/updated','customer/created','',undefined])('rejects unsupported or absent topic %s',async topic=>{
 expect((await receive(delivery({headers:{'X-Recharge-Topic':topic}}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'0','-1','1.1','01','unsafe',null])('rejects invalid subscription id %s',async id=>{
 expect((await receive(delivery({payload:payload(birth,id)}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();
});
it('accepts a canonical numeric string subscription id',async()=>{
 expect((await receive(delivery({payload:payload(birth,'123')}))).status).toBe(200);expect((await records())[0].id).toBe('recharge-creation:avenue-z:kind-patches:123');
});
it.each([null,{},[],{subscription:[]},{subscription:null},{subscription:{id:123},created_at:birth},{subscription:{id:123,event_created_at:birth}}])('never infers subscription birth from missing resource data: %j',async body=>{
 const raw=JSON.stringify(body);expect((await receive(delivery({raw}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();
});
it.each([null,'','2026-02-30T10:00:00Z','2026-10-15','2026-10-16T16:00:00Z','invalid',123])('rejects invalid subscription birth %s',async createdAt=>{
 expect((await receive(delivery({payload:payload(createdAt)}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();
});
it.each(['2026-10-15T16:00:00','2026-10-15 16:00:00','2026-10-15T17:00:00+01:00'])('uses the existing Recharge UTC contract for resource birth %s',async createdAt=>{
 expect((await receive(delivery({payload:payload(createdAt)}))).status).toBe(200);expect(JSON.parse((await records())[0].payload).createdAt).toBe(birth);
});
it('normalizes an explicit UTC offset and preserves the first delivery metadata across a retry',async()=>{
 expect((await receive(delivery({payload:payload('2026-10-15T16:00:00+00:00')}))).status).toBe(200);const before=await records();
 expect((await receive(delivery({headers:{'X-Recharge-Topic':'subscription/deleted'}}),{now:new Date('2026-10-15T16:11:00Z')})).status).toBe(200);expect(await records()).toEqual(before);expect(JSON.parse(before[0].payload).createdAt).toBe(birth);
});
it('rejects a conflicting authenticated birth instead of overwriting the retained timestamp',async()=>{
 expect((await receive(delivery())).status).toBe(200);const before=await records();expect((await receive(delivery({payload:payload('2026-10-15T15:59:59Z')}))).status).toBe(409);expect(await records()).toEqual(before);
});
it('keeps concurrent conflicting deliveries first-wins',async()=>{
 const responses=await Promise.all([receive(delivery()),receive(delivery({payload:payload('2026-10-15T15:59:59Z')}))]);expect(responses.map(response=>response.status).sort()).toEqual([200,409]);expect(await records()).toHaveLength(1);
});
it('rejects a deterministic-id collision with another tenant or action',async()=>{
 await store.run('INSERT INTO audit VALUES(?,?,?,?,?,?,?)','recharge-creation:avenue-z:kind-patches:123','foreign','kind-patches','actor','different.action',JSON.stringify({subscriptionId:'123',createdAt:birth}),now);const before=await records();expect((await receive(delivery())).status).toBe(409);expect(await records()).toEqual(before);
});
it.each(['{','[','not JSON'])('rejects authenticated malformed JSON %s',async raw=>{expect((await receive(delivery({raw}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();});
it('rejects authenticated invalid UTF-8',async()=>{expect((await receive(delivery({raw:new Uint8Array([0xc3,0x28])}))).status).toBe(400);expect(getStore).not.toHaveBeenCalled();});
it('rejects a declared body over128KiB without reading it',async()=>{
 const request=delivery({headers:{'Content-Length':String(128*1024+1)}}),read=vi.spyOn(request.body!,'getReader');expect((await receive(request)).status).toBe(413);expect(read).not.toHaveBeenCalled();expect(getStore).not.toHaveBeenCalled();
});
it.each([undefined,'1'])('bounds the actual raw stream even when content length is %s',async length=>{
 expect((await receive(delivery({raw:' '.repeat(128*1024+1),headers:{'Content-Length':length}}))).status).toBe(413);expect(getStore).not.toHaveBeenCalled();
});
it('accepts an exactly128KiB signed raw body',async()=>{
 const json=JSON.stringify(payload()),raw=json+' '.repeat(128*1024-Buffer.byteLength(json));expect((await receive(delivery({raw}))).status).toBe(200);
});
it.each(['clientSecret','storeDomain'])('fails closed before touching data when %s is absent',async field=>{expect((await receive(delivery(),{[field]:null})).status).toBe(503);expect(getStore).not.toHaveBeenCalled();});
it('returns a generic retryable failure when persistence is unavailable',async()=>{
 vi.spyOn(store,'run').mockRejectedValue(new Error('private database host and credentials'));const response=await receive(delivery());expect(response.status).toBe(503);expect(await response.text()).not.toContain('private');expect(await records()).toEqual([]);
});
it('safely accepts a retry after a committed write lost its acknowledgement',async()=>{
 const run=store.run.bind(store);let first=true;vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{const result=await run(sql,...args);if(first){first=false;throw new DOMException('Database request timed out','TimeoutError');}return result;});
 expect((await receive(delivery())).status).toBe(503);expect((await receive(delivery())).status).toBe(200);expect(await records()).toHaveLength(1);
});
it('does not log payloads, signatures or secrets on invalid delivery',async()=>{
 const info=vi.spyOn(console,'info'),warn=vi.spyOn(console,'warn'),error=vi.spyOn(console,'error');await receive(delivery({payload:payload('invalid')}));expect(info).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});
it('exposes a POST route using configured organization and fixed KP scope without browser authentication',async()=>{
 state.env.APP_ORGANIZATION_ID='configured-org';const body={...payload(),organizationId:'attacker',clientId:'beam'};expect((await POST(delivery({payload:body}))).status).toBe(200);expect((await records())[0]).toMatchObject({id:'recharge-creation:configured-org:kind-patches:123',organizationId:'configured-org',clientId:'kind-patches'});
});
it('uses the default organization and refuses a route with missing secure configuration before opening Store',async()=>{
 expect((await POST(delivery())).status).toBe(200);expect((await records())[0].organizationId).toBe('avenue-z');state.store.mockClear();delete state.env.RECHARGE_WEBHOOK_CLIENT_SECRET;expect((await POST(delivery())).status).toBe(503);expect(state.store).not.toHaveBeenCalled();
});
