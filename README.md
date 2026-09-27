# epos-licensing

The shop-locked license server and admin panel for the EPos 365 WPF POS client,
plus the public surfaces that have grown alongside it.

A license is sold for one shop and a fixed number of tills. The client half of
this lives in `pos_customized` and is already built; this repository is the
server it talks to. The behavioural contract is
`../pos_customized/Licensing_Design.md`, the `.lic` file format is
`LICENSE_FILE.md`, the customer-account slice is `SELF_REGISTRATION_DESIGN.md`,
and the admin panel's visual system is `design.md`. Those documents are the
specification; this README is only how to run it and what lives where.

Four audiences share one deployment, which is worth holding in mind when reading
the route list:

| Audience | Surface | Authentication |
| --- | --- | --- |
| Tills | `/api/activate`, `/api/checkin`, `/api/release` | The license key itself |
| The vendor | The admin panel at `/`, `/licenses`, `/shops`, `/releases`, `/audit`, `/admins` | NextAuth credentials, `User` table |
| Shop owners | `/api/customer/*`, called by the corporate site's server | Bearer token, `CustomerSession` table |
| Anyone | `/docs`, `/tools/csv-converter` | None, deliberately |

## What it does

Two mechanisms, deliberately independent, which together make "one shop, two
tills" hold:

- **A hard device cap per license.** The first till to activate is approved
  automatically and becomes the license's location baseline. Once `maxDevices`
  devices are approved, further activations are refused outright with 403. This
  is deterministic and never reaches a human.
- **Location clustering for everything under the cap.** A second till whose
  request comes from the same country and region as an approved device, or from
  the same IPv4 /24, is approved automatically. One that does not match is held
  in a pending queue for a person to judge. This is what catches a database
  copied to a different shop, which is the case the whole feature exists for.

A request with no usable location never auto-approves. An unconfirmable location
goes to the queue rather than through it.

A till can also hand its own slot back through `POST /api/release`, which needs
no admin involvement because a request can only ever name its own device id.
There was a 24-hour cooldown between two self-releases; it was removed because it
punished the honest case — a shop replacing or re-imaging a till hit it
immediately and was locked out of its own license for a day with no way to clear
it. `lastSelfReleaseAt` is still written on every release and is visible in the
panel, so a device releasing itself in a loop is still something a person can
see. See `releaseOwnDevice` in `src/server/licensing/service.ts`.

### Update announcements

Every activation and check-in response also carries the current published
release: version, minimum version, download URL, SHA-256, and a signature over
those. That is what drives the in-app updater in the WPF client. Releases are
managed at `/releases`, the announcement is read fresh on every request rather
than cached (so withdrawing a bad build takes effect everywhere at once), and
`currentUpdateAnnouncement` in `src/server/licensing/releases.ts` explains why.

### Why Vercel specifically

Location comes from the `x-vercel-ip-*` headers the edge network attaches before
the function runs. That makes the one external input the shop-locking mechanism
depends on free, instant, and unspoofable by the client. A third-party GeoIP
service would put a paid network round trip inside every activation and
check-in, and an outage there would either block activations or force a
fail-open that silently disables the check. Off Vercel the headers are simply
absent, and every second device lands in the queue.

## Setup

```bash
pnpm install
cp .env.example .env      # then fill it in, see below
pnpm db:push              # creates the schema
pnpm db:seed              # creates the single admin login
pnpm dev
```

`.env` needs:

| Variable | Notes |
| --- | --- |
| `AUTH_SECRET` | `npx auth secret` |
| `DATABASE_URL` | Supabase **transaction** pooler, port 6543, `?pgbouncer=true` |
| `DIRECT_URL` | Supabase **session** pooler, port 5432. Prisma needs it for DDL; the transaction pooler cannot run migrations |
| `LICENSE_SIGNING_PRIVATE_KEY` | PKCS#8 PEM, see below. Secret |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Bootstrap-only, see below. Delete after the first `db:seed` |

### Administrator accounts

Accounts live in the `User` table and are managed from the panel's
**Administrators** page: add a colleague, reset a password, remove someone. Any
administrator can do all three, since they already hold full authority over
every license.

