import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,platform:'vercel',identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,get runtimePlatform(){return state.platform;}}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
import {scopeForUser,initializePrivateOwner,getStore} from '../../lib/server/access';
import {allowGoogleIdentity} from '../../lib/server/standalone-auth';
beforeEach(async()=>{state.platform='vercel';const client=createClient({url:'file::memory:'});for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${f}`,'utf8'));Object.assign(state.env,{DB:sqliteBindings(client),APP_ORGANIZATION_ID:'company',APP_BOOTSTRAP_ADMIN_EMAIL:'owner@example.com'});state.identity.mockResolvedValue({userId:'google:one',email:'owner@example.com'});});
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
 await initializePrivateOwner();await initializePrivateOwner();expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'admin'});expect(await getStore().clients('company')).toHaveLength(2);
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
