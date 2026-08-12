from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'server/networkIdentity.js',
    """  authenticate(ws, ticket) {
    if (ws.accountId) return { ok: false, reason: 'already-bound' };
""",
    """  authenticate(ws, ticket) {
    ws.accountAccessDeniedAccountId = null;
    if (ws.accountId) return { ok: false, reason: 'already-bound' };
""",
    'clear blocked-auth diagnostic identity',
)
replace_once(
    'server/networkIdentity.js',
    """    if (!this.allowed(accountId)) return { ok: false, reason: 'blocked-account', accountId };

    ws.accountId = accountId;
""",
    """    if (!this.allowed(accountId)) {
      ws.accountAccessDeniedAccountId = accountId;
      return { ok: false, reason: 'blocked-account' };
    }

    ws.accountId = accountId;
""",
    'preserve blocked-auth return shape',
)
replace_once(
    'server/index.js',
    """          incidentForSocket(ws, {
            accountId: authenticated.accountId,
            kind: 'auth',
            code: 'account-sanctioned'
          });
""",
    """          incidentForSocket(ws, {
            accountId: ws.accountAccessDeniedAccountId,
            kind: 'auth',
            code: 'account-sanctioned'
          });
""",
    'use internal blocked-auth diagnostic identity',
)
replace_once(
    'server/networkSanctions.test.mjs',
    """  assert.deepEqual(identity.authenticate(fresh, 'ticket'), { ok: false, reason: 'blocked-account' });
  assert.equal(fresh.accountId, undefined);
""",
    """  assert.deepEqual(identity.authenticate(fresh, 'ticket'), { ok: false, reason: 'blocked-account' });
  assert.equal(fresh.accountId, undefined);
  assert.equal(fresh.accountAccessDeniedAccountId, 'blocked-player');
""",
    'blocked-auth diagnostic side-channel regression',
)
