import {compactAIContextForModel,type buildAIContext} from './context';

type AIContext=ReturnType<typeof buildAIContext>;
type NumericRow=AIContext['clients'][number]['details'][number];
type CollectionOmission={path:string;availableRows:number;includedRows:number;omittedRows:number;preexistingOmittedRows:number};
type TextOmission={path:string;originalCharacters:number;includedCharacters:number;omittedCharacters:number};
const MAX_MODEL_CONTEXT_BYTES=280000;
const provenanceScopeColumns=['date','dataset','metric','sourceId','definition','population','currency','quality','retrievedAt','coverageThrough','aggregation','storedObservationCount','observationCount','contributionCount','unknownContributionCounts','observationCountBasis','intervalObservationCount','withoutIntervalCount','duplicateIntervalObservationCount','intervalSummary'] as const;
const isNumericRow=(value:unknown):value is NumericRow=>!!value&&typeof value==='object'&&'key' in value&&'dimensions' in value&&'metrics' in value&&'summary' in value&&'provenance' in value;
const sparse=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==null&&item!==undefined));

function preview(input:AIContext,rowLimit:number,textLimit:number){
 const collections:CollectionOmission[]=[],text:TextOmission[]=[];
 const project=(value:unknown,path:string,parent?:Record<string,unknown>):unknown=>{
  if(typeof value==='string'){
   // Identity, citation, qualification and scope strings are never shortened.
   const narrative=/(?:^|\.)(?:text|notes|detail)$|\.(?:paragraphs|bullets|headlines|summary)\[\d+\]$/.test(path);
   const limit=/\.findings\[\d+\]\.detail$/.test(path)?Math.min(textLimit,2000):textLimit;
   if(narrative&&value.length>limit){text.push({path,originalCharacters:value.length,includedCharacters:limit,omittedCharacters:value.length-limit});return value.slice(0,limit)+'\n[Additional source prose omitted from the model preview.]';}
   return value;
  }
  if(Array.isArray(value)){
   const numeric=value.length>0&&value.every(isNumericRow),table=path.endsWith('.rows')&&value.length>0&&value.every(row=>Array.isArray(row));
   const limit=/\.traffic\.(?:countries|devices|sources)\.rows$/.test(path)?Math.max(20,rowLimit):rowLimit;
   const selected=numeric||table?value.slice(0,limit):value;
   const alreadyOmitted=path.endsWith('.comparisonDetails')?parent?.comparisonDetailsOmitted:path.endsWith('.details')?parent?.detailsOmitted:parent?.omitted;
   if(numeric||table)collections.push({path,availableRows:value.length,includedRows:selected.length,omittedRows:value.length-selected.length,preexistingOmittedRows:typeof alreadyOmitted==='number'?alreadyOmitted:0});
   return selected.map((item,i)=>project(item,`${path}[${i}]`));
  }
  if(!value||typeof value!=='object')return value;
  const object=value as Record<string,unknown>,copy=Object.fromEntries(Object.entries(object).map(([key,item])=>[key,project(item,path?`${path}.${key}`:key,object)]));
  if(isNumericRow(value)){
   // Keep the opaque key only for lossless interning, then remove it below.
   for(const key of ['metrics','summary','derived'])if(copy[key]&&typeof copy[key]==='object')copy[key]=sparse(copy[key] as Record<string,unknown>);
  }
  if(Array.isArray(object.rows)&&object.rows.length&&object.rows.every(isNumericRow)){
   const rows=copy.rows as NumericRow[],observations=rows.reduce((sum,row)=>sum+row.provenance.reduce((n,scope)=>n+scope.observationCount,0),0),stored=rows.reduce((sum,row)=>sum+row.provenance.reduce((n,scope)=>n+scope.storedObservationCount,0),0);
   if(typeof object.segmentCount==='number'){copy.returnedSegmentCount=rows.length;copy.omitted=object.segmentCount-rows.length;}
   if(typeof object.observationCount==='number'){copy.returnedObservationCount=observations;copy.omittedObservationCount=object.observationCount-observations;}
   if(typeof object.storedObservationCount==='number'){copy.returnedStoredObservationCount=stored;copy.omittedStoredObservationCount=object.storedObservationCount-stored;}
  }
  for(const [rowsKey,omittedKey,countsKey] of [['details','detailsOmitted','detailCounts'],['comparisonDetails','comparisonDetailsOmitted','comparisonDetailCounts']]){
   const original=object[rowsKey],counts=object[countsKey] as Record<string,number>|undefined;
   if(!Array.isArray(original)||!original.length||!original.every(isNumericRow))continue;
   const rows=copy[rowsKey] as NumericRow[],observations=rows.reduce((sum,row)=>sum+row.provenance.reduce((n,scope)=>n+scope.observationCount,0),0);
   copy[omittedKey]=typeof counts?.segments==='number'?counts.segments-rows.length:(typeof object[omittedKey]==='number'?object[omittedKey]:0)+original.length-rows.length;
   if(counts)copy[countsKey]={...counts,returned:rows.length,returnedObservations:observations,omittedObservations:counts.observations-observations};
  }
  return copy;
 };
 const projected=project(input,'') as AIContext,compact=compactAIContextForModel(projected);
 const evidenceRows=Object.fromEntries(Object.entries(compact.evidenceRows).map(([id,{key:_,...row}])=>[id,row]));
 let provenanceRangeEntriesOmitted=0;
 const provenanceTextValues:Record<string,string>={},textIds=new Map<string,string>();
 const encodeScopeValue=(value:unknown)=>{if(typeof value!=='string')return value??null;const existing=textIds.get(value);if(existing)return existing;const id=`text${textIds.size+1}`;textIds.set(value,id);provenanceTextValues[id]=value;return id;};
 const provenanceScopes=Object.fromEntries(Object.entries(compact.provenanceScopes).map(([id,scope])=>{
  const {contributedBounds=[],observedIntervals=[],incompleteIntervals=[],...identity}=scope;
  const ranges=[...contributedBounds,...observedIntervals,...incompleteIntervals];
  provenanceRangeEntriesOmitted+=ranges.length;
  const starts=ranges.flatMap(r=>r.start?[r.start]:[]).sort(),ends=ranges.flatMap(r=>r.end?[r.end]:[]).sort();
  const record={...identity,intervalSummary:ranges.length?[encodeScopeValue(starts[0]),encodeScopeValue(ends.at(-1)),observedIntervals.length,contributedBounds.length,incompleteIntervals.length]:null} as Record<string,unknown>;
  return [id,provenanceScopeColumns.map(column=>column==='intervalSummary'?record[column]:encodeScopeValue(record[column]))];
 }));
 return {format:'avenuez-model-preview-v1',instruction:'This is a bounded model preview, not the complete evidence archive. Resolve evidenceRowId in evidenceRows and provenanceScopeIds in provenanceScopes. Each scope is a tuple with fields in provenanceScopeColumns order; decode every string cell using provenanceTextValues, retaining numeric zero and null as unknown. intervalSummary is [start text ID, end text ID, observed range count, contributed bound count, incomplete range count]; these outer bounds never prove continuity or coverage. Full ranges remain in saved evidence. Numeric rows are the top supplied rows per dated slice; collection omission counts explicitly include rows outside this preview. A collection omitted from this model preview is not an unavailable source: availableRows and the saved numeric appendix distinguish supplied evidence from preview omission. Do not create an action merely to request omitted preview rows. Original segment/observation totals cover the complete supplied cut, not just these rows: never sum preview rows into a total or claim omitted segments were checked. Sparse numeric metric, summary and derived maps retain every supplied non-null value including zero; an absent metric is unavailable, never zero. Other null qualification and coverage values remain unknown. Keep current, comparison and closed reference dates separate. Preserve spendVerdict, recurrence qualifications, incidents and warnings. Truncated source prose is explicitly listed and cannot support claims about its omitted content. All workflow finding IDs and citation IDs are preserved. Cite context.sources IDs only, never row, text or scope registry IDs.',context:compact.context,evidenceRows,provenanceScopeColumns,provenanceScopes,provenanceTextValues,
  preview:{rowLimit,aggregateRowLimit:Math.max(20,rowLimit),maxBytes:MAX_MODEL_CONTEXT_BYTES,collections,text,provenanceRangeEntriesOmitted},
  compression:{uniqueEvidenceRows:compact.compression.uniqueEvidenceRows,evidenceRowReferences:compact.compression.evidenceRowReferences,uniqueProvenanceScopes:compact.compression.uniqueProvenanceScopes,provenanceScopeReferences:compact.compression.provenanceScopeReferences}};
}

/** Request-only projection. The full lossless registry remains the saved evidence. */
export function boundedAIContextForModel(input:AIContext){
 for(const [rows,characters] of [[16,12000],[12,6000],[8,2000],[4,500],[2,200],[1,200],[0,0]]){
  const result=preview(input,rows,characters);
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength<=MAX_MODEL_CONTEXT_BYTES)return result;
 }
 throw new Error('This evidence scope is too large for a bounded AI preview. Choose one client or a narrower reporting scope.');
}
