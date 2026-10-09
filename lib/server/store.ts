import type {Client,Connection,Observation,SourceBatch,Review,Finding,QueryFilters} from '../analytics/contracts';
import {shiftDate} from '../analytics/windows';
import {preferredObservations} from '../analytics/source-precedence';
type Db={prepare:(sql:string)=>any;batch:(statements:any[])=>Promise<any[]>};
export class Store {
  constructor(public db:Db){}
  async all<T=any>(sql:string,...values:unknown[]):Promise<T[]> {return (await this.db.prepare(sql).bind(...values).all()).results;}
  async first<T=any>(sql:string,...values:unknown[]):Promise<T|null> {return this.db.prepare(sql).bind(...values).first();}
  async run(sql:string,...values:unknown[]) {return this.db.prepare(sql).bind(...values).run();}
  async clients(org:string):Promise<Client[]> {return (await this.all('SELECT * FROM clients WHERE organizationId=? ORDER BY name',org)).map(r=>({...r,config:JSON.parse(r.config)}));}
  async connections(org:string,clientId?:string):Promise<Connection[]> {return (await this.all('SELECT * FROM connections WHERE organizationId=?'+(clientId?' AND clientId=?':''),...clientId?[org,clientId]:[org])).map(r=>({...r,enabled:!!r.enabled}));}
  async observations(org:string,client:string,filters?:QueryFilters,headlinesOnly=false):Promise<Observation[]> {
    let clause='',values:unknown[]=[org,client];
    if(filters){const days=Math.round((Date.parse(filters.to)-Date.parse(filters.from))/86400000)+1,offset=filters.compare==='weekday'?7:filters.compare==='fourWeeks'?28:days,priorFrom=shiftDate(filters.from,-offset),priorTo=shiftDate(filters.to,-offset),trendFrom=shiftDate(filters.to,-29),overviewFrom=priorFrom<trendFrom?priorFrom:trendFrom;
      // Keep headline history and renewal benchmarks; load bulky detail exports
      // only for the selected, comparison and prior-week periods.
      clause=` AND ((json_extract(o.payload,'$.dataset')='overview' AND o.date>=? AND o.date<=?) OR json_extract(o.payload,'$.dataset')='subscriptions' OR json_extract(o.payload,'$.metric') IN ('active_ads','active_creatives') OR (o.date BETWEEN ? AND ?) OR (o.date BETWEEN ? AND ?) OR (o.date BETWEEN ? AND ?))`;
      values.push(overviewFrom,filters.to,filters.from,filters.to,priorFrom,priorTo,shiftDate(filters.from,-7),shiftDate(filters.to,-7));
    }
    if(headlinesOnly)clause+=" AND json_extract(o.payload,'$.dataset')='overview'";
    return preferredObservations((await this.all(`SELECT o.payload FROM observations o JOIN current_snapshots c ON c.snapshotId=o.snapshotId AND c.date=o.date JOIN snapshots s ON s.id=o.snapshotId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready'${clause}`,...values)).map(r=>JSON.parse(r.payload)));
  }
  async persistBatch(org:string,source:string,batch:SourceBatch,key:string,now:string,window?:{from:string;to:string}) {
    const id=`${org}:${batch.clientId}:${source}:${key}`;
    const ready=await this.first('SELECT id FROM snapshots WHERE id=? AND status=?',id,'ready');
    await this.run('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,org,batch.clientId,source,now,batch.coverageThrough,Number(batch.complete),'writing',`snapshots/${id}.json`);
    const rows=batch.rows.map(r=>({...r,channels:batch.channels,sourceId:source,retrievedAt:now,coverageThrough:batch.coverageThrough,quality:batch.complete?(r.quality??'complete'):(r.quality==='historical'?'historical':'partial')}));
    if(!ready)for(let n=0;n<rows.length;n+=500){const values=rows.slice(n,n+500).map(r=>({date:r.date,rowKey:JSON.stringify([r.dataset,r.metric,r.start,r.end,Object.entries(r.dimensions).sort()]),payload:JSON.stringify(r)}));await this.run("INSERT INTO observations(snapshotId,date,rowKey,payload) SELECT ?,json_extract(value,'$.date'),json_extract(value,'$.rowKey'),json_extract(value,'$.payload') FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING",id,JSON.stringify(values));}
    const dates=window?(()=>{const d:string[]=[];for(let s=window.from;s<=window.to;s=shiftDate(s,1)){d.push(s);if(d.length>62)throw new Error('Window exceeds 62 days');}return d;})():[...new Set(rows.map(r=>r.date))];
    const pointers=dates.map(d=>this.db.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId,publishedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(organizationId,clientId,sourceId,date) DO UPDATE SET snapshotId=excluded.snapshotId,publishedAt=excluded.publishedAt WHERE excluded.publishedAt>=current_snapshots.publishedAt').bind(org,batch.clientId,source,d,id,now));
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
    const current=await this.first('SELECT * FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND current=1',org,client,date);
    if(current?.fingerprint===fingerprint||current?.createdAt>now)return current.id;
    const id=`${org}:${client}:${date}:${fingerprint}:${current?.revision??0}`;
    await this.db.batch([
      this.db.prepare('UPDATE reviews SET current=0 WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt<=? AND NOT EXISTS(SELECT 1 FROM reviews WHERE id=?) AND NOT EXISTS(SELECT 1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt>?)').bind(org,client,date,now,id,org,client,date,now),
      this.db.prepare('INSERT INTO reviews(id,organizationId,clientId,storeDate,revision,fingerprint,payload,createdAt,current) SELECT ?,?,?,?,COALESCE(MAX(revision),0)+1,?,?,?,1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? HAVING NOT EXISTS(SELECT 1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt>?) ON CONFLICT DO NOTHING').bind(id,org,client,date,fingerprint,JSON.stringify(payload),now,org,client,date,org,client,date,now)
    ]);return id;
  }
  async saveQualification(org:string,client:string,source:string,connectionVersion:number,clientVersion:number,payload:unknown,actor:string){await this.run('INSERT INTO qualifications(organizationId,clientId,sourceId,connectionVersion,clientVersion,version,payload,actorId,createdAt) SELECT ?,?,?,?,?,COALESCE(MAX(version),0)+1,?,?,? FROM qualifications WHERE organizationId=? AND sourceId=?',org,client,source,connectionVersion,clientVersion,JSON.stringify(payload),actor,new Date().toISOString(),org,source);}
  async qualification(org:string,source:string){const r=await this.first('SELECT * FROM qualifications WHERE organizationId=? AND sourceId=? ORDER BY version DESC LIMIT 1',org,source);return r?{...r,payload:JSON.parse(r.payload)}:null;}
  async reviews(org:string,client:string):Promise<Review[]>{return (await this.all('SELECT * FROM reviews WHERE organizationId=? AND clientId=? ORDER BY storeDate DESC,revision DESC LIMIT 365',org,client)).map(r=>({...r,current:!!r.current,payload:JSON.parse(r.payload)}));}
  async findings(org:string,client:string):Promise<Finding[]>{return (await this.all('SELECT * FROM findings WHERE organizationId=? AND clientId=? ORDER BY updatedAt DESC',org,client)).map(r=>({...JSON.parse(r.payload),id:r.id,clientId:r.clientId,version:r.version,updatedAt:r.updatedAt}));}
  async saveFinding(org:string,client:string,input:Partial<Finding>,actor:string,expected:number){const signal=input.evidence?.find(x=>x.startsWith('signal:'));const id=input.id??(signal?`${org}:${client}:${signal}`:crypto.randomUUID()),now=new Date().toISOString();const payload=JSON.stringify({...input,id,clientId:client});let r;
    if(expected===0)r=await this.run('INSERT INTO findings(id,organizationId,clientId,payload,version,updatedAt) VALUES(?,?,?,?,1,?) ON CONFLICT DO NOTHING',id,org,client,payload,now);
    else r=await this.run('UPDATE findings SET payload=?,version=version+1,updatedAt=? WHERE id=? AND organizationId=? AND clientId=? AND version=?',payload,now,id,org,client,expected);
    if(!r.meta.changes)throw new Error('Changed by another teammate');await this.audit(org,client,actor,'finding.updated',input);return id;}
  async enqueue(org:string,client:string,source:string,bucket:string,now:string){await this.run('INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt) VALUES(?,?,?,?,?,0,?) ON CONFLICT DO NOTHING',`${org}:${source}:${bucket}`,org,client,source,'pending',now);}
  async claim(now:string,org:string,permittedClientIds?:string[]){if(permittedClientIds?.length===0)return null;const clause=permittedClientIds?' AND clientId IN ('+permittedClientIds.map(()=>'?').join(',')+')':'';const r=await this.first(`SELECT * FROM jobs WHERE organizationId=?${clause} AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?)) ORDER BY dueAt LIMIT 1`,org,...permittedClientIds??[],now,now);if(!r)return null;const leaseUntil=new Date(Date.parse(now)+300000).toISOString();const result=await this.run(`UPDATE jobs SET status='running',leaseUntil=?,attempts=attempts+1 WHERE id=? AND organizationId=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?))`,leaseUntil,r.id,org,now,now);return result.meta.changes?{...r,leaseUntil,attempts:r.attempts+1}:null;}
  async retry(id:string,attempts:number,error:string,now:string){const dueAt=new Date(Date.parse(now)+Math.min(30,2**attempts)*60000).toISOString();await this.run('UPDATE jobs SET status=?,dueAt=?,error=?,leaseUntil=NULL WHERE id=?',attempts>=3?'failed':'pending',dueAt,error,id);}
  async finish(id:string,error?:string){await this.run('UPDATE jobs SET status=?,error=?,leaseUntil=NULL WHERE id=?',error?'failed':'complete',error??null,id);}
  async jobs(org:string){return this.all('SELECT * FROM jobs WHERE organizationId=? ORDER BY dueAt DESC LIMIT 30',org);}
}
