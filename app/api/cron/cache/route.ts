import {cronRequest} from '../../../../lib/server/cron';
import {cacheTick} from '../../../../lib/jobs/cache-runner';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(request:Request){return cronRequest(request,cacheTick);}
