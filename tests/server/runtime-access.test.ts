import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,runtimePlatform:'vercel'}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
import {scopeForUser,initializePrivateOwner,getStore} from '../../lib/server/access';
beforeEach(async()=>{const client=createClient({url:'file::memory:'});for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${f}`,'utf8'));Object.assign(state.env,{DB:sqliteBindings(client),APP_ORGANIZATION_ID:'company',APP_BOOTSTRAP_ADMIN_EMAIL:'owner@example.com'});state.identity.mockResolvedValue({userId:'google:one',email:'owner@example.com'});});
it('resolves memberships only inside the deployed application organization',async()=>{
 const s=getStore(),c=clients[0];for(const org of ['outside','company']){await s.run('INSERT INTO organizations VALUES(?,?,1)',org,org);await s.run('INSERT INTO members VALUES(?,?,?,?,?)',org,'owner@example.com','google:one',org==='outside'?'admin':'analyst','[]');}
 await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',c.id,'company',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config));
 expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'analyst'});
});
it('cannot let the first random signed-in user claim the standalone workspace',async()=>{
 state.identity.mockResolvedValue({userId:'google:stranger',email:'stranger@example.com'});await initializePrivateOwner();expect(await getStore().all('SELECT * FROM members')).toEqual([]);
});
it('initializes an explicit company admin and seeds clients once',async()=>{
 await initializePrivateOwner();await initializePrivateOwner();expect(await scopeForUser()).toMatchObject({organizationId:'company',role:'admin'});expect(await getStore().clients('company')).toHaveLength(2);
});
