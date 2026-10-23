import initial from '../../data/initial-clients.json';
import type {Client,Connection} from '../analytics/contracts';
import {todayIn,shiftDate,dayWindow} from '../analytics/windows';
import {fetchAutobrushSource,autobrushSourceDefinition} from '../sources/autobrush-fetch';
import {autobrushShopifyQualification} from '../sources/autobrush-shopify';
import {autobrushMotionQualification} from '../sources/autobrush-motion';
import {autobrushIntelligemsQualification} from '../sources/autobrush-intelligems';
import {requireQualifiedSource,validateRegisteredBatch} from '../sources/registered-contract';
import type {Store} from './store';

/** Protected setup operation. Returns contracts and aggregate proof, never raw
 * observations or credentials; registering/enabling remains a separate write. */
export async function qualifyAutobrushSource(store:Store,organizationId:string,provider:string,date:string,secret:(key:string)=>string|null,pull:typeof fetchAutobrushSource=fetchAutobrushSource,now=new Date()){
 const definition=autobrushSourceDefinition(provider,'autobrush'),client={...initial.find(value=>value.id==='autobrush')!,version:1} as Client;
 const today=todayIn(client.timezone,now);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<shiftDate(today,-29)||date>today)throw Error('Qualification date is outside the retained month');
 dayWindow(date,client.timezone);
 const connection:Connection={...definition,id:provider,clientId:'autobrush',enabled:false,lastSuccess:null,coverageThrough:null,error:null,version:1};
 const batch=await pull(connection,client,{from:date,to:date},store,organizationId,secret,fetch,Date.now()+700000,now);
 const contract=provider==='autobrush-motion'?autobrushMotionQualification(batch):provider==='autobrush-intelligems'?autobrushIntelligemsQualification(batch):autobrushShopifyQualification(batch,provider);
 requireQualifiedSource(contract,client);validateRegisteredBatch(batch,contract);
 const overview:Record<string,number>={};for(const row of batch.rows)if(row.dataset==='overview'&&row.value!==null)overview[row.metric]=(overview[row.metric]??0)+row.value;
 return {clientId:'autobrush',provider,date,rowCount:batch.rows.length,coverageThrough:batch.coverageThrough,overview,contract};
}
