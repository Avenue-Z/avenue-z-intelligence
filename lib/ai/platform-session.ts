import {loadAISession} from './session';
import {fingerprint} from '../reviews/build';
import type {AccessScope,QueryFilters} from '../analytics/contracts';
import type {Store} from '../server/store';
export const PLATFORM_CHAT_VERSION='avenuez-platform-chat-v1';
/** A conversation follows its actor across screens. A changed grant set gets
 * a new key, so history cannot reveal a brand that is no longer permitted. */
export async function loadPlatformSession(clientId:string|undefined,filters:QueryFilters,reviewId?:string,scope?:AccessScope,store?:Store){
 const starting=await loadAISession(clientId,filters,reviewId,scope,store);
 const records=(await starting.s.clients(starting.scope.organizationId)).filter(client=>starting.scope.permittedClientIds.includes(client.id));
 const scopeKey=await fingerprint({version:PLATFORM_CHAT_VERSION,clientIds:records.map(client=>client.id).sort()});
 return {...starting,scopeKey,clients:records.map(client=>client.name),records};
}
export async function platformSessionHistory(session:Awaited<ReturnType<typeof loadPlatformSession>>){
 const {s,scope,scopeKey}=session;
 return (await s.all('SELECT * FROM ai_turns WHERE organizationId=? AND actorId=? AND scopeKey=? ORDER BY createdAt DESC LIMIT 20',scope.organizationId,scope.actorId,scopeKey)).reverse().map(turn=>({...turn,payload:JSON.parse(turn.payload)}));
}
