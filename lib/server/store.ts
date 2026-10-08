import type {Client,Connection,Observation,SourceBatch,Review,Finding} from '../analytics/contracts';
import {shiftDate} from '../analytics/windows';
type Db={prepare:(sql:string)=>any;batch:(statements:any[])=>Promise<any[]>};
export class Store {
  constructor(public db:Db){}
  async all<T=any>(sql:string,...values:unknown[]):Promise<T[]> {return (await this.db.prepare(sql).bind(...values).all()).results;}
  async first<T=any>(sql:string,...values:unknown[]):Promise<T|null> {return this.db.prepare(sql).bind(...values).first();}
  async run(sql:string,...values:unknown[]) {return this.db.prepare(sql).bind(...values).run();}
  async clients(org:string):Promise<Client[]> {return (await this.all('SELECT * FROM clients WHERE organizationId=? ORDER BY name',org)).map(r=>({...r,config:JSON.parse(r.config)}));}
  async connections(org:string,clientId?:string):Promise<Connection[]> {return (await this.all('SELECT * FROM connections WHERE organizationId=?'+(clientId?' AND clientId=?':''),...clientId?[org,clientId]:[org])).map(r=>({...r,enabled:!!r.enabled}));}
  async observations(org:string,client:string):Promise<Observation[]> {return (await this.all(`SELECT o.payload FROM observations o JOIN current_snapshots c ON c.snapshotId=o.snapshotId AND c.date=o.date JOIN snapshots s ON s.id=o.snapshotId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready'`,org,client)).map(r=>JSON.parse(r.payload));}
  async persistBatch(org:string,source:string,batch:SourceBatch,key:string,now:string,window?:{from:string;to:string}) {
    const id=`${org}:${batch.clientId}:${source}:${key}`;
    if(await this.first('SELECT id FROM snapshots WHERE id=? AND status=?',id,'ready'))return id;
    await this.run('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,org,batch.clientId,source,now,batch.coverageThrough,Number(batch.complete),'writing',`snapshots/${id}.json`);
    const rows=batch.rows.map(r=>({...r,sourceId:source,retrievedAt:now,coverageThrough:batch.coverageThrough,quality:r.quality??(batch.complete?'complete':'partial')}));
    for(let n=0;n<rows.length;n+=80)await this.db.batch(rows.slice(n,n+80).map(r=>this.db.prepare('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(id,r.date,JSON.stringify([r.dataset,r.metric,Object.entries(r.dimensions).sort()]),JSON.stringify(r))));
    const dates=window?(()=>{const d:string[]=[];for(let s=window.from;s<=window.to;s=shiftDate(s,1)){d.push(s);if(d.length>62)throw new Error('Window exceeds 62 days');}return d;})():[...new Set(rows.map(r=>r.date))];
    const pointers=dates.map(d=>this.db.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?) ON CONFLICT(organizationId,clientId,sourceId,date) DO UPDATE SET snapshotId=excluded.snapshotId').bind(org,batch.clientId,source,d,id));
    await this.db.batch([...pointers,this.db.prepare('UPDATE snapshots SET status=? WHERE id=?').bind('ready',id)]);return id;
  }
  async note(org:string,client:string) {return await this.first('SELECT * FROM notes WHERE organizationId=? AND clientId=?',org,client)??{body:'',version:0};}
  async saveNote(org:string,client:string,body:string,actor:string,expected:number) {
    const now=new Date().toISOString();let r;
    if(expected===0)r=await this.run('INSERT INTO notes(organizationId,clientId,body,actorId,version,updatedAt) VALUES(?,?,?,?,1,?) ON CONFLICT DO NOTHING',org,client,body,actor,now);
    else r=await this.run('UPDATE notes SET body=?,actorId=?,version=version+1,updatedAt=? WHERE organizationId=? AND clientId=? AND version=?',body,actor,now,org,client,expected);
    if(!r.meta.changes)throw new Error('Changed by another teammate; reload before saving');
    await this.audit(org,client,actor,'note.updated',{body,expected});return this.note(org,client);
  }
  async audit(org:string,client:string,actor:string,action:string,payload:unknown){await this.run('INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),org,client,actor,action,JSON.stringify(payload),new Date().toISOString());}
  async saveReview(org:string,client:string,date:string,fingerprint:string,payload:unknown,now:string){
    const id=`${org}:${client}:${date}:${fingerprint}`;
    if(await this.first('SELECT id FROM reviews WHERE id=?',id))return id;
    await this.db.batch([
      this.db.prepare('UPDATE reviews SET current=0 WHERE organizationId=? AND clientId=? AND storeDate=?').bind(org,client,date),
      this.db.prepare('INSERT INTO reviews(id,organizationId,clientId,storeDate,revision,fingerprint,payload,createdAt,current) SELECT ?,?,?,?,COALESCE(MAX(revision),0)+1,?,?,?,1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? ON CONFLICT DO NOTHING').bind(id,org,client,date,fingerprint,JSON.stringify(payload),now,org,client,date)
    ]);return id;
  }
  async reviews(org:string,client:string):Promise<Review[]>{return (await this.all('SELECT * FROM reviews WHERE organizationId=? AND clientId=? ORDER BY storeDate DESC,revision DESC LIMIT 365',org,client)).map(r=>({...r,current:!!r.current,payload:JSON.parse(r.payload)}));}
  async findings(org:string,client:string):Promise<Finding[]>{return (await this.all('SELECT * FROM findings WHERE organizationId=? AND clientId=? ORDER BY updatedAt DESC',org,client)).map(r=>({...JSON.parse(r.payload),id:r.id,clientId:r.clientId,version:r.version,updatedAt:r.updatedAt}));}
  async saveFinding(org:string,client:string,input:Partial<Finding>,actor:string,expected:number){const id=input.id??crypto.randomUUID(),now=new Date().toISOString();const payload=JSON.stringify({...input,id,clientId:client});let r;
    if(expected===0)r=await this.run('INSERT INTO findings(id,organizationId,clientId,payload,version,updatedAt) VALUES(?,?,?,?,1,?) ON CONFLICT DO NOTHING',id,org,client,payload,now);
    else r=await this.run('UPDATE findings SET payload=?,version=version+1,updatedAt=? WHERE id=? AND organizationId=? AND clientId=? AND version=?',payload,now,id,org,client,expected);
    if(!r.meta.changes)throw new Error('Changed by another teammate');await this.audit(org,client,actor,'finding.updated',input);return id;}
  async enqueue(org:string,client:string,source:string,bucket:string,now:string){await this.run('INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt) VALUES(?,?,?,?,?,0,?) ON CONFLICT DO NOTHING',`${org}:${source}:${bucket}`,org,client,source,'pending',now);}
  async claim(now:string){const r=await this.first(`SELECT * FROM jobs WHERE (status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?) ORDER BY dueAt LIMIT 1`,now,now);if(!r)return null;const leaseUntil=new Date(Date.parse(now)+300000).toISOString();const result=await this.run(`UPDATE jobs SET status='running',leaseUntil=?,attempts=attempts+1 WHERE id=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?))`,leaseUntil,r.id,now,now);return result.meta.changes?{...r,leaseUntil,attempts:r.attempts+1}:null;}
  async finish(id:string,error?:string){await this.run('UPDATE jobs SET status=?,error=?,leaseUntil=NULL WHERE id=?',error?'failed':'complete',error??null,id);}
  async jobs(org:string){return this.all('SELECT * FROM jobs WHERE organizationId=? ORDER BY dueAt DESC LIMIT 30',org);}
}
