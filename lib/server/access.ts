import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../app/chatgpt-auth';
import {Store} from './store';
import {authorize} from './policy';
import type {AccessScope,Client} from '../analytics/contracts';
import initialClients from '../../data/initial-clients.json';
export function getStore(){if(!env.DB)throw new Error('Shared database unavailable');return new Store(env.DB);}
export async function scopeForUser():Promise<AccessScope|null>{const u=await getChatGPTUser();if(!u)return null;const s=getStore();const m=await s.first('SELECT * FROM members WHERE actorId=?',u.userId);if(!m)return null;const clients=await s.clients(m.organizationId);const ids=JSON.parse(m.clients) as string[];return {organizationId:m.organizationId,actorId:u.userId,role:m.role,permittedClientIds:ids.includes('*')?clients.map(c=>c.id):ids};}
// Only invoked by the protected browser entry page. New Sites remain owner-private.
// The first private owner claims the workspace once; subsequent people need an explicit invitation.
export async function initializePrivateOwner(){const u=await getChatGPTUser();if(!u)return;const s=getStore();
  await s.run('INSERT INTO organizations(id,name,initialized) VALUES(?,?,0) ON CONFLICT DO NOTHING','avenue-z','Avenue Z');
  await s.run("INSERT INTO members(organizationId,email,actorId,role,clients) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM members WHERE organizationId=?)",'avenue-z',u.email.toLowerCase(),u.userId,'admin','["*"]','avenue-z');
  await s.run("UPDATE members SET actorId=? WHERE email=? AND actorId=''",u.userId,u.email.toLowerCase());
  const owner=await s.first('SELECT role FROM members WHERE organizationId=? AND actorId=?','avenue-z',u.userId);
  const org=await s.first('SELECT initialized FROM organizations WHERE id=?','avenue-z');
  if(owner?.role==='admin'&&!org?.initialized){await s.db.batch([...(initialClients as unknown as Client[]).map(c=>s.db.prepare('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING').bind(c.id,'avenue-z',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config))),s.db.prepare('UPDATE organizations SET initialized=1 WHERE id=?').bind('avenue-z')]);}
}
export async function requireClientAccess(clientId?:string,admin=false){return authorize(await scopeForUser(),clientId,admin);}
