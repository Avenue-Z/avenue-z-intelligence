import type {Observation} from './contracts';
export function preferredObservations(rows:Observation[]):Observation[] {
 const live=new Set(rows.filter(r=>r.quality!=='historical').map(r=>`${r.date}:${r.dataset}:${r.metric}`));
 return rows.filter(r=>r.quality!=='historical'||!live.has(`${r.date}:${r.dataset}:${r.metric}`));
}
