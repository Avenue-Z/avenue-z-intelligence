import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createGa4ConnectionHandlers} from '@/lib/server/ga4-connection';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createGa4ConnectionHandlers({scope:scopeForUser,store:getStore,secret:serverSecret}).status;
