export function selectSharedDatabase<T>(bindings:{DB:T;TURSO_DATABASE_URL?:unknown;TURSO_AUTH_TOKEN?:unknown},create:(input:{url:string;authToken:string})=>T):T{
 const url=bindings.TURSO_DATABASE_URL,token=bindings.TURSO_AUTH_TOKEN;
 if(!url&&!token)return bindings.DB;
 if(typeof url!=='string'||!url||typeof token!=='string'||!token)throw new Error('Shared database service credential is not configured');
 return create({url,authToken:token});
}
