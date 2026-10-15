import type {AccessScope,Client} from '../analytics/contracts';
import type {KindWindow} from '../sources/kind-patches';
import type {RetainedRechargeCreation} from '../sources/recharge-subscription-cohort';
import {subscriptionIdentity,utcInstant} from '../sources/recharge-cancellations';
import {dayWindow} from '../analytics/windows';
import type {Store} from './store';

const action='recharge.subscription.creation.retained';
const topics=new Set(['subscription/created','subscription/cancelled','subscription/deleted']);
const pageSize=2000,maximumRecords=250000;

/** Reuse original resource creation timestamps after Recharge removes a live
 * subscription. This reads only authenticated minimal webhook audit records;
 * cancellation event timestamps never stand in for subscription creation. */
export async function retainedRechargeCreations(store:Store,scope:AccessScope,client:Client,window:KindWindow,deadline:number):Promise<RetainedRechargeCreation[]>{
 if(!['admin','service'].includes(scope.role)||client.id!=='kind-patches'||!scope.permittedClientIds.includes(client.id))throw Error('Retained Recharge creation access denied');
 const checkDeadline=()=>{if(Date.now()>=deadline)throw Error('Source synchronization deadline reached');};
 checkDeadline();
 const start=dayWindow(window.from,client.timezone).start,end=dayWindow(window.to,client.timezone).end;
 if(Date.parse(start)>=Date.parse(end))throw Error('Retained Recharge creation window is invalid');
 const prefix=`recharge-creation:${scope.organizationId}:${client.id}:`,rows:RetainedRechargeCreation[]=[];
 let cursor=prefix;
 for(;;){
  checkDeadline();
  const payload="CASE WHEN json_valid(payload) THEN payload ELSE NULL END",born=`json_extract(${payload},'$.createdAt')`;
  const page=await store.all<{id:string;payload:string}>(`SELECT id,payload FROM audit WHERE id>? AND id<? AND organizationId=? AND clientId=? AND action=? AND (julianday(${born}) IS NULL OR (julianday(${born})>=julianday(?) AND julianday(${born})<julianday(?))) ORDER BY id LIMIT ?`,cursor,`${prefix}\uffff`,scope.organizationId,client.id,action,start,end,pageSize);
  checkDeadline();
  if(rows.length+page.length>maximumRecords)throw Error('Retained Recharge creation record limit exceeded');
  for(const row of page){
   let value:Record<string,unknown>,subscriptionId:string,createdAt:string;
   try{
    value=JSON.parse(row.payload);
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.subscriptionId!=='string'||value.source!=='recharge-webhook'||typeof value.topic!=='string'||!topics.has(value.topic)||typeof value.receivedAt!=='string')throw Error();
    subscriptionId=subscriptionIdentity(value.subscriptionId);createdAt=utcInstant(value.createdAt).toString();utcInstant(value.receivedAt);
    if(row.id!==`${prefix}${subscriptionId}`||createdAt!==value.createdAt)throw Error();
   }catch{throw Error('Retained Recharge creation evidence is invalid');}
   rows.push({subscriptionId,createdAt});
  }
  if(page.length<pageSize)return rows;
  cursor=page.at(-1)!.id;
 }
}
