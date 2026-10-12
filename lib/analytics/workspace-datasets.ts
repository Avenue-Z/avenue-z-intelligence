/** Pure dataset scope shared by workspace reads and independent cache warming. */
export function workspaceDatasets(view:string):string[]{
 const core=['overview','subscriptions','subscriptionEvents'];
 if(view==='overview')return ['overview','funnels','revenue','media','subscriptions','subscriptionEvents'];
 if(view==='traffic'||view==='funnels')return [...core,'funnels','traffic'];
 if(view==='subscriptions')return core;
 if(view==='media')return [...core,'media'];
 if(view==='reviews'||view==='settings')return [...core,view];
 return ['overview',view,'subscriptions','subscriptionEvents'];
}
