import {cronRequest} from '../../../../lib/server/cron';
import {hourlyHistoryTick} from '../../../../lib/jobs/run-hourly-history';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(request:Request){return cronRequest(request,hourlyHistoryTick);}
