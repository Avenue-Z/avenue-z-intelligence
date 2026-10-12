import {standaloneAuth} from '../../../../lib/server/standalone-auth';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return standaloneAuth(request);}
export async function POST(request:Request){return standaloneAuth(request);}
