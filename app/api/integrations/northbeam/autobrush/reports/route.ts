import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createAutobrushNorthbeamDashboard} from '@/lib/server/autobrush-northbeam-dashboard';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createAutobrushNorthbeamDashboard({scope:scopeForUser,store:getStore,secret:serverSecret});
