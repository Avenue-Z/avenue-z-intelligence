import {AuthorizedWorkspace} from '../../page';
export const dynamic='force-dynamic';
export default async function ClientPage({params}:{params:Promise<{clientId:string}>}) {const {clientId}=await params;return <AuthorizedWorkspace clientId={clientId}/>;}
