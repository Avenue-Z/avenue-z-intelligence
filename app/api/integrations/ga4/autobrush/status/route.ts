import {getStore, scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createAutobrushGa4ConnectionHandlers} from '@/lib/server/autobrush-ga4-connection';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
export const GET = createAutobrushGa4ConnectionHandlers({scope: scopeForUser, store: getStore, secret: serverSecret}).status;
