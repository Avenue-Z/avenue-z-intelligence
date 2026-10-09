import type {Observation,Connection} from './contracts';
export function initialReportingDate(params:URLSearchParams,records:{rows:Observation[];connections:Connection[]}[],yesterday:string):string|null {
  if(params.has('from')||params.has('to')||params.get('mode')==='partial'||records.some(r=>r.connections.some(c=>c.enabled)))return null;
  const dates=records.map(r=>[...new Set(r.rows.filter(x=>x.dataset==='overview'&&x.metric==='revenue'&&x.value!==null&&['complete','historical'].includes(x.quality)&&x.date<=yesterday).map(x=>x.date))]);
  const common=dates.length?dates[0].filter(day=>dates.every(days=>days.includes(day))):[];
  return (common.length?common:dates.flat()).sort().at(-1)??null;
}
