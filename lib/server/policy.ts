import type {AccessScope} from '../analytics/contracts';
export function authorize(scope:AccessScope|null,clientId?:string,admin=false):AccessScope {
  if(!scope)throw new Error('Sign in required');
  if(clientId&&!scope.permittedClientIds.includes(clientId))throw new Error('Client access denied');
  if(admin&&scope.role!=='admin')throw new Error('Administrator access required');
  return scope;
}
export function checkOrigin(request:Request,publicOrigin?:string) {const origin=request.headers.get('origin'),expected=new URL(publicOrigin||request.url).origin;if(origin&&origin!==expected)throw new Error('Origin not allowed');}
