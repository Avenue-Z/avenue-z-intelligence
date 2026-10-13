import {env,runtimePlatform} from '@avenue/runtime';
import {getChatGPTUser} from '../../app/chatgpt-auth';
import {Store} from './store';
import {authorize} from './policy';
import type {AccessScope,Client} from '../analytics/contracts';
import initialClients from '../../data/initial-clients.json';
export function getStore(){const database=env.DB;if(!database)throw new Error('Shared database unavailable');return new Store(database);}
export async function scopeForUser():Promise<AccessScope|null>{const u=await getChatGPTUser();if(!u)return null;const s=getStore(),settings=env as unknown as Record<string,unknown>,org=runtimePlatform==='vercel'?String(settings.APP_ORGANIZATION_ID||'avenue-z'):'avenue-z';const m=await s.first('SELECT m.* FROM members m WHERE m.organizationId=? AND (m.actorId=? OR EXISTS(SELECT 1 FROM member_identities i WHERE i.organizationId=m.organizationId AND i.email=m.email AND i.actorId=?))',org,u.userId,u.userId);if(!m||!['admin','analyst'].includes(m.role))return null;const clients=await s.clients(m.organizationId);const ids=JSON.parse(m.clients) as string[];return {organizationId:m.organizationId,actorId:u.userId,role:m.role,permittedClientIds:ids.includes('*')?clients.map(c=>c.id):ids};}
// Only invoked by the protected browser entry page. New Sites remain owner-private.
// The first private owner claims the workspace once; subsequent people need an explicit invitation.
export async function initializePrivateOwner(){const u=await getChatGPTUser();if(!u)return;const s=getStore();
  const settings=env as unknown as Record<string,unknown>,org=runtimePlatform==='vercel'?String(settings.APP_ORGANIZATION_ID||'avenue-z'):'avenue-z';
  if(runtimePlatform==='vercel'&&u.email.toLowerCase()!==String(settings.APP_BOOTSTRAP_ADMIN_EMAIL||'').toLowerCase())return;
  let stage='existing-membership';
  try{
  // Established members need only authorization reads. Bootstrap writes on
  // every visit can prevent the entire dashboard loading when storage writes
  // are temporarily unavailable, even though persisted analytics are readable.
  const existing=await s.first('SELECT o.initialized FROM organizations o JOIN members m ON m.organizationId=o.id WHERE o.id=? AND (m.actorId=? OR EXISTS(SELECT 1 FROM member_identities i WHERE i.organizationId=m.organizationId AND i.email=m.email AND i.actorId=?)) LIMIT 1',org,u.userId,u.userId);
  if(existing?.initialized)return;
  stage='organization-insert';
  await s.run('INSERT INTO organizations(id,name,initialized) VALUES(?,?,0) ON CONFLICT DO NOTHING',org,'Avenue Z');
  stage='owner-insert';
  await s.run("INSERT INTO members(organizationId,email,actorId,role,clients) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM members WHERE organizationId=?)",org,u.email.toLowerCase(),u.userId,'admin','["*"]',org);
  stage='identity-attachment';
  await s.run("UPDATE members SET actorId=? WHERE organizationId=? AND email=? AND actorId=''",u.userId,org,u.email.toLowerCase());
  stage='initialization-status';
  const owner=await s.first('SELECT role FROM members WHERE organizationId=? AND actorId=?',org,u.userId);
  const organization=await s.first('SELECT initialized FROM organizations WHERE id=?',org);
  stage='initial-clients';
  if(owner?.role==='admin'&&!organization?.initialized){await s.db.batch([...(initialClients as unknown as Client[]).map(c=>s.db.prepare('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING').bind(c.id,org,c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config))),s.db.prepare('UPDATE organizations SET initialized=1 WHERE id=?').bind(org)]);}
  }catch(error){const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:undefined;console.warn('Workspace bootstrap failed',{stage,code,kind:error instanceof Error?error.name:'Unknown'});throw error;}
}
export async function requireClientAccess(clientId?:string,admin=false){return authorize(await scopeForUser(),clientId,admin);}
