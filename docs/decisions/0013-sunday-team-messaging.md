# ADR 0013 — Sunday Team messaging

## Decision

The Messages area contains a Sunday Team conversation per active site and Sunday date. It uses the
existing named users, bearer sessions, dotted ACL registry, audit log, SQLite
migrations, `useQuery`, `useTopic`, and multiplexed `/api/stream` connection.
There is no account provisioning, external notification, or monitoring alert.

Migration 11 adds `sites.timezone` and four tables: `message_threads`,
`message_thread_members`, `messages`, and `message_reads`. Topology identifiers
have no cascading foreign keys, consistent with the existing whole-tree
replace in `appConfig`: renaming a campus must not erase conversation history.
Partial unique indexes enforce one site/date thread with a null plan id;
non-null plan ids have their own unique index for future plan-specific threads.
Resolve uses SQLite `INSERT OR IGNORE` inside a transaction.

## Dates and lifecycle

Site timezones are validated IANA names, configurable in Admin → Campuses.
Existing installations have no timezone configuration to inherit; an unset
site uses **UTC**. Configure the site's actual timezone before rollout. Old
clients saving topology without a timezone preserve its stored value.

The current conversation is the upcoming Sunday, including Sunday itself,
calculated on the server from the site's civil date. It is available throughout
the week, including Saturday. At local Monday midnight, all earlier dates are
archived. A server lifecycle checks every minute and resolves each site's new
thread; HTTP access also applies lifecycle checks, covering downtime/restarts.
A manual archive/lock is preserved for the current date. Previous dates cannot
be reopened. History remains accessible to its members and messaging managers.

## Permissions and membership

The existing ACL is global: there is no existing user-to-site grant model.
`messages.manage` is a new permission in that same registry; wildcard
Administrators inherit it. It permits reading active-site conversations,
editing membership, locking/unlocking, archiving, syncing, and moderation.
Ordinary users have messaging access only through that thread's membership,
which supplies the site boundary without treating browser station campus as
trusted authority. Managers must also be members to send messages.

Mapped service types are collected across all rooms of a site, deduplicated,
and their Sunday plans are found using date-bounded Planning Center requests.
Actual service times (not rehearsals or human-readable date strings) are
converted to the site timezone and matched to the Sunday. Everyone scheduled
on any qualifying plan joins the same conversation. Roster requests are paged
and retain the related **person ID**, rather than using an assignment ID.
Existing `planning_center_person_id` links match active ProdMesh accounts.
Unmatched scheduled names appear only to managers. No accounts are created.

Reconciliation is additive. A complete successful refresh adds matched people;
missing assignments, empty responses, partial results, and outages never remove
existing members. Manual removals persist as tombstones and are not undone by
schedule refreshes. Administrators explicitly remove intentionally changed
assignments. No Planning Center configuration or mappings means manual mode.
Roster work runs in the background; opening existing messaging is never blocked
by an integration outage. Refreshes coalesce per site and reuse PC caches.

## Realtime and unread

`streamHub` conflates snapshots under backpressure, so sending chat messages as
one-off stream events would lose messages. Instead, `sunday:<user-id>` carries
an opaque revision. It invalidates the inbox and refreshes the bounded latest
50 messages. After a gap, the page fetches forward in 50-message pages from its
last known message ID, preserving every persisted message even after missed or
conflated revisions. A reconnect supplies a new revision snapshot. History is
paged backward; the inbox is capped at the latest 100 threads.

Private topics share the existing public SSE connection. Since native
EventSource cannot add a bearer header, an authenticated POST mints a random,
one-use ticket valid for 60 seconds. The session token is never put in a URL.
The server checks the session and exact user topic on subscription and every
delivery. Reconnects mint new tickets. Identity changes erase private cached
revisions; ticket failures retain public operational topics. Ticket count is
bounded. Revisions contain no message bodies or roster information.

Read state is one monotonic message ID per user/thread. The page advances it
only for loaded messages while visible and near the bottom, preserving unread
state while reading older messages. Ordinary sends are not audited; manual
membership/status changes and moderator deletion are audited.

The navigation and page are named Messages, at `/messages`; the previous
`/sunday-team` URL redirects there. New incoming messages update the navigation
badge and browser-tab unread count. When browsing outside Messages, an in-app
notification shows the sender and a plain-text preview (at most 240 characters,
three visible lines). It opens the exact conversation and dismisses after eight
seconds. Initial unread history and the sender's own messages do not replay
notifications. Previews are returned only in authorized inbox responses and
exclude soft-deleted messages; SSE revisions still contain no message bodies.

## Limits and verification

Messages render as React text, never HTML. Bodies are capped at 4,000 characters;
a persistent per-user 30/minute send limit prevents reconnects from bypassing
throttling. Senders are always derived from the session. Non-members and unknown
or inaccessible site/thread IDs receive no conversation content.

Soft deletion retains the original stored body for auditability and returns a
"Message deleted" tombstone. Delete is available in the API; editing, deletion
controls in the page, @mentions, and external notifications are deferred.

Automated coverage and two-user local browser verification cover logic,
realtime, unread, and desktop/mobile layout. Planning Center date filters follow
its [Plan API documentation](https://api.planningcenteronline.com/docs/apps/services/versions/2018-08-01/vertices/plan).
The fixture tests do not certify a live church's roster or API account; verify
that integration against the target account before Sunday rollout. Phone
viewport checks include composer placement and overflow; real iOS/Android
software-keyboard behavior still needs a physical-device check.
