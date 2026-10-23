import {expect,it} from 'vitest';
import {workspaceDatasets,workspaceObservationSelection} from '../../lib/analytics/workspace-datasets';

it('prepares Beam commerce, media and experiments without subscription operations',()=>{
 expect(workspaceDatasets('overview','beam')).toEqual(['overview','funnels','revenue','media','experiments']);
 expect(workspaceDatasets('media','beam')).toEqual(['overview','media','creatives']);
 expect(workspaceDatasets('traffic','beam')).toEqual(['overview','funnels','traffic']);
 expect(workspaceDatasets('subscriptions','beam')).toEqual(workspaceDatasets('overview','beam'));
});

it('includes daily media history for Beam and keeps KP dataset and cache scope unchanged',()=>{
 expect(workspaceObservationSelection('media','beam').trendDatasets).toContain('media');
 expect(workspaceDatasets('overview')).toContain('subscriptions');
 expect(workspaceDatasets('overview','kind-patches')).toEqual(workspaceDatasets('overview'));
 expect(workspaceObservationSelection('media').trendDatasets).not.toContain('media');
 expect(workspaceObservationSelection('media','kind-patches')).toEqual(workspaceObservationSelection('media'));
});
