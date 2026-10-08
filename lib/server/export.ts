export function csv(rows:Record<string,unknown>[]) {
  if(!rows.length)return '';
  const keys=Array.from(new Set(rows.flatMap(r=>Object.keys(r))));
  const cell=(v:unknown)=>{let s=v==null?'':String(v);if(typeof v==='string'&&/^[\s]*[=+@-]/.test(s))s="'"+s;return /[,"\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
  return [keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');
}
