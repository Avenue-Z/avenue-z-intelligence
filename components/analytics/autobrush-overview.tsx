'use client';
import {useMemo,useState} from 'react';
import type {ClientRecord} from './records';
import type {QueryFilters} from '../../lib/analytics/contracts';
import {ComparisonStat,comparisonLabel} from './metric-comparison';
import {money,number,percent} from '../../lib/analytics/display';
import {MetricVisualization,type ChartMetric} from './metric-visualization';
import {RevenueMixChart} from './chart';
import {beamOverviewChartContext as overviewChartContext} from '../../lib/analytics/beam-overview';
import type {TrendContextMode} from '../../lib/analytics/trend-context';
import {ExperimentReports} from './beam-overview';

const sales:ChartMetric[]=[{key:'revenue',label:'Net sales',unit:'currency',color:'var(--az-blue)'},{key:'orders',label:'Orders',unit:'count',color:'var(--az-purple)'},{key:'aov',label:'Average order value',unit:'currency',color:'var(--az-teal)'}];
const traffic:ChartMetric[]=[{key:'sessions',label:'Human sessions',unit:'count',color:'var(--az-teal)'},{key:'cvr',label:'Conversion rate',unit:'percent',color:'var(--az-purple)'},{key:'atc',label:'Add-to-cart rate',unit:'percent',color:'var(--az-blue)'}];
export function AutobrushOverview({record,filters,update}:{record:ClientRecord;filters:QueryFilters;update:(changes:Record<string,string>)=>void}){
 const [window,setWindow]=useState<TrendContextMode>(filters.from===filters.to?'7d':'selected');
 const context=useMemo(()=>overviewChartContext(record,filters,window),[record,filters,window]),a=record.metrics,b=record.prior,currency=record.client.currency,label=comparisonLabel(filters);
 return <>
  <div className="panel-heading"><h2>Store performance</h2><button className="small-button" onClick={()=>update({view:'media'})}>Meta spend & delivery</button></div>
  <div className="stat-grid">
   <ComparisonStat title="NET SALES" value={money(a.revenue,currency)} current={a.revenue} previous={b.revenue} unit="currency" currency={currency} label={label}/>
   <ComparisonStat title="ORDERS" value={number(a.orders)} current={a.orders} previous={b.orders} label={label}/>
   <ComparisonStat title="HUMAN SESSIONS" value={number(a.sessions)} current={a.sessions} previous={b.sessions} label={label}/>
   <ComparisonStat title="CONVERSION RATE" value={percent(a.cvr)} current={a.cvr} previous={b.cvr} unit="rate" label={label}/>
  </div>
  <div className="inline-controls" role="group" aria-label="Overview chart period" style={{margin:'12px 0',flexWrap:'wrap'}}>{(['7d','30d','selected'] as const).map(value=><button key={value} className="small-button" aria-pressed={window===value} onClick={()=>setWindow(value)}>{value==='selected'?'Selected period':value==='7d'?'7 days':'30 days'}</button>)}</div>
  <div className="two-columns">
   <MetricVisualization title="Sales performance" series={context.current} comparisonSeries={context.previous} metrics={sales} defaultMetrics={['revenue']} currency={currency} timezone={record.client.timezone} currentFrom={context.from} comparisonFrom={context.comparisonFrom} comparisonLabel={label} onRange={(from,to)=>update({from,to,period:''})}/>
   <MetricVisualization title="Traffic & conversion" series={context.current} comparisonSeries={context.previous} metrics={traffic} defaultMetrics={['sessions']} currency={currency} timezone={record.client.timezone} currentFrom={context.from} comparisonFrom={context.comparisonFrom} comparisonLabel={label} onRange={(from,to)=>update({from,to,period:''})}/>
  </div>
  <section className="panel"><div className="panel-heading"><h2>Sales channel mix</h2><button className="small-button" onClick={()=>update({view:'revenue'})}>Explore revenue</button></div><RevenueMixChart rows={record.views.revenue?.details??[]} currency={currency}/></section>
  {!!record.experimentDailyDetails?.length&&<ExperimentReports reports={record.experimentDailyDetails} marketScope="all"/>}
 </>;
}
