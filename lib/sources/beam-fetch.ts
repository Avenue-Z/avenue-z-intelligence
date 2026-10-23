import type {Client,Connection} from '../analytics/contracts';
import type {Store} from '../server/store';
import {validShopifyGrant} from '../server/shopify-connection';
import {validMotionGrant} from '../server/motion-connection';
import {readProviderCredential,saveProviderCredential} from '../server/provider-credentials';
import {parseShopifyAppConfig} from './shopify-auth';
import {parseMotionAppConfig,refreshMotionGrant} from './motion-auth';
import {fetchBeamShopifySource} from './beam-shopify';
import {beamMotionConfiguration,fetchBeamMotionSource} from './beam-motion';
import {beamIntelligemsConfiguration,fetchBeamIntelligemsSource} from './beam-intelligems';
import {beamSourceDefinition,effectiveBeamWindow} from './beam-sources';
import {sourceDates} from './kind-patches';
export {BEAM_SOURCES,beamSourceDefinition,isBeamProvider} from './beam-sources';

type CredentialStore=Pick<Store,'first'|'run'>;
type SecretReader=(name:string)=>string|null;
function settings(connection:Connection,client:Client){
 const definition=beamSourceDefinition(connection.provider,client.id);
 if(connection.clientId!==client.id||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Beam reporting identity mismatch');
 if(connection.endpoint!==definition.endpoint||connection.secretRef!==definition.secretRef)throw Error('Beam provider endpoint and credential reference are fixed');
 return definition;
}
function configured(secret:SecretReader,name:string){const value=secret(name);if(!value)throw Error(`Server secret ${name} is not configured`);return value;}

/** Dispatch only registered Beam endpoints. OAuth grants remain encrypted in
 * the organization/client/provider vault; adapters receive the token in memory. */
export async function fetchBeamSource(connection:Connection,client:Client,w:{from:string;to:string},store:CredentialStore,organizationId:string,secret:SecretReader,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date()){
 const definition=settings(connection,client),window=effectiveBeamWindow(connection,client,w,now);
 if(Date.now()>=deadline)throw Error('Source synchronization deadline reached');
 const raw=configured(secret,definition.secretRef);
 if(connection.provider==='beam-intelligems'){
  let input:unknown;try{input=raw.trimStart().startsWith('{')?JSON.parse(raw):{apiKey:raw.trim()};}catch{throw Error('Invalid Beam Intelligems configuration');}
  const config=beamIntelligemsConfiguration.parse(input);
  return fetchBeamIntelligemsSource(connection,client,window,config.apiKey,fetcher,deadline,now);
 }
 const authSecret=configured(secret,'AUTH_SECRET');
 if(connection.provider==='beam-motion'){
  let config;try{config=beamMotionConfiguration.parse(JSON.parse(raw));}catch{throw Error('Invalid Beam Motion configuration');}
  const app=parseMotionAppConfig(JSON.stringify({clientId:config.clientId})),identity={organizationId,clientId:'beam',provider:'motion'};
  let grant=await readProviderCredential(store,identity,authSecret);
  if(!validMotionGrant(grant,app.clientId))throw Error('Beam Motion reporting is not authorized');
  if(grant.expiresAt<=now.getTime()+60000){
   const refreshFetch:typeof fetch=(input,init)=>{
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('Source synchronization deadline reached');
    return fetcher(input,{...init,signal:AbortSignal.any([init?.signal??new AbortController().signal,AbortSignal.timeout(remaining)])});
   };
   const refreshed=await refreshMotionGrant(app,grant,refreshFetch,now.getTime());
   grant={...grant,...refreshed};
   await saveProviderCredential(store,identity,grant,authSecret);
  }
  if(!validMotionGrant(grant,app.clientId))throw Error('Beam Motion reporting authorization is invalid');
  return fetchBeamMotionSource({...connection,...config.reportingTimezone?{reportingTimezone:config.reportingTimezone}:{}},client,window,grant.accessToken,fetcher,deadline,now);
 }
 const app=parseShopifyAppConfig(raw);
 if(app.storeDomain!=='beamtlc.myshopify.com')throw Error('Beam Shopify store identity mismatch');
 const grant=await readProviderCredential(store,{organizationId,clientId:'beam',provider:'shopify'},authSecret);
 if(!validShopifyGrant(grant,app))throw Error('Beam Shopify reporting is not authorized');
 return fetchBeamShopifySource(connection,client,window,grant.accessToken,fetcher,deadline,now);
}

export function beamSourceDates(connection:Connection,client:Client,w:{from:string;to:string},now=new Date()){
 settings(connection,client);
 const requested=sourceDates(w);
 if(!requested.length)throw Error('Requested Beam source window is empty');
 return [...new Set(requested.map(date=>effectiveBeamWindow(connection,client,{from:date,to:date},now).to))].sort((a,b)=>b.localeCompare(a));
}

/** All requested dates are captured explicitly, newest first. Midnight's
 * previous-day Shopify anchor is deduplicated without inventing new-day zeros. */
export async function* fetchBeamBatches(connection:Connection,client:Client,w:{from:string;to:string},store:CredentialStore,organizationId:string,secret:SecretReader,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date()){
 for(const date of beamSourceDates(connection,client,w,now)){
  const window={from:date,to:date};
  yield {batch:await fetchBeamSource(connection,client,window,store,organizationId,secret,fetcher,deadline,now),window};
 }
}
