import type {Observation,Connection} from './contracts';
import {intradayConnections} from './intraday-coverage';
import {matchedCutoff,todayIn} from './windows';

/** Live follows the latest completed primary-feed hour. A midnight boundary
 * completes the preceding day; the new day starts with its first full hour.
 * Calendar date selections do not use this resolver.
 */
export function liveReportingDate(connections:Connection[],view:string,timezone:string,now=new Date()):string{
 const today=todayIn(timezone,now),coverage=intradayConnections(connections,view).map(source=>source.coverageThrough);
 if(!coverage.length||!coverage.every((value):value is string=>!!value&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now.getTime()))return today;
 const cutoff=matchedCutoff(coverage,timezone);
 return cutoff?todayIn(timezone,new Date(Date.parse(cutoff)-1)):today;
}
export function initialReportingDate(params:URLSearchParams,records:{rows:Observation[];connections:Connection[]}[],yesterday:string):string|null {
  if(params.has('from')||params.has('to')||params.get('mode')==='partial'||records.some(r=>r.connections.some(c=>c.enabled)))return null;
  const dates=records.map(r=>[...new Set(r.rows.filter(x=>x.dataset==='overview'&&x.metric==='revenue'&&x.value!==null&&['complete','historical'].includes(x.quality)&&x.date<=yesterday).map(x=>x.date))]);
  const common=dates.length?dates[0].filter(day=>dates.every(days=>days.includes(day))):[];
  return (common.length?common:dates.flat()).sort().at(-1)??null;
}
