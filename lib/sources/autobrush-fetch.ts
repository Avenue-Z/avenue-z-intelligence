import type {Client,Connection} from '../analytics/contracts';
import type {Store} from '../server/store';
import {readProviderCredential,saveProviderCredential} from '../server/provider-credentials';
import {validShopifyGrant} from '../server/shopify-connection';
import {validMotionGrant} from '../server/motion-connection';
import {parseShopifyAppConfig} from './shopify-auth';
import {parseMotionAppConfig,refreshMotionGrant} from './motion-auth';
import {fetchAutobrushShopifySource} from './autobrush-shopify';
import {fetchAutobrushMotionSource} from './autobrush-motion';
import {fetchAutobrushIntelligemsSource} from './autobrush-intelligems';
import {autobrushSourceDefinition,effectiveAutobrushWindow} from './autobrush-sources';
import {sourceDates} from './kind-patches';
export {AUTOBRUSH_SOURCES,isAutobrushProvider,autobrushSourceDefinition} from './autobrush-sources';

type SecretReader=(key:string)=>string|null;
type CredentialStore=Pick<Store,'first'|'run'>;
function configured(secret:SecretReader,key:string){const value=secret(key);if(!value)throw Error(`Server secret ${key} is not configured`);return value;}
function settings(connection:Connection,client:Client){
 const definition=autobrushSourceDefinition(connection.provider,client.id);
 if(connection.clientId!==client.id||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Autobrush reporting identity mismatch');
 if(connection.endpoint!==definition.endpoint||connection.secretRef!==definition.secretRef)throw Error('Autobrush endpoint and credential reference are fixed');
 return definition;
}
export async function fetchAutobrushSource(connection:Connection,client:Client,w:{from:string;to:string},store:CredentialStore,organizationId:string,secret:SecretReader,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date()){
 const definition=settings(connection,client);
 if(organizationId!==(secret('APP_ORGANIZATION_ID')||'avenue-z'))throw Error('Autobrush organization mismatch');
 const window=effectiveAutobrushWindow(connection,client,w,now);
 if(Date.now()>=deadline)throw Error('Source synchronization deadline reached');
 const raw=configured(secret,definition.secretRef);
 if(connection.provider==='autobrush-intelligems'){
  let key:string;
  try{const config=raw.trimStart().startsWith('{')?JSON.parse(raw):{apiKey:raw.trim()};
   if(config&&Object.hasOwn(config,'apiKeyEnv')){if(Object.keys(config).join(',')!=='apiKeyEnv'||config.apiKeyEnv!=='AUTOBRUSH_INTELLIGEMS_API_KEY')throw Error();key=configured(secret,'AUTOBRUSH_INTELLIGEMS_API_KEY');}
   else{if(!config||typeof config.apiKey!=='string')throw Error();key=config.apiKey;}
   if(!key.trim()||/[\r\n]/.test(key))throw Error();}
  catch{throw Error('Invalid Autobrush Intelligems configuration');}
  return fetchAutobrushIntelligemsSource(connection,client,window,key,fetcher,deadline,now);
 }
 const authSecret=configured(secret,'AUTH_SECRET');
 if(connection.provider==='autobrush-motion'){
  let app;
  try{const config=JSON.parse(raw);if(Object.keys(config).join(',')!=='clientId')throw Error();app=parseMotionAppConfig(raw);}
  catch{throw Error('Invalid Autobrush Motion configuration');}
  const identity={organizationId,clientId:'autobrush',provider:'motion'};
  let grant=await readProviderCredential(store,identity,authSecret);
  if(!validMotionGrant(grant,app.clientId))throw Error('Autobrush Motion reporting is not authorized');
  if(grant.expiresAt<=now.getTime()+60000){
   const bounded:typeof fetch=(input,init)=>{const remaining=deadline-Date.now();if(remaining<=0)throw Error('Source synchronization deadline reached');return fetcher(input,{...init,signal:AbortSignal.any([init?.signal??new AbortController().signal,AbortSignal.timeout(remaining)])});};
   grant={...grant,...await refreshMotionGrant(app,grant,bounded,now.getTime())};
   await saveProviderCredential(store,identity,grant,authSecret);
  }
  if(!validMotionGrant(grant,app.clientId))throw Error('Autobrush Motion reporting authorization is invalid');
  return fetchAutobrushMotionSource(connection,client,window,grant.accessToken,fetcher,deadline,now);
 }
 let app;
 try{const config=JSON.parse(raw);if(config.storeDomain!=='ama-brushh.myshopify.com'||Object.keys(config).join(',')!=='storeDomain')throw Error();app=parseShopifyAppConfig(JSON.stringify({storeDomain:config.storeDomain,clientId:configured(secret,'AUTOBRUSH_SHOPIFY_CLIENT_ID'),clientSecret:configured(secret,'AUTOBRUSH_SHOPIFY_CLIENT_SECRET')}));}
 catch{throw Error('Invalid Autobrush Shopify configuration');}
 const grant=await readProviderCredential(store,{organizationId,clientId:'autobrush',provider:'shopify'},authSecret);
 if(!validShopifyGrant(grant,app))throw Error('Autobrush Shopify reporting is not authorized');
 return fetchAutobrushShopifySource(connection,client,window,grant.accessToken,fetcher,deadline,now);
}
export function autobrushSourceDates(connection:Connection,client:Client,w:{from:string;to:string},now=new Date()){
 settings(connection,client);const requested=sourceDates(w);if(!requested.length)throw Error('Requested Autobrush source window is empty');
 return [...new Set(requested.map(date=>effectiveAutobrushWindow(connection,client,{from:date,to:date},now).to))].sort((a,b)=>b.localeCompare(a));
}
