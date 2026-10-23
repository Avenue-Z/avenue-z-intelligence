import {expect,it} from 'vitest';
import {planGa4Sync} from '../../lib/jobs/ga4-sync';
const now=new Date('2026-10-16T17:50:00Z');
const kinds=['total','hourly','detail'];
const complete=(date:string,at='2026-10-16T17:05:00Z')=>kinds.map(kind=>({storeDate:date,kind,capturedAt:at}));
it('prioritizes today and the two previous New York days ahead of bounded history',()=>{
 const dates=planGa4Sync([],now);expect(dates.slice(0,3)).toEqual(['2026-10-16','2026-10-15','2026-10-14']);
 expect(new Set(dates).size).toBe(dates.length);expect(dates.length).toBeLessThanOrEqual(7);
 expect(dates.every(date=>date>='2026-09-17'&&date<='2026-10-16')).toBe(true);
});
it('does not repoll current reports within the same UTC hour but continues missing history',()=>{
 const recent=[...complete('2026-10-16'),...complete('2026-10-15'),...complete('2026-10-14')];
 const dates=planGa4Sync(recent,now);expect(dates).not.toContain('2026-10-16');expect(dates).not.toContain('2026-10-15');expect(dates.length).toBeGreaterThan(0);
});
it('repairs an incomplete or mixed-version day and retries an old hourly capture',()=>{
 const rows=[...complete('2026-10-16').slice(0,2),...complete('2026-10-15','2026-10-16T16:59:00Z'),...complete('2026-10-14')];
 rows.at(-1)!.capturedAt='2026-10-16T17:04:00Z';expect(planGa4Sync(rows,now).slice(0,3)).toEqual(['2026-10-16','2026-10-15','2026-10-14']);
});
it('uses the store calendar across UTC midnight and excludes data older than thirty days',()=>{
 const dates=planGa4Sync([],new Date('2026-10-17T00:15:00Z'));expect(dates[0]).toBe('2026-10-16');expect(dates).not.toContain('2026-10-17');
});
