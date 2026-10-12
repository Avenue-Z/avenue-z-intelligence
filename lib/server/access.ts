import {env,runtimePlatform} from '@avenue/runtime';
import {getChatGPTUser} from '../../app/chatgpt-auth';
import {Store} from './store';
import {authorize} from './policy';
import type {AccessScope,Client} from '../analytics/contracts';
import initialClients from '../../data/initial-clients.json';
export function getStore(){if(!env.DB)throw new Error('Shared database unavailable');return new Store(env.DB);}
export async function scopeForUser():Promise<AccessScope|null>{const u=await getChatGPTUser();if(!u)return null;const s=getStore(),settings=env as unknown as Record<string,unknown>,org=runtimePlatform==='vercel'?String(settings.APP_ORGANIZATION_ID||'avenue-z'):'avenue-z';const m=await s.first('SELECT * FROM members WHERE organizationId=? AND actorId=?',org,u.userId);if(!m)return null;const clients=await s.clients(m.organizationId);const ids=JSON.parse(m.clients) as string[];return {organizationId:m.organizationId,actorId:u.userId,role:m.role,permittedClientIds:ids.includes('*')?clients.map(c=>c.id):ids};}
// Only invoked by the protected browser entry page. New Sites remain owner-private.
// The first private owner claims the workspace once; subsequent people need an explicit invitation.
export async function initializePrivateOwner(){const u=await getChatGPTUser();if(!u)return;const s=getStore();
  const settings=env as unknown as Record<string,unknown>,org=runtimePlatform==='vercel'?String(settings.APP_ORGANIZATION_ID||'avenue-z'):'avenue-z';
  if(runtimePlatform==='vercel'&&u.email.toLowerCase()!==String(settings.APP_BOOTSTRAP_ADMIN_EMAIL||'').toLowerCase())return;
  await s.run('INSERT INTO organizations(id,name,initialized) VALUES(?,?,0) ON CONFLICT DO NOTHING',org,'Avenue Z');
  await s.run("INSERT INTO members(organizationId,email,actorId,role,clients) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM members WHERE organizationId=?)",org,u.email.toLowerCase(),u.userId,'admin','["*"]',org);
  await s.run("UPDATE members SET actorId=? WHERE organizationId=? AND email=? AND actorId=''",u.userId,org,u.email.toLowerCase());
  const owner=await s.first('SELECT role FROM members WHERE organizationId=? AND actorId=?',org,u.userId);
  const organization=await s.first('SELECT initialized FROM organizations WHERE id=?',org);
  if(owner?.role==='admin'&&!organization?.initialized){await s.db.batch([...(initialClients as unknown as Client[]).map(c=>s.db.prepare('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING').bind(c.id,org,c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config))),s.db.prepare('UPDATE organizations SET initialized=1 WHERE id=?').bind(org)]);}
}
export async function requireClientAccess(clientId?:string,admin=false){return authorize(await scopeForUser(),clientId,admin);}
