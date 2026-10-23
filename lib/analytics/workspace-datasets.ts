/** Pure dataset scope shared by workspace reads and independent cache warming. */
export function workspaceDatasets(view:string,clientId?:string|number):string[]{
 if(clientId==='beam'||clientId==='autobrush'){
  if(view==='overview'||view==='subscriptions')return ['overview','funnels','revenue','media','experiments'];
  if(view==='traffic'||view==='funnels')return ['overview','funnels','traffic'];
  if(view==='media')return ['overview','media','creatives'];
  return ['overview',view];
 }
 const core=['overview','subscriptions','subscriptionEvents'];
 if(view==='overview')return ['overview','funnels','revenue','media','subscriptions','subscriptionEvents','orderStreams','renewalDiagnostics','orderHygiene'];
 if(view==='traffic'||view==='funnels')return [...core,'funnels','traffic'];
 if(view==='subscriptions')return [...core,'orderStreams','renewalDiagnostics'];
 if(view==='media')return [...core,'media'];
 if(view==='reviews'||view==='settings')return [...core,view];
 return ['overview',view,'subscriptions','subscriptionEvents',...view==='revenue'?['orderStreams','orderHygiene']:view==='products'?['orderHygiene']:[]];
}
/** Foreground and native warming share an exact load-affecting selection.
 * Supplemental prior-week detail remains available to AI/review Store callers.
 */
export function workspaceObservationSelection(viewOrDatasets:string|string[],clientId?:string){
 const datasets=(Array.isArray(viewOrDatasets)?viewOrDatasets:workspaceDatasets(viewOrDatasets,clientId)).filter(dataset=>dataset!=='reviews'&&dataset!=='settings');
 const includeOperations=clientId!=='beam'&&clientId!=='autobrush'&&(datasets.includes('renewalDiagnostics')||datasets.includes('media')&&datasets.includes('revenue'));
 return {datasets,includePriorWeek:false,includeOperations,trendDatasets:datasets.filter(dataset=>['overview','revenue','traffic','markets','products','subscriptions','subscriptionEvents',...['beam','autobrush'].includes(String(clientId))?['media']:[],...!datasets.includes('traffic')&&!datasets.includes('revenue')?['funnels']:[]].includes(dataset))};
}
