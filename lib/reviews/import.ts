import {z} from 'zod';
import {Temporal} from '@js-temporal/polyfill';
const record=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{try{return Temporal.PlainDate.from(v).toString()===v;}catch{return false;}},'Use a valid store date'),title:z.string().min(1).max(200),text:z.string().min(1).max(200000),sourceUrl:z.string().url().refine(v=>new URL(v).protocol==='https:','Use an HTTPS report URL')});
export function parseReviewArchive(input:unknown){return z.array(record).min(1).max(31).parse(input);}
