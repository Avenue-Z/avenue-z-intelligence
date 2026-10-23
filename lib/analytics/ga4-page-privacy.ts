import type {Ga4Report,Ga4ReportRow} from '../sources/ga4-data';

/** Classify reserved private routes, never public slugs by their length. */
export function ga4PageLabel(value:string):string{
 if(!value)return value;
 let path=value.split(/[?#]/)[0];
 if(/^https?:\/\//i.test(path)){try{path=new URL(path).pathname;}catch{return '/[private]';}}
 let decoded=path;
 try{for(let pass=0;pass<4&&/%[0-9a-f]{2}/i.test(decoded);pass++)decoded=decodeURIComponent(decoded);}
 catch{return '/[private]';}
 decoded=decoded.replaceAll('\\','/');
 if(decoded.includes('[private]')||/(?:^|\/)(?:orders|checkouts?|accounts?|customers?|cart|loop_subscriptions)(?:\/|$)/i.test(decoded)||/(?:^|\/)tools\/recurring(?:\/|$)/i.test(decoded)||decoded.includes('@')&&/[^\s/]+@[^\s/]+/.test(decoded)||/%[0-9a-f]{2}/i.test(decoded))return '/[private]';
 return path;
}

/** Run after raw pagination checks. Redacted rows can share a dimension key;
 * pool only the additive metrics used by the cached GA4 workspace. */
export function privateSafeGa4Report(input:Ga4Report):Ga4Report{
 const names=input.dimensionHeaders.map(header=>header.name),pages=names.filter(name=>name==='landingPage'||name==='landingPagePlusQueryString');
 if(!pages.length)return input;
 let changed=false;
 const rows=input.rows.map(row=>{const dimensions={...row.dimensions};for(const page of pages){dimensions[page]=ga4PageLabel(dimensions[page]);changed ||= dimensions[page]!==row.dimensions[page];}return {dimensions,metrics:{...row.metrics}};});
 if(!changed)return input;
 const groups=new Map<string,Ga4ReportRow>(),rawKeys=new Set<string>(),additive=new Set(['sessions','engagedSessions','ecommercePurchases','purchaseRevenue']);
 for(let index=0;index<rows.length;index++){
  const rawKey=JSON.stringify(names.map(name=>input.rows[index].dimensions[name]));if(rawKeys.has(rawKey))throw Error('GA4 report repeated a dimension row');rawKeys.add(rawKey);
  const row=rows[index],key=JSON.stringify(names.map(name=>row.dimensions[name])),prior=groups.get(key);
  if(!prior){groups.set(key,row);continue;}
  for(const metric of input.metricHeaders){
   if(!additive.has(metric.name))throw Error('GA4 private page aggregation requires additive workspace metrics');
   const value=prior.metrics[metric.name]+row.metrics[metric.name];
   if(!Number.isFinite(value)||metric.type==='TYPE_INTEGER'&&!Number.isSafeInteger(value))throw Error('GA4 private page totals are invalid');
   prior.metrics[metric.name]=value;
  }
 }
 return {...input,rows:[...groups.values()],rowCount:groups.size};
}
