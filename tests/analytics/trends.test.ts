import {it,expect} from 'vitest';
import {visibleTrend} from '../../lib/analytics/trends';
it('shows the observed time span while preserving missing internal days',()=>{
 const values=[{date:'2026-10-01',revenue:null,spend:null},{date:'2026-10-02',revenue:10,spend:0},{date:'2026-10-03',revenue:null,spend:null},{date:'2026-10-04',revenue:20,spend:5},{date:'2026-10-05',revenue:null,spend:null}];
 expect(visibleTrend(values).map(x=>x.date)).toEqual(['2026-10-02','2026-10-03','2026-10-04']);
});
it('does not manufacture a chart from entirely unavailable values',()=>expect(visibleTrend([{date:'2026-10-01',revenue:null,spend:null}])).toEqual([]));
