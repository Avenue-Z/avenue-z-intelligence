import {getStore} from '../../../../lib/server/access';
import {serverSecret} from '../../../../lib/server/secrets';
import {receiveRechargeWebhook} from '../../../../lib/server/recharge-webhook';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
export async function POST(request:Request){return receiveRechargeWebhook(request,{store:getStore,organizationId:serverSecret('APP_ORGANIZATION_ID')||'avenue-z',clientSecret:serverSecret('RECHARGE_WEBHOOK_CLIENT_SECRET'),storeDomain:serverSecret('RECHARGE_WEBHOOK_STORE_DOMAIN')});}
