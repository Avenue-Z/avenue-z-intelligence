import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createGa4DashboardHandler} from '@/lib/server/ga4-dashboard';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createGa4DashboardHandler({scope:scopeForUser,store:getStore,secret:serverSecret});
