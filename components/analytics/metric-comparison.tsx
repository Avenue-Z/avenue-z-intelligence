import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import type { QueryFilters } from '../../lib/analytics/contracts';
import { finiteMetric, money, multiple, number, percent } from '../../lib/analytics/display';
import styles from './metric-comparison.module.css';
import type { ComponentProps } from 'react';

export function comparisonLabel(filters: Pick<QueryFilters,'compare'|'from'|'to'>) {
  if (filters.compare === 'previous') return filters.from === filters.to ? 'yesterday' : 'previous period';
  return filters.compare === 'weekday' ? 'last week' : filters.compare === 'fourWeeks' ? 'four weeks earlier' : filters.compare === 'thirtyDays' ? '30 days earlier' : 'comparison';
}

type Unit = 'count' | 'currency' | 'rate' | 'multiple';
export function MetricComparison({current,previous,unit='count',currency='USD',label='yesterday',lowerIsBetter=false,neutral=false,baseline=true}:{current:number|null|undefined;previous:number|null|undefined;unit?:Unit;currency?:string;label?:string;lowerIsBetter?:boolean;neutral?:boolean;baseline?:boolean}) {
  if (!finiteMetric(current) || !finiteMetric(previous)) return <span className={styles.missing}>— vs {label}</span>;
  const difference=current-previous,Icon=difference>0?ArrowUp:difference<0?ArrowDown:ArrowRight;
  const tone=neutral||difference===0?'neutral':(lowerIsBetter?difference<0:difference>0)?'favorable':'unfavorable';
  const format=unit==='currency'?money:unit==='rate'?percent:unit==='multiple'?multiple:number;
  const change=unit==='rate'?`${difference>0?'+':''}${(difference*100).toFixed(2)} pp`:previous===0?`${difference>0?'+':''}${format(difference,currency)}`:`${difference>0?'+':''}${(difference/Math.abs(previous)*100).toFixed(1)}%`;
  return <span className={styles.comparison}><span className={styles.delta} data-tone={tone} aria-label={`${difference>0?'Increased':difference<0?'Decreased':'Unchanged'} ${change} vs ${label}`}><Icon size={12} aria-hidden="true"/>{change}</span><span className={styles.baseline}>vs {label}{baseline?` · ${format(previous,currency)}`:''}</span></span>;
}

export function ComparisonStat({title,value,note,...comparison}:ComponentProps<typeof MetricComparison>&{title:string;value:string;note?:string}) {
  return <div className="stat-card"><span className="stat-label">{title}</span><strong>{value}</strong><MetricComparison {...comparison}/>{note&&<span className="stat-note">{note}</span>}</div>;
}
