import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow} from '../analytics/windows';
import {checkDate,hourlySessionCutoff,localHourInterval,observation,privateSessionPage,publicSessionPages,reconcileSessions,sanitizePage,sessionCount,sessionMetrics,sourceBatch,sourceMarket,trafficLabel,type KindWindow,type Raw} from './kind-patches';

// A complete store day can contain substantially more groups after adding hour.
// Request one extra group as a truncation sentinel, never publish a top-N cut.
export const HOURLY_TRAFFIC_GROUP_LIMIT=39999;
export const TRAFFIC_DIMENSIONS=['page','market','device','source','utm_source','utm_medium','utm_campaign'];
const rawDimensions=['landing_page_path','session_country','session_device_type','referrer_source','utm_source','utm_medium','utm_campaign'];

export function hourlyTrafficQueries(date:string,timezone:string,now=new Date()){
 const cutoff=hourlySessionCutoff(timezone,now);
 checkDate(date,{from:date,to:date});
 dayWindow(date,timezone);
 if(date>cutoff.date)throw new Error('Traffic window extends beyond the current store day');
 if(date===cutoff.date&&!cutoff.hour)throw new Error('The first complete store hour is not available yet');
 const eligible=date===cutoff.date?` AND hour_of_day < ${cutoff.hour}`:'',where=`${publicSessionPages}${eligible}`,show=Object.keys(sessionMetrics).join(','),suffix=`SINCE ${date} UNTIL ${date} ORDER BY day ASC LIMIT ${HOURLY_TRAFFIC_GROUP_LIMIT+1}`;
 return {
  detail:`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day,hour_of_day,${rawDimensions.join(',')} ${suffix}`,
  hourly:`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day,hour_of_day ${suffix}`,
  daily:`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day ${suffix}`
 };
}

export function normalizeHourlyTraffic(input:{detail:Raw[];hourly:Raw[];daily:Raw[]},client:Client,w:KindWindow,now=new Date()):SourceBatch {
 if(w.from!==w.to)throw new Error('Hourly traffic must be captured one complete store day at a time');
 const date=w.to,timezone=client.timezone,cutoff=hourlySessionCutoff(timezone,now);
 checkDate(date,w);
 hourlyTrafficQueries(date,timezone,now);
 if(date>cutoff.date)throw new Error('Traffic window extends beyond the current store day');
 if(input.detail.length>HOURLY_TRAFFIC_GROUP_LIMIT)throw new Error(`Hourly traffic export is incomplete or exceeds the ${HOURLY_TRAFFIC_GROUP_LIMIT}-group row limit`);
 const coverageThrough=date<cutoff.date?dayWindow(date,timezone).end:cutoff.through;
 const metrics=Object.keys(sessionMetrics),seen=new Set<string>(),totalsByHour=new Map<number,Record<string,number>>(),authority=new Map<number,Raw>();
 const groups=new Map<string,{hour:number;dimensions:Record<string,string>;counts:Record<string,number>;interval:{start:string;end:string}}>();
 // Every raw row still validates its own date/hour/counts. The fixed capture
 // date and timezone need at most 24 expensive Temporal interval conversions.
 const intervals=new Map<number,ReturnType<typeof localHourInterval>>();
 const validHour=(r:Raw)=>{
  checkDate(r.day,w);
  const hour=Number(r.hour_of_day);
  if(!['number','string'].includes(typeof r.hour_of_day)||r.hour_of_day===''||!Number.isInteger(hour)||hour<0||hour>23)throw new Error('Invalid provider traffic hour');
  if(!intervals.has(hour))intervals.set(hour,localHourInterval(date,hour,timezone));
  const interval=intervals.get(hour);
  if(!interval)throw new Error('Traffic data contains a skipped local hour');
  if(Date.parse(interval.end)>Date.parse(coverageThrough))throw new Error('Traffic data extends beyond the last full store hour');
  for(const field of metrics)sessionCount(r[field]);
  return {hour,interval};
 };
 for(const r of input.detail){
  const {hour,interval}=validHour(r),rawKey=JSON.stringify([date,hour,...rawDimensions.map(field=>r[field])]);
  if(seen.has(rawKey))throw new Error('Duplicate hourly traffic aggregate');
  seen.add(rawKey);
  const page=sanitizePage(String(r.landing_page_path??'/'));
  if(privateSessionPage(page))throw new Error('Private landing page returned by public session query');
  const dimensions={page,market:sourceMarket(r.session_country),device:trafficLabel(r.session_device_type),source:trafficLabel(r.referrer_source),utm_source:trafficLabel(r.utm_source),utm_medium:trafficLabel(r.utm_medium),utm_campaign:trafficLabel(r.utm_campaign)},counts=Object.fromEntries(metrics.map(field=>[field,sessionCount(r[field])])),key=JSON.stringify([hour,dimensions]),existing=groups.get(key),hourTotals=totalsByHour.get(hour)??Object.fromEntries(metrics.map(field=>[field,0]));
  for(const field of metrics)hourTotals[field]+=counts[field];
  totalsByHour.set(hour,hourTotals);
  if(existing)for(const field of metrics)existing.counts[field]+=counts[field];
  else groups.set(key,{hour,dimensions,counts,interval});
 }
 for(const r of input.hourly){
  const {hour}=validHour(r);
  if(authority.has(hour))throw new Error('Duplicate independent hourly traffic aggregate');
  authority.set(hour,r);
 }
 if(input.daily.length!==1)throw new Error('One independent daily traffic aggregate is required for each covered day');
 checkDate(input.daily[0].day,w);
 for(const field of metrics){
  const dailyCount=sessionCount(input.daily[0][field]);
  reconcileSessions(dailyCount,input.detail.reduce((sum,r)=>sum+sessionCount(r[field]),0));
  reconcileSessions(dailyCount,input.hourly.reduce((sum,r)=>sum+sessionCount(r[field]),0));
 }
 for(const hour of new Set([...totalsByHour.keys(),...authority.keys()]))for(const field of metrics)reconcileSessions(authority.has(hour)?sessionCount(authority.get(hour)![field]):0,totalsByHour.get(hour)?.[field]??0);
 const rows:Observation[]=[];
 for(const group of groups.values())for(const [field,metric] of Object.entries(sessionMetrics))rows.push(observation(date,'traffic',metric,group.counts[field],'shopify_human_public_landing_page_traffic','human_public_landing_page_sessions',null,group.dimensions,group.interval));
 rows.push(...rows.filter(r=>r.metric==='converting_sessions').map(r=>({...r,metric:'completed_checkouts'})));
 return {...sourceBatch(client,rows,coverageThrough,[],'hourly',client.id==='beam'?{beamTrafficHourly:true}:client.id==='autobrush'?{autobrushTrafficHourly:true}:{kindTrafficHourly:true}),dimensions:TRAFFIC_DIMENSIONS};
}
