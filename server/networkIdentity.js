'use strict';

class NetworkIdentity {
  constructor() {
    this.consumeTicket = null;
  }

  configure(consumeTicket) {
    this.consumeTicket = typeof consumeTicket === 'function' ? consumeTicket : null;
  }

  authenticate(ws, ticket) {
    if (ws.accountId) return { ok: false, reason: 'already-bound' };
    if (!this.consumeTicket) return { ok: false, reason: 'unavailable' };

    const identity = this.consumeTicket(ticket);
    const accountId = String(identity?.accountId || '');
    if (!accountId) return { ok: false, reason: 'invalid-ticket' };

    ws.accountId = accountId;
    return { ok: true, accountId };
  }

  bindResumedPlayer(ws, player) {
    const accountId = String(player?.accountId || '');
    if (ws.accountId && accountId && ws.accountId !== accountId) return false;
    if (accountId) ws.accountId = accountId;
    return true;
  }

  accountForSocket(ws, accounts) {
    if (!ws?.accountId) return null;
    return accounts.get(ws.accountId) || null;
  }

  reset() {
    this.consumeTicket = null;
  }
}

const networkIdentity = new NetworkIdentity();

module.exports = { NetworkIdentity, networkIdentity };
