'use client';
import {useState} from 'react';
import {CartesianGrid,Line,LineChart,ReferenceLine,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {PORTFOLIO_METRICS,type PortfolioMetricKey, type buildPortfolioOverview} from '../../lib/analytics/portfolio';
import {finiteMetric} from '../../lib/analytics/display';
import styles from './executive-overview.module.css';

export type PortfolioBrand=ReturnType<typeof buildPortfolioOverview>['brands'][number];
type PortfolioPoint=PortfolioBrand['points'][number];
type Metric=typeof PORTFOLIO_METRICS[number];
export type PortfolioChartMode='actual'|'change';
type ChartRow={date:string;[key:string]:number|string|null};
export function formatPortfolioValue(value:number|null,metric:Metric,currency:string,compact=false){
 if(!finiteMetric(value))return '—';
 if(metric.unit==='percent')return `${(value*100).toFixed(compact?1:2)}%`;
 return new Intl.NumberFormat('en-US',{...metric.unit==='currency'?{style:'currency',currency}:{},...compact?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:metric.unit==='currency'?2:0,minimumFractionDigits:metric.key==='aov'?2:0}}).format(value);
}
export function formatPortfolioChange(value:number|null){return finiteMetric(value)?`${value>0?'+':''}${(value*100).toFixed(2)}%`:'—';}
/** Presentation keys preserve the model's dated gaps, zeroes and separate brand values. */
export function portfolioChartRows(brands:PortfolioBrand[],mode:PortfolioChartMode):ChartRow[]{
 const dates=[...new Set(brands.flatMap(brand=>brand.points.map(point=>point.date)))].sort();
 return dates.map(date=>{const row:ChartRow={date};brands.forEach((brand,index)=>{const point=brand.points.find(value=>value.date===date);row[`brand_${index}`]=finiteMetric(mode==='change'?point?.change:point?.value)?(mode==='change'?point!.change:point!.value):null;row[`prior_${index}`]=finiteMetric(point?.previous)?point!.previous:null;});return row;});
}
export function portfolioChartLine(brand:PortfolioBrand,index:number,rows:ChartRow[],comparison=false){
 const key=`${comparison?'prior':'brand'}_${index}`,available=rows.filter(row=>finiteMetric(typeof row[key]==='number'?row[key] as number:null)).length;
 return <Line key={key} name={`${brand.name}${comparison?' · comparison':''}`} dataKey={key} type="linear" stroke={brand.color} strokeWidth={comparison?1.4:2.4} strokeDasharray={comparison?'5 4':undefined} strokeOpacity={comparison?.6:1} dot={available<8||available<rows.length?{r:2.6,fill:brand.color,strokeWidth:0}:false} activeDot={{r:4,fill:brand.color}} connectNulls={false} isAnimationActive={false}/>;
}
export function PortfolioChartTooltip({active,label,brands,metric,mode,compare}:{active?:boolean;label?:unknown;brands:PortfolioBrand[];metric:Metric;mode:PortfolioChartMode;compare:boolean}){
 if(!active||label==null)return null;
 const date=String(label);
 return <div className={styles.tooltip}><strong>{date}</strong>{brands.map(brand=>{const point=brand.points.find(value=>value.date===date);return <div className={styles.tooltipBrand} key={brand.id}><div className={styles.tooltipTitle}><span><i style={{background:brand.color}}/>{brand.name}</span><b>{mode==='change'?formatPortfolioChange(point?.change??null):formatPortfolioValue(point?.value??null,metric,brand.currency)}</b></div><small>{brand.timezone} · {brand.currency}</small><div className={styles.tooltipValues}><span>{date}</span><b>{formatPortfolioValue(point?.value??null,metric,brand.currency)}</b></div>{compare&&<div className={styles.tooltipValues}><span>{point?.comparisonDate??'Comparison unavailable'}</span><b>{formatPortfolioValue(point?.previous??null,metric,brand.currency)}</b></div>}<small>{metric.key==='spend'?brand.spendScope:brand.scope}</small>{metric.key==='spend'&&brand.spendNote&&<small>Selected report cache · {brand.spendNote}</small>}</div>;})}</div>;
}
export function PortfolioSparkline({points,color,label}:{points:PortfolioPoint[];color:string;label:string}){
 const values=points.filter(point=>finiteMetric(point.value)).map(point=>point.value as number);
 if(!values.length)return <span className={styles.noSpark}>No dated trend</span>;
 const low=Math.min(...values),high=Math.max(...values),width=96,height=26,range=high-low;
 const dots=points.flatMap((point,index)=>{if(!finiteMetric(point.value))return [];const previous=points[index-1],contiguous=previous&&finiteMetric(previous.value)&&Date.parse(point.date)-Date.parse(previous.date)===86400000;return [{x:2+index/Math.max(1,points.length-1)*(width-4),y:range?height-3-(point.value-low)/range*(height-6):height/2,date:point.date,value:point.value,command:contiguous?'L':'M'}];});
 const path=dots.map(dot=>`${dot.command}${dot.x.toFixed(2)} ${dot.y.toFixed(2)}`).join(' ');
 return <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}><path d={path} stroke={color} strokeWidth="1.8" fill="none"/>{dots.map(dot=><circle key={dot.date} cx={dot.x} cy={dot.y} r={dots.length<8?1.8:1.1} fill={color}><title>{`${dot.date}: ${dot.value.toLocaleString('en-US')}`}</title></circle>)}</svg>;
}
export function PortfolioChart({brands,metric,window,mixedCurrencies,onMetric,onWindow}:{brands:PortfolioBrand[];metric:Metric;window:'7d'|'30d'|'selected';mixedCurrencies:boolean;onMetric:(metric:PortfolioMetricKey)=>void;onWindow:(window:'7d'|'30d'|'selected')=>void}){
 const [chosenMode,setMode]=useState<PortfolioChartMode>('actual'),[compare,setCompare]=useState(true),[hidden,setHidden]=useState<string[]>([]);
 const mode=mixedCurrencies&&metric.unit==='currency'?'change':chosenMode,shown=brands.filter(brand=>!hidden.includes(brand.id));
 const rows=portfolioChartRows(shown,mode),available=rows.some(row=>shown.some((_,index)=>finiteMetric(typeof row[`brand_${index}`]==='number'?row[`brand_${index}`] as number:null)||mode==='actual'&&compare&&finiteMetric(typeof row[`prior_${index}`]==='number'?row[`prior_${index}`] as number:null)));
 const percent=mode==='change'||metric.unit==='percent',axisCurrency=shown[0]?.currency??'USD';
 function toggle(id:string){setHidden(previous=>previous.includes(id)?previous.filter(value=>value!==id):shown.length>1?[...previous,id]:previous);}
 return <section className={styles.chartPanel} aria-label="Portfolio performance chart">
  <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>BRAND TRENDS</span><h2>Performance over time</h2></div><div className={styles.controls}><label className={styles.selectLabel}>Metric<select aria-label="Portfolio chart metric" value={metric.key} onChange={event=>onMetric(event.target.value as PortfolioMetricKey)}>{PORTFOLIO_METRICS.map(value=><option key={value.key} value={value.key}>{value.label}</option>)}</select></label><div className={styles.segmented} role="group" aria-label="Portfolio chart range">{([['7d','7D'],['30d','30D'],['selected','Selected']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={window===value} onClick={()=>onWindow(value)}>{label}</button>)}</div></div></div>
  <div className={styles.chartToolbar}><div className={styles.segmented} role="group" aria-label="Portfolio chart values"><button type="button" aria-pressed={mode==='actual'} disabled={mixedCurrencies&&metric.unit==='currency'} onClick={()=>setMode('actual')}>Actual values</button><button type="button" aria-pressed={mode==='change'} onClick={()=>setMode('change')}>Change vs baseline</button></div><button type="button" className={styles.compareButton} aria-pressed={compare} onClick={()=>setCompare(value=>!value)}><span className={styles.dashedKey}/>Comparison</button></div>
  <div className={styles.brandToggles} role="group" aria-label="Chart brands">{brands.map(brand=>{const selected=!hidden.includes(brand.id);return <button type="button" key={brand.id} aria-pressed={selected} disabled={selected&&shown.length===1} onClick={()=>toggle(brand.id)} title={metric.key==='spend'?[brand.spendScope,brand.spendNote].filter(Boolean).join(' · '):brand.scope}><i style={{background:brand.color}}/>{brand.name}</button>;})}<span>{mode==='change'?'Change against each brand’s own comparison':`${metric.label} · ${metric.unit==='currency'?axisCurrency:metric.unit==='percent'?'%':'count'}`}</span></div>
  {!available?<div className={styles.chartEmpty}><strong>No dated {metric.label.toLowerCase()} comparison available</strong><p>{mode==='change'?'Each point needs a value and a usable comparison for its own brand.':'Dated values will appear here as they become available.'}</p></div>:<div className={styles.plot} role="img" aria-label={`${metric.label} by brand and date. ${mode==='change'?'Change against each brand’s own comparison.':'Actual values.'} Missing values remain gaps.`}><ResponsiveContainer width="100%" height={300}><LineChart data={rows} margin={{top:16,right:22,left:2,bottom:6}} accessibilityLayer><CartesianGrid stroke="var(--az-chart-grid)" vertical={false}/><XAxis dataKey="date" tickFormatter={value=>String(value).slice(5)} tick={{fill:'var(--az-muted)',fontSize:10}} stroke="var(--az-border)" axisLine={false} tickLine={false} minTickGap={28}/><YAxis width={66} tickFormatter={value=>percent?`${(Number(value)*100).toFixed(mode==='change'?0:1)}%`:formatPortfolioValue(Number(value),metric,axisCurrency,true)} tick={{fill:'var(--az-muted)',fontSize:10}} stroke="var(--az-border)" axisLine={false} tickLine={false}/><Tooltip content={<PortfolioChartTooltip brands={shown} metric={metric} mode={mode} compare={compare}/>} cursor={{stroke:'var(--az-border)'}}/>{mode==='change'&&compare&&<ReferenceLine y={0} stroke="var(--az-muted)" strokeDasharray="5 4"/>}{shown.flatMap((brand,index)=>[portfolioChartLine(brand,index,rows),...mode==='actual'&&compare?[portfolioChartLine(brand,index,rows,true)]:[]])}</LineChart></ResponsiveContainer></div>}
  <div className={styles.chartFooter}><span>{mixedCurrencies&&metric.unit==='currency'?'Different currencies · showing change vs baseline.':mode==='change'?'0% is each brand’s own comparison baseline.':compare?'Dashed lines show each brand’s comparison dates.':'Hover for exact dated values.'}</span><span>Hover for brand scope and dates · gaps stay blank</span></div>
 </section>;
}
