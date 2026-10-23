import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {AccessScope} from '../analytics/contracts';
import {exchangeMotionCode,MOTION_SCOPES,motionAuthorizationUrl,parseMotionAppConfig,verifyMotionCallback} from '../sources/motion-auth';
import type {MotionGrant} from '../sources/motion-auth';
import {authorize} from './policy';
import {readProviderCredential,saveProviderCredential} from './provider-credentials';
import type {Store} from './store';

type Dependencies={scope:()=>Promise<AccessScope|null>;store:()=>Pick<Store,'first'|'run'>;secret:(key:string)=>string|null;fetcher?:typeof fetch;now?:()=>number};
type SavedGrant=MotionGrant&{appClientId:string;authorizedAt:string};
const prefix='/api/integrations/motion/beam',cookieName='__Host-az-beam-motion-oauth',lifetime=600000;
const cookieOptions='Path=/; Secure; HttpOnly; SameSite=Lax';
const securityHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
function response(body:unknown,status=200,clear=false){return Response.json(body,{status,headers:{...securityHeaders,...(clear?{'Set-Cookie':`${cookieName}=; ${cookieOptions}; Max-Age=0`}:{})}});}
function redirect(location:string,cookie?:string){return new Response(null,{status:303,headers:{...securityHeaders,Location:location,...(cookie?{'Set-Cookie':cookie}:{})}});}
function stateKey(secret:string){return createHash('sha256').update('avenue-z:motion-state:v1:').update(secret).digest();}
function actor(scope:AccessScope){return createHash('sha256').update(JSON.stringify([scope.organizationId,scope.actorId])).digest('base64url');}
function stateCookie(scope:AccessScope,secret:string,now:number){
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
 const plaintext=Buffer.from(JSON.stringify({state,verifier,actor:actor(scope),issuedAt:now,expiresAt:now+lifetime}));
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',stateKey(secret),iv);cipher.setAAD(Buffer.from(cookieName));
 const value=['v1',iv.toString('base64url'),Buffer.concat([cipher.update(plaintext),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
 return {state,verifier,cookie:`${cookieName}=${value}; ${cookieOptions}; Max-Age=${lifetime/1000}`};
}
function decode(part:string){if(!/^[A-Za-z0-9_-]+$/.test(part))throw Error('Invalid state');const bytes=Buffer.from(part,'base64url');if(bytes.toString('base64url')!==part)throw Error('Invalid state');return bytes;}
function readState(request:Request,scope:AccessScope,secret:string,now:number){
 const matches=(request.headers.get('cookie')||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${cookieName}=`));
 if(matches.length!==1||matches[0].length>4096)throw Error('Invalid state');
 const parts=matches[0].slice(cookieName.length+1).split('.');if(parts.length!==4||parts[0]!=='v1')throw Error('Invalid state');
 const iv=decode(parts[1]),encrypted=decode(parts[2]),tag=decode(parts[3]);if(iv.length!==12||tag.length!==16)throw Error('Invalid state');
 const decipher=createDecipheriv('aes-256-gcm',stateKey(secret),iv);decipher.setAAD(Buffer.from(cookieName));decipher.setAuthTag(tag);
 const data=JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8')) as Record<string,unknown>;
 if(typeof data.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.state)||typeof data.verifier!=='string'||!/^[A-Za-z0-9_-]{64}$/.test(data.verifier)||data.actor!==actor(scope)||typeof data.issuedAt!=='number'||typeof data.expiresAt!=='number'||data.expiresAt-data.issuedAt!==lifetime||data.issuedAt>now+30000||data.expiresAt<=now)throw Error('Invalid state');
 return {state:data.state,verifier:data.verifier};
}
function validGrant(payload:unknown,clientId:string):payload is SavedGrant{
 if(!payload||typeof payload!=='object')return false;const grant=payload as SavedGrant;
 return grant.appClientId===clientId&&grant.tokenType==='Bearer'&&typeof grant.accessToken==='string'&&/^[\x21-\x7e]{1,16384}$/.test(grant.accessToken)&&typeof grant.refreshToken==='string'&&/^[\x21-\x7e]{1,16384}$/.test(grant.refreshToken)&&Number.isFinite(grant.expiresAt)&&grant.expiresAt>0&&Array.isArray(grant.scopes)&&grant.scopes.includes('offline_access')&&grant.scopes.every(s=>typeof s==='string'&&(MOTION_SCOPES as readonly string[]).includes(s))&&typeof grant.authorizedAt==='string'&&Number.isFinite(Date.parse(grant.authorizedAt));
}
export {validGrant as validMotionGrant};
export function createMotionConnectionHandlers(deps:Dependencies){
 const now=deps.now??Date.now;
 function settings(){const raw=deps.secret('AUTH_URL'),secret=deps.secret('AUTH_SECRET');if(!raw||!secret||secret.length<32)throw Error('Missing configuration');const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Invalid origin');return {origin:url.origin,secret};}
 function trusted(request:Request,origin:string){return new URL(request.url).origin===origin||request.headers.get('host')===new URL(origin).host;}
 async function access(){try{return authorize(await deps.scope(),'beam',true);}catch{return null;}}
 const identity=(scope:AccessScope)=>({organizationId:scope.organizationId,clientId:'beam',provider:'motion'});
 const config=()=>parseMotionAppConfig(deps.secret('SOURCE_BEAM_MOTION')||'');
 return {
  async connect(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Motion connection is not configured'},503);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403);
   const current=await deps.scope();if(!current){const target=new URL('/signin',setup.origin);target.searchParams.set('callbackUrl',`${prefix}/connect`);return redirect(target.toString());}
   let scope;try{scope=authorize(current,'beam',true);}catch{return response({error:'Administrator access required'},403);}
   let app;try{app=config();}catch{return response({error:'Motion connection is not configured'},503);}
   try{const saved=await readProviderCredential(deps.store(),identity(scope),setup.secret);if(validGrant(saved,app.clientId))return redirect(`${setup.origin}/clients/beam`);}catch{return response({error:'Motion connection storage is unavailable'},503);}
   const state=stateCookie(scope,setup.secret,now());return redirect(motionAuthorizationUrl(app,`${setup.origin}${prefix}/callback`,state.state,state.verifier),state.cookie);
  },
  async callback(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Motion connection is not configured'},503,true);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403,true);
   const scope=await access();if(!scope)return response({error:'Administrator access required'},403,true);
   let app;try{app=config();}catch{return response({error:'Motion connection is not configured'},503,true);}
   let code:string,verifier:string;try{const state=readState(request,scope,setup.secret,now());code=verifyMotionCallback(new URL(request.url).searchParams,state.state).code;verifier=state.verifier;}catch{return response({error:'Motion authorization expired or could not be verified. Start the connection again.'},400,true);}
   let grant;try{grant=await exchangeMotionCode(app,code,`${setup.origin}${prefix}/callback`,verifier,deps.fetcher,now());}catch{return response({error:'Motion did not authorize the required offline reporting access'},502,true);}
   try{await saveProviderCredential(deps.store(),identity(scope),{...grant,appClientId:app.clientId,authorizedAt:new Date(now()).toISOString()} satisfies SavedGrant,setup.secret);}catch{return response({error:'Motion authorization could not be stored. Start the connection again.'},503,true);}
   return redirect(`${setup.origin}/clients/beam`,`${cookieName}=; ${cookieOptions}; Max-Age=0`);
  },
  async status(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Motion connection is not configured'},503);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403);
   const scope=await access();if(!scope)return response({error:'Administrator access required'},403);
   let app;try{app=config();}catch{return response({error:'Motion connection is not configured'},503);}
   try{const grant=await readProviderCredential(deps.store(),identity(scope),setup.secret),authorized=validGrant(grant,app.clientId);return response({clientId:'beam',provider:'motion',authorized,scopes:authorized?grant.scopes:[],authorizedAt:authorized?grant.authorizedAt:null,expiresAt:authorized?new Date(grant.expiresAt).toISOString():null});}catch{return response({error:'Motion connection storage is unavailable'},503);}
  },
 };
}
