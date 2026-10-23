import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,platform:'vercel',identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,get runtimePlatform(){return state.platform;}}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
import {scopeForUser,initializePrivateOwner,getStore} from '../../lib/server/access';
import {Store} from '../../lib/server/store';
import {allowGoogleIdentity} from '../../lib/server/standalone-auth';
beforeEach(async()=>{state.platform='vercel';for(const key of Object.keys(state.env))delete state.env[key];const client=createClient({url:'file::memory:'});for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${f}`,'utf8'));Object.assign(state.env,{DB:sqliteBindings(client),APP_ORGANIZATION_ID:'company',APP_BOOTSTRAP_ADMIN_EMAIL:'owner@example.com'});state.identity.mockResolvedValue({userId:'google:one',email:'owner@example.com'});});
it('resolves memberships only inside the deployed application organization',async()=>{
 const s=getStore(),c=clients[0];for(const org of ['outside','company']){await s.run('INSERT INTO organizations VALUES(?,?,1)',org,org);await s.run('INSERT INTO members VALUES(?,?,?,?,?)',org,'owner@example.com','google:one',org==='outside'?'admin':'analyst','[]');}
 await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',c.id,'company',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config));
 expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'analyst'});
});
it('cannot let the first random signed-in user claim the standalone workspace',async()=>{
 state.identity.mockResolvedValue({userId:'google:stranger',email:'stranger@example.com'});await initializePrivateOwner();expect(await getStore().all('SELECT * FROM members')).toEqual([]);
});
it('initializes an explicit company admin and seeds clients once',async()=>{
 expect(await allowGoogleIdentity({email:'owner@example.com',email_verified:true,sub:'one'})).toBe(true);
 await initializePrivateOwner();await initializePrivateOwner();expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'admin'});expect(await getStore().clients('company')).toHaveLength(3);
});
it('lets an initialized member read the workspace without requiring bootstrap writes',async()=>{
 const s=getStore();await s.run('INSERT INTO organizations VALUES(?,?,1)','company','Company');await s.run('INSERT INTO members VALUES(?,?,?,?,?)','company','owner@example.com','google:one','admin','["*"]');
 const writes=vi.spyOn(Store.prototype,'run').mockRejectedValue(Object.assign(new Error('Writes are blocked'),{code:'BLOCKED'}));
 try{await expect(initializePrivateOwner()).resolves.toBeUndefined();expect(writes).not.toHaveBeenCalled();expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'admin'});}finally{writes.mockRestore();}
});
it('keeps registered identity aliases readable without bootstrap writes and still enforces revocation',async()=>{
 const s=getStore();await s.run('INSERT INTO organizations VALUES(?,?,1)','company','Company');await s.run('INSERT INTO members VALUES(?,?,?,?,?)','company','owner@example.com','sites:owner','admin','["*"]');await s.run('INSERT INTO member_identities VALUES(?,?,?)','company','owner@example.com','google:one');
 const writes=vi.spyOn(Store.prototype,'run').mockRejectedValue(Object.assign(new Error('Writes are blocked'),{code:'BLOCKED'}));
 try{await expect(initializePrivateOwner()).resolves.toBeUndefined();expect(writes).not.toHaveBeenCalled();expect(await scopeForUser()).toMatchObject({role:'admin'});}finally{writes.mockRestore();}
 await s.run('DELETE FROM members WHERE organizationId=?','company');expect(await scopeForUser()).toBeNull();
});
it('preserves native Sites access when a member also signs in with Google',async()=>{
 const s=getStore(),c=clients[0];
 state.env.APP_ORGANIZATION_ID='avenue-z';
 await s.run('INSERT INTO organizations VALUES(?,?,1)','avenue-z','Company');
 await s.run('INSERT INTO members VALUES(?,?,?,?,?)','avenue-z','analyst@example.com','sites:analyst','analyst',JSON.stringify([c.id]));
 await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',c.id,'avenue-z',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config));
 expect(await allowGoogleIdentity({email:'analyst@example.com',email_verified:true,sub:'analyst'})).toBe(true);
 expect((await s.first('SELECT actorId FROM members WHERE organizationId=? AND email=?','avenue-z','analyst@example.com'))?.actorId).toBe('sites:analyst');
 state.platform='sites';
 state.identity.mockResolvedValue({userId:'sites:analyst',email:'analyst@example.com'});
 expect(await scopeForUser()).toEqual({organizationId:'avenue-z',actorId:'sites:analyst',role:'analyst',permittedClientIds:[c.id]});
 state.platform='vercel';
 state.identity.mockResolvedValue({userId:'google:analyst',email:'analyst@example.com'});
 expect(await scopeForUser()).toEqual({organizationId:'avenue-z',actorId:'google:analyst',role:'analyst',permittedClientIds:[c.id]});
 await s.run('UPDATE members SET clients=? WHERE organizationId=? AND email=?','[]','avenue-z','analyst@example.com');
 expect(await scopeForUser()).toMatchObject({role:'analyst',permittedClientIds:[]});
 await s.run('DELETE FROM members WHERE organizationId=? AND email=?','avenue-z','analyst@example.com');
 expect(await scopeForUser()).toBeNull();
});
it('does not authorize a Google identity associated with another organization',async()=>{
 const s=getStore();
 await s.run('INSERT INTO members VALUES(?,?,?,?,?)','outside','analyst@example.com','sites:outside','admin','["*"]');
 state.env.APP_ORGANIZATION_ID='outside';
 expect(await allowGoogleIdentity({email:'analyst@example.com',email_verified:true,sub:'outside'})).toBe(true);
 state.env.APP_ORGANIZATION_ID='company';
 state.identity.mockResolvedValue({userId:'google:outside',email:'analyst@example.com'});
 expect(await scopeForUser()).toBeNull();
 expect(await allowGoogleIdentity({email:'analyst@example.com',email_verified:true,sub:'outside'})).toBe(false);
});
async function domainWorkspace(){
 const s=getStore();Object.assign(state.env,{APP_GOOGLE_WORKSPACE_DOMAIN:'avenuez.com',APP_GOOGLE_WORKSPACE_CLIENT_IDS:'kind-patches'});
 await s.run('INSERT INTO organizations VALUES(?,?,1)','company','Company');
 for(const c of clients)await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',c.id,'company',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config));
 return s;
}
const employee={email:'person@avenuez.com',email_verified:true,hd:'avenuez.com',sub:'employee'};
it('onboards verified company Google Workspace employees as KP analysts only',async()=>{
 const s=await domainWorkspace();expect(await allowGoogleIdentity(employee)).toBe(true);
 state.identity.mockResolvedValue({userId:'google:employee',email:employee.email});
 expect(await scopeForUser()).toEqual({organizationId:'company',actorId:'google:employee',role:'analyst',permittedClientIds:['kind-patches']});
 expect(await s.first('SELECT role,clients FROM members WHERE email=?',employee.email)).toEqual({role:'analyst',clients:'["kind-patches"]'});
 expect(await allowGoogleIdentity(employee)).toBe(true);expect(await s.all('SELECT * FROM members')).toHaveLength(1);
});
it('onboards verified company employees to the approved KP and Beam analyst scope',async()=>{
 const s=await domainWorkspace();state.env.APP_GOOGLE_WORKSPACE_CLIENT_IDS='kind-patches,beam';
 expect(await allowGoogleIdentity({...employee,email_verified:false})).toBe(false);
 expect(await allowGoogleIdentity({...employee,email:'outsider@gmail.com'})).toBe(false);
 expect(await allowGoogleIdentity(employee)).toBe(true);
 state.identity.mockResolvedValue({userId:'google:employee',email:employee.email});
 expect(await scopeForUser()).toEqual({organizationId:'company',actorId:'google:employee',role:'analyst',permittedClientIds:['kind-patches','beam']});
 expect(await s.first('SELECT role,clients FROM members WHERE email=?',employee.email)).toEqual({role:'analyst',clients:'["kind-patches","beam"]'});
 await s.run('UPDATE members SET clients=? WHERE email=?','[]',employee.email);
 expect(await allowGoogleIdentity(employee)).toBe(false);
});
it('checks the signed hosted-domain claim as well as exact verified email domain',async()=>{
 const s=await domainWorkspace();
 for(const profile of [{...employee,email_verified:false},{...employee,hd:undefined},{...employee,hd:'other.com'},{...employee,email:'person@gmail.com'},{...employee,email:'person@avenuez.com.attacker.example'},{...employee,email:'person@@avenuez.com'}])expect(await allowGoogleIdentity(profile)).toBe(false);
 expect(await s.all('SELECT * FROM members')).toEqual([]);
});
it('does not autojoin an uninitialized organization or malformed and unknown domain grants',async()=>{
 const s=await domainWorkspace();
 for(const grants of ['*','kind-patches,*','missing-client','']){state.env.APP_GOOGLE_WORKSPACE_CLIENT_IDS=grants;expect(await allowGoogleIdentity(employee)).toBe(false);}
 state.env.APP_GOOGLE_WORKSPACE_CLIENT_IDS='kind-patches';await s.run('UPDATE organizations SET initialized=0');expect(await allowGoogleIdentity(employee)).toBe(false);
 expect(await s.all('SELECT * FROM members')).toEqual([]);
});
it('preserves explicit admin grants when domain onboarding is enabled',async()=>{
 const s=await domainWorkspace();await s.run('INSERT INTO members VALUES(?,?,?,?,?)','company',employee.email,'sites:owner','admin','["*"]');
 expect(await allowGoogleIdentity(employee)).toBe(true);state.identity.mockResolvedValue({userId:'google:employee',email:employee.email});
 const scope=await scopeForUser();expect(scope?.role).toBe('admin');expect(scope?.permittedClientIds.toSorted()).toEqual(clients.map(c=>c.id).toSorted());
 expect((await s.first('SELECT actorId FROM members WHERE email=?',employee.email))?.actorId).toBe('sites:owner');
});
it('keeps revoked and empty client grants denied during domain sign-in and existing sessions',async()=>{
 const s=await domainWorkspace();expect(await allowGoogleIdentity(employee)).toBe(true);state.identity.mockResolvedValue({userId:'google:employee',email:employee.email});
 await s.run('UPDATE members SET clients=?','[]');expect(await allowGoogleIdentity(employee)).toBe(false);expect(await scopeForUser()).toMatchObject({permittedClientIds:[]});
 await s.run('UPDATE members SET role=?,clients=?','revoked','["kind-patches"]');expect(await allowGoogleIdentity(employee)).toBe(false);expect(await scopeForUser()).toBeNull();
});
it('does not resurrect a removed membership or rebind its Google subject to a changed address',async()=>{
 const s=await domainWorkspace();expect(await allowGoogleIdentity(employee)).toBe(true);await s.run('DELETE FROM members WHERE email=?',employee.email);
 expect(await allowGoogleIdentity(employee)).toBe(false);expect(await allowGoogleIdentity({...employee,email:'new-person@avenuez.com'})).toBe(false);
 expect(await s.all('SELECT * FROM members')).toEqual([]);
});
it('does not give recycled company email addresses the previous Google identity permissions',async()=>{
 const s=await domainWorkspace();expect(await allowGoogleIdentity(employee)).toBe(true);await s.run('UPDATE members SET role=?,clients=?','admin','["*"]');
 expect(await allowGoogleIdentity({...employee,sub:'different-employee'})).toBe(false);
 expect(await s.all('SELECT * FROM member_identities')).toHaveLength(1);
});
it('keeps company domain onboarding disabled unless both settings are provided',async()=>{
 const s=await domainWorkspace();delete state.env.APP_GOOGLE_WORKSPACE_DOMAIN;expect(await allowGoogleIdentity(employee)).toBe(false);
 state.env.APP_GOOGLE_WORKSPACE_DOMAIN='avenuez.com';delete state.env.APP_GOOGLE_WORKSPACE_CLIENT_IDS;expect(await allowGoogleIdentity(employee)).toBe(false);
 expect(await s.all('SELECT * FROM members')).toEqual([]);
});
