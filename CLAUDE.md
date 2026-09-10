# Working on prodmesh

A LAN-hosted production dashboard for churches: room mode control, run of show,
service data from Planning Center, and SPL analysis. React 19 + TypeScript +
Vite on the front, Express + SQLite (`better-sqlite3`) on the back, served as
one origin in production.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the mental model and
[`docs/STATE.md`](docs/STATE.md) for what is live vs mock. Decisions are ADRs in
[`docs/decisions/`](docs/decisions/). Device and API behaviour that cost real
on-site time to learn is in
[`docs/INTEGRATION-NOTES.md`](docs/INTEGRATION-NOTES.md) — read it before
touching any integration.

```bash
npm run dev     # Vite (5173) + API (3001)
npm test        # server (node --test) + UI (vitest)
npm run build   # → dist/
npm start       # built app + API on one port (8080)
npm run lint
```

A dev server with the extra local-test room:
`PRODMESH_LOCAL_TEST=1 PORT=8080 NODE_ENV=production node server/index.js`

## Rules

These are not style preferences. Each one exists because breaking it caused a
real problem.

**Never commit `server/data/`.** It holds the live Planning Center token, PINs,
shows, timelines and the SQLite database. It is git-ignored; keep it that way.
Before every commit:

```bash
git diff --cached --name-only | grep -E "data/secrets|data/settings|data/shows|data/timelines|data/checklists|prodmesh.db"
```

Expect no hits.

**Everything under `server/` is published.** The Dockerfile's runtime stage does
`COPY --from=build /app/server ./server` wholesale, so seed fixtures *and* every
`*.test.js` ship inside the image — `docker run … cat server/topologySeed.js`
prints them. Never put a real device IP, OS username or hostname, Planning
Center id (service type or person), or a real person's name in `server/`. Demo
and test data uses TEST-NET-1 (`192.0.2.x`), role-shaped usernames, and
fictional ids. UI *placeholders* in `src/` deliberately stay `192.168.1.x` —
they are illustrative and match what an admin expects to type.

**No runtime CDN or internet dependencies.** A booth machine may have no route
to the internet. Fonts are bundled via `@fontsource`. Vendor any new asset
rather than hotlinking it.

