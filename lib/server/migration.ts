import type {Store} from './store';
export const migrationTables=['organizations','clients','members','member_identities','connections','qualifications','snapshots','observations','current_snapshots','notes','findings','reviews','audit','ai_requests','ai_turns'] as const;
export async function migrationPage(store:Store,org:string,table:string,cursor=0){
 if(!migrationTables.includes(table as typeof migrationTables[number]))throw new Error('Unsupported migration table');
 if(!Number.isSafeInteger(cursor)||cursor<0||cursor>1000000)throw new Error('Invalid migration cursor');
 const current="EXISTS(SELECT 1 FROM current_snapshots c WHERE c.organizationId=? AND c.snapshotId=t.id)";
 const where=table==='observations'?"EXISTS(SELECT 1 FROM current_snapshots c WHERE c.organizationId=? AND c.snapshotId=t.snapshotId AND c.date=t.date)":table==='snapshots'?`t.organizationId=? AND ${current}`:table==='organizations'?'t.id=?':'t.organizationId=?';
 const args=table==='snapshots'?[org,org]:[org];
 const rows=await store.all<Record<string,unknown>>(`SELECT t.* FROM ${table} t WHERE ${where} ORDER BY t.rowid LIMIT 501 OFFSET ?`,...args,cursor);
 const page=rows.slice(0,500);return {table,rows:page,nextCursor:rows.length>500?cursor+500:null};
}
