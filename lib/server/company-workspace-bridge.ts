import {runtimePlatform} from '@avenue/runtime';
import type {AccessScope} from '../analytics/contracts';
import {getStore} from './access';
import {authorize} from './policy';
import {serverSecret} from './secrets';
import type {Workspace} from './workspace';
const requestLimit=16384,responseLimit=4*1024*1024,lifetime=90000;
const signatureHeader='x-workspace-signature';
export const publicCompanyAIErrors=['Hourly AI request limit reached. Please try again later.','AI analysis timed out. Please retry with a narrower question.','OpenAI is not configured'];
export const publicCompanyWorkspaceSizeError='This selection has too much detail. Choose a shorter period or a specific landing page.';
class PublicCompanyError extends Error {}
type Purpose='workspace'|'chat'|'review';
type Envelope={purpose?:'chat'|'review';version:1;issuedAt:number;expiresAt:number;actorId:string;organizationId:string;query:string};
const encoder=new TextEncoder();
function bridgeSecret(){const secret=serverSecret('COMPANY_WORKSPACE_SECRET');if(!secret||secret.length<32)throw Error('Company workspace configuration unavailable');return secret;}
async function hmacKey(secret:string){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function signature(body:string,secret:string){return [...new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),encoder.encode(body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function boundedText(message:Request|Response,limit:number){
 const length=message.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw Error('Company workspace payload too large');
 if(!message.body)throw Error('Company workspace payload unavailable');
 const reader=message.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>limit){await reader.cancel();throw Error('Company workspace payload too large');}text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}
}
function companyEndpoint(base:string,purpose:Purpose){
 let url:URL;try{url=new URL(base);}catch{throw Error('Company workspace configuration unavailable');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)throw Error('Company workspace configuration unavailable');
 // The sole destination comes from server configuration, never user parameters.
 return new URL(`/api/internal/${purpose}`,url.origin).href;
}
/** A configured bridge must fail closed: a cold fallback could exhaust Sites. */
async function companyJSON(scope:AccessScope,p:URLSearchParams,purpose:Purpose):Promise<unknown>{
 if(runtimePlatform!=='sites')return undefined;
 const base=serverSecret('COMPANY_WORKSPACE_URL'),secret=serverSecret('COMPANY_WORKSPACE_SECRET');
 if(!base&&!secret)return undefined;
 if(!base)throw Error('Company workspace configuration unavailable');
 const endpoint=companyEndpoint(base,purpose),key=bridgeSecret(),now=Date.now();
 const body=JSON.stringify({...purpose==='workspace'?{}:{purpose},version:1,issuedAt:now,expiresAt:now+lifetime,actorId:scope.actorId,organizationId:scope.organizationId,query:p.toString()} satisfies Envelope);
 if(encoder.encode(body).length>(purpose==='workspace'?requestLimit:65536))throw Error('Company workspace request too large');
 const headers:Record<string,string>={'content-type':'application/json',[signatureHeader]:await signature(body,key)},protection=serverSecret('COMPANY_WORKSPACE_PROTECTION_SECRET');
 if(protection)headers['x-vercel-protection-bypass']=protection;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),purpose==='workspace'?85000:150000);
 try{
  const response=await fetch(endpoint,{method:'POST',headers,body,redirect:'error',cache:'no-store',signal:controller.signal});
  if(!response.ok){if(purpose!=='workspace'||response.status===413){let failure:unknown;try{failure=JSON.parse(await boundedText(response,requestLimit));}catch{/* Reject malformed provider/protection responses without exposing their content. */}if(failure&&typeof failure==='object'&&'error' in failure&&typeof failure.error==='string'&&(purpose!=='workspace'&&publicCompanyAIErrors.includes(failure.error)||purpose==='workspace'&&response.status===413&&failure.error===publicCompanyWorkspaceSizeError))throw new PublicCompanyError(failure.error);}throw Error('Company workspace unavailable. Please retry.');}
  return JSON.parse(await boundedText(response,responseLimit));
 }catch(error){if(error instanceof PublicCompanyError||error instanceof Error&&error.message.startsWith('Company workspace'))throw error;throw Error('Company workspace unavailable. Please retry.');}finally{clearTimeout(timer);}
}
export async function bridgedWorkspace(scope:AccessScope,p:URLSearchParams):Promise<Workspace|null>{
 const value=await companyJSON(scope,p,'workspace');if(value===undefined)return null;
 const result=value as Workspace;
 if(!result||result.scope?.actorId!==scope.actorId||result.scope.organizationId!==scope.organizationId||!Array.isArray(result.scope.permittedClientIds)||result.scope.permittedClientIds.some(id=>!scope.permittedClientIds.includes(id))||!Array.isArray(result.clients)||result.clients.some(client=>!result.scope.permittedClientIds.includes(client.client.id))||!Array.isArray(result.jobs)||result.jobs.some(job=>!result.scope.permittedClientIds.includes(job.clientId)))throw Error('Company workspace access changed. Please reload.');
 return result;
}
export async function bridgedChat(scope:AccessScope,body:{clientId?:string;reviewId?:string;question:string;filters:unknown}){
 const params=new URLSearchParams({payload:JSON.stringify(body)});if(body.clientId)params.set('clientId',body.clientId);
 const result=await companyJSON(scope,params,'chat');if(result===undefined)return null;
 if(!result||typeof result!=='object'||!('id' in result)||!('payload' in result)||!('question' in result)||result.question!==body.question)throw Error('Company workspace answer unavailable');
 return result;
}
export async function bridgedManualReview(scope:AccessScope,clientId:string,date:string):Promise<{id:string}|null>{
 const params=new URLSearchParams({clientId,payload:JSON.stringify({clientId,date})}),result=await companyJSON(scope,params,'review');if(result===undefined)return null;
 if(!result||typeof result!=='object'||!('id' in result)||typeof result.id!=='string')throw Error('Company workspace review unavailable');
 return {id:result.id};
}
/** Verify the exact bytes before resolving the signed actor in current records. */
export async function companyWorkspaceAccess(request:Request,purpose:Purpose='workspace'):Promise<{scope:AccessScope;params:URLSearchParams}>{
 if(runtimePlatform!=='vercel')throw Error('Company workspace access denied');
 const secret=bridgeSecret(),mac=request.headers.get(signatureHeader)||'';
 if(!/^[a-f0-9]{64}$/.test(mac))throw Error('Company workspace access denied');
 const body=await boundedText(request,purpose==='workspace'?requestLimit:65536),bytes=new Uint8Array(mac.match(/../g)!.map(byte=>parseInt(byte,16)));
 // Web Crypto performs MAC verification without a JavaScript string comparison.
 if(!await crypto.subtle.verify('HMAC',await hmacKey(secret),bytes,encoder.encode(body)))throw Error('Company workspace access denied');
 let envelope:Envelope;try{envelope=JSON.parse(body);}catch{throw Error('Company workspace access denied');}
 const now=Date.now(),keys=['version','issuedAt','expiresAt','actorId','organizationId','query',...purpose==='workspace'?[]:['purpose']];
 if(!envelope||typeof envelope!=='object'||Object.keys(envelope).length!==keys.length||Object.keys(envelope).some(key=>!keys.includes(key))||envelope.version!==1||envelope.purpose!==(purpose==='workspace'?undefined:purpose)||!Number.isSafeInteger(envelope.issuedAt)||!Number.isSafeInteger(envelope.expiresAt)||envelope.expiresAt-envelope.issuedAt>lifetime||envelope.expiresAt<=envelope.issuedAt||envelope.issuedAt>now+5000||envelope.expiresAt<=now||now-envelope.issuedAt>lifetime||typeof envelope.actorId!=='string'||!envelope.actorId||envelope.actorId.length>512||typeof envelope.organizationId!=='string'||envelope.organizationId!==(serverSecret('APP_ORGANIZATION_ID')||'avenue-z')||typeof envelope.query!=='string')throw Error('Company workspace access denied');
 const params=new URLSearchParams(envelope.query),store=getStore(),member=await store.first('SELECT m.* FROM members m WHERE m.organizationId=? AND (m.actorId=? OR EXISTS(SELECT 1 FROM member_identities i WHERE i.organizationId=m.organizationId AND i.email=m.email AND i.actorId=?))',envelope.organizationId,envelope.actorId,envelope.actorId);
 if(!member||!['admin','analyst','service'].includes(member.role))throw Error('Company workspace access denied');
 let grants:unknown;try{grants=JSON.parse(member.clients);}catch{throw Error('Company workspace access denied');}
 if(!Array.isArray(grants)||grants.some(id=>typeof id!=='string'))throw Error('Company workspace access denied');
 const clients=await store.clients(envelope.organizationId),scope:AccessScope={organizationId:envelope.organizationId,actorId:envelope.actorId,role:member.role,permittedClientIds:clients.filter(client=>grants.includes('*')||grants.includes(client.id)).map(client=>client.id)};
 return {scope:authorize(scope,params.get('clientId')||undefined),params};
}