**Third-party embeds go through `src/lib/embed.ts`.** A livestream player is the
one thing that cannot be vendored, so the rule above has an exception and it is
fenced: `safeEmbedUrl()` (https only — `new URL()` is a parser, not a check) and
`EMBED_SANDBOX` on the `<iframe>`. The sandbox is not about token theft; the
same-origin policy already stops a cross-origin frame reading our DOM or
`localStorage`. It stops an embedded page navigating the tab, which on an
unattended booth display means leaving the dashboard mid-service. Pin the
hostname too where the host set is known (Restream's preview does); do not
invent one where it is not.

**Branch, then merge locally.** `feat/<name>` (or `fix/`, `chore/`, `docs/`) →
tests green → live-verify against a running server → **the maintainer tests it**
→ merge `--no-ff` to main → push → delete the branch both sides. The maintainer
opens no pull requests against this repo: a PR exists so somebody can review
code they did not write, and solo that is ceremony with no reviewer on the far
end. Branches with nothing user-visible (server refactors, test additions) may
merge once tests are green and a live boot is verified. Anything a user can see
or click waits for the maintainer.

**Outside contributions arrive as pull requests** — same principle, other
situation: a PR is the only way to review a change nobody here controls.
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the contract with them; keep it and this
file in step. Two consequences for CI. It must trigger on **both**
`push: branches: ['**']` (the maintainer's branches, which never raise a PR) and
`pull_request` (fork branches, whose pushes fire in the fork, not here) — a
workflow with only one of those silently tests half the work that reaches main.
Publishing stays gated on
`github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')`,
which on a `pull_request` event is `refs/pull/N/merge` and so never publishes.
Treat a fork PR as untrusted: it gets no secrets and a read-only token, so any
job needing either must degrade rather than fail.

When taking work from a fork, **cherry-pick with `-x`** rather than reimplementing
it. That preserves the original `Author` and records the source commit, which is
both the attribution and the audit trail for where a device workaround came
from. Code carrying an insight from a third-party project needs its provenance
established before it lands, because MIT inbound-equals-outbound covers what a
contributor wrote and nothing else.

**main is the integration branch; tags are the deployment channel.** Trunk-based
— there is no `develop` or `nightly`, because a second long-lived branch exists
to coordinate multiple developers and several released versions at once, and
this project has neither.

`deploy/update.sh` checks out the **newest `vX.Y.Z` tag**, not the tip of main
(`--edge` opts into main for the maintainer's own box). It never moves
backwards: a box already ahead of the newest release is left alone rather than
rolled back. Docker publishes `:main` from main and `:latest` only from `v*`
tags, so an external church on `:latest` gets releases only.

So merging to main is *not* the moment anything reaches a room. That is
deliberate: merging means the work is finished, tagging means "this is safe in
a room on a Sunday", and those are different judgements. It matters because
Admin → System has an Update button a volunteer can press.

Avoid gratuitous server restarts; SSE clients disconnect.

**Cutting a release.** On main, with the phase complete and the maintainer
having run it in the building:

1. `package.json` version → the release number (drop the `-dev` suffix).
   `server/deployment.js` reports this, so skipping it makes a 1.1 box
   truthfully claim to be 1.0.
2. Update `docs/STATE.md` — what shipped, what is still mock.
3. Commit (`Release vX.Y.Z`), tag `vX.Y.Z` **on that commit**, push both.
4. Once the tag's Docker build finishes, mirror `:latest` onto the
   pre-transfer image name, so installs predating the org move keep updating:

   ```bash
   docker buildx imagetools create \
     --tag ghcr.io/jbeale/prodmesh:latest ghcr.io/prodmesh/prodmesh:latest
   ```

   No rebuild — the same digest gains a second name. It is manual because a
   user-owned package can only grant Actions access to that user's own
   repositories, so CI cannot write there without a standing `write:packages`
   token for a name we are trying to retire. Needs `docker login ghcr.io` as
   jbeale with a `write:packages` PAT. Drop this step, and `deploy/README.md`'s
   migration note, once the compose files in the wild have moved on.
5. Bump `package.json` to the next `-dev` so main is never mistaken for a
   release.

Tag per phase, not per merge. Between releases main carries `-dev`, which is
what Admin → System will show on an edge box — accurate, and obviously not a
release.

## Threat model

prodmesh is a **LAN appliance**, like Bitfocus Companion. The bar is *"this got
bridged onto guest wifi and a teenager is throwing requests at it"*, not
internet exposure. That is why there is no TLS and why it binds all interfaces:
deliberate, not an oversight.

Triage findings against that bar. Unauthenticated resource exhaustion and
privilege escalation matter. Passive wire sniffing does not. If you are ever
tempted to port-forward any of this, don't.

## What automated tests can and cannot certify

The suite (`npm test`) covers the settings/PIN/lock engine, config validation,
room mapping, permissions and ACLs, full API auth + lockout flows, and UI
interaction in jsdom. It runs against **mock-mode rooms**, so it needs no
hardware. Green means the logic holds.

Green does **not** mean the feature works. Anything touching ProPresenter,
Companion, Smaart or Planning Center is only truly verified on-site, against
that building's gear, usually on a Sunday. A ProPresenter minor version can
change API behaviour underneath passing tests. Do not report a hardware-facing
change as verified because CI is green — say which half was checked.

## Environment variables

| Variable | Effect |
|---|---|
| `PRODMESH_DATA_DIR` | Relocate the data dir. Tests use temp dirs. |
| `PRODMESH_LOCAL_TEST=1` | Adds the local-test dev room. Hidden in production. |
| `PRODMESH_AUTOSTART_TEST=1` | Show autostart ignores the arm window, and a scheduled-time start doesn't wait for the clock. **Dev only.** |
| `PRODMESH_LOG_FILE` | Override the log path Admin → Logs tails. |
| `PRODMESH_SECRET_*` | Supply secrets by env instead of `server/data/secrets.json`. |
| `PORT` | Serve port (default 8080). |

## Conventions

- Backend is plain JS (ESM), frontend is TypeScript. Server tests are
  `node --test`, one process per file — a file's module-level code is how boot
  order gets arranged, so keep tests that need different boot state in
  different files.
- Comments explain *why*, especially where code looks strange because a device
  or API is strange. Preserve that reasoning when you edit; it is the most
  expensive content in the repo.
- UI copy follows [`docs/UI_TEXT.md`](docs/UI_TEXT.md): terse labels, HelpTip
  for supplementary detail, no intro paragraphs.
- Test practice as configuration moves into Admin is in
  [`docs/TESTING.md`](docs/TESTING.md).
- Keep `docs/STATE.md` current. It is how a cold context — human or agent —
  finds out where the project actually stands.
