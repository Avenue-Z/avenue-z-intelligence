import {createDecipheriv,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {readProviderCredential,saveProviderCredential,type ProviderCredentialIdentity} from '../../lib/server/provider-credentials';
import type {Store} from '../../lib/server/store';

const identity:ProviderCredentialIdentity={organizationId:'org-a',clientId:'beam',provider:'shopify'};
const secret='test-vault-secret-with-at-least-32-characters';
const payload={accessToken:'shpat_PRIVATE_TEST_TOKEN',shop:'beam.myshopify.com',scope:['read_orders']};
type CredentialStore=Pick<Store,'first'|'run'>;
type Row={organizationId:string;clientId:string;provider:string;payload:string;updatedAt:string};
function fixture(){
 const rows=new Map<string,Row>(),writes:{sql:string;values:unknown[]}[]=[],reads:{sql:string;values:unknown[]}[]=[];
 const key=(value:ProviderCredentialIdentity)=>JSON.stringify([value.organizationId,value.clientId,value.provider]);
 const store:CredentialStore={
  async run(sql,...values){writes.push({sql,values});const [organizationId,clientId,provider,payload,updatedAt]=values as string[];rows.set(key({organizationId,clientId,provider}),{organizationId,clientId,provider,payload,updatedAt});return {meta:{changes:1}};},
  async first<T>(sql:string,...values:unknown[]):Promise<T|null>{reads.push({sql,values});return rows.get(JSON.stringify(values)) as T??null;},
 };
 return {store,rows,writes,reads,key};
}
afterEach(()=>vi.restoreAllMocks());

it('persists only serialized AES-256-GCM ciphertext and decrypts it after a durable read',async()=>{
 const {store,rows,writes,reads,key}=fixture();await saveProviderCredential(store,identity,payload,secret);
 const persisted=rows.get(key(identity))!;
 expect(typeof persisted.payload).toBe('string');expect(persisted.payload).not.toContain(payload.accessToken);
 expect(JSON.stringify(writes)).not.toContain(payload.accessToken);expect(writes[0].sql).toMatch(/INSERT INTO provider_credentials/i);
 expect(writes[0].sql).toMatch(/ON CONFLICT\s*\(organizationId,clientId,provider\) DO UPDATE/i);
 expect(writes[0].values.slice(0,3)).toEqual(['org-a','beam','shopify']);expect(Number.isFinite(Date.parse(persisted.updatedAt))).toBe(true);
 const [version,encodedIv,encodedCiphertext,encodedTag]=persisted.payload.split('.');expect(version).toBe('v1');
 const iv=Buffer.from(encodedIv,'base64url'),tag=Buffer.from(encodedTag,'base64url');expect(iv.byteLength).toBe(12);expect(tag.byteLength).toBe(16);
 const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),iv);
 decipher.setAAD(Buffer.from(JSON.stringify(['provider_credentials',1,'org-a','beam','shopify'])));decipher.setAuthTag(tag);
 expect(JSON.parse(Buffer.concat([decipher.update(Buffer.from(encodedCiphertext,'base64url')),decipher.final()]).toString('utf8'))).toEqual(payload);
 expect(await readProviderCredential(store,identity,secret)).toEqual(payload);
 expect(reads[0].sql).toMatch(/WHERE organizationId=\? AND clientId=\? AND provider=\?/i);expect(reads[0].values).toEqual(['org-a','beam','shopify']);
});

it('returns null only for an absent credential',async()=>{
 const {store}=fixture();expect(await readProviderCredential(store,identity,secret)).toBeNull();
});

it('uses a fresh random IV and replaces only the selected composite identity',async()=>{
 const {store,rows,key}=fixture();await saveProviderCredential(store,identity,payload,secret);const original=rows.get(key(identity))!.payload;
 await saveProviderCredential(store,identity,payload,secret);expect(rows.get(key(identity))!.payload).not.toBe(original);
 for(const scoped of [{...identity,organizationId:'org-b'},{...identity,clientId:'other-client'},{...identity,provider:'recharge'}]){
  expect(await readProviderCredential(store,scoped,secret)).toBeNull();await saveProviderCredential(store,scoped,{accessToken:'other'},secret);
 }
 await saveProviderCredential(store,identity,{accessToken:'replacement'},secret);expect(rows.size).toBe(4);expect(await readProviderCredential(store,identity,secret)).toEqual({accessToken:'replacement'});
});

it.each(['organizationId','clientId','provider'] as const)('rejects ciphertext transplanted to a different %s',async field=>{
 const {store,rows,key}=fixture();await saveProviderCredential(store,identity,payload,secret);
 const other={...identity,[field]:'other'};rows.set(key(other),{...rows.get(key(identity))!,...other});
 await expect(readProviderCredential(store,other,secret)).rejects.toThrow();
});

it('rejects another encryption key without returning credentials',async()=>{
 const {store}=fixture();await saveProviderCredential(store,identity,payload,secret);
 await expect(readProviderCredential(store,identity,'another-secret-of-at-least-32-characters')).rejects.toThrow();
});

