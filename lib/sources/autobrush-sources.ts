import type {Client,Connection} from '../analytics/contracts';
import {shiftDate,dayWindow} from '../analytics/windows';
import {checkDate,hourlySessionCutoff} from './kind-patches';
import {AUTOBRUSH_SHOPIFY_ENDPOINT} from './autobrush-shopify';

export const AUTOBRUSH_SOURCES=[
 {provider:'autobrush-shopify-sales',name:'Shopify · hourly sales across all channels',endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT,secretRef:'SOURCE_AUTOBRUSH_SHOPIFY',pollMinutes:60},
 {provider:'autobrush-shopify-products',name:'Shopify · hourly products across all channels',endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT,secretRef:'SOURCE_AUTOBRUSH_SHOPIFY',pollMinutes:60},
 {provider:'autobrush-shopify-sessions',name:'Shopify · hourly human sessions & public pages',endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT,secretRef:'SOURCE_AUTOBRUSH_SHOPIFY',pollMinutes:60},
 {provider:'autobrush-shopify-traffic',name:'Shopify · hourly human page, country, device & UTM traffic',endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT,secretRef:'SOURCE_AUTOBRUSH_SHOPIFY',pollMinutes:60},
 {provider:'autobrush-shopify-markets',name:'Shopify · hourly billing-country sales & human session countries',endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT,secretRef:'SOURCE_AUTOBRUSH_SHOPIFY',pollMinutes:60},
 {provider:'autobrush-motion',name:'Motion · provider-date Meta spend & ad delivery',endpoint:'https://projects.motionapp.com/mcp',secretRef:'SOURCE_AUTOBRUSH_MOTION',pollMinutes:60},
 {provider:'autobrush-intelligems',name:'Intelligems · all-market experiment results',endpoint:'https://api.intelligems.io/v25-10-beta',secretRef:'SOURCE_AUTOBRUSH_INTELLIGEMS',pollMinutes:60},
] as const;
export type AutobrushProvider=typeof AUTOBRUSH_SOURCES[number]['provider'];
export function isAutobrushProvider(provider:string):provider is AutobrushProvider{return AUTOBRUSH_SOURCES.some(source=>source.provider===provider);}
export function autobrushSourceDefinition(provider:string,clientId:string){
 if(clientId!=='autobrush')throw Error('These reporting sources are scoped to Autobrush');
 const source=AUTOBRUSH_SOURCES.find(source=>source.provider===provider);
 if(!source)throw Error('Unknown Autobrush reporting provider');
 return source;
}
/** At midnight Shopify has no completed new-day hour. Routine Shopify polling
 * refreshes the last closed store day; provider-date sources retain their date. */
export function effectiveAutobrushWindow(connection:Connection,client:Client,w:{from:string;to:string},now=new Date()){
 if(connection.clientId!=='autobrush'||client.id!=='autobrush'||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Autobrush reporting identity mismatch');
 autobrushSourceDefinition(connection.provider,client.id);
 if(w.from!==w.to)throw Error('Autobrush sources require one store day per batch');
 checkDate(w.to,w);dayWindow(w.to,client.timezone);
 const cutoff=hourlySessionCutoff(client.timezone,now);
 if(w.to>cutoff.date)throw Error('Autobrush window extends beyond the current store day');
 return connection.provider.startsWith('autobrush-shopify-')&&w.to===cutoff.date&&cutoff.hour===0?{from:shiftDate(w.to,-1),to:shiftDate(w.to,-1)}:w;
}