`ADMIN_EMAIL` and `ADMIN_PASSWORD` exist only to create the *first* account,
because nobody can reach the page that adds accounts until somebody can sign in.
`pnpm db:seed` refuses to touch anything once an account exists, so a stale
password left in an environment cannot silently reset one that has since been
changed. Nothing reads either variable at runtime; delete them after the first
run.

Passwords are bcrypt at cost 12. There is no invitation email and no
self-service sign-up: whoever adds an account sets the password and passes it on
out of band. Removing your own account is refused, which is what guarantees one
always remains — the only person who could delete the last account is its owner.

Lost the only password? Delete the row from the `User` table and run
`pnpm db:seed` again.

## The signing key

Licenses are signed RSA-2048 / SHA-256 / PKCS#1 v1.5. The client verifies
against a public key compiled into `Pos.Core/Services/LicenseBlobSigning.cs`.

```bash
pnpm keypair
```

prints both halves: the private key to put in the environment, and the public
key to paste into `LicenseBlobSigning.cs` as `DevPublicKeyBase64`, replacing the
dev key. That paste is a manual, one-time hand-off. The public key is emitted as
PKCS#1 DER base64, which is what `RSA.ImportRSAPublicKey` consumes;
SubjectPublicKeyInfo, the other common encoding, would not load.

The private key belongs in the Vercel and Supabase environment only. It is never
committed, never logged, and never surfaced in the panel. Regenerating it after
launch invalidates every license already issued.

## Canonical serialization

The single most breakable thing here. The client verifies against the bytes
produced by

```csharp
JsonSerializer.Serialize(payload,
    new JsonSerializerOptions { PropertyNamingPolicy = null, WriteIndented = false })
```

so `src/server/licensing/signing.ts` reproduces `System.Text.Json` exactly rather
than delegating to `JSON.stringify`: fixed field order, PascalCase, no
whitespace, nulls written rather than omitted, dates truncated to whole seconds,
and .NET's HTML-safe escaping. That last one is not academic. `ShopLabel` is
admin-entered, and an apostrophe or ampersand in a shop name is the common case;
`.NET` writes those as `'` and `&`, and a signature computed over the
literal characters fails on every till.

A mismatch is silent. Nothing throws; the customer just sees "this license file
is invalid or has been tampered with". `pnpm verify:signing` is what stands
between a change here and that outcome.

## Endpoints

Called by `Pos.Core.Services.LicenseService`. Bodies and responses are PascalCase
because the client deserializes with `System.Text.Json`'s defaults, where
`PropertyNameCaseInsensitive` is false — a camelCase response would bind to
nothing and read as an empty approval state. Requests are accepted in either
case.

| Route | Outcomes |
| --- | --- |
| `POST /api/activate` | 200 approved · 202 pending · 403 device limit · 410 blocked · 404 unknown key |
| `POST /api/checkin` | 200 approved · 202 pending · 410 blocked, rejected, deactivated or unknown device |
| `POST /api/release` | 200 slot freed or already free · 404 unknown key or device · 409 the device holds no slot |
| `DELETE /api/device` | Admin session required. Frees a slot |

A device refused for exceeding the cap gets no database row at all, so the
pending queue stays a pure location-review queue.

### Customer endpoints

Called server-to-server by the corporate website's own backend, never from a
browser — see `SELF_REGISTRATION_DESIGN.md` for why. Bodies and responses are
plain camelCase: nothing here is deserialized by the client's
`System.Text.Json`, so the PascalCase constraint above does not apply.
Authentication is a bearer token from `/signin` or `/register`, checked against
`CustomerSession`.

| Route | Purpose |
| --- | --- |
| `POST /api/customer/register` | Creates a `Customer` and their first `Shop`. Never a `License` |
| `POST /api/customer/signin` · `/signout` | Issues and revokes a session token |
| `GET /api/customer/me` | The caller's own shops, license status and device counts |
| `POST /api/customer/profile` · `/change-password` | Self-service account edits |
| `POST /api/customer/shops` | Adds a shop, against the account's `shopLimit` |
| `POST /api/customer/shops/[id]/subdomain` | Claims a subdomain for one of their shops |
| `GET /api/customer/check-slug` | Live availability while typing a subdomain. Side-effect free |
| `POST /api/leads/quote-request` | A quote request, with or without a signed-in customer |

