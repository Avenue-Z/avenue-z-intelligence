import {it,expect} from 'vitest';
import {selectSharedDatabase} from '../../lib/server/shared-database';
it('keeps the preview binding until both independent service credentials are configured',()=>{
 const local={prepare:()=>({})};expect(selectSharedDatabase({DB:local},()=>{throw Error('unexpected');})).toBe(local);
 expect(()=>selectSharedDatabase({DB:local,TURSO_DATABASE_URL:'libsql://team.db'},()=>local)).toThrow('credential');
 let input:unknown;expect(selectSharedDatabase({DB:local,TURSO_DATABASE_URL:'libsql://team.db',TURSO_AUTH_TOKEN:'service'},v=>{input=v;return local;})).toBe(local);expect(input).toEqual({url:'libsql://team.db',authToken:'service'});
});
