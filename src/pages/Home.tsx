import { useEffect, useState, type ReactNode } from 'react';
import { getEnabledIntegrations, getRooms, type RemoteCampus, type RemoteDigest, type RemoteServer, type RoomMeta } from '../api';
import { useQuery } from '../lib/useQuery';
import { remoteSummaryTopic, useTopic } from '../lib/stream';
import { useChurch } from '../layout/church';
import { inCampus, useCampus, ALL_CAMPUSES, remoteCampusId } from '../layout/campus';
import { useRemoteServers } from '../layout/remote';
import { RoomCard } from '../components/RoomCard';
import { RemoteRoomCard } from '../components/RemoteRoomCard';
import { SiteSection } from '../components/SiteSection';
import { ChevronDown, Network } from 'lucide-react';

// Campus overview: every room as a live status card, then the Quick Access
// launcher (Companion / Screen Sharing / device UIs) for the same campus.
//
// Cards are grouped under a header per campus whenever more than one campus is
// on screen: this server's campuses first, then each linked server's (ADR
// 0018). One campus needs no header; the page subtitle already names it.
export function Home() {
  const { campusId } = useCampus();
  const church = useChurch();
  const remote = useRemoteServers();
  const [rooms, setRooms] = useState<RoomMeta[]>([]);
  const enabledIntegrations = useQuery('enabled-integrations', getEnabledIntegrations, { staleMs: 60_000 }).data?.enabled;

  useEffect(() => {
    getRooms().then(setRooms).catch(() => {});
  }, []);

  const showRoomMode = enabledIntegrations?.companion !== false;
  const visibleRooms = rooms.filter((r) => inCampus(campusId, r.site));
  const visibleSites = church.sites.filter(
    (s) => campusId === ALL_CAMPUSES || s.id === campusId,
  );

  // Local groups in the Campuses editor's order, then any room whose campus
  // the topology no longer names (misconfiguration must not hide a room).
  const localGroups = visibleSites
    .map((site) => ({ site, rooms: visibleRooms.filter((r) => r.site === site.id) }))
    .filter((g) => g.rooms.length > 0 || campusId !== ALL_CAMPUSES);
  const orphans = visibleRooms.filter((r) => !church.sites.some((s) => s.id === r.site));

  const remoteGroups = remote.flatMap((server) => server.campuses
    .filter((c) => campusId === ALL_CAMPUSES || campusId === remoteCampusId(server.systemId, c.id))
    .map((campus) => ({ server, campus })));

  const groupCount = localGroups.length + (orphans.length ? 1 : 0) + remoteGroups.length;
  const headed = groupCount > 1;
  const roomCount = visibleRooms.length + remoteGroups.reduce((n, g) => n + g.campus.rooms.length, 0);

  const remoteSelected = remoteGroups.length === 1 && campusId !== ALL_CAMPUSES ? remoteGroups[0] : null;
  const campusName =
    campusId === ALL_CAMPUSES
      ? 'All campuses'
      : remoteSelected
        ? `${remoteSelected.campus.name} · ${remoteSelected.server.name}`
        : church.sites.find((s) => s.id === campusId)?.name ?? campusId;

  return (
    <div className="home">
      <div className="pagehead">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1 className="pagehead__title">Home</h1>
          <p className="pagehead__sub">{campusName}</p>
        </div>
      </div>

      <section className="home__overview" aria-labelledby="rooms-heading">
        <div className="home__section-head">
          <div>
            <p className="section-label">Room network</p>
            <h2 id="rooms-heading">Live room status</h2>
          </div>
          <span className="home__room-count mono">{roomCount.toString().padStart(2, '0')} ROOMS</span>
        </div>

        {localGroups.map(({ site, rooms: siteRooms }) => (
          <CampusGroup key={site.id} title={headed ? site.name : null} empty={rooms.length > 0}>
            {siteRooms.map((r) => <RoomCard key={r.id} room={r} showRoomMode={showRoomMode} />)}
          </CampusGroup>
        ))}
        {orphans.length > 0 && (
          <CampusGroup title={headed ? 'Other rooms' : null}>
            {orphans.map((r) => <RoomCard key={r.id} room={r} showRoomMode={showRoomMode} />)}
          </CampusGroup>
        )}
        {remoteGroups.map(({ server, campus }) => (
          <RemoteCampusGroup key={`${server.systemId}/${campus.id}`} server={server} campus={campus} headed={headed} />
        ))}
      </section>

      {/* Quick Access is this server's own device launchers; a linked
          server's campus has none here (they open from its own dashboard). */}
      {visibleSites.length > 0 && <details className="home__tools">
        <summary className="home__tools-summary">
          <span className="home__tools-icon"><Network size={17} /></span>
          <span>
            <strong>Infrastructure &amp; quick access</strong>
            <small>Companion, screen sharing, and device interfaces</small>
          </span>
          <ChevronDown className="home__tools-chevron" size={17} />
        </summary>
        <div className="home__tools-body">
          {visibleSites.map((site) => (
            <SiteSection key={site.id} site={site} />
          ))}
        </div>
      </details>}
    </div>
  );
}

function CampusGroup({ title, server, empty = true, children }: {
  title: string | null;
  /** The linked server a remote campus is on, shown beside its name. */
  server?: string;
  /** Whether an empty group may say so (not before rooms have loaded). */
  empty?: boolean;
  children: ReactNode[];
}) {
  return (
    <div className="home__campus">
      {title && (
        <h3 className="home__campus-head">
          {title}
          {server && <span className="home__campus-server">{server}</span>}
        </h3>
      )}
      <div className="home__rooms">
        {children}
        {children.length === 0 && empty && <p className="svc__muted">No rooms at this campus yet.</p>}
      </div>
    </div>
  );
}

/** One linked server's campus. Its own component so the digest subscription
 *  is a hook; several campuses on one server share one topic. */
function RemoteCampusGroup({ server, campus, headed }: { server: RemoteServer; campus: RemoteCampus; headed: boolean }) {
  const digest = useTopic<RemoteDigest>(remoteSummaryTopic(server.systemId));
  return (
    <CampusGroup title={headed ? campus.name : null} server={server.name}>
      {campus.rooms.map((room) => (
        <RemoteRoomCard key={room.id} server={server} room={room} digest={digest} />
      ))}
    </CampusGroup>
  );
}
