# Account self-service

Wobble Rush uses a server-issued recovery code plus an HttpOnly persistent session. The recovery code
is a recovery credential, not the normal request credential: after sign-in the browser uses the
HttpOnly cookie and WebSocket authentication uses a short one-time WST ticket.

This self-service layer gives the player direct control over that account without exposing session
bearers to JavaScript.

## Active sessions

`POST /api/auth/sessions` returns the current account's unexpired persistent sessions. Each item has:

- an opaque public session ID derived from a short prefix of the SHA-256 token hash;
- `current`, which marks the browser making the request;
- creation, last-seen and expiry timestamps.

The API never returns the raw session token or its full hash. It also deliberately stores and shows
no IP address, user-agent or device fingerprint. The UI therefore labels sessions only as the current
device or another session and shows activity time.

`POST /api/auth/sessions/revoke` can revoke another session by public ID. It refuses to revoke the
current session; the explicit logout endpoint owns that operation. `POST /api/auth/sessions/revoke-others`
keeps the current session and removes every other persistent session for the account.

Existing authenticated WebSocket connections are not forcibly terminated by these HTTP operations.
A revoked browser cannot mint a new WST after its persistent session is gone, and an already issued
WST remains short-lived and one-time as before.

## Recovery-code rotation

Recovery rotation is deliberately staged so losing an HTTP response cannot destroy the only usable
recovery credential.

`POST /api/auth/recovery/rotate/prepare` requires the current HttpOnly session. It generates a new
high-entropy recovery code and stores only its hash in `accounts.pending_secret_hash`. The active
`secret_hash` is untouched, so the old recovery code and all sessions continue to work if the prepare
response is lost.

After receiving the prepared code, the browser stores it as `pendingRecovery` next to (not instead of)
the currently active code. It verifies that localStorage actually persisted the pending value before
sending `POST /api/auth/recovery/rotate/confirm`.

Confirmation matches the submitted code against the pending server hash and, in one SQLite
transaction:

1. promotes the pending hash to the active recovery hash;
2. clears the pending columns;
3. revokes every persistent session except the browser performing confirmation.

Only after a successful confirmation does the browser promote its local pending code to the active
saved recovery code. If the confirm response is lost after the transaction commits, both the old code
and the prepared new code remain stored locally and confirmation is idempotent: retrying with the new
code returns success when that hash is already active. If the active session later disappears, the
client tries the staged code before discarding any saved account, so a committed-but-unacknowledged
rotation is still recoverable.

A prepared hash expires after 15 minutes. Expiry or a mismatched prepared code never changes the
active recovery hash.

## Explicit logout on this device

The existing `POST /api/auth/logout` still revokes only the current server session and clears the
cookie. The account UI adds the important client-side half: after explicit confirmation it also
removes that account's saved recovery credential from localStorage.

Security-sensitive logout uses a checked storage write. If localStorage rejects the removal, Wobble
does not immediately sign in again with the credential that failed to disappear; it keeps the page
signed out and warns the player to clear site data manually before leaving.

If another saved local account exists after a successful removal, Wobble Rush selects it. Otherwise
the current page stays signed out. On a later reload the existing first-run behavior may create a new,
unrelated Wobble account; the signed-out account itself is not recovered again unless the player
supplies its recovery code or signs in through its linked Google identity.

## Safety properties

- Session bearer cookies remain HttpOnly and never enter JSON responses or localStorage.
- Public session IDs are revocation handles, not authentication credentials.
- Preparing a recovery change never invalidates the active code.
- Confirmation is idempotent and keeps the current browser session alive.
- Prepared recovery material is stored separately from the active local code until confirmation.
- Destructive UI operations use a two-step confirmation.
- Logout verifies that the local recovery credential was actually removed before continuing.
- No automatic account deletion is included in this scope.
