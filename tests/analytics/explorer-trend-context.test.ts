import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {explorerTrendData,ExplorerTrend} from '../../components/analytics/traffic-workspace';
import type {QueryFilters} from '../../lib/analytics/contracts';
import type {ExplorerSeriesPoint} from '../../lib/analytics/traffic-explorer';
const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',mode:'partial',compare:'previous',view:'traffic',market:'',stream:'',source:'',device:'',page:'',period:'today'};
const point=(date:string,sessions:number):ExplorerSeriesPoint=>({date,metrics:{sessions}});
const selected=[point('2026-10-13',30)],previous=[point('2026-10-12',20)];
const context={current:[point('2026-10-07',100),point('2026-10-08',0),point('2026-10-10',120),point('2026-10-12',140),point('2026-10-13',30)],previous:[point('2026-10-06',90),point('2026-10-07',100),point('2026-10-09',110),point('2026-10-11',130),point('2026-10-12',20)]};
it('uses seven observed store days ending at today while keeping uncaptured dates blank',()=>{
 const model=explorerTrendData({current:selected,previous,context,filters,comparisonFrom:'2026-10-12',metric:'sessions',range:'7d'});
 expect(model.points.map(day=>[day.date,day.current,day.comparisonDate,day.previous])).toEqual([
  ['2026-10-07',100,'2026-10-06',90],['2026-10-08',0,'2026-10-07',100],['2026-10-09',null,'2026-10-08',null],['2026-10-10',120,'2026-10-09',110],['2026-10-11',null,'2026-10-10',null],['2026-10-12',140,'2026-10-11',130],['2026-10-13',30,'2026-10-12',20],
 ]);
 expect(selected).toEqual([point('2026-10-13',30)]);
});
it('shows thirty calendar dates without filling the older missing values',()=>{
 const model=explorerTrendData({current:selected,previous,context,filters,comparisonFrom:'2026-10-12',metric:'sessions',range:'30d'});
 expect(model.points).toHaveLength(30);expect(model.points[0]).toEqual({date:'2026-09-14',current:null,comparisonDate:'2026-09-13',previous:null});expect(model.points[29].current).toBe(30);
});
it('selected-period chart retains the selected matched comparison rather than closed historical values',()=>{
 const model=explorerTrendData({current:selected,previous,context:{...context,previous:[point('2026-10-12',140)]},filters,comparisonFrom:'2026-10-12',metric:'sessions',range:'selected'});
 expect(model.points).toEqual([{date:'2026-10-13',current:30,comparisonDate:'2026-10-12',previous:20}]);
});
it('aligns context against the selected same-weekday date offset',()=>{
 const model=explorerTrendData({current:selected,previous,context,filters:{...filters,compare:'weekday'},comparisonFrom:'2026-10-06',metric:'sessions',range:'7d'});
 expect(model.points[0].comparisonDate).toBe('2026-09-30');expect(model.points[6].comparisonDate).toBe('2026-10-06');
});
it('defaults the displayed chart dates to seven days with local range controls',()=>{
 const html=renderToStaticMarkup(createElement(ExplorerTrend,{current:selected,previous,context,filters,comparisonFrom:'2026-10-12',metric:'sessions',currency:'USD',timezone:'Europe/Stockholm',heading:'Traffic over time'}));
 expect(html).toContain('2026-10-07 – 2026-10-13');expect(html).toContain('7 days');expect(html).toContain('30 days');expect(html).toContain('Selected period');expect(html).not.toContain('Intraday comparisons retain');expect(html).not.toContain('comparison aligned by period day');
});
it('presents a selected single day as exact values instead of a one-point trend',()=>{
 const html=renderToStaticMarkup(createElement(ExplorerTrend,{current:selected,previous,filters,comparisonFrom:'2026-10-12',metric:'sessions',currency:'USD',timezone:'Europe/Stockholm',heading:'This page over time'}));
 expect(html).toContain('<strong>30</strong>');expect(html).toContain('<strong>20</strong>');expect(html).toContain('2026-10-12');expect(html).not.toContain('>Line</button>');expect(html).not.toContain('>Bars</button>');
});
it('refreshes the ending daily points from the selected current and matched comparison values',()=>{
 const model=explorerTrendData({current:selected,previous,context:{current:[point('2026-10-13',999)],previous:[point('2026-10-12',140)]},filters,comparisonFrom:'2026-10-12',metric:'sessions',range:'7d'});
 expect(model.points[6]).toEqual({date:'2026-10-13',current:30,comparisonDate:'2026-10-12',previous:20});
});
