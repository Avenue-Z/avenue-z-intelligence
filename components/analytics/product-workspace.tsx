'use client';
import {useMemo,useState} from 'react';
import type {QueryFilters} from '../../lib/analytics/contracts';
import {contextSeries,trendContextRange,type TrendContextMode} from '../../lib/analytics/trend-context';
import {MetricVisualization,type ChartMetric,type MetricSeriesPoint} from './metric-visualization';
import type {ClientRecord} from './records';

type ProductDay={date:string;metrics:Record<string,number|null>;summary?:Record<string,number|null>};
type ProductRecord=Omit<ClientRecord,'datasetSeries'|'comparisonDatasetSeries'|'datasetHistorySeries'|'trendDatasetSeries'|'trendComparisonDatasetSeries'>&{
 datasetSeries?:Record<string,ProductDay[]>;
 comparisonDatasetSeries?:Record<string,ProductDay[]>;
 trendDatasetSeries?:Record<string,ProductDay[]>;
 trendComparisonDatasetSeries?:Record<string,ProductDay[]>;
};
const metrics:ChartMetric[]=[{key:'revenue',label:'Net sales',unit:'currency'},{key:'orders',label:'Product orders',unit:'count'},{key:'aov',label:'Average order value',unit:'currency'},{key:'discounts',label:'Discounts',unit:'currency'}];

export function productChartContext(record:ProductRecord,filters:QueryFilters,window:TrendContextMode){
 const dates=trendContextRange(filters,window,record.comparison.from),range={from:dates.from,to:dates.to},comparisonRange={from:dates.comparisonFrom,to:dates.comparisonTo};
 const flatten=(rows:ProductDay[]):MetricSeriesPoint[]=>rows.map(point=>({date:point.date,...point.metrics,...point.summary}));
 return {range,comparisonRange,series:flatten(contextSeries(record.datasetSeries?.products??[],record.trendDatasetSeries?.products??[],range)),comparisonSeries:flatten(contextSeries(record.comparisonDatasetSeries?.products??[],record.trendComparisonDatasetSeries?.products??[],comparisonRange))};
}

export function ProductWorkspace({record,filters}:{record:ProductRecord;filters:QueryFilters}){
 const [chosenContext,setContext]=useState<TrendContextMode|null>(null),window=chosenContext??(filters.from===filters.to?'7d':'selected');
 const context=useMemo(()=>productChartContext(record,filters,window),[record,filters,window]);
 return <div>
  <div className="inline-controls" role="group" aria-label="Product chart period" style={{margin:'12px 0',flexWrap:'wrap'}}>{(['7d','30d','selected'] as const).map(value=><button key={value} type="button" className="small-button" aria-pressed={window===value} onClick={()=>setContext(value)}>{value==='selected'?'Selected period':`${value==='7d'?7:30} days`}</button>)}</div>
  <MetricVisualization title="Product performance over time" subtitle={`${context.range.from} – ${context.range.to} · ${record.client.timezone}`} series={context.series} comparisonSeries={context.comparisonSeries} metrics={metrics} currency={record.client.currency} timezone={record.client.timezone} currentFrom={context.range.from} comparisonFrom={context.comparisonRange.from} comparisonLabel={`${context.comparisonRange.from} – ${context.comparisonRange.to}`} defaultMetrics={['revenue']} caption="Product order counts can overlap; these are reported product counts, not unique store orders."/>
 </div>;
}