## Admin panel

Server Components and Server Actions throughout. Two client components exist and
both earn it: the sidebar (it reads the current path to mark the active section)
and the CSV converter (the whole conversion runs in the visitor's browser).
Sign-in is NextAuth Credentials against the `User` table, which holds as many
administrator accounts as you add.

- `/` — the pending approval queue, and the landing page, because it is the only
  thing in the system that needs a human. Each row puts the requesting location
  beside the license's already-approved location so the decision is read rather
  than reconstructed.
- `/licenses`, `/licenses/new` — issued licenses, those needing attention first
- `/licenses/[id]` — terms, devices, `.lic` generation, block/unblock, key
  regeneration, history. `.lic` files download from the two `license-file`
  routes underneath it, one per license and one per device
- `/shops`, `/shops/new`, `/shops/[id]` — customers, their contact details and
  their shops. A customer holds several shops (`shopLimit` caps how many), each
  with its own subdomain, template and publish state, so `/shops/[id]/shop/new`
  and `/shops/[id]/shop/[shopId]` sit underneath. `/shops/[id]/edit` and
  `/shops/[id]/password` maintain the login itself
- `/releases` — published client builds. What every till's updater reads
- `/audit` — the append-only feed
- `/admins` — administrator accounts

### Public surfaces

Neither needs a session, and neither reads the database.

- `/docs` — the shop-facing guides for the till itself: sandbox sales, stock
  warnings, end of day, permissions, printing, and the rest. The prose lives in
  `src/app/docs/_content/*.ts` and one registry in `_content/index.ts` feeds the
  index page, the individual pages and the PDFs together. **After changing any
  guide, run `pnpm docs:pdf`** — the PDFs under `public/docs` are committed and
  go stale otherwise; the script skips anything whose source hash is unchanged.
- `/tools/csv-converter` — normalises a catalogue exported from another till
  system into the CSV the product importer reads. Open to anyone because the
  shop doing the migration has no panel account, and safe to leave open because
  nothing leaves the browser. Nothing on that page may name another till
  product.

The visual system is Vercel's brand foundation, vendored byte-identical at
`public/vercel-brand.css` so the panel has no third-party runtime dependency;
refresh it from `https://vercel.com/geist/vercel-brand.css`. The identity slot
names EPos 365 rather than carrying the Vercel wordmark, since this is a vendor's
internal tool and not a Vercel-authored surface. Tailwind is installed but not
imported: its preflight would fight the foundation for the same elements.

## Verification

```bash
pnpm verify:signing      # no database, no server
pnpm verify:csv          # no database, no server
pnpm dev                 # the two below need it running
pnpm verify:endpoints
pnpm verify:admin        # needs ADMIN_EMAIL / ADMIN_PASSWORD still set
pnpm verify              # all four
```

Each script prints its own pass count, so the total is read from the run rather
than quoted here and left to rot. Between them they cover first activation,
same-location and same-subnet auto-approval, a location mismatch reaching the
queue and being approved or rejected, the device cap as a hard 403 that writes no
row and outranks the location check, the cap also binding an operator approving
from the queue, slot release and reuse, blocked licenses, unknown keys and
devices, signature verification against the client's own public key, tamper
detection, a `.lic` file round-tripping through the parse
`ImportLicenseFileAsync` performs, and the converter's delimiter, decimal-comma
and encoding handling.

Location is simulated by sending the `x-vercel-ip-*` headers the edge network
would attach, which is the only way to reach the clustering logic without two
machines in two cities. Fixtures are named with the run's timestamp and removed
afterwards.

## Connection handling

Supabase's transaction pooler closes connections it considers idle while Prisma
keeps them in its own pool, so the first query after a quiet period can fail
with "Can't reach database server" against a perfectly healthy database.

`src/server/db.ts` retries those. The retry is scoped to
`PrismaClientInitializationError` alone, which is raised while opening the
connection and therefore proves the statement never executed, so replaying it
cannot duplicate a write. Errors like `P1017`, where the server closed an
established connection and an insert may or may not have committed, are
deliberately not retried.

## Deployment

Vercel. `vercel.json` cannot carry comments, so its four decisions are recorded
here.

**`buildCommand: "prisma generate && next build"`.** The Prisma client is
generated to `generated/prisma`, which is gitignored, so it does not arrive with
the source. `postinstall` normally produces it, but Vercel restores a cached
`node_modules` and skips install entirely when the lockfile has not changed —
and a cached client generated against an older schema is worse than none, since
it builds cleanly and then fails at runtime on a column it does not know about.
Generating explicitly on every build removes both cases.

**`regions: ["hnd1"]`.** Supabase is in `ap-northeast-1`; `hnd1` is Vercel's
Tokyo region. Vercel defaults to `iad1` in Washington DC, which would put a
transpacific round trip on *every* query, and both activation and check-in make
several in sequence. This is the single largest thing affecting how fast a till
activates. Move it if the database ever moves. It does not affect the
`x-vercel-ip-*` headers, which the edge attaches from the caller's own address
before the request reaches whichever region runs the function.

**`X-Robots-Tag: noindex, nofollow` on everything.** The panel is reachable by
URL and lists customer names and license keys; it should never appear in a
search result. `nosniff` and a same-origin referrer policy come along as cheap
hardening.

**`Cache-Control: no-store` on `/api/*`.** The route handlers are already
`force-dynamic`, so this changes nothing about Vercel's own behaviour — it
instructs whatever proxy sits between a shop and here. An activation response
cached anywhere would either replay an approval after a device was deactivated
or serve one till's signed blob to another.

Route handlers run on the Node runtime because they need `node:crypto`; do not
move them to the edge.

### First deploy

```bash
pnpm dlx vercel link
pnpm dlx vercel env add AUTH_SECRET production            # npx auth secret
pnpm dlx vercel env add DATABASE_URL production
pnpm dlx vercel env add DIRECT_URL production
pnpm dlx vercel env add LICENSE_SIGNING_PRIVATE_KEY production
pnpm dlx vercel --prod
```

Set the variables **before** the first build, not after. `src/env.js` validates
at build time and `LICENSE_SIGNING_PRIVATE_KEY` is required, so a deploy without
it fails during the build rather than at the first activation — which is the
right way round, but it does mean the very first deploy fails if you push first
and configure second.

Paste the private key as a single line with newlines written as literal `\n`.
That is what Vercel's UI produces for a multi-line value, and `signing.ts`
unescapes it. Do not add `ADMIN_EMAIL` or `ADMIN_PASSWORD`: nothing reads them at
runtime, and the account already exists.

`AUTH_SECRET` must be the same value for the life of the deployment. Changing it
invalidates every signed-in session, which is a nuisance rather than a
catastrophe, but it is not a value to rotate casually.

### The schema

There is no `prisma/migrations` directory: the schema has been applied with
`pnpm db:push`, which is a local operation against `DIRECT_URL` and is not part
of the Vercel build. So **deploying does not change the database**. After any
change to `schema.prisma`, run `pnpm db:push` yourself, and do it before
promoting the deploy that depends on it.

That is fine while this is one operator and one database. Before anyone else
touches the schema, switch to `prisma migrate dev` locally and add
`prisma migrate deploy` to the build command, so the schema change and the code
that needs it ship together and are reviewable.

`package.json` already carries `db:generate` (`prisma migrate dev`) and
`db:migrate` (`prisma migrate deploy`) for that day, but nothing has used them
yet: with no `prisma/migrations` directory, running `db:generate` starts the
migration history from the current schema. Do that deliberately, not by reaching
for the nearest-looking script. The `Customer` table holds real customer details,
which `SELF_REGISTRATION_DESIGN.md` flagged as a reasonable trigger to make the
switch.

### Connection limit

Append `&connection_limit=1` to `DATABASE_URL` on Vercel, so each function
instance holds one pooled connection rather than competing for the project's
shared budget. Serverless scales instance count rather than per-instance
concurrency, so a larger pool per instance buys nothing and exhausts Supabase's
budget sooner.

### The client

The WPF client is not part of this deployment and does not learn the URL by
itself. After the first successful deploy, set
`LicenseService.ServerUrl` in `pos_customized` to the production domain and
rebuild. Use a custom domain rather than a `*.vercel.app` URL: the generated one
changes with the project name, and the value is compiled into every till.
