import type {Client,Connection,Observation,SourceBatch,Review,Finding,QueryFilters} from '../analytics/contracts';
import {shiftDate,dayWindow,matchedCutoff,comparisonPeriod,todayIn} from '../analytics/windows';
import {preferredObservations} from '../analytics/source-precedence';
import {FunnelRollupAccumulator} from '../analytics/funnel-rollup';
import {Temporal} from '@js-temporal/polyfill';
import {QueryCache} from './query-cache';
import {observationCodec} from './observation-codec';
import {durableObservationPayload} from './durable-observation-cache';
type Db={prepare:(sql:string)=>any;batch:(statements:any[])=>Promise<any[]>;allowCrossRequestCoalescing?:boolean};
// Vercel reuses a warm adapter; Sites owns a fresh adapter per Store. This
// optional memory cache stays isolated while the durable cache is shared.
const observationCaches=new WeakMap<Db,QueryCache<Observation[]>>();
function observationCache(db:Db){let cache=observationCaches.get(db);if(!cache){cache=new QueryCache({ttlMs:60000,maxEntries:16,maxBytes:16*1024*1024,maxEntryBytes:12*1024*1024,coalesce:db.allowCrossRequestCoalescing!==false},observationCodec);observationCaches.set(db,cache);}return cache;}
export type ScheduledReviewLease={id:string;leaseToken:string};
export class Store {
  constructor(public db:Db){}
  async all<T=any>(sql:string,...values:unknown[]):Promise<T[]> {return (await this.db.prepare(sql).bind(...values).all()).results;}
  async first<T=any>(sql:string,...values:unknown[]):Promise<T|null> {return this.db.prepare(sql).bind(...values).first();}
  async run(sql:string,...values:unknown[]) {return this.db.prepare(sql).bind(...values).run();}
  async clients(org:string):Promise<Client[]> {return (await this.all('SELECT * FROM clients WHERE organizationId=? ORDER BY name',org)).map(r=>({...r,config:JSON.parse(r.config)}));}
  async connections(org:string,clientId?:string):Promise<Connection[]> {return (await this.all('SELECT * FROM connections WHERE organizationId=?'+(clientId?' AND clientId=?':''),...clientId?[org,clientId]:[org])).map(r=>({...r,enabled:!!r.enabled}));}
  async observations(org:string,client:string,filters?:QueryFilters,headlinesOnly=false,options?:{deadline:number},selection?:{datasets:string[];dimensions?:boolean}):Promise<Observation[]> {
    const checkBudget=()=>{if(options&&Date.now()>=options.deadline)throw Error('Observation cache warm budget elapsed');};
    const readPage=async<T>(sql:string,...values:unknown[])=>{checkBudget();const rows=await this.all<T>(sql,...values);checkBudget();return rows;};
    checkBudget();
    const [capturedPointers,clientRow,sources,qualifications]=await Promise.all([
      this.all<{snapshotId:string;sourceId:string;date:string;publishedAt:string}>("SELECT c.snapshotId,c.sourceId,c.date,c.publishedAt FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready'",org,client),
      this.first<{timezone:string}>('SELECT timezone FROM clients WHERE organizationId=? AND id=?',org,client),
      filters?.mode==='partial'?this.connections(org,client):Promise.resolve([]),
      filters||headlinesOnly||selection?this.all<{sourceId:string;profiles:string|null}>("SELECT sourceId,json_extract(payload,'$.profiles') AS profiles FROM qualifications WHERE organizationId=? AND clientId=?",org,client):Promise.resolve([])
    ]);
    checkBudget();
    if(!capturedPointers.length)return [];
    let clause='',values:unknown[]=[],overviewWindow:[string,string]|undefined,marketWindow:[string,string]|undefined;
    const detailWindows:[string,string][]=[];let subscriptionTo:string|undefined;
    if(filters){const comparison=comparisonPeriod(filters),priorFrom=comparison.from,priorTo=comparison.to,trendFrom=shiftDate(filters.to,-29),overviewFrom=priorFrom<trendFrom?priorFrom:trendFrom;
      // Keep headline history and renewal benchmarks; load bulky detail exports
      // only for the selected, comparison and prior-week periods.
      clause=` AND ((json_extract(o.payload,'$.dataset')='overview' AND o.date>=? AND o.date<=?) OR (json_extract(o.payload,'$.dataset')='subscriptions' AND o.date<=?) OR (json_extract(o.payload,'$.dataset')='markets' AND o.date>=? AND o.date<=?) OR json_extract(o.payload,'$.metric') IN ('active_ads','active_creatives') OR (o.date BETWEEN ? AND ?) OR (o.date BETWEEN ? AND ?) OR (o.date BETWEEN ? AND ?))`;
      overviewWindow=[overviewFrom,filters.to];detailWindows.push([filters.from,filters.to],[priorFrom,priorTo],[shiftDate(filters.from,-7),shiftDate(filters.to,-7)]);
      marketWindow=[shiftDate(filters.from,-1),filters.to];
      subscriptionTo=[filters.to,priorTo].sort().at(-1);
      values.push(overviewFrom,filters.to,subscriptionTo,shiftDate(filters.from,-1),filters.to,...detailWindows.flat());
    }
    if(headlinesOnly)clause+=" AND json_extract(o.payload,'$.dataset')='overview'";
    const selectedDatasets=selection?[...new Set(selection.datasets)].sort():null,dimensionSelection:Record<string,string>={};let selectionClause='',selectionValues:unknown[]=[];
    // For IN selections SQLite otherwise favors the row-key ordering index and
    // decodes every dataset in the snapshot/day. Seek the selected datasets first.
    const selectionIndex=selectedDatasets?.length?' INDEXED BY idx_observations_snapshot_date_dataset_rowkey':'';
    if(selectedDatasets){selectionClause+=selectedDatasets.length?` AND json_extract(o.payload,'$.dataset') IN (${selectedDatasets.map(()=>'?').join(',')})`:' AND 0';selectionValues.push(...selectedDatasets);
      if(selection?.dimensions&&filters)for(const dimension of ['market','stream','source','device','page'] as const){const value=filters[dimension];if(!value)continue;dimensionSelection[dimension]=value;const aliases=[value];
        if(dimension==='market'&&/^[A-Z]{2}$/.test(value)){const name=new Intl.DisplayNames(['en'],{type:'region',fallback:'code'}).of(value==='UK'?'GB':value);if(name&&name!==value)aliases.push(name);if(value==='UK')aliases.push('GB');}
        selectionClause+=` AND (json_extract(o.payload,'$.dimensions.${dimension}') IN (${aliases.map(()=>'?').join(',')}) OR json_type(o.payload,'$.dimensions.${dimension}') IS NULL)`;selectionValues.push(...aliases);
      }
      clause+=selectionClause;values.push(...selectionValues);
    }

    // Registered sources reject observations outside their metric profiles.
    // Use the union of every historical qualification, not only the latest,
    // so changing a contract cannot hide older renewal/inventory rows. Sources
    // without a complete profile history (including archives) stay conservative.
    const profiles=new Map<string,{dataset:string;metric:string}[]|null>();
    for(const qualification of qualifications){
      let registered:unknown;try{registered=JSON.parse(qualification.profiles??'null');}catch{registered=null;}
      if(!Array.isArray(registered)||!registered.length||registered.some(p=>!p||typeof p.dataset!=='string'||typeof p.metric!=='string')){profiles.set(qualification.sourceId,null);continue;}
      if(profiles.get(qualification.sourceId)===null)continue;
      profiles.set(qualification.sourceId,[...profiles.get(qualification.sourceId)??[],...registered]);
    }
    const inWindow=(date:string,window:[string,string])=>date>=window[0]&&date<=window[1];
    const selectedPointers=capturedPointers.filter(pointer=>{
      const registered=profiles.get(pointer.sourceId);if(!registered)return true;
      return registered.some(profile=>{
        if(selectedDatasets&&!selectedDatasets.includes(profile.dataset))return false;
        if(headlinesOnly&&profile.dataset!=='overview')return false;
        if(!filters)return true;
        return (profile.dataset==='subscriptions'&&(!subscriptionTo||pointer.date<=subscriptionTo))||['active_ads','active_creatives'].includes(profile.metric)||
          (profile.dataset==='overview'&&!!overviewWindow&&inWindow(pointer.date,overviewWindow))||
          (profile.dataset==='markets'&&!!marketWindow&&inWindow(pointer.date,marketWindow))||detailWindows.some(window=>inWindow(pointer.date,window));
      });
    });
    const operationalMetrics=new Set(['active_customers','active_ads','active_creatives']);
    const operationalSources=new Set([...profiles].filter(([,registered])=>registered?.length&&registered.every(profile=>operationalMetrics.has(profile.metric))).map(([sourceId])=>sourceId));
    const operationalPointers=headlinesOnly?[]:capturedPointers.filter(pointer=>operationalSources.has(pointer.sourceId));
    const latestOperationalDates=new Map<string,string>();for(const pointer of operationalPointers){const prior=latestOperationalDates.get(pointer.sourceId);if(!prior||pointer.date>prior)latestOperationalDates.set(pointer.sourceId,pointer.date);}
    const freshOperationalPointers=operationalPointers.filter(pointer=>pointer.date===latestOperationalDates.get(pointer.sourceId));
    const pointers=selectedPointers.filter(pointer=>!operationalSources.has(pointer.sourceId));
    let cutoffClock:string|undefined;
    if(clientRow&&filters?.mode==='partial'){const contributing=sources.filter(c=>c.enabled&&(!c.provider||c.provider==='gateway'||c.provider==='kind-triple-whale'||c.provider==='kind-shopify-hourly')),coverage=contributing.map(c=>c.coverageThrough),known=contributing.length>0&&coverage.every((x):x is string=>!!x&&Date.parse(x)>=Date.parse(dayWindow(filters.to,clientRow.timezone).start));const cutoff=known?matchedCutoff(coverage as string[],clientRow.timezone):null;if(cutoff)cutoffClock=Temporal.Instant.from(cutoff).toZonedDateTimeISO(clientRow.timezone).toPlainTime().toString();}
    // Observation loading deliberately retains every dataset/dimension for
    // queryClient's unsupported-filter checks, peers and navigation. View and
    // dimension selections therefore share rows, while load-affecting filters
    // and fresh metadata are part of the key. Published pointers invalidate
    // across refreshes, including refreshes performed by another instance.
    const version=pointers.map(p=>[p.sourceId,p.snapshotId,p.date]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const key=JSON.stringify(['chart-series-v3',org,client,filters?[filters.from,filters.to,filters.compare,filters.compareFrom??null,filters.compareTo??null,filters.mode]:null,headlinesOnly,clientRow?.timezone??null,cutoffClock??null,...selection?[{datasets:selectedDatasets,dimensions:!!selection.dimensions,filters:dimensionSelection}]:[],version]);
    const load=()=>durableObservationPayload(this.db,org,client,key,async()=>{
    checkBudget();
    // Missing partial coverage must retain raw hourly rows so queryClient can
    // decline the comparison; it must never turn a full day into a partial day.
    const accumulator=clientRow&&(!filters||filters.mode==='closed'||cutoffClock)?new FunnelRollupAccumulator({timezone:clientRow.timezone,cutoffClock}):null;
    const rows:Observation[]=[];
    const add=(page:{payload:string}[])=>{for(const r of page){const row=JSON.parse(r.payload);if(accumulator)accumulator.add(row);else rows.push(row);}};
    // Seek within each captured snapshot/date using the primary key. Sorting
    // the entire source set again for every page made large exports quadratic.
    const readPointer=async(pointer:typeof pointers[number],cursor:string|null=null)=>{for(;;){const page=await readPage<{payload:string;rowKey:string}>(`SELECT o.payload,o.rowKey FROM observations o${selectionIndex} WHERE o.snapshotId=? AND o.date=?${clause}${cursor?' AND o.rowKey>?':''} ORDER BY o.rowKey LIMIT 2000`,pointer.snapshotId,pointer.date,...values,...cursor?[cursor]:[]);add(page);if(page.length<2000)return;cursor=page[page.length-1].rowKey;}};
    const history:typeof pointers=[],groups:(typeof pointers)[]=[];
    for(const pointer of pointers){if(filters&&!detailWindows.some(window=>inWindow(pointer.date,window))||headlinesOnly)history.push(pointer);else groups.push([pointer]);}
    for(let index=0;index<history.length;index+=16)groups.push(history.slice(index,index+16));
    let nextGroup=0;
    const read=async()=>{for(;;){const group=groups[nextGroup++];if(!group)return;
      if(group.length===1){await readPointer(group[0]);continue;}
      // Constrained history normally fits one response. If it overflows, do
      // not repeat the grouped sort: resume that pointer with its primary-key
      // cursor and read subsequent pointers individually. Captured ids retain
      // snapshot consistency even if a source refresh publishes during I/O.
      const page=await readPage<{payload:string;rowKey:string;pointerIndex:number}>(`SELECT o.payload,o.rowKey,CAST(p.key AS INTEGER) AS pointerIndex FROM json_each(?) p JOIN observations o${selectionIndex} ON o.snapshotId=json_extract(p.value,'$.snapshotId') AND o.date=json_extract(p.value,'$.date') WHERE 1=1${clause} ORDER BY CAST(p.key AS INTEGER),o.rowKey LIMIT 2000`,JSON.stringify(group),...values);
      add(page);if(page.length<2000)continue;
      const last=page[page.length-1];await readPointer(group[last.pointerIndex],last.rowKey);
      for(let index=last.pointerIndex+1;index<group.length;index++)await readPointer(group[index]);
    }};
    await Promise.all(Array.from({length:Math.min(4,groups.length)},()=>read()));
    const stable=(accumulator?accumulator.finish():rows).map(row=>({row,key:JSON.stringify([row.sourceId,row.date,row.dataset,row.metric,row.definition,row.population,row.currency,row.start,row.end,Object.entries(row.dimensions).sort(),row.retrievedAt,row.quality])})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(x=>x.row);
    checkBudget();return observationCodec.encode(preferredObservations(stable));
    },options?.deadline);
    // A warming deadline must never cancel a browser request coalesced on the
    // same key. Warming populates durable storage without joining that promise.
    const [cached,operations]=await Promise.all([pointers.length?(options?load().then(payload=>observationCodec.decode(payload)):observationCache(this.db).getEncoded(key,load)):Promise.resolve([]),
      freshOperationalPointers.length?readPage<{payload:string}>(`SELECT json_extract(o.payload,'$') AS payload FROM json_each(?) p JOIN observations o ON o.snapshotId=json_extract(p.value,'$.snapshotId') AND o.date=json_extract(p.value,'$.date') WHERE json_extract(o.payload,'$.metric') IN ('active_customers','active_ads','active_creatives') ORDER BY o.date,o.rowKey`,JSON.stringify(freshOperationalPointers)).then(rows=>rows.map(row=>JSON.parse(row.payload) as Observation)):Promise.resolve([])]);
    return operations.length?[...cached,...operations]:cached;
  }
  async persistBatch(org:string,source:string,batch:SourceBatch,key:string,now:string,window?:{from:string;to:string}) {
    const id=`${org}:${batch.clientId}:${source}:${key}`;
    const ready=await this.first('SELECT id FROM snapshots WHERE id=? AND status=?',id,'ready');
    await this.run('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,org,batch.clientId,source,now,batch.coverageThrough,Number(batch.complete),'writing',`snapshots/${id}.json`);
    const rows=batch.rows.map(r=>({...r,channels:batch.channels,sourceId:source,retrievedAt:now,coverageThrough:batch.coverageThrough,quality:batch.complete?(r.quality??'complete'):(r.quality==='historical'?'historical':'partial')}));
    if(!ready)for(let n=0;n<rows.length;n+=2000){const inserts=[];for(let start=n;start<Math.min(n+2000,rows.length);start+=500){const values=rows.slice(start,start+500).map(r=>({date:r.date,rowKey:JSON.stringify([r.dataset,r.metric,r.start,r.end,Object.entries(r.dimensions).sort()]),payload:JSON.stringify(r)}));inserts.push(this.db.prepare("INSERT INTO observations(snapshotId,date,rowKey,payload) SELECT ?,json_extract(value,'$.date'),json_extract(value,'$.rowKey'),json_extract(value,'$.payload') FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING").bind(id,JSON.stringify(values)));}await this.db.batch(inserts);}
    const dates=window?(()=>{const d:string[]=[];for(let s=window.from;s<=window.to;s=shiftDate(s,1)){d.push(s);if(d.length>62)throw new Error('Window exceeds 62 days');}return d;})():[...new Set(rows.map(r=>r.date))];
    const grouped=new Map<string,Observation[]>();for(const row of rows){const values=grouped.get(row.date);if(values)values.push(row);else grouped.set(row.date,[row]);}
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([field,item])=>[field,canonical(item)])):value;
    const pointers=[];let today:string|null=null;try{if(batch.timezone&&Number.isFinite(Date.parse(now)))today=todayIn(batch.timezone,new Date(now));}catch{/* Older unqualified archives retain conservative pointer publication. */}
    for(const date of dates){let dataHash:string|null=null,coveredThrough:string|null=null;
      if(today&&date<today&&batch.coverageThrough){coveredThrough=dayWindow(date,batch.timezone).end;if(Date.parse(batch.coverageThrough)>=Date.parse(coveredThrough)){
        const facts=(grouped.get(date)??[]).map(row=>{const {retrievedAt:_retrieval,coverageThrough:_coverage,...fact}=row;return JSON.stringify(canonical(fact));}).sort();
        const content=JSON.stringify(canonical({date,timezone:batch.timezone,currency:batch.currency,complete:batch.complete,grain:batch.grain,channels:[...(batch.channels??[])].sort(),dimensions:[...(batch.dimensions??[])].sort(),facts}));
        dataHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content))),byte=>byte.toString(16).padStart(2,'0')).join('');
      }}
      // The publication watermark still advances on unchanged facts, preventing
      // delayed older data from replacing the retained immutable snapshot.
      pointers.push(this.db.prepare("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId,publishedAt,dataHash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(organizationId,clientId,sourceId,date) DO UPDATE SET snapshotId=CASE WHEN excluded.dataHash IS NOT NULL AND current_snapshots.dataHash=excluded.dataHash AND EXISTS (SELECT 1 FROM snapshots old WHERE old.id=current_snapshots.snapshotId AND julianday(old.coverageThrough)>=julianday(?)) THEN current_snapshots.snapshotId ELSE excluded.snapshotId END,publishedAt=excluded.publishedAt,dataHash=excluded.dataHash WHERE excluded.publishedAt>=current_snapshots.publishedAt").bind(org,batch.clientId,source,date,id,now,dataHash,coveredThrough));
    }
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
  async saveReview(org:string,client:string,date:string,fingerprint:string,payload:unknown,now:string,job?:ScheduledReviewLease){
    if(job&&!await this.first("SELECT id FROM scheduled_reviews WHERE id=? AND organizationId=? AND clientId=? AND storeDate=? AND leaseToken=? AND status='running'",job.id,org,client,date,job.leaseToken))throw new Error('Review job lease expired');
    const current=await this.first('SELECT * FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND current=1',org,client,date);
    const completion=(id:string)=>this.db.prepare("UPDATE scheduled_reviews SET status='complete',reviewId=?,completedAt=?,error=NULL,leaseToken=NULL,leaseUntil=NULL WHERE id=? AND organizationId=? AND clientId=? AND storeDate=? AND leaseToken=? AND status='running' AND EXISTS(SELECT 1 FROM reviews WHERE id=? AND organizationId=? AND clientId=?)").bind(id,now,job!.id,org,client,date,job!.leaseToken,id,org,client);
    if(current?.fingerprint===fingerprint||current?.createdAt>now){if(job){const r=await completion(current.id).run();if(!r.meta.changes)throw new Error('Review job lease expired');}return current.id;}
    const id=`${org}:${client}:${date}:${fingerprint}:${current?.revision??0}`;
    const guard=job?" AND EXISTS(SELECT 1 FROM scheduled_reviews WHERE id=? AND leaseToken=? AND status='running')":'',guardValues=job?[job.id,job.leaseToken]:[];
    const results=await this.db.batch([
      this.db.prepare('UPDATE reviews SET current=0 WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt<=? AND NOT EXISTS(SELECT 1 FROM reviews WHERE id=?) AND NOT EXISTS(SELECT 1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt>?)'+guard).bind(org,client,date,now,id,org,client,date,now,...guardValues),
      this.db.prepare('INSERT INTO reviews(id,organizationId,clientId,storeDate,revision,fingerprint,payload,createdAt,current) SELECT ?,?,?,?,(SELECT COALESCE(MAX(revision),0)+1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=?),?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND createdAt>?)'+guard+' ON CONFLICT DO NOTHING').bind(id,org,client,date,org,client,date,fingerprint,JSON.stringify(payload),now,org,client,date,now,...guardValues),
      ...(job?[completion(id)]:[])
    ]);if(job&&!results[results.length-1].meta.changes)throw new Error('Review job lease expired or review changed concurrently');return id;
  }
  async saveQualification(org:string,client:string,source:string,connectionVersion:number,clientVersion:number,payload:unknown,actor:string){await this.run('INSERT INTO qualifications(organizationId,clientId,sourceId,connectionVersion,clientVersion,version,payload,actorId,createdAt) SELECT ?,?,?,?,?,COALESCE(MAX(version),0)+1,?,?,? FROM qualifications WHERE organizationId=? AND sourceId=?',org,client,source,connectionVersion,clientVersion,JSON.stringify(payload),actor,new Date().toISOString(),org,source);}
  async qualification(org:string,source:string){const r=await this.first('SELECT * FROM qualifications WHERE organizationId=? AND sourceId=? ORDER BY version DESC LIMIT 1',org,source);return r?{...r,payload:JSON.parse(r.payload)}:null;}
  async reviews(org:string,client:string):Promise<Review[]>{return (await this.all("SELECT id,organizationId,clientId,storeDate,revision,fingerprint,createdAt,current,json_remove(payload,'$.evidence') AS payload FROM reviews WHERE organizationId=? AND clientId=? ORDER BY storeDate DESC,revision DESC LIMIT 365",org,client)).map(r=>({...r,current:!!r.current,payload:JSON.parse(r.payload)}));}
  async findings(org:string,client:string):Promise<Finding[]>{
    const findings:Finding[]=(await this.all('SELECT * FROM findings WHERE organizationId=? AND clientId=? ORDER BY updatedAt DESC',org,client)).map(r=>({...JSON.parse(r.payload),id:r.id,clientId:r.clientId,version:r.version,updatedAt:r.updatedAt}));
    const checks=await this.all("SELECT r.id,r.storeDate,r.createdAt,a.value AS action FROM reviews r,json_each(r.payload,'$.actions') a WHERE r.organizationId=? AND r.clientId=? AND r.current=1 AND json_extract(r.payload,'$.type')='ai' AND json_extract(a.value,'$.existingFindingId') IS NOT NULL ORDER BY r.storeDate DESC,r.createdAt DESC",org,client);
    for(const check of checks){const a=JSON.parse(check.action),f=findings.find(x=>x.id===a.existingFindingId);if(f&&!f.latestCheck)f.latestCheck={reviewId:check.id,storeDate:check.storeDate,checkedAt:check.createdAt,detail:a.detail,nextStep:a.nextStep,severity:a.severity,sourceIds:a.sourceIds??[]};}
    return findings;
  }
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
