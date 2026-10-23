import {cronRequest} from '../../../../lib/server/cron';
import {autobrushCron} from '../../../../lib/server/autobrush-cron';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(request:Request){return cronRequest(request,()=>autobrushCron(true));}
