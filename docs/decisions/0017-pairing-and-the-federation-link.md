# 0017 — Pairing and the federation link

Status: proposed · 2026-11-09 · details [0014](0014-a-server-per-site.md) and
[0016](0016-federation-network-boundaries.md) · part of
[#46](https://github.com/prodmesh/prodmesh/issues/46) · builds on
[#49](https://github.com/prodmesh/prodmesh/issues/49)

## Context

[0014](0014-a-server-per-site.md) decided that sites are peers, that trust is
pinned at pairing rather than delegated to a PKI, and that an admin at one site
generates a join token which an admin at the other redeems.
[0016](0016-federation-network-boundaries.md) decided which network paths
cross between sites. Neither says what a join token *is*, how the two servers
talk once paired, or how either notices the other has gone. This ADR settles
those, because they are the first federation code to be written and the first
thing two admins will handle by hand.

#49 has since given every install what pairing needs: a stable system id, an
Ed25519 signing key, and a self-signed P-256 certificate with a SHA-256
fingerprint (`server/identity.js`).

The design was checked against a real deployment plan:

- per-site control VLANs;
- a routed management network that the two ProdMesh servers sit on;
- each server reaching its own site's control VLAN, either over a second NIC or
  by routing, and never the other site's.

That plan shaped two requirements below that a single-NIC lab would never have
surfaced. The example addresses here are TEST-NET-1, per 0016: the real ones
belong in the church's network documentation, not this public repository.

## Decision

### The federation link is a second listener, not a route on the dashboard

A separate HTTPS server, with its own port (default **8443**), serving only
`/federation/v1/…`. It is a different Express app from the dashboard's, so:

- **nothing on the dashboard port is reachable as federation**, and nothing on
  the federation port is the dashboard. A firewall rule that lets the other site
  reach 8443 exposes the federation protocol and nothing else. 0016's
  "ProdMesh ↔ ProdMesh on the link port only" is then enforceable by port
  number alone.
- **it binds one address, chosen by the admin**, never all interfaces. The
  dashboard deliberately binds everything; a multi-homed box would then offer
  the federation link on its control-VLAN NIC too, which is exactly the
  surface 0016 says must not exist. Binding the management interface keeps the
  link off the control network even where the box has a leg in it.
- **it does not listen at all until federation is switched on.** A single-site
  church never opens the port, and nothing in its threat model changes.

It serves TLS with the #49 certificate. Plain HTTP is not offered on this port,
whatever 0016's Tier B says about the operator path. The link carries signed
identity and is the one channel built to cross a WAN, so it pays for TLS
unconditionally: it is free here, because we control both ends and pin rather
than chain.

### Both ends present certificates, and the pin is the authentication

The link is **mutual TLS**. Each server presents its #49 certificate. Each
side requests the other's (`requestCert: true`) and authenticates it by looking
up its SHA-256 fingerprint in the peers table. It does not chain to a CA: there
is none, and 0014 deliberately has none.

That makes every request on the link authenticated at the transport. There is
no bearer token to leak and no per-request signature to get wrong: a request
arriving on an unknown certificate is refused before any handler runs.

To make an outbound call, a server uses the peer's **stored certificate** as its
only trust anchor (`ca`). It also checks the presented fingerprint in
`checkServerIdentity` instead of a hostname. #49's test suite already
exercises exactly that pattern. Pinning the certificate rather than a hostname
is also what lets a peer's address change without re-pairing.

The Ed25519 signing key is **not** used on the link: mutual TLS already
authenticates it. The signing key is for 0014's user assertions, which travel
through a *browser* and so cannot lean on the link's TLS.

### The join token

Generated in Admin by a full administrator at site A. It is one string, so it
can go in a Slack DM, a text, or be read over a phone:

```
pmjoin1.<base64url(JSON)>
```

```json
{
  "v": 1,
  "id": "<A's system id>",
  "name": "Grace Fellowship — North",
  "addr": "192.0.2.10:8443",
  "fp": "<A's certificate SHA-256 fingerprint>",
  "secret": "<128 random bits, base64url>",
  "exp": 1794283747731
}
```

- **`addr` is the federation address the admin configured, not a guess.** A box
  with a NIC on each of three VLANs has three addresses, and auto-detection
  would sometimes hand the other site one it cannot route to: worst of all,
  the control-VLAN one. The admin chooses it once, in the same place as the
  bind address, and a DNS name is allowed and preferred.
- **`fp` is why the token is safe to carry a secret.** B connects to `addr`
  trusting only the certificate whose fingerprint is `fp`, so the first
  connection cannot be intercepted however the token travelled. A token copied
  wrong fails closed.
- **`secret` is a one-time password.** A stores a hash of it, never the value.
  It is single-use and expires after **30 minutes**: long enough for two admins
  on a call, short enough that a token found in a chat log next week is dead.
  Generating a new token does not cancel others. Admin lists outstanding tokens
  and can cancel one.
- **Redemption is throttled** through `credentialThrottle.js`, keyed on the
  source address, like every other door that checks a secret.

### Pairing is two steps and two people, and the second one is an Accept button

1. **B redeems.** An admin at B pastes the token. B opens mutual TLS to `addr`,
   pinning `fp` and presenting its own certificate. It then sends
   `POST /federation/v1/pair` with the secret and B's public identity: id,
   name, federation address and signing public key. B's fingerprint and
   certificate come from the TLS session itself, never from the request body.
2. **A records B as `pending`** and answers with A's public identity. B records
   A as `pending` too, and shows *"Waiting for Grace Fellowship — North to
   accept"*.
3. **An admin at A accepts**, seeing B's name, the address it connected from,
   and B's fingerprint. Both sides move to `paired` on B's next contact.

The Accept step is the one addition to 0014's description, and it is there
for one threat: **an intercepted token**. If the token leaks between A and B, an
attacker who redeems it first would otherwise be paired silently. With Accept,
A's admin sees an unexpected site waiting and declines it. In the normal case
both admins are on the same call, and the button costs a second.

A `pending` peer can do nothing except ask whether it has been accepted.

### Peers, and leaving

A migration adds `federation_peers`:

| Column | Holds |
|---|---|
| `system_id` | the peer's identity (primary key) |
| `name` | its display name, refreshed on every probe |
| `address` | where to reach it; editable by an admin, because IPs move and the pin does not |
| `certificate` | its PEM; the fingerprint is derived from it |
| `signing_public_key` | for 0014's assertions |
| `state` | `pending` · `paired` · `removed` |
| `paired_at`, `paired_by`, `last_seen_at`, `last_error` | for the admin and the audit trail |

**Unpairing is local and immediate.** Removing a peer forgets its certificate,
so its next connection is refused at the TLS layer. It then tells the peer,
best effort, with `POST /federation/v1/unpair`, so both lists agree. If that
call never arrives, the peer finds out on its next probe, when the handshake
is refused, and shows *"no longer paired"*. It does not show *"unreachable"*:
the two mean different things to whoever reads them.

Rows are marked `removed`, never deleted, because the audit trail points at
them, the same as users and tokens.

### Liveness: one probe a minute, into `health.js`

Every paired peer is probed with `GET /federation/v1/hello` once a minute,
always on, as 0016 requires. The answer carries id, name, version and the
peer's clock. The result is recorded as an integration in `health.js`
(`peer:<systemId>`), so:

- the existing reachability card shows peers beside ProPresenter and Companion;
- 0015's alert spine can raise *"South campus unreachable"* with no new
  plumbing;
- **clock skew is measured here**, from the hello's timestamp, and shown on the
  peer. 0014 named skew as the failure that will present as "I can't view the
  other campus"; this is where it becomes visible before anyone tries.

No request on the dashboard ever waits on a probe or on any federation call,
per 0016's invariant.

### Configuration lives in Admin

Admin gains a **Sites** section:

- **Federation:** on or off; the bind address (a list of this machine's
  interfaces to choose from); the port; and the federation address peers
  should use.
- **This server:** its name, id and fingerprint, linked to the System panel
  from #49.
- **Pair a site:** generate a token, or paste one.
- **Peers:** each with its state, address, fingerprint, last seen and clock
  skew; Accept, Edit address, Remove.

## Consequences

- **The firewall rule for the link is one port between two hosts.** Nothing
  else on either server is reachable cross-site, even before any rule is
  written, because the listener binds only the management interface.
- **`CLAUDE.md`'s threat model is amended in the same change**, as 0014
  requires: *a LAN appliance, plus a mutually authenticated federation link
  that is off unless switched on*.
- **A restored clone pairs as the original.** #49 keeps the identity through a
  restore, private keys included, which is right for moving the host. But two
  live copies hold the same keys and are indistinguishable to a peer. The
  documentation for moving a server says to retire the old one first. The probe
  makes the symptom visible, because the same id answers from two addresses,
  and #56 detects it on the LAN.
- **Pairing is still pairwise.** Fourteen campuses are 91 pairings, as 0014 and
  0016 both record. Two campuses are one. This ADR does not try to solve the
  fourteen.

## Not decided here

- **What travels over the link once paired:** the directory, digests, and the
  assertion exchange for the operator path. 0014 has the shape; the wire format
  is the next ADR, and it will be written against a link that already works.
- **Certificate rotation.** Today rotating a key means pairing again. That
  is acceptable for two sites and worth revisiting before fourteen.
- **Whether `/federation/v1` is public.** It is versioned so it can be frozen,
  but per [0013](0013-public-api-is-an-allowlist.md) not in the release that
  first implements it.
