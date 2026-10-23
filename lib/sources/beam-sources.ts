import {BEAM_SHOPIFY_ENDPOINT} from './beam-shopify';
import type {Client,Connection} from '../analytics/contracts';
import {hourlySessionCutoff} from './kind-patches';
import {shiftDate} from '../analytics/windows';

export const BEAM_SOURCES=[
 {provider:'beam-shopify-sales',name:'Shopify · hourly sales channels excluding Faire',endpoint:BEAM_SHOPIFY_ENDPOINT,secretRef:'SOURCE_BEAM_SHOPIFY',pollMinutes:60},
 {provider:'beam-shopify-products',name:'Shopify · hourly products excluding Faire',endpoint:BEAM_SHOPIFY_ENDPOINT,secretRef:'SOURCE_BEAM_SHOPIFY',pollMinutes:60},
 {provider:'beam-shopify-sessions',name:'Shopify · hourly human US sessions & pages',endpoint:BEAM_SHOPIFY_ENDPOINT,secretRef:'SOURCE_BEAM_SHOPIFY',pollMinutes:60},
 {provider:'beam-shopify-traffic',name:'Shopify · hourly human US page, device & UTM traffic',endpoint:BEAM_SHOPIFY_ENDPOINT,secretRef:'SOURCE_BEAM_SHOPIFY',pollMinutes:60},
 {provider:'beam-shopify-markets',name:'Shopify · hourly billing-country sales & human US sessions',endpoint:BEAM_SHOPIFY_ENDPOINT,secretRef:'SOURCE_BEAM_SHOPIFY',pollMinutes:60},
 {provider:'beam-motion',name:'Motion · Meta spend & ad delivery',endpoint:'https://projects.motionapp.com/mcp',secretRef:'SOURCE_BEAM_MOTION',pollMinutes:60},
 {provider:'beam-intelligems',name:'Intelligems · US experiment results',endpoint:'https://api.intelligems.io/v25-10-beta',secretRef:'SOURCE_BEAM_INTELLIGEMS',pollMinutes:60},
] as const;
export type BeamProvider=typeof BEAM_SOURCES[number]['provider'];
export function isBeamProvider(provider:string):provider is BeamProvider{return BEAM_SOURCES.some(source=>source.provider===provider);}
export function beamSourceDefinition(provider:string,clientId:string){
 if(clientId!=='beam')throw Error('These reporting sources are scoped to Beam');
 const source=BEAM_SOURCES.find(source=>source.provider===provider);
 if(!source)throw Error('Unknown Beam reporting provider');
 return source;
}
/** A source run captures one real store day. At midnight Shopify has no
 * completed new-day hour, so routine polling refreshes the last closed day. */
export function effectiveBeamWindow(connection:Connection,client:Client,w:{from:string;to:string},now=new Date()){
 beamSourceDefinition(connection.provider,client.id);
 if(w.from!==w.to)throw Error('Beam sources require one store day per batch');
 const cutoff=hourlySessionCutoff(client.timezone,now);
 return connection.provider.startsWith('beam-shopify-')&&w.to===cutoff.date&&cutoff.hour===0?{from:shiftDate(w.to,-1),to:shiftDate(w.to,-1)}:w;
}
