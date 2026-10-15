import {createHmac,timingSafeEqual} from 'node:crypto';
import {utcInstant} from '../sources/recharge-cancellations';
import type {Store} from './store';

type Options={store:()=>Store;organizationId:string;clientSecret:string|null;storeDomain:string|null;now?:Date};
const maximumBodyBytes=128*1024;
const topics=new Set(['subscription/created','subscription/cancelled','subscription/deleted']);
const clientId='kind-patches',action='recharge.subscription.creation.retained';
const respond=(status:number,body:Record<string,unknown>)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
class RejectedWebhook extends Error{constructor(public status:number,message:string){super(message);}}

async function rawBody(request:Request){
 const length=request.headers.get('content-length');
 if(length!==null){if(!/^\d+$/.test(length))throw new RejectedWebhook(400,'Invalid webhook body');if(Number(length)>maximumBodyBytes)throw new RejectedWebhook(413,'Webhook body too large');}
 if(!request.body)return Buffer.alloc(0);
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maximumBodyBytes){void reader.cancel().catch(()=>{});throw new RejectedWebhook(413,'Webhook body too large');}parts.push(next.value);}}
 finally{reader.releaseLock();}
 return Buffer.concat(parts,bytes);
}

function signature(request:Request,now:number){
 const header=request.headers.get('X-Recharge-Webhook-Signature'),timestampHeader=request.headers.get('X-Recharge-Webhook-Timestamp');
 if(!header||header.length>1024||!timestampHeader)return null;
 const values=new Map<string,string>();
 for(const part of header.split(',')){
  const match=/^\s*([a-z][a-z0-9]*)=([^,]*)\s*$/.exec(part);if(!match)return null;
  const key=match[1],value=match[2].trim();if(values.has(key))return null;values.set(key,value);
 }
 const timestamp=values.get('t'),digest=values.get('v1');
 if(!timestamp||timestamp!==timestampHeader||!/^\d{1,12}$/.test(timestamp)||!digest||!/^[a-f0-9]{64}$/i.test(digest))return null;
 const seconds=Number(timestamp),age=now/1000-seconds;
 if(!Number.isSafeInteger(seconds)||seconds<=0||age>172800||age< -300)return null;
 return {timestamp,seconds,digest:Buffer.from(digest,'hex')};
}

/** The signed resource's own birth timestamp survives later cancellation or
 * deletion. Event timestamps and customer/order details are never retained.
 * See Recharge's timestamp-bound signature contract in its webhook reference. */
export async function receiveRechargeWebhook(request:Request,options:Options){
 const {clientSecret,storeDomain,organizationId}=options,now=(options.now??new Date()).getTime();
 if(!clientSecret||!storeDomain||!organizationId||!Number.isFinite(now))return respond(503,{error:'Recharge webhook unavailable'});
 try{
  if(request.headers.get('X-Recharge-External-Platform-Domain')!==storeDomain)throw new RejectedWebhook(401,'Invalid webhook authentication');
  const signed=signature(request,now);if(!signed)throw new RejectedWebhook(401,'Invalid webhook authentication');
  const raw=await rawBody(request),expected=createHmac('sha256',clientSecret).update(`${signed.timestamp}.`).update(raw).digest();
  if(!timingSafeEqual(expected,signed.digest))throw new RejectedWebhook(401,'Invalid webhook authentication');
  const topic=request.headers.get('X-Recharge-Topic');if(!topic||!topics.has(topic))throw new RejectedWebhook(400,'Unsupported webhook topic');
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new RejectedWebhook(400,'Invalid webhook body');}
  const subscription=body&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).subscription:null;
  if(!subscription||typeof subscription!=='object'||Array.isArray(subscription))throw new RejectedWebhook(400,'Invalid subscription resource');
  const resource=subscription as Record<string,unknown>,id=resource.id;
  if(typeof id!=='number'&&typeof id!=='string'||!Number.isSafeInteger(Number(id))||!/^[1-9]\d*$/.test(String(id)))throw new RejectedWebhook(400,'Invalid subscription resource');
  let createdAt:string;try{const created=utcInstant(resource.created_at);if(created.epochMilliseconds>(signed.seconds+1)*1000||created.epochMilliseconds>now+300000)throw Error('Future resource');createdAt=created.toString();}catch{throw new RejectedWebhook(400,'Invalid subscription creation timestamp');}
  const subscriptionId=String(id),receivedAt=new Date(now).toISOString(),auditId=`recharge-creation:${organizationId}:${clientId}:${subscriptionId}`,store=options.store();
  const retained={subscriptionId,createdAt,receivedAt,source:'recharge-webhook',topic};
  // First-wins makes an uncertain committed acknowledgement safe to retry.
  // Re-read the winning record so concurrent conflicting births fail closed.
  await store.run('INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',auditId,organizationId,clientId,'recharge-webhook',action,JSON.stringify(retained),receivedAt);
  const saved=await store.first<{organizationId:string;clientId:string;actorId:string;action:string;payload:string}>('SELECT organizationId,clientId,actorId,action,payload FROM audit WHERE id=?',auditId);
  let previous:Record<string,unknown>|null=null;try{previous=saved?JSON.parse(saved.payload):null;}catch{/* A malformed collision must never be overwritten. */}
  if(!saved||saved.organizationId!==organizationId||saved.clientId!==clientId||saved.actorId!=='recharge-webhook'||saved.action!==action||!previous||previous.subscriptionId!==subscriptionId||previous.createdAt!==createdAt||previous.source!=='recharge-webhook'||typeof previous.topic!=='string'||!topics.has(previous.topic)||typeof previous.receivedAt!=='string'||!Number.isFinite(Date.parse(previous.receivedAt)))return respond(409,{error:'Conflicting retained subscription creation'});
  return respond(200,{accepted:true});
 }catch(error){return error instanceof RejectedWebhook?respond(error.status,{error:error.message}):respond(503,{error:'Recharge webhook persistence unavailable'});}
}
