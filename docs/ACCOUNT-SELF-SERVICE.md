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

`POST /api/auth/recovery/rotate` requires the current HttpOnly session. Rotation runs in one SQLite
transaction:

1. a new high-entropy recovery code is generated;
2. its hash replaces the previous account recovery hash;
3. every persistent session except the current one is revoked;
4. the new recovery code is returned once with `Cache-Control: no-store`.

After a successful rotation the previous recovery code no longer authenticates. The browser replaces
its locally saved recovery code with the returned value and opens the existing code panel so the
player can save the replacement somewhere safe.

## Explicit logout on this device

The existing `POST /api/auth/logout` still revokes only the current server session and clears the
cookie. The account UI adds the important client-side half: after explicit confirmation it also
removes that account's saved recovery credential from localStorage. This prevents the next page load
from silently logging straight back in with the recovery code.

If another saved local account exists, Wobble Rush selects it. Otherwise the current page stays signed
out. On a later reload the existing first-run behavior may create a new, unrelated Wobble account;
the signed-out account itself is not recovered again unless the player supplies its recovery code or
signs in through its linked Google identity.

## Safety properties

- Session bearer cookies remain HttpOnly and never enter JSON responses or localStorage.
- Public session IDs are revocation handles, not authentication credentials.
- Recovery rotation preserves the current browser session so the player is not locked out during the
  operation.
- Destructive UI operations use a two-step confirmation.
- Logout warns the player that the locally saved recovery credential will be removed.
- No automatic account deletion is included in this scope.
