import { useEffect } from 'react';
import { getSundayInbox, type AuthStatus } from '../api';
import { useQuery, invalidate } from './useQuery';
import { useTopic } from './stream';
export function useSundayInbox(identity: AuthStatus | null) {
  const uid = identity?.authenticated ? identity.user?.id : null;
  const revision = useTopic<{ revision: string }>(uid ? `sunday:${uid}` : null);
  const inbox = useQuery(uid ? `sunday-inbox:${uid}` : null, getSundayInbox);
  useEffect(() => { if (uid && revision) invalidate(`sunday-inbox:${uid}`); }, [uid, revision]);
  return { ...inbox, revision };
}
