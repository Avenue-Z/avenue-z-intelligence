import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {AccessScope} from '../analytics/contracts';
import {exchangeShopifyCode,parseShopifyAppConfig,SHOPIFY_REPORTING_SCOPES,shopifyAuthorizationUrl,verifyShopifyCallback} from '../sources/shopify-auth';
import type {ShopifyAppConfig} from '../sources/shopify-auth';
import {authorize} from './policy';
import {readProviderCredential,saveProviderCredential} from './provider-credentials';
import type {Store} from './store';

type Dependencies={scope:()=>Promise<AccessScope|null>;store:()=>Pick<Store,'first'|'run'>;secret:(key:string)=>string|null;fetcher?:typeof fetch;now?:()=>number};
type Grant={accessToken:string;scopes:string[];storeDomain:string;appClientId:string;authorizedAt:string};
const prefix='/api/integrations/shopify/beam',cookieName='__Host-az-beam-shopify-oauth',lifetime=600000;
const cookieOptions='Path=/; Secure; HttpOnly; SameSite=Lax';
const securityHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
function response(body:unknown,status=200,clear=false){return Response.json(body,{status,headers:{...securityHeaders,...(clear?{'Set-Cookie':`${cookieName}=; ${cookieOptions}; Max-Age=0`}:{})}});}
function redirect(location:string,cookie?:string){return new Response(null,{status:303,headers:{...securityHeaders,Location:location,...(cookie?{'Set-Cookie':cookie}:{})}});}
function signature(value:string,secret:string){return createHmac('sha256',secret).update('beam-shopify-state:v1:').update(value).digest('base64url');}
function actor(scope:AccessScope){return createHash('sha256').update(JSON.stringify([scope.organizationId,scope.actorId])).digest('base64url');}
function same(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function stateCookie(scope:AccessScope,secret:string,now:number){
 const state=randomBytes(32).toString('base64url'),encoded=Buffer.from(JSON.stringify({state,actor:actor(scope),issuedAt:now,expiresAt:now+lifetime})).toString('base64url');
 return {state,cookie:`${cookieName}=${encoded}.${signature(encoded,secret)}; ${cookieOptions}; Max-Age=${lifetime/1000}`};
}
function readState(request:Request,scope:AccessScope,secret:string,now:number){
 const matches=(request.headers.get('cookie')||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${cookieName}=`));
 if(matches.length!==1||matches[0].length>2048)throw Error('Invalid state');
 const value=matches[0].slice(cookieName.length+1),parts=value.split('.');
 if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part))||!same(parts[1],signature(parts[0],secret)))throw Error('Invalid state');
 const data=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')) as Record<string,unknown>;
 if(typeof data.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.state)||data.actor!==actor(scope)||typeof data.issuedAt!=='number'||typeof data.expiresAt!=='number'||data.expiresAt-data.issuedAt!==lifetime||data.issuedAt>now+30000||data.expiresAt<=now)throw Error('Invalid state');
 return data.state;
}
function validGrant(payload:unknown,config:ShopifyAppConfig):payload is Grant{
 if(!payload||typeof payload!=='object')return false;
 const grant=payload as Grant;
 return grant.storeDomain===config.storeDomain&&grant.appClientId===config.clientId&&typeof grant.accessToken==='string'&&grant.accessToken.length>0&&grant.accessToken.length<=4096&&Array.isArray(grant.scopes)&&grant.scopes.every(s=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(s))&&SHOPIFY_REPORTING_SCOPES.every(s=>grant.scopes.includes(s))&&typeof grant.authorizedAt==='string'&&Number.isFinite(Date.parse(grant.authorizedAt));
}
export {validGrant as validShopifyGrant};
export function createShopifyConnectionHandlers(deps:Dependencies){
 const now=deps.now??Date.now;
 function settings(){
  const raw=deps.secret('AUTH_URL'),secret=deps.secret('AUTH_SECRET');
  if(!raw||!secret||secret.length<32)throw Error('Missing configuration');
  const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Invalid origin');
  return {origin:url.origin,secret};
 }
 function trusted(request:Request,origin:string){const url=new URL(request.url);return url.origin===origin||request.headers.get('host')===new URL(origin).host;}
 async function access(){try{return authorize(await deps.scope(),'beam',true);}catch{return null;}}
 const identity=(scope:AccessScope)=>({organizationId:scope.organizationId,clientId:'beam',provider:'shopify'});
 function config(){return parseShopifyAppConfig(deps.secret('SOURCE_BEAM_SHOPIFY')||'');}
 return {
  async connect(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Shopify connection is not configured'},503);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403);
   const current=await deps.scope();
   if(!current){const target=new URL('/signin',setup.origin);target.searchParams.set('callbackUrl',`${prefix}/connect`);return redirect(target.toString());}
   let scope;try{scope=authorize(current,'beam',true);}catch{return response({error:'Administrator access required'},403);}
   let app;try{app=config();}catch{return response({error:'Shopify connection is not configured'},503);}
   const shop=new URL(request.url).searchParams.getAll('shop');if(shop.length>1||shop.length===1&&shop[0]!==app.storeDomain)return response({error:'Store not allowed'},400);
   try{const saved=await readProviderCredential(deps.store(),identity(scope),setup.secret);if(validGrant(saved,app))return redirect(`${setup.origin}/clients/beam`);}catch{return response({error:'Shopify connection storage is unavailable'},503);}
   const state=stateCookie(scope,setup.secret,now());return redirect(shopifyAuthorizationUrl(app,`${setup.origin}${prefix}/callback`,state.state),state.cookie);
  },
  async callback(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Shopify connection is not configured'},503,true);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403,true);
   const scope=await access();if(!scope)return response({error:'Administrator access required'},403,true);
   let app;try{app=config();}catch{return response({error:'Shopify connection is not configured'},503,true);}
   let code:string;try{const state=readState(request,scope,setup.secret,now());code=verifyShopifyCallback(new URL(request.url).searchParams,app,state,now()).code;}catch{return response({error:'Shopify authorization expired or could not be verified. Start the connection again.'},400,true);}
   let grant;try{grant=await exchangeShopifyCode(app,code,deps.fetcher);}catch{return response({error:'Shopify did not authorize the required offline reporting access'},502,true);}
   try{await saveProviderCredential(deps.store(),identity(scope),{...grant,storeDomain:app.storeDomain,appClientId:app.clientId,authorizedAt:new Date(now()).toISOString()} satisfies Grant,setup.secret);}catch{return response({error:'Shopify authorization could not be stored. Start the connection again.'},503,true);}
   return redirect(`${setup.origin}/clients/beam`,`${cookieName}=; ${cookieOptions}; Max-Age=0`);
  },
  async status(request:Request){
   let setup;try{setup=settings();}catch{return response({error:'Shopify connection is not configured'},503);}
   if(!trusted(request,setup.origin))return response({error:'Origin not allowed'},403);
   const scope=await access();if(!scope)return response({error:'Administrator access required'},403);
   let app;try{app=config();}catch{return response({error:'Shopify connection is not configured'},503);}
   try{const grant=await readProviderCredential(deps.store(),identity(scope),setup.secret),authorized=validGrant(grant,app);return response({clientId:'beam',provider:'shopify',storeDomain:app.storeDomain,authorized,scopes:authorized?grant.scopes:[],authorizedAt:authorized?grant.authorizedAt:null,reportingVerified:false});}catch{return response({error:'Shopify connection storage is unavailable'},503);}
  },
 };
}
