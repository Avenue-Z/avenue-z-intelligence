/** Fixed reporting identities. OAuth credentials never belong in this module. */
export type Ga4ClientId='beam'|'autobrush';
export type Ga4Profile={clientId:Ga4ClientId;name:string;propertyId:string;timezone:string;currency:'USD';streamId:string|null};
const profiles:Record<Ga4ClientId,Ga4Profile>={beam:{clientId:'beam',name:'Beam',propertyId:'292550743',timezone:'America/New_York',currency:'USD',streamId:null},autobrush:{clientId:'autobrush',name:'Autobrush',propertyId:'274489308',timezone:'America/Los_Angeles',currency:'USD',streamId:'2635677328'}};
export function isGa4Client(value:unknown):value is Ga4ClientId{return value==='beam'||value==='autobrush';}
export function ga4Profile(clientId:Ga4ClientId='beam'):Ga4Profile{if(!isGa4Client(clientId))throw Error('Unsupported GA4 client');return {...profiles[clientId]};}
export function ga4ProfileForProperty(propertyId:string){const clientId=propertyId==='292550743'?'beam':propertyId==='274489308'?'autobrush':null;if(!clientId)throw Error('Unsupported GA4 property');return ga4Profile(clientId);}
export function ga4Dimensions(profile:Ga4Profile,kind:'total'|'hourly'|'detail'){return [...kind==='total'?[]:kind==='hourly'?['dateHour']:['dateHour','landingPage','countryId','deviceCategory','sessionSource','sessionMedium','sessionCampaignName'],...profile.streamId?['streamId']:[]];}
export function ga4ViewTimezone(clientId:unknown,view:string,fallback:string){return view==='ga4'&&isGa4Client(clientId)?ga4Profile(clientId).timezone:fallback;}
