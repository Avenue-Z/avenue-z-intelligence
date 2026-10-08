import type {AccessScope} from '../analytics/contracts';
export function authorize(scope:AccessScope|null,clientId?:string,admin=false):AccessScope {
  if(!scope)throw new Error('Sign in required');
  if(clientId&&!scope.permittedClientIds.includes(clientId))throw new Error('Client access denied');
  if(admin&&scope.role!=='admin')throw new Error('Administrator access required');
  return scope;
}
export function checkOrigin(request:Request) {const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new Error('Origin not allowed');}
