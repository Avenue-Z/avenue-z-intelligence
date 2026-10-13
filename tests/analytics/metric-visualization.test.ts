import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {Bar,Line} from 'recharts';
import {MetricVisualization,metricChartMark,metricSeriesChartMark,type MetricSeriesPoint} from '../../components/analytics/metric-visualization';
const render=(series:MetricSeriesPoint[],comparisonSeries:MetricSeriesPoint[])=>renderToStaticMarkup(createElement(MetricVisualization,{title:'Sales performance over time',series,comparisonSeries,metrics:[{key:'revenue',label:'Sales',unit:'currency'}],currency:'USD',timezone:'Europe/Stockholm',currentFrom:'2026-10-11',comparisonFrom:'2026-10-10',comparisonLabel:'Previous period'}));
it('shows a one-day selection as bars and explains that it is a comparison rather than a fabricated trend',()=>{
 const html=render([{date:'2026-10-11',revenue:100}],[{date:'2026-10-10',revenue:80}]);
 expect(html).toMatch(/aria-pressed="true"[^>]*>Bars</);expect(html).toContain('One selected store day');expect(html).toContain('Light bars: Previous period');expect(html).not.toContain('Dashed lines: Previous period');
});
it('keeps a multi-day selection in line mode without inventing dates',()=>{
 const html=render([{date:'2026-10-11',revenue:100},{date:'2026-10-12',revenue:120}],[{date:'2026-10-10',revenue:80},{date:'2026-10-11',revenue:90}]);
 expect(html).toMatch(/aria-pressed="true"[^>]*>Line</);expect(html).toContain('Dashed lines: Previous period');expect(html).not.toContain('One selected store day');
});

it('renders both compared values as grouped bars and uses their distinct real data keys',()=>{
 const current=metricChartMark({key:'revenue',label:'Sales',unit:'currency'},'bar',1,'blue'),comparison=metricChartMark({key:'revenue',label:'Sales',unit:'currency'},'bar',1,'blue','Previous period');
 expect(current.type).toBe(Bar);expect(comparison.type).toBe(Bar);expect(current.props).toMatchObject({dataKey:'revenue'});expect(comparison.props).toMatchObject({dataKey:'comparison_revenue',name:'Sales · Previous period'});
});
it('keeps a comparison point visible when the user explicitly chooses line mode for one day',()=>{
 const comparison=metricChartMark({key:'revenue',label:'Sales',unit:'currency'},'line',1,'blue','Previous period');expect(comparison.type).toBe(Line);expect(comparison.props).toMatchObject({dataKey:'comparison_revenue',dot:{r:3},connectNulls:false});
});
it('keeps isolated captured values visible inside a thirty-day context of missing observations',()=>{
 const rows=Array.from({length:30},(_,index)=>({date:`2026-09-${String(index+1).padStart(2,'0')}`,revenue:index===29?100:null,comparison_revenue:index===28?80:null}));
 for(const label of [undefined,'Yesterday']){const mark=metricSeriesChartMark({key:'revenue',label:'Sales',unit:'currency'},'line',rows,'blue',label);expect(mark.props).toMatchObject({dot:{r:3},connectNulls:false});}
 expect(rows.filter(row=>row.revenue!==null)).toHaveLength(1);
});
it('retains dots for many separated observations without connecting their missing store days',()=>{
 const rows=Array.from({length:30},(_,index)=>({date:`2026-09-${String(index+1).padStart(2,'0')}`,revenue:index%2?100+index:null}));
 const mark=metricSeriesChartMark({key:'revenue',label:'Sales',unit:'currency'},'line',rows,'blue');expect(mark.props).toMatchObject({dot:{r:3},connectNulls:false});
});
