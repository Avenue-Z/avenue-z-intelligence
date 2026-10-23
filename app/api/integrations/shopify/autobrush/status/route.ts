import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createAutobrushShopifyConnectionHandlers} from '@/lib/server/autobrush-shopify-connection';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createAutobrushShopifyConnectionHandlers({scope:scopeForUser,store:getStore,secret:serverSecret}).status;
