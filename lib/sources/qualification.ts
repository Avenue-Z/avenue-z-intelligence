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
const row=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),metric:z.string().min(1).max(80),value:z.number().finite().nullable(),dataset:z.enum(['overview','revenue','funnels','markets','products','subscriptions','media','experiments']).default('overview'),dimensions:z.record(z.string()).default({}),definition:z.string().min(1),currency:z.string().nullable(),sourceId:z.string().optional(),retrievedAt:z.string().optional(),coverageThrough:z.string().datetime().nullable().optional(),start:z.string().datetime().optional(),end:z.string().datetime().optional(),quality:z.enum(['complete','partial','historical','estimated']).optional(),numerator:z.number().finite().optional(),denominator:z.number().finite().optional()});
const batch=z.object({clientId:z.string(),timezone:z.string(),currency:z.string().regex(/^[A-Z]{3}$/),channels:z.array(z.string()),dimensions:z.array(z.string()),grain:z.enum(['daily','hourly','segment']),complete:z.boolean(),coverageThrough:z.string().datetime().nullable(),nextCursor:z.string().nullable().optional(),rows:z.array(row).max(50000)});
export function validateBatch(input:unknown,clientId:string):SourceBatch {
  if((input as {clientId?:string})?.clientId!==clientId) throw new Error('Client identity mismatch');
  return batch.parse(input) as SourceBatch;
}
export function safeSourceUrl(value:string) {
  const u=new URL(value);const h=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.port && u.port!=='443'||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.includes(':')||/^\d+(\.\d+){3}$/.test(h)||!h.includes('.')) throw new Error('Use an HTTPS service hostname without credentials');
  return u.toString();
}