it.each([1,2,3])('rejects tampering with encrypted envelope segment %i',async segment=>{
 const {store,rows,key}=fixture();await saveProviderCredential(store,identity,payload,secret);const row=rows.get(key(identity))!,parts=row.payload.split('.');
 const bytes=Buffer.from(parts[segment],'base64url');bytes[0]^=1;parts[segment]=bytes.toString('base64url');row.payload=parts.join('.');
 await expect(readProviderCredential(store,identity,secret)).rejects.toThrow();
});

it.each([null,42,{},'',JSON.stringify(payload),'v2.AAAAAAAAAAAAAAAA.YQ.AAAAAAAAAAAAAAAAAAAAAA','v1.bad.YQ.bad','v1.AAAAAAAAAAAAAAAA.YQ=.AAAAAAAAAAAAAAAAAAAAAA','v1.AAAAAAAAAAAAAAAA.YQ.AAAAAAAAAAAAAAAAAAAAAA.extra','x'.repeat(90000)])('rejects malformed stored credential case %#',async malformed=>{
 const {store,rows,key}=fixture();rows.set(key(identity),{...identity,payload:malformed as string,updatedAt:'now'});
 await expect(readProviderCredential(store,identity,secret)).rejects.toThrow();
});

it('enforces the 64 KiB UTF-8 JSON limit before writing',async()=>{
 const {store,rows,writes}=fixture();const boundary='x'.repeat(65534);await saveProviderCredential(store,identity,boundary,secret);expect(await readProviderCredential(store,identity,secret)).toBe(boundary);
 for(const oversized of ['x'.repeat(65535),'é'.repeat(32768)])await expect(saveProviderCredential(store,identity,oversized,secret)).rejects.toThrow();
 expect(writes).toHaveLength(1);expect(rows.size).toBe(1);
});

it.each([undefined,()=>payload,Symbol('secret'),BigInt(1)])('rejects non-JSON payload case %# without storage writes',async invalid=>{
 const {store,writes}=fixture();await expect(saveProviderCredential(store,identity,invalid,secret)).rejects.toThrow();expect(writes).toHaveLength(0);
});

it('rejects circular payloads without storage writes',async()=>{
 const {store,writes}=fixture(),circular:Record<string,unknown>={accessToken:payload.accessToken};circular.self=circular;
 await expect(saveProviderCredential(store,identity,circular,secret)).rejects.toThrow();expect(writes).toHaveLength(0);
});

it.each([
 {organizationId:'',clientId:'beam',provider:'shopify'},
 {organizationId:'org-a',clientId:null,provider:'shopify'},
 {organizationId:'org-a',clientId:'beam',provider:1},
 null,
])('rejects invalid credential identity case %# before database access',async invalid=>{
 const {store,writes,reads}=fixture();await expect(saveProviderCredential(store,invalid as ProviderCredentialIdentity,payload,secret)).rejects.toThrow();
 await expect(readProviderCredential(store,invalid as ProviderCredentialIdentity,secret)).rejects.toThrow();expect(writes).toHaveLength(0);expect(reads).toHaveLength(0);
});

it.each(['','x'.repeat(31),null,42])('rejects invalid encryption secret case %# before database access',async invalid=>{
 const {store,writes,reads}=fixture();await expect(saveProviderCredential(store,identity,payload,invalid as string)).rejects.toThrow();
 await expect(readProviderCredential(store,identity,invalid as string)).rejects.toThrow();expect(writes).toHaveLength(0);expect(reads).toHaveLength(0);
});

it('sanitizes serialization, database and decryption errors without logging tokens or attaching causes',async()=>{
 const {store}=fixture(),log=vi.spyOn(console,'log').mockImplementation(()=>{}),warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
 const leaked=()=>{throw Error(payload.accessToken);};
 const attempts=[
  ()=>saveProviderCredential(store,identity,{toJSON:leaked},secret),
  ()=>saveProviderCredential({...store,run:leaked},identity,payload,secret),
  ()=>readProviderCredential({...store,first:leaked},identity,secret),
 ];
 await saveProviderCredential(store,identity,payload,secret);attempts.push(()=>readProviderCredential(store,identity,'another-secret-of-at-least-32-characters'));
 for(const attempt of attempts){const failure=await attempt().then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(payload.accessToken);expect(failure.cause).toBeUndefined();expect(JSON.stringify(failure)).not.toContain(payload.accessToken);}
 expect(log).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});

it('creates a tenant-scoped SQL table whose upsert preserves other provider grants',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(readFileSync('drizzle/0010_provider_credentials.sql','utf8'));
  const store:CredentialStore={async first<T>(sql:string,...values:unknown[]){return db.prepare(sql).get(...values as string[]) as T??null;},async run(sql,...values){return db.prepare(sql).run(...values as string[]);}};
  await saveProviderCredential(store,identity,payload,secret);await saveProviderCredential(store,{...identity,provider:'recharge'},{accessToken:'other'},secret);await saveProviderCredential(store,identity,{accessToken:'replacement'},secret);
  expect(db.prepare('SELECT count(*) AS count FROM provider_credentials').get()).toEqual({count:2});expect(await readProviderCredential(store,identity,secret)).toEqual({accessToken:'replacement'});
  expect(await readProviderCredential(store,{...identity,provider:'recharge'},secret)).toEqual({accessToken:'other'});
 }finally{db.close();}
});
