'use strict';

class AccountAccessPolicy {
  constructor() {
    this.lookup = null;
  }

  configure(lookup) {
    this.lookup = typeof lookup === 'function' ? lookup : null;
  }

  sanction(accountId) {
    const id = String(accountId || '').trim();
    if (!id || !this.lookup) return null;
    try {
      return this.lookup(id) || null;
    } catch {
      // Access-control failures fail closed. A database/read error must not accidentally reopen
      // a legacy authentication path for an account whose sanction state cannot be verified.
      return { reason: 'other', expiresAt: null, permanent: true, unavailable: true };
    }
  }

  allowed(accountId) {
    return !this.sanction(accountId);
  }

  reset() {
    this.lookup = null;
  }
}

const accountAccessPolicy = new AccountAccessPolicy();

module.exports = { AccountAccessPolicy, accountAccessPolicy };
