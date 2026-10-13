import { z } from 'zod';
import type { QualificationRecord, SourceBatch } from '../analytics/contracts';
export function validateQualification(r:QualificationRecord) {
  const reasons:string[]=[];
  try { new Intl.DateTimeFormat('en',{timeZone:r.timezone || 'invalid'}).format(); } catch { reasons.push('Invalid timezone'); }
  if(!/^[A-Z]{3}$/.test(r.currency)) reasons.push('Invalid currency');
  if(!r.paginationComplete) reasons.push('Pagination incomplete');
  if(!r.reconciled) reasons.push('Totals not reconciled');
  if(r.requiresHourly&&!r.hourlyGrain) reasons.push('Hourly data unavailable');
  r.requiredChannels.filter(x=>!r.channels.includes(x)).forEach(x=>reasons.push(`Missing channel: ${x}`));
  r.requiredDimensions.filter(x=>!r.dimensions.includes(x)).forEach(x=>reasons.push(`Missing dimension: ${x}`));
  return {status:reasons.length?'unqualified':'qualified',reasons} as const;
}
const row=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),metric:z.string().min(1).max(80),value:z.number().finite().nullable(),dataset:z.enum(['overview','revenue','funnels','traffic','markets','products','subscriptions','subscriptionEvents','media','creatives','orderStreams','renewalDiagnostics','orderHygiene','experiments']).default('overview'),dimensions:z.record(z.string()).default({}),definition:z.string().min(1),currency:z.string().nullable(),sourceId:z.string().optional(),retrievedAt:z.string().optional(),coverageThrough:z.string().datetime().nullable().optional(),start:z.string().datetime().optional(),end:z.string().datetime().optional(),quality:z.enum(['complete','partial','historical','estimated']).optional(),numerator:z.number().finite().optional(),denominator:z.number().finite().optional()});
const batch=z.object({clientId:z.string(),timezone:z.string(),currency:z.string().regex(/^[A-Z]{3}$/),channels:z.array(z.string()),dimensions:z.array(z.string()),grain:z.enum(['daily','hourly','segment']),complete:z.boolean(),coverageThrough:z.string().datetime().nullable(),nextCursor:z.string().nullable().optional(),rows:z.array(row.extend({population:z.string().min(1)})).max(50000)});
export function validateBatch(input:unknown,clientId:string,options?:{kindTrafficHourly?:true;kindMetaHourly?:true}):SourceBatch {
  if((input as {clientId?:string})?.clientId!==clientId) throw new Error('Client identity mismatch');
  if(options?.kindTrafficHourly||options?.kindMetaHourly){
    const expanded=batch.extend({rows:z.array(row.extend({population:z.string().min(1)})).max(199995)}).parse(input);
    if(clientId!=='kind-patches'||expanded.grain!=='hourly'||options.kindTrafficHourly&&options.kindMetaHourly)throw Error('Expanded source limit requires one registered Kind Patches hourly profile');
    if(options.kindTrafficHourly&&expanded.rows.some(value=>value.dataset!=='traffic'||value.definition!=='shopify_human_public_landing_page_traffic'||value.population!=='human_public_landing_page_sessions'||!value.start||!value.end||!['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts'].includes(value.metric)))throw Error('Expanded source limit is only valid for qualified hourly public traffic');
    if(options.kindMetaHourly&&expanded.rows.some(value=>value.dataset!=='creatives'||value.definition!=='meta_per_ad_platform_account_attribution_pixel_purchase_store_hour'||value.population!=='meta_platform_ad_report'||!value.start||!value.end||!['meta_ad_spend','meta_ad_impressions','meta_ad_clicks','meta_ad_pixel_purchases','meta_ad_pixel_purchase_value'].includes(value.metric)||!['channel','ad_id','ad','campaign_id','campaign','reporting_timezone','attribution'].every(d=>typeof value.dimensions[d]==='string')))throw Error('Expanded source limit is only valid for qualified hourly Meta performance');
    return expanded as SourceBatch;
  }
  return batch.parse(input) as SourceBatch;
}
export function safeSourceUrl(value:string) {
  const u=new URL(value);const h=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.port && u.port!=='443'||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.includes(':')||/^\d+(\.\d+){3}$/.test(h)||!h.includes('.')) throw new Error('Use an HTTPS service hostname without credentials');
  return u.toString();
}
