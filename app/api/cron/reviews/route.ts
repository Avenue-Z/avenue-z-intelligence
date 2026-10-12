import {cronRequest} from '../../../../lib/server/cron';
import {reviewTick} from '../../../../lib/jobs/runner';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request){return cronRequest(request,reviewTick);}
