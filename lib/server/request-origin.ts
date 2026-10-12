import {runtimePlatform} from '@avenue/runtime';
import {serverSecret} from './secrets';
import {checkOrigin} from './policy';
export function checkApplicationOrigin(request:Request){
 const configured=runtimePlatform==='vercel'?serverSecret('AUTH_URL'):undefined;
 if(runtimePlatform==='vercel'&&!configured)throw new Error('Application origin is not configured');
 checkOrigin(request,configured??undefined);
}
