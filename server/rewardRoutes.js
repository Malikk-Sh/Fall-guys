const express = require('express');
const { SESSION_COOKIE, parseCookies } = require('./auth');

function installRewardRoutes({
  app,
  auth,
  rewards,
  enabled = process.env.ENABLE_DEV_REWARDS === '1'
}) {
  const json = express.json({ limit: '10kb' });

  app.post('/api/rewards/dev', json, (req, res) => {
    if (!enabled) return res.status(404).json({ ok: false, error: 'not-found' });
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
    const session = auth.resolveSession(token);
    if (!session) return res.status(401).json({ ok: false, error: 'session-required' });

    const result = rewards.grant({
      accountId: session.accountId,
      source: 'dev_rewarded',
      reward: 'random_cosmetic',
      idempotencyKey: req.body?.idempotencyKey
    });
    if (!result.ok) {
      const status = result.reason === 'daily-limit' ? 429 : result.reason === 'pool-exhausted' ? 409 : 400;
      return res.status(status).json(result);
    }

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'reward_granted',
        source: 'dev_rewarded',
        accountId: session.accountId,
        cosmeticId: result.cosmeticId,
        duplicate: result.duplicate
      })
    );
    return res.json(result);
  });
}

module.exports = { installRewardRoutes };
