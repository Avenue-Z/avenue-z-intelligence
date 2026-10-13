'use client';
import {useMemo,useState} from 'react';
import {finiteMetric,money,number} from '../../lib/analytics/display';
import type {QueryFilters} from '../../lib/analytics/contracts';
import {aggregateExplorerRows,explorerMetric,type ExplorerMetric,type ExplorerSeriesPoint} from '../../lib/analytics/traffic-explorer';
import {ComparisonStat,MetricComparison,comparisonLabel} from './metric-comparison';
import {ExplorerMetricPicker,ExplorerComparisonPicker,ExplorerRanking,ExplorerTrend,formatExplorerMetric,type ExplorerRecord} from './traffic-workspace';
import styles from './traffic-workspace.module.css';

type MarketRecord=ExplorerRecord;
const marketMetrics:ExplorerMetric[]=['revenue','orders','aov','refunds','discounts'];
const noRows:ExplorerRecord['details']=[];
const noSeries:ExplorerSeriesPoint[]=[];

export function MarketWorkspace({record,filters,update}:{record:MarketRecord;filters:QueryFilters;update:(changes:Record<string,string>)=>void}){
 const [metric,setMetric]=useState<ExplorerMetric>('revenue'),[top,setTop]=useState(10);
 const rows=record.views.markets?.details??(filters.view==='markets'?record.details:noRows),previousRows=record.comparisonViews?.markets?.details??noRows;
 const groups=useMemo(()=>aggregateExplorerRows(rows,'market'),[rows]),totals=useMemo(()=>aggregateExplorerRows(rows,'all')[0],[rows]);
 const previousGroups=useMemo(()=>aggregateExplorerRows(previousRows,'market'),[previousRows]),previousTotals=useMemo(()=>aggregateExplorerRows(previousRows,'all')[0],[previousRows]);
 const previousByMarket=useMemo(()=>new Map(previousGroups.map(group=>[group.label,group])),[previousGroups]);
 const label=comparisonLabel(filters),currency=record.client.currency;
 const current=record.datasetSeries?.markets??noSeries,previous=record.comparisonDatasetSeries?.markets??noSeries;
 const trendContext=useMemo(()=>({current:record.trendDatasetSeries?.markets??current,previous:record.trendComparisonDatasetSeries?.markets??previous}),[record.trendDatasetSeries,record.trendComparisonDatasetSeries,current,previous]);
 const availableMetrics=marketMetrics.filter(key=>key==='revenue'||key==='orders'||key==='aov'||groups.some(group=>finiteMetric(explorerMetric(group,key))));
 const markets=record.availableDimensions.market??[];
 return <>
  <div className="stat-grid">
   <ComparisonStat title="REVENUE" value={money(totals?.metrics.revenue,currency)} current={totals?.metrics.revenue} previous={previousTotals?.metrics.revenue} unit="currency" currency={currency} label={label}/>
   <ComparisonStat title="ORDERS" value={number(totals?.metrics.orders)} current={totals?.metrics.orders} previous={previousTotals?.metrics.orders} label={label}/>
   <ComparisonStat title="AOV" value={money(totals?explorerMetric(totals,'aov'):null,currency)} current={totals?explorerMetric(totals,'aov'):null} previous={previousTotals?explorerMetric(previousTotals,'aov'):null} unit="currency" currency={currency} label={label}/>
   <ComparisonStat title="MARKETS" value={number(groups.length||null)} current={groups.length||null} previous={previousGroups.length||null} label={label} neutral/>
  </div>
  <div className={styles.workspaceControls}>
   <label className={styles.control}>Market<select aria-label="Market trend selection" value={filters.market} onChange={event=>update({market:event.target.value})}><option value="">All markets</option>{markets.map(market=><option value={market} key={market}>{market}</option>)}</select></label>
   <ExplorerMetricPicker metric={metric} setMetric={setMetric} metrics={availableMetrics} label="Market chart metric"/>
   <ExplorerComparisonPicker filters={filters} update={update} label="Market trend comparison"/>
   <label className={styles.control}>Rank<select aria-label="Market ranking size" value={top} onChange={event=>setTop(Number(event.target.value))}><option value={5}>Top 5</option><option value={10}>Top 10</option><option value={20}>Top 20</option></select></label>
  </div>
  <ExplorerTrend current={current} previous={previous} context={trendContext} filters={filters} comparisonFrom={record.comparison.from} metric={metric} currency={currency} timezone={record.client.timezone} heading={`${filters.market||'All markets'} performance over time`}/>
  <ExplorerRanking groups={groups} previousGroups={previousGroups} comparisonLabel={label} metric={metric} currency={currency} title="Market performance" description="Click a market to explore its trend" top={top} onSelect={market=>update({market:market==='Unspecified'?'':market})}/>
  <div className="panel">
   <div className="panel-heading"><h2>Market totals</h2><button className="small-button" disabled={!filters.market} onClick={()=>update({market:''})}>Show all markets</button></div>
   <div className="table-scroll"><table className="data-table"><thead><tr><th>Market</th>{availableMetrics.map(key=><th key={key}>{key==='aov'?'AOV':key[0].toUpperCase()+key.slice(1)}</th>)}</tr></thead>
    <tbody>{[...groups].sort((a,b)=>(b.metrics.revenue??-1)-(a.metrics.revenue??-1)).map(group=><tr key={group.key}>
     <td><button className={styles.segmentLink} onClick={()=>update({market:group.label==='Unspecified'?'':group.label})}>{group.label}<span>Explore daily trend →</span></button></td>
     {availableMetrics.map(key=><td key={key}>{formatExplorerMetric(key,explorerMetric(group,key),currency)}<MetricComparison current={explorerMetric(group,key)} previous={previousByMarket.has(group.label)?explorerMetric(previousByMarket.get(group.label)!,key):null} unit={key==='orders'?'count':'currency'} currency={currency} label={label} lowerIsBetter={key==='refunds'||key==='discounts'}/></td>)}
    </tr>)}</tbody>
   </table>{!groups.length&&<p className={styles.quiet}>No market observations are captured for this selection.</p>}</div>
  </div>
 </>;
}
