# Identity Service

Authentication, token issuance and enrollment-based authorization (Phase 3 · deliverable 3.1).
Contract: [`docs/architecture/phase-3-student-experience.md` §2](../../docs/architecture/phase-3-student-experience.md).

TypeScript · Fastify · node:crypto (scrypt, Ed25519, RSA) · zod — port **4001**.

## Endpoints

| Method | Path                                    | Auth                     | Purpose                                                                                      |
| ------ | --------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| GET    | `/health`                               | —                        | Liveness                                                                                     |
| GET    | `/.well-known/jwks.json`                | —                        | Public Ed25519 keys (OKP JWKs with `kid`)                                                    |
| POST   | `/v1/auth/login`                        | —                        | `{email, password, institutionId}` → `{accessToken, refreshToken, expiresIn, user}`          |
| POST   | `/v1/auth/refresh`                      | —                        | `{refreshToken}` → new pair (rotation)                                                       |
| POST   | `/v1/auth/logout`                       | optional bearer          | `{refreshToken}` → revokes the family and the presented access token (`204`)                 |
| GET    | `/v1/me`                                | bearer                   | Current user                                                                                 |
| GET    | `/v1/me/sections`                       | bearer                   | `{role, institutionId, classSectionIds}` the caller may read                                 |
| POST   | `/v1/authorize`                         | internal token or bearer | `{subject, action:"read", resource:{type, classSectionId}}` → `{allowed, reason}`            |
| POST   | `/v1/users`                             | admin bearer             | Create a user in the admin's institution (optional password, `studentId`/`professorId` link) |
| POST   | `/v1/sync/sections`                     | internal token or admin  | Mirror of class sections + teaching professor                                                |
| POST   | `/v1/sync/enrollments`                  | internal token or admin  | Mirror of enrollments; `mode: "replace"` withdraws missing ones per section                  |
| PUT    | `/v1/identity-providers/:institutionId` | admin bearer             | Configure OIDC SSO for the institution                                                       |
| GET    | `/v1/auth/oidc/:institutionId/start`    | —                        | `302` to the IdP (`?format=json` returns `{authorizationUrl}`)                               |
| GET    | `/v1/auth/oidc/:institutionId/callback` | —                        | Completes the code flow → same response as login                                             |

Errors are always `{ "error": { "code", "message", "details?" } }`.

## LGPD data subject rights (Phase 4 · 4.11)

Contract: [`phase-4-institutional-intelligence.md` §6](../../docs/architecture/phase-4-institutional-intelligence.md).

| Method | Path                                   | Who                                                                      | Purpose                                                                                                                                                                |
| ------ | -------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/dsr`                              | the subject, or coordinator/admin of the institution (or internal token) | `{subjectType: student\|professor\|user, subjectId, institutionId, type, requestedBy, channel, details?}` → `{id, status: "received", dueAt}` (+15 days, LGPD art. 19) |
| GET    | `/v1/dsr?status&institutionId&overdue` | staff (own institution) / internal                                       | List with `overdue`, `daysRemaining` and a summary                                                                                                                     |
| GET    | `/v1/dsr/:id`                          | staff or the subject                                                     | Request, per-service `results`, `pendingServices`, `timeline`                                                                                                          |
| GET    | `/v1/dsr/:id/export`                   | staff or the subject                                                     | Access-request JSON bundle (`ci-dsr-access-export/v1`)                                                                                                                 |
| POST   | `/v1/dsr/:id/verify`                   | staff                                                                    | `received → verifying` (identity of the subject verified)                                                                                                              |
| POST   | `/v1/dsr/:id/execute`                  | staff                                                                    | `verifying/in_progress → in_progress → completed`; re-running only retries failed handlers                                                                             |
| POST   | `/v1/dsr/:id/reject`                   | staff                                                                    | `{reason}`; only before execution                                                                                                                                      |

- Execution fans out to `DataSubjectHandler`s: the services in `DSR_HANDLER_URLS`
  (`audit=http://audit:4011,notifications=http://notifications:4006`, called as
  `POST {url}/internal/v1/dsr/{type}` with `X-Internal-Token`) plus identity's own handler. Any failed handler
  keeps the request `in_progress` (`dsr.execution_partial`); for deletion/anonymisation identity runs **last**, only
  after every other service succeeded, so the account is never erased while other data remains.
- Identity handler — access: profile, roles, links, credential metadata, login-history summary; deletion /
  anonymisation: credentials and login history removed, refresh tokens revoked, account disabled and turned into an
  anonymised tombstone (`anon-<id>@anonymized.invalid`); restriction: account disabled; correction: `details.name` /
  `details.email` applied.
- Access exports are stored through `ExportStore` (in-memory, or `DSR_EXPORT_DIR` files with mode `0600`; a CMEK
  bucket adapter fits the same interface). Audit: `dsr.received`, `dsr.verified`, `dsr.execution_started`,
  `dsr.execution_partial`, `dsr.completed`, `dsr.rejected` — identifiers only, never the subject's data.

## Security model

- **Passwords** — scrypt `N=2^15, r=8, p=1`, 16-byte salt, stored as `scrypt$N$r$p$salt$hash`.
  Unknown users are checked against a dummy hash so timing does not reveal accounts; the error is the same
  generic `invalid_credentials`. 5 consecutive failures lock the credential for 15 minutes (`423` + `Retry-After`).
- **Access tokens** — JWT `EdDSA` (Ed25519), 15 min, claims `iss, sub, aud, iat, exp, jti, inst, role, pid`.
  The verifier pins the algorithm list (no `alg: none`, no HS256/RS256 confusion) and checks that the key type
  matches the algorithm. Logout adds the token `jti` to a denylist consulted by this service.
