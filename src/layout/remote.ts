import { getRemoteCampuses, type RemoteServer } from '../api';
import { useQuery } from '../lib/useQuery';

// Linked servers' campuses (ADR 0018). One shared query for the sidebar picker
// and Home. The directory changes on a human timescale and the server already
// refreshes it from each peer every minute, so a slow poll is plenty; the live
// part — mode, show, next event — arrives separately on each server's digest
// topic.
const NONE: RemoteServer[] = [];

export function useRemoteServers(): RemoteServer[] {
  return useQuery('federation-campuses', getRemoteCampuses, { pollMs: 60_000, staleMs: 30_000 }).data ?? NONE;
}
