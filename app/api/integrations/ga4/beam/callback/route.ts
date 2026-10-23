import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createGa4ConnectionHandlers} from '@/lib/server/ga4-connection';
import {AUTOBRUSH_GA4_STATE_PREFIX,createAutobrushGa4ConnectionHandlers} from '@/lib/server/autobrush-ga4-connection';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
const dependencies={scope:scopeForUser,store:getStore,secret:serverSecret};
const beam=createGa4ConnectionHandlers(dependencies),autobrush=createAutobrushGa4ConnectionHandlers(dependencies);
export async function GET(request:Request){
 const state=new URL(request.url).searchParams.get('state')||'';
 // Routing only: each handler still checks its own encrypted state, actor and PKCE.
 return state.startsWith(AUTOBRUSH_GA4_STATE_PREFIX)?autobrush.callback(request):beam.callback(request);
}
