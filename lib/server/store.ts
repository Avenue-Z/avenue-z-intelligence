import type {Client,Connection,Observation,SourceBatch,Review,Finding,QueryFilters} from '../analytics/contracts';
import {shiftDate,dayWindow,comparisonPeriod,todayIn} from '../analytics/windows';
import {preferredObservations} from '../analytics/source-precedence';
import {FunnelRollupAccumulator} from '../analytics/funnel-rollup';
import {confirmedIntradayCutoff} from '../analytics/intraday-coverage';
import {Temporal} from '@js-temporal/polyfill';
import {QueryCache} from './query-cache';
import {observationCodec} from './observation-codec';
import {durableObservationPayload} from './durable-observation-cache';
import {snapshotDayManifests,snapshotDayManifest,readSnapshotDayProjection,readSmallSnapshotDayProjections,discardSnapshotDayProjection,writeSnapshotDayProjection,snapshotDayPayload} from './snapshot-day-projections';
import {trendContextWindows} from '../analytics/trend-context';
import {TrendRollupAccumulator} from '../analytics/trend-rollup';
import {readTrendObservations} from './trend-observations';
import {reviewIndexFields} from '../reviews/index';
import {retryPublication} from '../jobs/publication-retry';
import {fingerprint} from '../reviews/build';
import {assertSourceActivation} from '../sources/registered-contract';
import {expiredRechargeEventDay,completeRechargeEventDay,rechargeExactEventMetrics} from './recharge-event-retention';
import {readActiveCustomerComparison} from './active-customer-comparison';
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
  async observations(org:string,client:string,filters?:QueryFilters,headlinesOnly=false,options?:{deadline:number},selection?:{datasets:string[];dimensions?:boolean;includePriorWeek?:boolean;includeOperations?:boolean;trendDatasets?:string[]}):Promise<Observation[]> {
    const checkBudget=()=>{if(options&&Date.now()>=options.deadline)throw Error('Observation cache warm budget elapsed');};
    const readPage=async<T>(sql:string,...values:unknown[])=>{checkBudget();const rows=await this.all<T>(sql,...values);checkBudget();return rows;};
    checkBudget();
    const [capturedPointers,clientRow,sources,qualifications]=await Promise.all([
      this.all<{snapshotId:string;sourceId:string;date:string;publishedAt:string}>("SELECT c.snapshotId,c.sourceId,c.date,c.publishedAt FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready'",org,client),
      this.first<{timezone:string;version:number;config:string}>('SELECT timezone,version,config FROM clients WHERE organizationId=? AND id=?',org,client),
      filters?.mode==='partial'?this.connections(org,client):Promise.resolve([]),
      filters||headlinesOnly||selection?this.all<{sourceId:string;profiles:string|null;connectionVersion:number;clientVersion:number;version:number}>("SELECT sourceId,connectionVersion,clientVersion,version,json_extract(payload,'$.profiles') AS profiles FROM qualifications WHERE organizationId=? AND clientId=?",org,client):Promise.resolve([])
    ]);
    checkBudget();
    if(!capturedPointers.length)return [];
    let clause='',values:unknown[]=[],overviewWindow:[string,string]|undefined,marketWindow:[string,string]|undefined;
    const detailWindows:[string,string][]=[];let subscriptionTo:string|undefined;
    const trendDatasets=[...new Set(selection?.trendDatasets??[])].filter(dataset=>selection?.datasets.includes(dataset));
    const trendWindows: [string,string][]=filters&&trendDatasets.length?trendContextWindows(filters):[];
    if(filters){const comparison=comparisonPeriod(filters),priorFrom=comparison.from,priorTo=comparison.to,trendFrom=shiftDate(filters.to,-29),overviewFrom=priorFrom<trendFrom?priorFrom:trendFrom;
      // Keep headline history and renewal benchmarks; load bulky detail exports
      // only for the selected, comparison and prior-week periods.
      overviewWindow=[overviewFrom,filters.to];detailWindows.push([filters.from,filters.to],[priorFrom,priorTo]);
      // Workspace views use current/comparison evidence. Review and AI callers
      // retain supplemental weekday benchmarks through the default true option.
      if(selection?.includePriorWeek!==false)detailWindows.push([shiftDate(filters.from,-7),shiftDate(filters.to,-7)]);
      clause=` AND ((json_extract(o.payload,'$.dataset')='overview' AND o.date>=? AND o.date<=?) OR (json_extract(o.payload,'$.dataset')='subscriptions' AND o.date<=?) OR (json_extract(o.payload,'$.dataset')='markets' AND o.date>=? AND o.date<=?) OR json_extract(o.payload,'$.metric') IN ('active_ads','active_creatives') OR ${detailWindows.map(()=>'(o.date BETWEEN ? AND ?)').join(' OR ')})`;
      marketWindow=[shiftDate(filters.from,-1),filters.to];
      subscriptionTo=[filters.to,priorTo].sort().at(-1);
      values.push(overviewFrom,filters.to,subscriptionTo,shiftDate(filters.from,-1),filters.to,...detailWindows.flat());
    }
    if(trendWindows.length){clause=clause.slice(0,-1)+` OR (json_extract(o.payload,'$.dataset') IN (${trendDatasets.map(()=>'?').join(',')}) AND (${trendWindows.map(()=>'(o.date BETWEEN ? AND ?)').join(' OR ')})))`;values.push(...trendDatasets,...trendWindows.flat());}
    if(headlinesOnly)clause+=" AND json_extract(o.payload,'$.dataset')='overview'";
    const dateClause=clause,dateValues=[...values];
    const selectedDatasets=selection?[...new Set(selection.datasets)].sort():null,dimensionSelection:Record<string,string>={},dimensionAliases=new Map<string,string[]>();let selectionClause='',selectionValues:unknown[]=[];
    // For IN selections SQLite otherwise favors the row-key ordering index and
    // decodes every dataset in the snapshot/day. Seek the selected datasets first.
    const selectionIndex=selectedDatasets?.length?' INDEXED BY idx_observations_snapshot_date_dataset_rowkey':'';
    if(selectedDatasets){selectionClause+=selectedDatasets.length?` AND json_extract(o.payload,'$.dataset') IN (${selectedDatasets.map(()=>'?').join(',')})`:' AND 0';selectionValues.push(...selectedDatasets);
      if(selection?.dimensions&&filters)for(const dimension of ['market','stream','source','device','page'] as const){const value=filters[dimension];if(!value)continue;dimensionSelection[dimension]=value;const aliases=[value];
        if(dimension==='market'&&/^[A-Z]{2}$/.test(value)){const name=new Intl.DisplayNames(['en'],{type:'region',fallback:'code'}).of(value==='UK'?'GB':value);if(name&&name!==value)aliases.push(name);if(value==='UK')aliases.push('GB');}
        dimensionAliases.set(dimension,aliases);selectionClause+=` AND (json_extract(o.payload,'$.dimensions.${dimension}') IN (${aliases.map(()=>'?').join(',')}) OR json_type(o.payload,'$.dimensions.${dimension}') IS NULL)`;selectionValues.push(...aliases);
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
          (profile.dataset==='markets'&&!!marketWindow&&inWindow(pointer.date,marketWindow))||
          (trendDatasets.includes(profile.dataset)&&trendWindows.some(window=>inWindow(pointer.date,window)))||detailWindows.some(window=>inWindow(pointer.date,window));
      });
    });
    const operationalMetrics=new Set(['active_customers','active_ads','active_creatives']);
    const operationalSources=new Set([...profiles].filter(([,registered])=>registered?.length&&registered.every(profile=>operationalMetrics.has(profile.metric))).map(([sourceId])=>sourceId));
    const operationalPointers=headlinesOnly||selection?.includeOperations===false?[]:capturedPointers.filter(pointer=>operationalSources.has(pointer.sourceId));
    const latestOperationalDates=new Map<string,string>();for(const pointer of operationalPointers){const prior=latestOperationalDates.get(pointer.sourceId);if(!prior||pointer.date>prior)latestOperationalDates.set(pointer.sourceId,pointer.date);}
    const freshOperationalPointers=operationalPointers.filter(pointer=>pointer.date===latestOperationalDates.get(pointer.sourceId));
    const pointers=selectedPointers.filter(pointer=>!operationalSources.has(pointer.sourceId));
    let cutoffClock:string|undefined,completePartialDay=false,trendCutoff:string|null=null;
    if(clientRow&&filters?.mode==='partial'){
      const cutoff=confirmedIntradayCutoff(sources,filters.view,clientRow.timezone,filters.to);
      if(cutoff){
        trendCutoff=cutoff;
        completePartialDay=Date.parse(cutoff)===Date.parse(dayWindow(filters.to,clientRow.timezone).end);
        // A next-midnight capture completes both matched days. Applying its
        // 00:00 clock to their starts would discard every contributed hour.
        if(!completePartialDay)cutoffClock=Temporal.Instant.from(cutoff).toZonedDateTimeISO(clientRow.timezone).toPlainTime().toString();
      }
    }
    // Observation loading deliberately retains every dataset/dimension for
    // queryClient's unsupported-filter checks, peers and navigation. View and
    // dimension selections therefore share rows, while load-affecting filters
    // and fresh metadata are part of the key. Published pointers invalidate
    // across refreshes, including refreshes performed by another instance.
    const version=pointers.map(p=>[p.sourceId,p.snapshotId,p.date]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // Context cohorts retain each active dimension, even when the selected
    // detail read keeps all dimensions for navigation. Its layout must not
    // reuse a cohort previously collapsed across that dimension. All values
    // remain present, so changing US to CA shares the same captured cohort.
    const trendDimensions=filters&&trendDatasets.length?(['market','stream','source','device','page'] as const).filter(dimension=>!!filters[dimension]):[];
    const trendCacheIdentity={timezone:clientRow?.timezone??null,clientVersion:clientRow?.version,config:clientRow?.config,qualifications:[...qualifications].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
    const key=JSON.stringify(['chart-series-v9',org,client,filters?[filters.from,filters.to,filters.compare,filters.compareFrom??null,filters.compareTo??null,filters.mode]:null,headlinesOnly,clientRow?.timezone??null,cutoffClock??null,completePartialDay,...selection?[{datasets:selectedDatasets,dimensions:!!selection.dimensions,includePriorWeek:selection.includePriorWeek!==false,trendDatasets:[...trendDatasets].sort(),trendDimensions,...trendDatasets.length?{trendCacheIdentity}:{},filters:dimensionSelection}]:[],version]);
    const temporalContext=clientRow&&filters?{timezone:clientRow.timezone,cutoff:trendCutoff,anchorDate:filters.to}:undefined;
    const contextualDatasets=trendDatasets.filter(dataset=>['traffic','funnels','products','markets'].includes(dataset));
    const contextualPointers=filters&&contextualDatasets.length?pointers.filter(pointer=>!detailWindows.some(window=>inWindow(pointer.date,window))&&trendWindows.some(window=>inWindow(pointer.date,window))&&(!profiles.get(pointer.sourceId)||profiles.get(pointer.sourceId)!.some(profile=>contextualDatasets.includes(profile.dataset)))):[];
    const contextKeys=new Set(contextualPointers.map(pointer=>JSON.stringify([pointer.snapshotId,pointer.date])));
    // A range hit must not skip independent day-cohort preparation forever.
    // Only the hosted warmer owns these writes; browser reads remain read-only.
    const warmedContext=options&&filters?await readTrendObservations(this,contextualPointers,contextualDatasets,filters,{organizationId:org,clientId:client},temporalContext,options.deadline,trendCacheIdentity):undefined;
    const load=()=>durableObservationPayload(this.db,org,client,key,async()=>{
    checkBudget();
    // Missing partial coverage must retain raw hourly rows so queryClient can
    // decline the comparison; it must never turn a full day into a partial day.
    const cutoffDates=new Set(filters?[filters.to,comparisonPeriod(filters).to,shiftDate(filters.to,-7)]:[]);
    const accumulator=clientRow&&(!filters||filters.mode==='closed'||cutoffClock||completePartialDay)?new FunnelRollupAccumulator({timezone:clientRow.timezone,cutoffClock,...filters?.mode==='partial'?{cutoffDates}:{}}):null;
    const fullDayContext=clientRow&&filters?.mode==='partial'&&trendDatasets.length?new TrendRollupAccumulator(filters,temporalContext):null;
    const contextRows=warmedContext??(filters?await readTrendObservations(this,contextualPointers,contextualDatasets,filters,{organizationId:org,clientId:client},temporalContext,options?.deadline,trendCacheIdentity):[]);
    const rows:Observation[]=[];
    const addRow=(row:Observation)=>{if(fullDayContext&&row.date!==filters!.to&&trendDatasets.includes(row.dataset)&&['traffic','funnels'].includes(row.dataset))fullDayContext.add(row);if(accumulator)accumulator.add(row);else rows.push(row);};
    const add=(page:{payload:string}[])=>{for(const r of page)addRow(JSON.parse(r.payload));};
    // Mirror the SQL predicate on complete day projections. Missing dimensions
    // remain in the evidence for queryClient's unsupported-filter checks.
    const accepts=(row:Observation,date:string)=>{
      if(filters&&!((row.dataset==='overview'&&!!overviewWindow&&inWindow(date,overviewWindow))||(row.dataset==='subscriptions'&&!!subscriptionTo&&date<=subscriptionTo)||(row.dataset==='markets'&&!!marketWindow&&inWindow(date,marketWindow))||(trendDatasets.includes(row.dataset)&&trendWindows.some(window=>inWindow(date,window)))||['active_ads','active_creatives'].includes(row.metric)||detailWindows.some(window=>inWindow(date,window))))return false;
      if(contextualDatasets.includes(row.dataset)&&contextualPointers.some(pointer=>pointer.date===date&&pointer.sourceId===row.sourceId))return false;
      if(headlinesOnly&&row.dataset!=='overview'||selectedDatasets&&!selectedDatasets.includes(row.dataset))return false;
      for(const [dimension,aliases] of dimensionAliases){if(Object.hasOwn(row.dimensions,dimension)&&!aliases.includes(row.dimensions[dimension]))return false;}return true;
    };
    // A complete mixed-source day can be much larger than a small indexed
    // selection. Use it when that source/day contributes requested dense detail;
    // otherwise preserve the SQL seek that transfers only the chosen datasets.
    const denseDatasets=new Set(['funnels','traffic','products','creatives']);
    const projectionPointers=pointers.filter(pointer=>{
      const registeredContext=profiles.get(pointer.sourceId);if(contextKeys.has(JSON.stringify([pointer.snapshotId,pointer.date]))&&registeredContext?.every(profile=>contextualDatasets.includes(profile.dataset)))return false;
      if(!filters&&!selectedDatasets&&!headlinesOnly)return true;
      const detailRequested=!filters||detailWindows.some(window=>inWindow(pointer.date,window));
      const requested=(dataset:string)=>(detailRequested||trendDatasets.includes(dataset)&&trendWindows.some(window=>inWindow(pointer.date,window)))&&!headlinesOnly&&(!selectedDatasets||selectedDatasets.includes(dataset));
      const registered=profiles.get(pointer.sourceId);
      if(!registered)return [...denseDatasets].some(requested);
      const dense=registered.filter(profile=>denseDatasets.has(profile.dataset));return !dense.length||dense.some(profile=>requested(profile.dataset));
    });
    const manifests=await snapshotDayManifests(this.db,org,client,projectionPointers,options?.deadline),legacyPointers:typeof pointers=[];
    // Decode one source/day at a time. Chunk I/O is bounded and parallel, while
    // a visitor avoids allocating a second full 30K-row observation array.
    const consume=async(pointer:typeof pointers[number],payload:string|null|undefined)=>{const manifest=snapshotDayManifest(manifests,pointer);let used=false;if(payload)try{observationCodec.visit(payload,row=>{if(accepts(row,pointer.date))addRow(row);},pointer);used=true;}catch(error){if(!(error instanceof Error)||error.message!=='Invalid observation projection')throw error;if(manifest)await discardSnapshotDayProjection(this.db,org,client,manifest);}if(!used)legacyPointers.push(pointer);};
    for(let index=0;index<pointers.length;){checkBudget();const pointer=pointers[index],manifest=snapshotDayManifest(manifests,pointer);
      if(manifest?.chunkCount===1){const group:typeof pointers=[],small=[];while(index<pointers.length&&group.length<4){const next=pointers[index],entry=snapshotDayManifest(manifests,next);if(entry?.chunkCount!==1)break;group.push(next);small.push(entry);index++;}const payloads=await readSmallSnapshotDayProjections(this.db,org,client,small,options?.deadline);for(const next of group)await consume(next,payloads.get(JSON.stringify([next.snapshotId,next.date])));}
      else{index++;await consume(pointer,manifest?await readSnapshotDayProjection(this.db,org,client,manifest,options?.deadline):null);}
    }
    // Seek within each captured snapshot/date using the primary key. Sorting
    // the entire source set again for every page made large exports quadratic.
    const readPointer=async(pointer:typeof pointers[number],cursor:string|null=null)=>{const scope=scopedRead(pointer);for(;;){const page=await readPage<{payload:string;rowKey:string}>(`SELECT o.payload,o.rowKey FROM observations o${scope.index} WHERE o.snapshotId=? AND o.date=?${scope.clause}${cursor?' AND o.rowKey>?':''} ORDER BY o.rowKey LIMIT 2000`,pointer.snapshotId,pointer.date,...scope.values,...cursor?[cursor]:[]);add(page);if(page.length<2000)return;cursor=page[page.length-1].rowKey;}};
    const scopedRead=(pointer:typeof pointers[number])=>{
      const registered=profiles.get(pointer.sourceId);
      if(!filters||!registered||detailWindows.some(window=>inWindow(pointer.date,window))){
        // One qualified dataset fixes the index prefix, so row-key paging does
        // not sort every page of a broad workspace selection. Incomplete or
        // multi-dataset profile histories retain the conservative predicate.
        const datasets=filters&&registered&&selectedDatasets?[...new Set(registered.map(profile=>profile.dataset))].filter(dataset=>selectedDatasets.includes(dataset)):[];
        if(datasets.length===1)return {clause:clause+" AND json_extract(o.payload,'$.dataset')=?",values:[...values,datasets[0]],index:selectionIndex,datasets:null};
        return {clause,values,index:selectionIndex,datasets:null};
      }
      // Outside detail windows only headline/renewal/market history and global
      // inventory metrics can qualify. Narrow the indexed dataset seek before
      // decoding payloads, rather than scanning every historical funnel row.
      const datasets=[...new Set(registered.filter(profile=>(profile.dataset==='overview'&&!!overviewWindow&&inWindow(pointer.date,overviewWindow))||(profile.dataset==='subscriptions'&&!!subscriptionTo&&pointer.date<=subscriptionTo)||(profile.dataset==='markets'&&!!marketWindow&&inWindow(pointer.date,marketWindow))||(trendDatasets.includes(profile.dataset)&&trendWindows.some(window=>inWindow(pointer.date,window)))||['active_ads','active_creatives'].includes(profile.metric)).map(profile=>profile.dataset))].filter(dataset=>(!selectedDatasets||selectedDatasets.includes(dataset))&&(!headlinesOnly||dataset==='overview')&&(!contextKeys.has(JSON.stringify([pointer.snapshotId,pointer.date]))||!contextualDatasets.includes(dataset))).sort();
      let localClause=dateClause+(datasets.length?` AND json_extract(o.payload,'$.dataset') IN (${datasets.map(()=>'?').join(',')})`:' AND 0');const localValues:unknown[]=[...dateValues,...datasets];
      for(const [dimension,aliases] of dimensionAliases){localClause+=` AND (json_extract(o.payload,'$.dimensions.${dimension}') IN (${aliases.map(()=>'?').join(',')}) OR json_type(o.payload,'$.dimensions.${dimension}') IS NULL)`;localValues.push(...aliases);}
      return {clause:localClause,values:localValues,index:datasets.length?' INDEXED BY idx_observations_snapshot_date_dataset_rowkey':selectionIndex,datasets};
    };
    const history=new Map<string,typeof pointers>(),groups:(typeof pointers)[]=[];
    for(const pointer of legacyPointers){if(filters&&!detailWindows.some(window=>inWindow(pointer.date,window))||headlinesOnly){const key=JSON.stringify(scopedRead(pointer).datasets),group=history.get(key);if(group)group.push(pointer);else history.set(key,[pointer]);}else groups.push([pointer]);}
    for(const historyGroup of history.values())for(let index=0;index<historyGroup.length;index+=16)groups.push(historyGroup.slice(index,index+16));
    let nextGroup=0;
    const read=async()=>{for(;;){const group=groups[nextGroup++];if(!group)return;
      if(group.length===1){await readPointer(group[0]);continue;}
      // Constrained history normally fits one response. If it overflows, do
      // not repeat the grouped sort: resume that pointer with its primary-key
      // cursor and read subsequent pointers individually. Captured ids retain
      // snapshot consistency even if a source refresh publishes during I/O.
      const scope=scopedRead(group[0]);
      const page=await readPage<{payload:string;rowKey:string;pointerIndex:number}>(`SELECT o.payload,o.rowKey,CAST(p.key AS INTEGER) AS pointerIndex FROM json_each(?) p JOIN observations o${scope.index} ON o.snapshotId=json_extract(p.value,'$.snapshotId') AND o.date=json_extract(p.value,'$.date') WHERE 1=1${scope.clause} ORDER BY CAST(p.key AS INTEGER),o.rowKey LIMIT 2000`,JSON.stringify(group),...scope.values);
      add(page);if(page.length<2000)continue;
      const last=page[page.length-1];await readPointer(group[last.pointerIndex],last.rowKey);
      for(let index=last.pointerIndex+1;index<group.length;index++)await readPointer(group[index]);
    }};
    await Promise.all(Array.from({length:Math.min(4,groups.length)},()=>read()));
    const stable=(accumulator?accumulator.finish():rows).map(row=>({row,key:JSON.stringify([row.sourceId,row.date,row.dataset,row.metric,row.definition,row.population,row.currency,row.start,row.end,Object.entries(row.dimensions).sort(),row.retrievedAt,row.quality])})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(x=>x.row);
    checkBudget();return observationCodec.encode([...preferredObservations(stable),...contextRows,...fullDayContext?fullDayContext.finish():[]]);
    // Foreground reads reuse ready shared data but do not wait for multi-chunk
    // range-cache writes. Only bounded hosted warming publishes those entries.
    },options?.deadline,{publish:!!options});
    // A warming deadline must never cancel a browser request coalesced on the
    // same key. Warming populates durable storage without joining that promise.
    const [cached,operations]=await Promise.all([pointers.length?(options?load().then(payload=>observationCodec.decode(payload)):observationCache(this.db).getEncoded(key,load)):Promise.resolve([]),
      freshOperationalPointers.length?readPage<{payload:string}>(`SELECT json_extract(o.payload,'$') AS payload FROM json_each(?) p JOIN observations o ON o.snapshotId=json_extract(p.value,'$.snapshotId') AND o.date=json_extract(p.value,'$.date') WHERE json_extract(o.payload,'$.metric') IN ('active_customers','active_ads','active_creatives') ORDER BY o.date,o.rowKey`,JSON.stringify(freshOperationalPointers)).then(async rows=>{const operations=rows.map(row=>JSON.parse(row.payload) as Observation),current=operations.filter(row=>row.metric==='active_customers'&&row.quality==='complete').sort((a,b)=>b.date.localeCompare(a.date)||b.retrievedAt.localeCompare(a.retrievedAt))[0];if(current){const comparison=await readActiveCustomerComparison(this,org,client,current,options?.deadline);if(comparison)current.activeCustomerComparison=comparison;}return operations;}):Promise.resolve([])]);
    return operations.length?[...cached,...operations]:cached;
  }
  async persistBatch(org:string,source:string,batch:SourceBatch,key:string,now:string,window?:{from:string;to:string},options?:{restoreMaterialization?:boolean;publicationDeadline?:number;factPageSize?:100|500;beforeFactPage?:()=>Promise<void>}) {
    // A fact page is replay-safe even when the database committed before its
    // response timed out. Retry that exact page, not the entire large capture.
    const publish=<T>(operation:string,work:()=>Promise<T>):Promise<T>=>{
      if(options?.publicationDeadline===undefined)return work();
      if(Date.now()>=options.publicationDeadline)throw Error('Source publication budget elapsed');
      return retryPublication(operation,options.publicationDeadline,work);
    };
    const publishFacts=<T>(operation:string,work:()=>Promise<T>)=>publish(operation,async()=>{
      if(options?.beforeFactPage)await options.beforeFactPage();
      if(options?.publicationDeadline!==undefined&&Date.now()>=options.publicationDeadline)throw Error('Source publication budget elapsed');
      return work();
    });
    const id=`${org}:${batch.clientId}:${source}:${key}`;
    // A partial publication owns the same immutable provenance as a ready one.
    // Retried missing facts must not mix their retry timestamp with old rows.
    const existing=await publish('source.snapshot.read',()=>this.first('SELECT id,status,retrievedAt,coverageThrough,complete FROM snapshots WHERE id=?',id));
    const ready=existing?.status==='ready'?existing:null;
    // Generic same-key replays preserve first-wins values, even when their
    // incoming batch differs. Only the native immutable hash proves these rows.
    const canonicalWriting=existing?.status==='writing'&&await fingerprint(batch)===key;
    const created=await publish('source.snapshot.create',()=>this.run('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,org,batch.clientId,source,now,batch.coverageThrough,Number(batch.complete),'writing',`snapshots/${id}.json`));
    const complete=existing?!!existing.complete:batch.complete;
    const rows=batch.rows.map(r=>({...r,channels:batch.channels,sourceId:source,retrievedAt:existing?.retrievedAt??now,coverageThrough:existing?existing.coverageThrough:batch.coverageThrough,quality:complete?(r.quality??'complete'):(r.quality==='historical'?'historical':'partial')}));
    const dates=window?(()=>{const d:string[]=[];for(let s=window.from;s<=window.to;s=shiftDate(s,1)){d.push(s);if(d.length>62)throw new Error('Window exceeds 62 days');}return d;})():[...new Set(rows.map(r=>r.date))];
    const grouped=new Map<string,Observation[]>();for(const row of rows){const values=grouped.get(row.date);if(values)values.push(row);else grouped.set(row.date,[row]);}
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([field,item])=>[field,canonical(item)])):value;
    const dayHashes=new Map<string,{dataHash:string|null;coveredThrough:string|null}>();let today:string|null=null;try{if(batch.timezone&&Number.isFinite(Date.parse(now)))today=todayIn(batch.timezone,new Date(now));}catch{/* Older unqualified archives retain conservative pointer publication. */}
    for(const date of dates){let dataHash:string|null=null,coveredThrough:string|null=null;
      if(today&&date<today&&batch.coverageThrough){coveredThrough=dayWindow(date,batch.timezone).end;if(Date.parse(batch.coverageThrough)>=Date.parse(coveredThrough)){
        // Provider sum order can change a monetary double by ~1e-12 without
        // changing the money. Normalize only its fingerprint to six decimals;
        // retain original facts/archives and exact count/rate corrections.
        const facts=(grouped.get(date)??[]).map(row=>{const {retrievedAt:_retrieval,coverageThrough:_coverage,...fact}=row;const monetaryValue=fact.currency&&typeof fact.value==='number'&&Number.isFinite(fact.value)?Number(fact.value.toFixed(6)):fact.value;return JSON.stringify(canonical({...fact,value:monetaryValue}));}).sort();
        const content=JSON.stringify(canonical({date,timezone:batch.timezone,currency:batch.currency,complete:batch.complete,grain:batch.grain,channels:[...(batch.channels??[])].sort(),dimensions:[...(batch.dimensions??[])].sort(),facts}));
        dataHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content))),byte=>byte.toString(16).padStart(2,'0')).join('');
      }}
      dayHashes.set(date,{dataHash,coveredThrough});
    }
    // Closed unchanged days already have immutable facts. Resolve them before
    // inserting a mixed refresh so polling today does not repeatedly store its
    // unchanged historical dates. The complete original batch remains archived.
    const retained=new Map<string,string>(),retainedEvents=new Set<string>();
    if([...dayHashes.values()].some(day=>day.dataHash)){
      const current=await publish('source.snapshot.current',()=>this.all<{date:string;snapshotId:string;dataHash:string|null;coverageThrough:string|null;complete:number}>("SELECT c.date,c.snapshotId,c.dataHash,s.coverageThrough,s.complete FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId AND s.sourceId=c.sourceId AND s.status='ready' WHERE c.organizationId=? AND c.clientId=? AND c.sourceId=? AND c.date IN (SELECT value FROM json_each(?))",org,batch.clientId,source,JSON.stringify(dates)));
      for(const day of current){const hash=dayHashes.get(day.date);if(hash?.dataHash&&hash.dataHash===day.dataHash&&hash.coveredThrough&&day.coverageThrough&&Date.parse(day.coverageThrough)>=Date.parse(hash.coveredThrough))retained.set(day.date,day.snapshotId);}
      // Recharge cannot query exact events after seven days. A state-only
      // refresh must not erase a previously qualified complete event day.
      const expired=current.filter(day=>!retained.has(day.date)&&day.complete&&dayHashes.get(day.date)?.coveredThrough&&expiredRechargeEventDay(day.date,batch.timezone,now)&&(grouped.get(day.date)??[]).some(row=>row.metric==='new_subscriptions')&&!(grouped.get(day.date)??[]).some(row=>rechargeExactEventMetrics.has(row.metric)));
      if(expired.length){
        const [sourceRecord,clientRecord,qualification]=await publish('source.recharge.retention.activation',()=>Promise.all([this.first<{provider:string;enabled:number;version:number}>('SELECT provider,enabled,version FROM connections WHERE organizationId=? AND clientId=? AND id=?',org,batch.clientId,source),this.first<Omit<Client,'config'>&{config:string}>('SELECT * FROM clients WHERE organizationId=? AND id=?',org,batch.clientId),this.qualification(org,source)]));
        if(sourceRecord?.provider==='kind-recharge-cancellations'&&sourceRecord.enabled&&clientRecord&&clientRecord.timezone===batch.timezone&&clientRecord.currency===batch.currency){
          let contract:ReturnType<typeof assertSourceActivation>|undefined;try{contract=assertSourceActivation(sourceRecord,qualification,{...clientRecord,config:JSON.parse(clientRecord.config)});}catch{/* Unqualified originals cannot be pinned. */}
          if(contract)for(const day of expired){const incoming=grouped.get(day.date)??[],through=dayHashes.get(day.date)!.coveredThrough!;if(!day.coverageThrough||Date.parse(day.coverageThrough)<Date.parse(through)||!completeRechargeEventDay(incoming,day.date,batch.timezone,source,contract,false))continue;
            const original=await publish('source.recharge.retention.original',()=>this.all<{payload:string}>('SELECT payload FROM observations WHERE snapshotId=? AND date=? ORDER BY rowKey LIMIT 121',day.snapshotId,day.date));let originalRows:Observation[];try{originalRows=original.map(row=>JSON.parse(row.payload));}catch{continue;}
            if(!completeRechargeEventDay(originalRows,day.date,batch.timezone,source,contract,true))continue;
            retained.set(day.date,day.snapshotId);retainedEvents.add(day.date);dayHashes.set(day.date,{dataHash:day.dataHash,coveredThrough:through});
          }
        }
      }
    }
    // A replay can need a previously retained day after a later correction.
    // First-wins inserts preserve existing rows and the snapshot's original
    // retrieval metadata while materializing only those now-required dates.
    // A ready immutable capture already contains these facts. Check existence
    // by snapshot/date instead of replaying tens of thousands of INSERT OR
    // IGNORE statements. A previously retained, unmaterialized date can still
    // be restored after a later source correction.
    // Archived copies can be only partly pruned when a bounded maintenance
    // run ends. Replay every original row for those captures; first-wins
    // inserts fill gaps while preserving the immutable capture metadata.
    // The cleaner accepts stale writing captures too. Keep the entire bounded
    // resume newer than its two-hour cutoff; old/unbounded captures replay fully.
    const originalRetrieval=existing?Date.parse(existing.retrievedAt):NaN;
    const resume=canonicalWriting&&!options?.restoreMaterialization&&options?.publicationDeadline!==undefined&&Number.isFinite(originalRetrieval)&&originalRetrieval+2*3600000>options.publicationDeadline;
    const archived=ready||resume?await publish('source.snapshot.archive',()=>this.first("SELECT id FROM audit WHERE id=? AND organizationId=? AND clientId=? AND action='snapshot.materialization.archive_verified'",`archive-materialization:${id}`,org,batch.clientId)):null;
    const materialized=new Set<string>(ready&&!archived?(await publish('source.snapshot.materialized',()=>this.all<{date:string}>("SELECT value AS date FROM json_each(?) d WHERE EXISTS (SELECT 1 FROM observations o WHERE o.snapshotId=? AND o.date=d.value LIMIT 1)",JSON.stringify(dates),id))).map(value=>value.date):[]);
    const rowKey=(row:Observation)=>JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]);
    let writeRows=options?.restoreMaterialization?rows:rows.filter(row=>!retained.has(row.date)&&!materialized.has(row.date));
    if(resume&&!archived&&writeRows.length){
      const committed=new Set<string>();let cursor:{date:string;rowKey:string}|undefined;
      for(;;){
        const page=await publish('source.facts.resume',()=>this.all<{date:string;rowKey:string}>(`SELECT date,rowKey FROM observations WHERE snapshotId=?${cursor?' AND (date,rowKey)>(?,?)':''} ORDER BY date,rowKey LIMIT 2000`,id,...cursor?[cursor.date,cursor.rowKey]:[]));
        if(Date.now()>=options!.publicationDeadline!)throw Error('Source publication budget elapsed');
        for(const row of page)committed.add(JSON.stringify([row.date,row.rowKey]));
        if(page.length<2000)break;cursor=page[page.length-1];
      }
      // Presence of exact pairs is authoritative; counts and prefixes cannot
      // prove completion when prior pages contain holes or span multiple dates.
      writeRows=writeRows.filter(row=>!committed.has(JSON.stringify([row.date,rowKey(row)])));
    }
    const factPageSize=options?.factPageSize??2000,factRows=writeRows.map(row=>({row,key:rowKey(row)}));
    // Dense captures otherwise scatter each small transaction across both
    // snapshot indexes. Stable primary-key order keeps consecutive pages local
    // while retaining the original first value of duplicate source keys.
    if(options?.factPageSize)factRows.sort((a,b)=>a.row.date<b.row.date?-1:a.row.date>b.row.date?1:a.key<b.key?-1:a.key>b.key?1:0);
    // Hosted ingestion yields the writer between 100-row transactions so
    // subscription events and other hourly sources can commit in between.
    for(let n=0;n<factRows.length;n+=factPageSize){const inserts:ReturnType<Db['prepare']>[]=[];for(let start=n;start<Math.min(n+factPageSize,factRows.length);start+=500){const values=factRows.slice(start,Math.min(start+500,n+factPageSize)).map(({row,key})=>({date:row.date,rowKey:key,payload:JSON.stringify(row)}));inserts.push(this.db.prepare("INSERT INTO observations(snapshotId,date,rowKey,payload) SELECT ?,json_extract(value,'$.date'),json_extract(value,'$.rowKey'),json_extract(value,'$.payload') FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING").bind(id,JSON.stringify(values)));}await publishFacts('source.facts.page',()=>this.db.batch(inserts));}
    const pointers=[];
    for(const date of dates){const {dataHash,coveredThrough}=dayHashes.get(date)!;
      // Pin the retained immutable id, even if a concurrent older publication
      // changes the current pointer between the lookup and this transaction.
      // The publication watermark still advances on unchanged facts, preventing
      // delayed older data from replacing the retained immutable snapshot.
      if(retainedEvents.has(date)){
        // Advance only this pointer's publication watermark. A concurrent real
        // event correction must keep its different immutable snapshot intact.
        pointers.push(this.db.prepare('UPDATE current_snapshots SET publishedAt=? WHERE organizationId=? AND clientId=? AND sourceId=? AND date=? AND snapshotId=? AND publishedAt<=?').bind(now,org,batch.clientId,source,date,retained.get(date),now));continue;
      }
      pointers.push(this.db.prepare("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId,publishedAt,dataHash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(organizationId,clientId,sourceId,date) DO UPDATE SET snapshotId=CASE WHEN excluded.dataHash IS NOT NULL AND current_snapshots.dataHash=excluded.dataHash AND EXISTS (SELECT 1 FROM snapshots old WHERE old.id=current_snapshots.snapshotId AND old.status='ready' AND julianday(old.coverageThrough)>=julianday(?)) THEN current_snapshots.snapshotId ELSE excluded.snapshotId END,publishedAt=excluded.publishedAt,dataHash=excluded.dataHash WHERE excluded.publishedAt>=current_snapshots.publishedAt").bind(org,batch.clientId,source,date,retained.get(date)??id,now,dataHash,coveredThrough));
    }
    const publication=[...pointers,this.db.prepare('UPDATE snapshots SET status=? WHERE id=?').bind('ready',id)];
    await publishFacts('source.snapshot.publish',()=>this.db.batch(publication));
    // Derived materialization happens after authoritative publication. A replay
    // must retain the raw snapshot's original retrieval/coverage metadata. A
    // new capture or hash-verified writing retry can use this batch. Closed
    // unchanged dates may still point at an older snapshot and need no duplicate.
    if(created.meta.changes||canonicalWriting)try{
      if(options?.beforeFactPage)await options.beforeFactPage();
      const published=await publish('source.projection.days',()=>this.all<{date:string}>('SELECT date FROM current_snapshots WHERE organizationId=? AND clientId=? AND sourceId=? AND snapshotId=?',org,batch.clientId,source,id));
      for(const {date} of published){const day={snapshotId:id,date,sourceId:source};await writeSnapshotDayProjection(this.db,org,batch.clientId,day,snapshotDayPayload(grouped.get(date)??[],day),options?.publicationDeadline);}
    }catch{/* Optional projections must never fail a completed source job. */}
    return id;
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
  async reviews(org:string,client:string,indexOnly=false):Promise<Review[]>{
    // Normal dashboard tabs need summaries, never the full report sections.
    // Project before transport while preserving missing keys and JSON types.
    const payload=indexOnly?"(SELECT json_group_object(j.key,json(CASE j.type WHEN 'object' THEN j.value WHEN 'array' THEN j.value WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_quote(j.value) END)) FROM json_each(r.payload) j WHERE j.key IN (SELECT value FROM json_each(?)))":"json_remove(r.payload,'$.evidence')";
    return (await this.all(`SELECT r.id,r.organizationId,r.clientId,r.storeDate,r.revision,r.fingerprint,r.createdAt,r.current,${payload} AS payload FROM reviews r WHERE r.organizationId=? AND r.clientId=? ORDER BY r.storeDate DESC,r.revision DESC LIMIT 365`,...indexOnly?[JSON.stringify(reviewIndexFields),org,client]:[org,client])).map(r=>({...r,current:!!r.current,payload:JSON.parse(r.payload)}));
  }
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
  async claim(now:string,org:string,permittedClientIds?:string[],leaseMs=300000,currentOnly=false){if(permittedClientIds?.length===0)return null;const clause=(permittedClientIds?' AND clientId IN ('+permittedClientIds.map(()=>'?').join(',')+')':'')+(currentOnly?" AND id NOT LIKE '%:hourly-history:____-__-__'":'');const r=await this.first(`SELECT * FROM jobs WHERE organizationId=?${clause} AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?)) ORDER BY CASE WHEN id LIKE '%:hourly-history:____-__-__' THEN 1 ELSE 0 END,dueAt LIMIT 1`,org,...permittedClientIds??[],now,now);if(!r)return null;const leaseUntil=new Date(Date.parse(now)+leaseMs).toISOString();const result=await this.run(`UPDATE jobs SET status='running',leaseUntil=?,attempts=attempts+1 WHERE id=? AND organizationId=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?))`,leaseUntil,r.id,org,now,now);return result.meta.changes?{...r,leaseUntil,attempts:r.attempts+1}:null;}
  async retry(id:string,attempts:number,error:string,now:string){const dueAt=new Date(Date.parse(now)+Math.min(30,2**attempts)*60000).toISOString();await this.run('UPDATE jobs SET status=?,dueAt=?,error=?,leaseUntil=NULL WHERE id=?',attempts>=3?'failed':'pending',dueAt,error,id);}
  async finish(id:string,error?:string){await this.run('UPDATE jobs SET status=?,error=?,leaseUntil=NULL WHERE id=?',error?'failed':'complete',error??null,id);}
  async jobs(org:string){return this.all('SELECT * FROM jobs WHERE organizationId=? ORDER BY dueAt DESC LIMIT 30',org);}
}
