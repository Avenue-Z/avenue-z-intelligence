import {cronRequest} from '../../../../lib/server/cron';
import {beamCron} from '../../../../lib/server/beam-cron';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
export async function GET(request:Request){return cronRequest(request,()=>beamCron(true));}
