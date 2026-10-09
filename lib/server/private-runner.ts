import {getChatGPTUser} from '../../app/chatgpt-auth';
import {scopeForUser} from './access';
import {serverSecret} from './secrets';
import type {AccessScope} from '../analytics/contracts';
// Native Sites dispatch admits service calls only with its Site-bound bearer.
// This switch is enabled only for the confirmed owner-private publication.
export async function privateRunnerScope():Promise<AccessScope>{
 if(serverSecret('PRIVATE_SITE_RUNNER_ENABLED')!=='true')throw new Error('Private-site runner is disabled');
 const [identity,visitor]=await Promise.all([getChatGPTUser(),scopeForUser()]);
 if(identity&&!visitor)throw new Error('Workspace membership required');
 if(visitor){if(visitor.role!=='admin'||!visitor.permittedClientIds.includes('kind-patches'))throw new Error('Administrator access required');return {...visitor,permittedClientIds:['kind-patches']};}
 return {organizationId:'avenue-z',actorId:'private-site-runner',role:'admin',permittedClientIds:['kind-patches']};
}
