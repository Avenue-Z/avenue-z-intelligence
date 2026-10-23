'use client';
import {useMemo,useState} from 'react';
import {finiteMetric,money,number} from '../../lib/analytics/display';
import type {QueryFilters} from '../../lib/analytics/contracts';
import {aggregateExplorerRows,explorerMetric,type ExplorerMetric,type ExplorerSeriesPoint} from '../../lib/analytics/traffic-explorer';
import {ComparisonStat,MetricComparison,comparisonLabel} from './metric-comparison';
import {unsupportedClientFilterReset} from '../../lib/analytics/client-filter-policy';
import {ExplorerMetricPicker,ExplorerComparisonPicker,ExplorerRanking,ExplorerTrend,formatExplorerMetric,type ExplorerRecord} from './traffic-workspace';
import styles from './traffic-workspace.module.css';

type MarketRecord=ExplorerRecord;
const marketMetrics:ExplorerMetric[]=['revenue','orders','aov','refunds','discounts'];
const noRows:ExplorerRecord['details']=[];
const noSeries:ExplorerSeriesPoint[]=[];
// Session-only countries do not define financial totals. Keep financial rows
// with missing values so the strict aggregate still reports those as unknown.
const financialTotals=(rows:MarketRecord['details'])=>aggregateExplorerRows(rows.filter(row=>marketMetrics.some(metric=>Object.hasOwn(row.metrics,metric))),'all')[0];
export function marketWorkspaceHref(clientId:string,filters:QueryFilters,market:string){
 const params=new URLSearchParams(Object.entries({...filters,...unsupportedClientFilterReset(filters,'markets'),view:'markets',market:market==='Unspecified'?'':market}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
 return `/clients/${encodeURIComponent(clientId)}?${params}`;
}

export function MarketWorkspace({record,filters,update}:{record:MarketRecord;filters:QueryFilters;update:(changes:Record<string,string>)=>void}){
 const [metric,setMetric]=useState<ExplorerMetric>('revenue'),[top,setTop]=useState(10);
 const rows=record.views.markets?.details??(filters.view==='markets'?record.details:noRows),previousRows=record.comparisonViews?.markets?.details??noRows;
 const groups=useMemo(()=>aggregateExplorerRows(rows,'market'),[rows]),totals=useMemo(()=>financialTotals(rows),[rows]);
 const previousGroups=useMemo(()=>aggregateExplorerRows(previousRows,'market'),[previousRows]),previousTotals=useMemo(()=>financialTotals(previousRows),[previousRows]);
 const previousByMarket=useMemo(()=>new Map(previousGroups.map(group=>[group.label,group])),[previousGroups]);
 const label=comparisonLabel(filters),currency=record.client.currency;
 const current=record.datasetSeries?.markets??noSeries,previous=record.comparisonDatasetSeries?.markets??noSeries;
 const trendContext=useMemo(()=>({current:record.trendDatasetSeries?.markets??current,previous:record.trendComparisonDatasetSeries?.markets??previous}),[record.trendDatasetSeries,record.trendComparisonDatasetSeries,current,previous]);
 const availableMetrics=marketMetrics.filter(key=>key==='revenue'||key==='orders'||key==='aov'||groups.some(group=>finiteMetric(explorerMetric(group,key))));
 const markets=record.availableDimensions.market??[];
 const selectMarket=(market:string)=>update({...unsupportedClientFilterReset(filters,'markets'),view:'markets',market:market==='Unspecified'?'':market});
 return <>
  {filters.market&&<div className="panel-heading"><h2>{filters.market} market</h2><button type="button" className="small-button" onClick={()=>selectMarket('')}>Show all markets</button></div>}
  <div className="stat-grid">
   <ComparisonStat title="REVENUE" value={money(totals?.metrics.revenue,currency)} current={totals?.metrics.revenue} previous={previousTotals?.metrics.revenue} unit="currency" currency={currency} label={label}/>
   <ComparisonStat title="ORDERS" value={number(totals?.metrics.orders)} current={totals?.metrics.orders} previous={previousTotals?.metrics.orders} label={label}/>
   <ComparisonStat title="AOV" value={money(totals?explorerMetric(totals,'aov'):null,currency)} current={totals?explorerMetric(totals,'aov'):null} previous={previousTotals?explorerMetric(previousTotals,'aov'):null} unit="currency" currency={currency} label={label}/>
   <ComparisonStat title="MARKETS" value={number(groups.length||null)} current={groups.length||null} previous={previousGroups.length||null} label={label} neutral/>
  </div>
  <div className={styles.workspaceControls}>
   <label className={styles.control}>Market<select aria-label="Market trend selection" value={filters.market} onChange={event=>selectMarket(event.target.value)}><option value="">All markets</option>{markets.map(market=><option value={market} key={market}>{market}</option>)}</select></label>
   <ExplorerMetricPicker metric={metric} setMetric={setMetric} metrics={availableMetrics} label="Market chart metric"/>
   <ExplorerComparisonPicker filters={filters} update={update} label="Market trend comparison"/>
   <label className={styles.control}>Rank<select aria-label="Market ranking size" value={top} onChange={event=>setTop(Number(event.target.value))}><option value={5}>Top 5</option><option value={10}>Top 10</option><option value={20}>Top 20</option></select></label>
  </div>
  <ExplorerTrend current={current} previous={previous} context={trendContext} filters={filters} comparisonFrom={record.comparison.from} metric={metric} currency={currency} timezone={record.client.timezone} heading={`${filters.market||'All markets'} performance over time`}/>
  <ExplorerRanking groups={groups} previousGroups={previousGroups} comparisonLabel={label} metric={metric} currency={currency} title="Market performance" description="Select a market to view its performance" top={top} onSelect={selectMarket}/>
  <div className="panel">
   <div className="panel-heading"><h2>{filters.market?`${filters.market} market totals`:'Market totals'}</h2></div>
   <div className="table-scroll"><table className="data-table"><thead><tr><th>Market</th>{availableMetrics.map(key=><th key={key}>{key==='aov'?'AOV':key[0].toUpperCase()+key.slice(1)}</th>)}</tr></thead>
    <tbody>{[...groups].sort((a,b)=>(b.metrics.revenue??-1)-(a.metrics.revenue??-1)).map(group=><tr key={group.key}>
     <td><a className={styles.segmentLink} aria-label={`View ${group.label} market`} aria-current={filters.market===group.label?'page':undefined} href={marketWorkspaceHref(record.client.id,filters,group.label)} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();selectMarket(group.label);}}}>{group.label}<span>{filters.market===group.label?'Selected market':'View market →'}</span></a></td>
     {availableMetrics.map(key=><td key={key}>{formatExplorerMetric(key,explorerMetric(group,key),currency)}<MetricComparison current={explorerMetric(group,key)} previous={previousByMarket.has(group.label)?explorerMetric(previousByMarket.get(group.label)!,key):null} unit={key==='orders'?'count':'currency'} currency={currency} label={label} lowerIsBetter={key==='refunds'||key==='discounts'}/></td>)}
    </tr>)}</tbody>
   </table>{!groups.length&&<p className={styles.quiet}>No market observations are captured for this selection.</p>}</div>
  </div>
 </>;
}
