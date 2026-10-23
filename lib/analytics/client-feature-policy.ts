import {isGa4Client,ga4ViewTimezone} from './ga4-profile';
import {northbeamProfile} from './northbeam-dashboard';
const tabs:[string,string][]=[['overview','Overview'],['revenue','Revenue'],['traffic','Traffic'],['markets','Markets'],['products','Products & offers'],['subscriptions','Subscriptions'],['media','Spend & efficiency'],['reviews','Reviews & follow-ups'],['settings','Data & settings']];

/** Older saved Beam frames predate the capability flag. */
export function clientSubscriptionsEnabled(clientId?:string,enabled?:boolean){return enabled??clientId!=='beam';}
export function clientViewTabs(clientId?:string,subscriptionsEnabled?:boolean):[string,string][]{
 const available=tabs.flatMap(tab=>clientId==='autobrush'&&tab[0]==='media'?[tab,['northbeam','Attribution'] as [string,string]]:[tab]).filter(([view])=>view!=='subscriptions'||clientSubscriptionsEnabled(clientId,subscriptionsEnabled));
 return isGa4Client(clientId)?available.flatMap(tab=>tab[0]==='traffic'?[tab,['ga4','Web analytics'] as [string,string]]:[tab]):available;
}

export function isClientReportView(clientId:unknown,view:string){return view==='ga4'&&isGa4Client(clientId)||view==='northbeam'&&clientId==='autobrush';}
export function clientViewTimezone(clientId:unknown,view:string,fallback:string){return view==='northbeam'&&clientId==='autobrush'?northbeamProfile.reportingTimezone:ga4ViewTimezone(clientId,view,fallback);}
