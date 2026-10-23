import {ga4Profile,type Ga4ClientId} from '../analytics/ga4-profile';
import {parseGa4AppConfig} from '../sources/ga4-auth';
/** Reuse company application configuration only; grants stay client scoped. */
export function ga4AppConfig(secret:(key:string)=>string|null,clientId:Ga4ClientId='beam'){
 const profile=ga4Profile(clientId),raw=secret(clientId==='beam'?'SOURCE_BEAM_GA4':'SOURCE_AUTOBRUSH_GA4')||'';
 if(raw.length>16384)throw Error('Invalid GA4 configuration');
 const value:unknown=JSON.parse(raw);
 let app;
 if(clientId==='autobrush'&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'oauthClientConfig')){
  const reference=value as Record<string,unknown>;
  if(Object.keys(reference).sort().join(',')!=='oauthClientConfig,propertyId'||reference.propertyId!==profile.propertyId||reference.oauthClientConfig!=='SOURCE_BEAM_GA4')throw Error('Invalid GA4 configuration');
  app={...parseGa4AppConfig(secret('SOURCE_BEAM_GA4')||''),propertyId:profile.propertyId};
 }else app=parseGa4AppConfig(raw);
 if(app.propertyId!==profile.propertyId)throw Error('GA4 property is not allowed');
 return app;
}
