import {Auth,type AuthConfig} from '@auth/core';
import Google from '@auth/core/providers/google';
import {env,runtimePlatform} from '@avenue/runtime';
import {getStore} from './access';
import type {ChatGPTUser} from '../../app/chatgpt-auth';
import {checkOrigin} from './policy';

function secret(key:string){const value=(env as unknown as Record<string,unknown>)[key];return typeof value==='string'?value:'';}
function origin(){const url=new URL(secret('AUTH_URL'));if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('AUTH_URL must use HTTPS');return url.origin;}
function activeMember(member:Record<string,unknown>|null){
 if(!member||!['admin','analyst'].includes(String(member.role)))return false;
 try{const clients=JSON.parse(String(member.clients));return Array.isArray(clients)&&clients.length>0&&clients.every(id=>typeof id==='string'&&id.length>0);}catch{return false;}
}
function workspaceDomainAccess(){
 const domain=secret('APP_GOOGLE_WORKSPACE_DOMAIN').toLowerCase(),clients=[...new Set(secret('APP_GOOGLE_WORKSPACE_CLIENT_IDS').split(',').map(id=>id.trim()).filter(Boolean))];
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)||!clients.length||clients.length>32||clients.some(id=>id==='*'||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)))return null;
 return {domain,clients};
}
export async function allowGoogleIdentity(profile:Record<string,unknown>|undefined){
 if(!profile||profile.email_verified!==true||typeof profile.email!=='string'||!/^[^@\s]+@[^@\s]+$/.test(profile.email)||typeof profile.sub!=='string'||!profile.sub||profile.sub.length>255)return false;
 const email=profile.email.toLowerCase(),actorId=`google:${profile.sub}`,s=getStore(),org=secret('APP_ORGANIZATION_ID')||'avenue-z';
 const identity=await s.first('SELECT email FROM member_identities WHERE organizationId=? AND actorId=?',org,actorId);
 // Identity aliases remain after revocation. Neither a removed membership nor
 // a changed/recycled Google address may claim its former permissions.
 if(identity&&identity.email!==email)return false;
 let member=await s.first('SELECT * FROM members WHERE organizationId=? AND email=?',org,email);
 if(!member){
  if(identity)return false;
  if(email===secret('APP_BOOTSTRAP_ADMIN_EMAIL').toLowerCase()&&!(await s.first('SELECT COUNT(*) AS n FROM members WHERE organizationId=?',org))?.n)return true;
  const policy=workspaceDomainAccess();
  if(!policy||email.split('@')[1]!==policy.domain||profile.hd!==policy.domain)return false;
  const organization=await s.first('SELECT initialized FROM organizations WHERE id=?',org),clients=await s.clients(org);
  if(!organization?.initialized||policy.clients.some(id=>!clients.some(client=>client.id===id)))return false;
  await s.run("INSERT INTO members(organizationId,email,actorId,role,clients) VALUES(?,?,?,'analyst',?) ON CONFLICT DO NOTHING",org,email,actorId,JSON.stringify(policy.clients));
  member=await s.first('SELECT * FROM members WHERE organizationId=? AND email=?',org,email);
 }
 if(!activeMember(member))return false;
 if(typeof member.actorId==='string'&&member.actorId.startsWith('google:')&&member.actorId!==actorId)return false;
 const bound=await s.first("SELECT actorId FROM member_identities WHERE organizationId=? AND email=? AND actorId LIKE 'google:%' LIMIT 1",org,email);
 if(bound&&bound.actorId!==actorId)return false;
 if(!identity)await s.run('INSERT INTO member_identities(organizationId,email,actorId) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE organizationId=? AND email=? AND role IN (\'admin\',\'analyst\')) ON CONFLICT DO NOTHING',org,email,actorId,org,email);
 const authorized=await s.first('SELECT m.* FROM members m JOIN member_identities i ON i.organizationId=m.organizationId AND i.email=m.email WHERE m.organizationId=? AND m.email=? AND i.actorId=?',org,email,actorId);
 return activeMember(authorized);
}
export function standaloneAuthConfig():AuthConfig{
 const base=origin(),key=secret('AUTH_SECRET'),clientId=secret('AUTH_GOOGLE_ID'),clientSecret=secret('AUTH_GOOGLE_SECRET'),domainPolicy=workspaceDomainAccess();if(key.length<32)throw new Error('Application authentication secret is not configured');
 if(!clientId||!clientSecret)throw new Error('Google application sign-in is not configured');
 return {
  basePath:'/api/auth',secret:key,trustHost:true,useSecureCookies:base.startsWith('https:'),
  providers:[Google({clientId,clientSecret,authorization:{params:{scope:'openid email profile',...(domainPolicy?{hd:domainPolicy.domain}:{})}}})],
  session:{strategy:'jwt',maxAge:8*60*60},
  callbacks:{
   signIn:({account,profile})=>account?.provider==='google'?allowGoogleIdentity(profile):false,
   jwt:({token,account})=>{if(account?.provider==='google')token.googleSubject=account.providerAccountId;return token;},
   session:({session,token})=>({...session,user:{...session.user,id:typeof token.googleSubject==='string'?`google:${token.googleSubject}`:''}}),
   redirect:({url})=>{try{const target=new URL(url,base);return target.origin===base?target.href:base;}catch{return base;}},
  },
  logger:{error(){console.error('Application authentication failed');},warn(code){console.warn('Application authentication warning:',code);},debug(){}},
 };
}
export async function standaloneIdentity(requestHeaders:Headers):Promise<ChatGPTUser|null>{
 if(runtimePlatform!=='vercel'||!secret('AUTH_SECRET')||!secret('AUTH_URL'))return null;
 try{
  const response=await Auth(new Request(`${origin()}/api/auth/session`,{headers:{cookie:requestHeaders.get('cookie')??''}}),standaloneAuthConfig());
  if(!response.ok)return null;const session=await response.json() as {user?:{id?:unknown;email?:unknown;name?:unknown}},user=session.user;
  if(typeof user?.id!=='string'||!user.id.startsWith('google:')||typeof user.email!=='string')return null;
  const name=typeof user.name==='string'?user.name:null;
  return {userId:user.id,email:user.email.toLowerCase(),displayName:name||user.email,fullName:name};
 }catch{return null;}
}
export async function standaloneAuth(request:Request){
 if(runtimePlatform!=='vercel')return Response.json({error:'Application sign-in is unavailable on this preview'},{status:404});
 try{
  const url=new URL(request.url),base=new URL(origin());
  if(url.origin!==base.origin&&request.headers.get('host')!==base.host)return Response.json({error:'Untrusted authentication host'},{status:403});
  checkOrigin(request,base.origin);
  // Next can expose an internal hostname in request.url. OAuth URLs always use
  // the configured app origin, never forwarded headers supplied by a visitor.
  return Auth(new Request(new URL(`${url.pathname}${url.search}`,base),request),standaloneAuthConfig());
 }catch{return Response.json({error:'Application sign-in is not configured'},{status:503});}
}
