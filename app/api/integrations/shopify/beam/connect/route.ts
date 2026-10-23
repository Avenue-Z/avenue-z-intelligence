import {getStore,scopeForUser} from '@/lib/server/access';
import {serverSecret} from '@/lib/server/secrets';
import {createShopifyConnectionHandlers} from '@/lib/server/shopify-connection';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=30;
export const GET=createShopifyConnectionHandlers({scope:scopeForUser,store:getStore,secret:serverSecret}).connect;