- **Refresh tokens** — opaque `rt_…` (256 bits), 30 days, only SHA-256 stored, rotated on every use. Presenting
  an already-rotated token revokes the whole family (`auth.refresh_reuse_detected`)
  — except within a **10 s grace window**: re-presenting the immediately-previous token returns the same
  successor pair (no new rotation), so concurrent refreshes from one client do not log the user out.
  The successor pair is held only in a short-lived `RotationGraceStore` (in-memory; Redis TTL across replicas).
- **OIDC** — authorization code + PKCE S256, single-use `state` (10 min), `nonce`, RS256 `id_token` verified
  against the IdP JWKS (`iss`, `aud`, `azp`, `exp` with 60 s skew), `email_verified` must not be `false`.
  Users are linked by email **within the institution**; there is no just-in-time account creation.
- **Authorization** — students: active enrollment; professors: sections they teach; coordinators/admins:
  their institution. Cross-institution access is denied first, for every role. A bearer caller may only query
  itself unless it is staff of the subject's institution. Sync endpoints never move a section across tenants.
- **Audit** — `auth.login_succeeded`, `auth.login_failed`, `auth.locked`, `auth.refresh_reuse_detected`,
  `auth.logout`, `auth.user_created` are POSTed to the audit service (failures are logged, never fatal).
  Passwords and tokens are never logged or audited.

## Using the verifier in other services

`src/jwt-verify.ts` is self-contained (node:crypto, zod, fastify types):

```ts
import { createJwksAccessTokenVerifier, requireAuth } from './jwt-verify.js';

const verify = createJwksAccessTokenVerifier({ jwksUrl: `${IDENTITY_URL}/.well-known/jwks.json` });
app.get(
  '/v1/lectures/:id',
  { preHandler: requireAuth(verify, { roles: ['student', 'professor'] }) },
  handler,
);
// request.auth → { sub, inst, role, pid, ... }
```

The JWKS is cached for 5 minutes and refetched (at most every 30 s) when an unknown `kid` appears, so key
rotation works by publishing the new key while keeping the old one in `IDENTITY_PREVIOUS_PUBLIC_KEYS_PEM`.

## Configuration

| Env                                                                                  | Default       | Notes                                                                          |
| ------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `PORT`                                                                               | `4001`        |                                                                                |
| `IDENTITY_SIGNING_KEY_PEM`                                                           | —             | Ed25519 PKCS#8 PEM (Secret Manager). Unset → ephemeral dev key with a warning. |
| `IDENTITY_PREVIOUS_PUBLIC_KEYS_PEM`                                                  | —             | Concatenated SPKI PEMs still accepted during rotation                          |
| `IDENTITY_ISSUER`                                                                    | `ci-identity` |                                                                                |
| `IDENTITY_INTERNAL_TOKEN`                                                            | —             | Shared secret for `X-Internal-Token` service calls (sync, authorize)           |
| `AUDIT_SERVICE_URL`                                                                  | —             | e.g. `http://localhost:4011`; unset → in-memory audit                          |
| `DSR_HANDLER_URLS`                                                                   | —             | `name=url` pairs of services implementing `/internal/v1/dsr/{type}`            |
| `DSR_EXPORT_DIR`                                                                     | —             | Directory for access-request bundles; unset → in-memory                        |
| `IDENTITY_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `IDENTITY_BOOTSTRAP_INSTITUTION_ID` | —             | Creates a first admin at start-up                                              |

## Group executives (Phase 5 §2)

Role `group_executive`, linked to a holding company (`holdingCompanyId`). Created with `POST /v1/users` by an admin of an
institution of that holding company, or with the internal token; the home `institutionId` must belong to the holding
(`403 holding_company_mismatch`). Access tokens carry `hc`; `/v1/me` returns `holdingCompanyId`. `/v1/authorize` denies every
per-institution resource (`group_scope_only`) and `/v1/me/sections` is empty — group data is read only through
group-intelligence. Postgres resolves institution → holding from `institutions`; audit records them as `admin` actors.

## Integration stage (Postgres, internal token)

- `DATABASE_URL` set → `src/repository.pg.ts` (all repositories + `PgDsrRepository`); unset → in-memory.
  Refresh rotation runs in one transaction with `SELECT … FOR UPDATE` on the token row, so concurrent refreshes on
  different replicas serialise; the 10 s grace pair is stored AES-256-GCM-sealed in `refresh_token_grace`
  (key `IDENTITY_GRACE_KEY` base64 32 bytes, else HKDF of the signing key). OIDC client secrets are stored only as
  references (`clientSecretRef`: `env:NAME` / `none`; plaintext is rejected with `secret_reference_required`).
- `INTERNAL_API_TOKEN` (alias `IDENTITY_INTERNAL_TOKEN`) is accepted as `x-internal-token` on sync/authorize/DSR
  calls and sent to DSR handlers. identity publishes no bus events.
- Schema gaps: `data/migrations/pending/identity.sql`.
- `TEST_DATABASE_URL=postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433 pnpm test` also runs
  `src/identity.pg.test.ts` against a fresh database with every migration applied.

## Development

```bash
pnpm --filter @ci/identity-service test       # 83 tests (vitest + app.inject)
pnpm --filter @ci/identity-service dev
```

Repositories are interfaces with in-memory implementations (`src/repositories.ts`); a PostgreSQL adapter is
the next step (tables: `users`, `user_credentials`, `refresh_tokens`, `revoked_access_tokens`,
`identity_provider_configs`, `oidc_auth_states`, `access_section_mirror`, `access_enrollment_mirror`, `login_events`, `dsr_requests`, `dsr_service_results`, `dsr_events`).
