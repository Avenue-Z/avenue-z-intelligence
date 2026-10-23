import {getStore, scopeForUser} from '../../../../../../lib/server/access';
import {serverSecret} from '../../../../../../lib/server/secrets';
import {createAutobrushMotionConnectionHandlers} from '../../../../../../lib/server/autobrush-motion-connection';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
export const GET = createAutobrushMotionConnectionHandlers({scope: scopeForUser, store: getStore, secret: serverSecret}).connect;
