import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createMotionConnectionHandlers} from '@/lib/server/motion-connection';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createMotionConnectionHandlers({scope:scopeForUser,store:getStore,secret:serverSecret}).callback;
