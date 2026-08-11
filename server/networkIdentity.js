'use strict';

class NetworkIdentity {
  constructor() {
    this.consumeTicket = null;
    this.accountAllowed = null;
    this.socketsByAccount = new Map();
  }

  configure(consumeTicket, accountAllowed = null) {
    this.consumeTicket = typeof consumeTicket === 'function' ? consumeTicket : null;
    this.accountAllowed = typeof accountAllowed === 'function' ? accountAllowed : null;
  }

  allowed(accountId) {
    const id = String(accountId || '');
    if (!id) return false;
    if (!this.accountAllowed) return true;
    try {
      return this.accountAllowed(id) !== false;
    } catch {
      // Access-control failures fail closed: a broken sanction lookup must not accidentally
      // re-enable a blocked account.
      return false;
    }
  }

  trackSocket(ws, accountId) {
    const id = String(accountId || '');
    if (!ws || !id) return;
    if (ws.__wobbleTrackedAccount === id) return;
    if (ws.__wobbleTrackedAccount) this.untrackSocket(ws, ws.__wobbleTrackedAccount);
    let sockets = this.socketsByAccount.get(id);
    if (!sockets) {
      sockets = new Set();
      this.socketsByAccount.set(id, sockets);
    }
    sockets.add(ws);
    ws.__wobbleTrackedAccount = id;
    if (!ws.__wobbleSanctionCloseHook) {
      ws.__wobbleSanctionCloseHook = true;
      ws.once?.('close', () => this.untrackSocket(ws, ws.__wobbleTrackedAccount));
    }
  }

  untrackSocket(ws, accountId) {
    const id = String(accountId || '');
    const sockets = this.socketsByAccount.get(id);
    if (sockets) {
      sockets.delete(ws);
      if (!sockets.size) this.socketsByAccount.delete(id);
    }
    if (ws?.__wobbleTrackedAccount === id) ws.__wobbleTrackedAccount = '';
  }

  authenticate(ws, ticket) {
    if (ws.accountId) return { ok: false, reason: 'already-bound' };
    if (!this.consumeTicket) return { ok: false, reason: 'unavailable' };

    const identity = this.consumeTicket(ticket);
    const accountId = String(identity?.accountId || '');
    if (!accountId) return { ok: false, reason: 'invalid-ticket' };
    if (!this.allowed(accountId)) return { ok: false, reason: 'blocked-account' };

    ws.accountId = accountId;
    this.trackSocket(ws, accountId);
    return { ok: true, accountId };
  }

  bindResumedPlayer(ws, player) {
    const accountId = String(player?.accountId || '');
    if (ws.accountId && accountId && ws.accountId !== accountId) return false;
    if (accountId && !this.allowed(accountId)) return false;
    if (accountId) {
      ws.accountId = accountId;
      this.trackSocket(ws, accountId);
    }
    return true;
  }

  accountForSocket(ws, accounts) {
    if (!ws?.accountId || !this.allowed(ws.accountId)) return null;
    return accounts.get(ws.accountId) || null;
  }

  disconnectAccount(accountId, { code = 4003, reason = 'account-sanctioned' } = {}) {
    const id = String(accountId || '');
    if (!id) return 0;
    const sockets = [...(this.socketsByAccount.get(id) || [])];
    let disconnected = 0;
    for (const ws of sockets) {
      try {
        if (ws.readyState == null || ws.readyState <= 1) {
          ws.close?.(code, reason);
          disconnected += 1;
        }
      } catch {
        // The server-side sanction remains authoritative even if one stale socket cannot be closed.
      }
    }
    return disconnected;
  }

  reset() {
    this.consumeTicket = null;
    this.accountAllowed = null;
    this.socketsByAccount.clear();
  }
}

const networkIdentity = new NetworkIdentity();

module.exports = { NetworkIdentity, networkIdentity };
