import {Auth,type AuthConfig} from '@auth/core';
import Google from '@auth/core/providers/google';
import {env,runtimePlatform} from '@avenue/runtime';
import {getStore} from './access';
import type {ChatGPTUser} from '../../app/chatgpt-auth';
import {checkOrigin} from './policy';

function secret(key:string){const value=(env as unknown as Record<string,unknown>)[key];return typeof value==='string'?value:'';}
function origin(){const url=new URL(secret('AUTH_URL'));if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('AUTH_URL must use HTTPS');return url.origin;}
export async function allowGoogleIdentity(profile:Record<string,unknown>|undefined){
 if(!profile||profile.email_verified!==true||typeof profile.email!=='string'||typeof profile.sub!=='string')return false;
 const email=profile.email.toLowerCase(),s=getStore(),org=secret('APP_ORGANIZATION_ID')||'avenue-z';
 const member=await s.first('SELECT * FROM members WHERE organizationId=? AND email=?',org,email);
 if(member){await s.run('UPDATE members SET actorId=? WHERE organizationId=? AND email=?',`google:${profile.sub}`,org,email);return true;}
 if(email!==secret('APP_BOOTSTRAP_ADMIN_EMAIL').toLowerCase())return false;
 return !(await s.first('SELECT COUNT(*) AS n FROM members WHERE organizationId=?',org))?.n;
}
export function standaloneAuthConfig():AuthConfig{
 const base=origin(),key=secret('AUTH_SECRET');if(key.length<32)throw new Error('Application authentication secret is not configured');
 return {
  basePath:'/api/auth',secret:key,trustHost:true,useSecureCookies:base.startsWith('https:'),
  providers:[Google({clientId:secret('AUTH_GOOGLE_ID'),clientSecret:secret('AUTH_GOOGLE_SECRET')})],
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
