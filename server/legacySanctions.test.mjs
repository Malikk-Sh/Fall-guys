import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./index');
const { accountAccessPolicy } = require('./accountAccessPolicy');

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('legacy recovery-code routes obey the same account sanction policy', async t => {
  const created = core.accounts.create('Legacy Blocked', Date.now());
  const publicSanction = {
    reason: 'exploit-cheat',
    expiresAt: Date.now() + 60 * 60 * 1000,
    permanent: false
  };
  accountAccessPolicy.configure(accountId => (accountId === created.id ? publicSanction : null));

  const server = core.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    accountAccessPolicy.reset();
    await new Promise(resolve => server.close(resolve));
  });

  const login = await post(base, '/account/login', { secret: created.secret });
  assert.equal(login.response.status, 403);
  assert.deepEqual(login.body, { ok: false, error: 'account-sanctioned', sanction: publicSanction });

  const rename = await post(base, '/account/name', { secret: created.secret, name: 'Bypass Name' });
  assert.equal(rename.response.status, 403);
  assert.equal(core.accounts.get(created.id).name, 'Legacy Blocked');

  const record = await post(base, '/account/record', {
    secret: created.secret,
    mode: 'race',
    courseKey: 'sanction-bypass',
    timeMs: 12345
  });
  assert.equal(record.response.status, 403);
  assert.equal(core.accounts.records(created.id).length, 0);

  assert.equal(JSON.stringify(login.body).includes('internal'), false);
});
