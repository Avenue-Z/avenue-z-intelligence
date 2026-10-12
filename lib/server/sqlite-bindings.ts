import type {Client,InValue,ResultSet} from '@libsql/client';
type Statement={sql:string;args:InValue[];bind:(...values:unknown[])=>Statement;all:()=>Promise<{results:Record<string,unknown>[]}>;first:()=>Promise<Record<string,unknown>|null>;run:()=>Promise<{meta:{changes:number}}>};
const rows=(r:ResultSet)=>r.rows.map(row=>Object.fromEntries(r.columns.map((key,i)=>[key,row[i]])));
export function sqliteBindings(client:Client){
 const prepare=(sql:string):Statement=>{
  const statement:Statement={sql,args:[],bind(...values){return {...statement,args:values as InValue[],all:async()=>({results:rows(await client.execute({sql,args:values as InValue[]}))}),first:async()=>rows(await client.execute({sql,args:values as InValue[]}))[0]??null,run:async()=>({meta:{changes:(await client.execute({sql,args:values as InValue[]})).rowsAffected}})};},async all(){return {results:rows(await client.execute(sql))};},async first(){return rows(await client.execute(sql))[0]??null;},async run(){return {meta:{changes:(await client.execute(sql)).rowsAffected}};}};
  return statement;
 };
 return {prepare,async batch(statements:Statement[]){return (await client.batch(statements.map(s=>({sql:s.sql,args:s.args})),'write')).map(r=>({results:rows(r),meta:{changes:r.rowsAffected}}));}};
}
