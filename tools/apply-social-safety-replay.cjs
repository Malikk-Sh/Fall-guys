'use strict';

const fs = require('node:fs');

const read = file => fs.readFileSync(file, 'utf8');
const write = (file, value) => fs.writeFileSync(file, value);
function replaceOnce(file, from, to) {
  const source = read(file);
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`anchor not found in ${file}: ${from.slice(0, 120)}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`anchor not unique in ${file}`);
  write(file, source.slice(0, first) + to + source.slice(first + from.length));
}

// Migration registration -----------------------------------------------------------------------
replaceOnce(
  'server/migrations/index.js',
  "const recentPartners = require('./006_recent_partners');",
  "const recentPartners = require('./006_recent_partners');\nconst socialSafety = require('./007_social_safety');"
);
replaceOnce(
  'server/migrations/index.js',
  '  rewardPlatform,\n  recentPartners\n]);',
  '  rewardPlatform,\n  recentPartners,\n  socialSafety\n]);'
);

// Profile derives avoid state from the same server DB ------------------------------------------
replaceOnce(
  'server/accounts.js',
  `            lastChapterId: recent.last_chapter_id,\n            lastPlayedAt: recent.last_played_at`,
  `            lastChapterId: recent.last_chapter_id,\n            lastPlayedAt: recent.last_played_at,\n            avoided: Boolean(recent.avoided)`
);
replaceOnce(
  'server/accounts.js',
  `      SELECT rp.partner_account_id, a.display_name, rp.matches_together,\n             rp.last_chapter_id, rp.last_played_at\n      FROM recent_partners rp`,
  `      SELECT rp.partner_account_id, a.display_name, rp.matches_together,\n             rp.last_chapter_id, rp.last_played_at,\n             EXISTS (\n               SELECT 1 FROM matchmaking_avoids ma\n               WHERE (ma.account_a = rp.account_id AND ma.account_b = rp.partner_account_id)\n                  OR (ma.account_a = rp.partner_account_id AND ma.account_b = rp.account_id)\n             ) AS avoided\n      FROM recent_partners rp`
);

// Core server + matchmaking --------------------------------------------------------------------
replaceOnce(
  'server/index.js',
  "const { trackSignatureMetrics } = require('./signatureMetrics');",
  "const { trackSignatureMetrics } = require('./signatureMetrics');\nconst { SocialSafety } = require('./socialSafety');"
);
replaceOnce(
  'server/index.js',
  'const gameplay = new GameplayMetrics({ db: gameDb });',
  'const gameplay = new GameplayMetrics({ db: gameDb });\nconst socialSafety = new SocialSafety({ db: gameDb });'
);
replaceOnce(
  'server/index.js',
  `function enqueueCoop(ws, message) {`,
  `function coopMatchCompatible(ws, entry, requested, safety = socialSafety) {\n  if (!entry?.ws || entry.ws.readyState !== 1 || entry.ws === ws) return false;\n  if (requested && entry.chapterId && entry.chapterId !== requested) return false;\n  return !safety.shouldAvoid(ws.accountId, entry.ws.accountId);\n}\n\nfunction enqueueCoop(ws, message) {`
);
replaceOnce(
  'server/index.js',
  `  const partnerIndex = coopMatchmaking.findIndex(entry => {\n    if (entry.ws.readyState !== 1 || entry.ws === ws) return false;\n    return !requested || !entry.chapterId || entry.chapterId === requested;\n  });`,
  `  const partnerIndex = coopMatchmaking.findIndex(entry => coopMatchCompatible(ws, entry, requested));`
);
replaceOnce(
  'server/index.js',
  '  accounts,\n  gameplay,',
  '  accounts,\n  gameplay,\n  socialSafety,\n  coopMatchCompatible,'
);

// Authenticated HTTP social actions --------------------------------------------------------------
replaceOnce(
  'server/bootstrap.js',
  "const { installRewardRoutes } = require('./rewardRoutes');",
  "const { installRewardRoutes } = require('./rewardRoutes');\nconst { installSocialRoutes } = require('./socialRoutes');"
);
replaceOnce(
  'server/bootstrap.js',
  'installAuthRoutes({',
  'const authRoutes = installAuthRoutes({'
);
replaceOnce(
  'server/bootstrap.js',
  `});\n\ninstallRewardRoutes({ app: core.app, auth, rewards });`,
  `});\n\ninstallSocialRoutes({\n  app: core.app,\n  socialSafety: core.socialSafety,\n  requireSession: authRoutes.requireSession\n});\ninstallRewardRoutes({ app: core.app, auth, rewards });`
);
replaceOnce(
  'server/bootstrap.js',
  '        socialCosmetics: true,\n        rewardPlatform: true,',
  '        socialCosmetics: true,\n        socialSafety: true,\n        rewardPlatform: true,'
);

// Client API ------------------------------------------------------------------------------------
replaceOnce(
  'client/core/account.js',
  `export async function equipAccountCosmetic(slot, cosmeticId, options) {\n  const { ok, data } = await post('/api/cosmetics/equip', { slot, cosmeticId }, options);\n  return ok ? data.inventory || null : null;\n}\n`,
  `export async function equipAccountCosmetic(slot, cosmeticId, options) {\n  const { ok, data } = await post('/api/cosmetics/equip', { slot, cosmeticId }, options);\n  return ok ? data.inventory || null : null;\n}\n\nexport async function avoidRecentPartner(targetAccountId, options) {\n  const { ok, data } = await post('/api/social/avoid', { targetAccountId }, options);\n  return ok ? data : null;\n}\n\nexport async function reportRecentPartner(targetAccountId, reason, options) {\n  const { ok, data } = await post('/api/social/report', { targetAccountId, reason }, options);\n  return ok ? data : null;\n}\n`
);

// AccountFlow wires social actions to the existing profile --------------------------------------
replaceOnce(
  'client/core/AccountFlow.js',
  '  accountProfile,\n  listAccounts,',
  '  accountProfile,\n  avoidRecentPartner,\n  listAccounts,'
);
replaceOnce(
  'client/core/AccountFlow.js',
  '  rememberAccount,\n  sessionAccount,',
  '  rememberAccount,\n  reportRecentPartner,\n  sessionAccount,'
);
replaceOnce(
  'client/core/AccountFlow.js',
  '    this.game.ui.onProfileRefresh = () => this.refreshProfile();',
  `    this.game.ui.onProfileRefresh = () => this.refreshProfile();\n    this.game.ui.onRecentPartnerAvoid = partner => this.avoidPartner(partner);\n    this.game.ui.onRecentPartnerReport = (partner, reason) => this.reportPartner(partner, reason);`
);
replaceOnce(
  'client/core/AccountFlow.js',
  `  recordFor(mode, spec) {`,
  `  async avoidPartner(partner) {\n    if (!partner?.id) return null;\n    try {\n      const result = await avoidRecentPartner(partner.id);\n      if (!result) return this.game.ui.toast('Не удалось сохранить исключение — попробуйте ещё раз.');\n      await this.refreshProfile();\n      this.game.ui.toast('Этого игрока больше не подберёт вам быстрый поиск.');\n      return result;\n    } catch {\n      this.game.ui.toast('Не удалось сохранить исключение — попробуйте ещё раз.');\n      return null;\n    }\n  }\n\n  async reportPartner(partner, reason) {\n    if (!partner?.id || !reason) return null;\n    try {\n      const result = await reportRecentPartner(partner.id, reason);\n      if (!result) return this.game.ui.toast('Жалобу не удалось отправить.');\n      this.game.ui.toast(result.duplicate ? 'Такая жалоба уже отправлена недавно.' : 'Жалоба отправлена. Спасибо.');\n      return result;\n    } catch {\n      this.game.ui.toast('Жалобу не удалось отправить.');\n      return null;\n    }\n  }\n\n  recordFor(mode, spec) {`
);

// Profile controls ------------------------------------------------------------------------------
replaceOnce(
  'client/ui/UI.js',
  `    $('#recentPartnerInvite').addEventListener('click', () => {\n      const partner = this.serverProfile?.recentPartner;\n      if (partner) this.onRecentPartnerInvite?.(partner);\n    });`,
  `    $('#recentPartnerInvite').addEventListener('click', () => {\n      const partner = this.serverProfile?.recentPartner;\n      if (partner) this.onRecentPartnerInvite?.(partner);\n    });\n    $('#recentPartnerAvoid').addEventListener('click', () => {\n      const partner = this.serverProfile?.recentPartner;\n      if (partner && !partner.avoided) this.onRecentPartnerAvoid?.(partner);\n    });\n    $('#recentPartnerReport').addEventListener('click', () =>\n      $('#recentPartnerReportReasons').classList.toggle('hidden')\n    );\n    selectAll('[data-social-report]').forEach(button =>\n      button.addEventListener('click', () => {\n        const partner = this.serverProfile?.recentPartner;\n        if (!partner) return;\n        $('#recentPartnerReportReasons').classList.add('hidden');\n        this.onRecentPartnerReport?.(partner, button.dataset.socialReport);\n      })\n    );`
);
replaceOnce(
  'client/ui/UI.js',
  `    const invite = $('#recentPartnerInvite');\n    invite.disabled = !partner;\n    if (!partner) return;`,
  `    const invite = $('#recentPartnerInvite');\n    const avoid = $('#recentPartnerAvoid');\n    const report = $('#recentPartnerReport');\n    invite.disabled = !partner;\n    avoid.disabled = !partner || Boolean(partner?.avoided);\n    avoid.textContent = partner?.avoided ? 'НЕ БУДЕМ ПОДБИРАТЬ' : 'НЕ ПОДБИРАТЬ СНОВА';\n    report.disabled = !partner;\n    $('#recentPartnerReportReasons').classList.add('hidden');\n    if (!partner) return;`
);

// Replay invite + resilient automatic share -----------------------------------------------------
replaceOnce(
  'client/ui/menuBindings.js',
  "import { courseSpec, dailyCourseSpec, randomSeed } from '../core/Config.js';",
  "import { courseSpec, dailyCourseSpec, randomSeed } from '../core/Config.js';\nimport { shareInvite } from '../core/invite.js';"
);
replaceOnce(
  'client/ui/menuBindings.js',
  `    game.ui.pendingRecentPartnerInviteName = partner?.name || 'напарника';`,
  `    game.pendingReplayShare = { partnerName: partner?.name || 'напарника' };`
);
replaceOnce(
  'client/ui/menuBindings.js',
  `  $('#copyInvite').addEventListener('click', async () => {\n    const mode = game.room?.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;\n    const link = game.ui.inviteLink($('#roomCode').textContent.trim(), mode);\n    try {\n      // На телефоне системное «Поделиться» удобнее буфера обмена: ссылка сразу уходит в\n      // мессенджер, а не требует переключения приложений вручную.\n      if (navigator.share) {\n        const title = mode === GAME_MODE.COOP ? 'Wobble Rush — кооп' : 'Wobble Rush — гонка';\n        await navigator.share({ title, url: link });\n      } else await navigator.clipboard.writeText(link);\n      game.ui.toast('Ссылка-приглашение готова!');\n    } catch {\n      game.ui.toast(link);\n    }\n  });`,
  `  game.shareRoomInvite = async ({ code, mode, automatic = false, partnerName = '' } = {}) => {\n    const roomMode = mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;\n    const link = game.ui.inviteLink(code || $('#roomCode').textContent.trim(), roomMode);\n    const title = roomMode === GAME_MODE.COOP ? 'Wobble Rush — кооп' : 'Wobble Rush — гонка';\n    const result = await shareInvite({ title, url: link });\n    if (result.shared) {\n      game.ui.toast(automatic && partnerName ? 'Приглашение для ' + partnerName + ' открыто.' : 'Ссылка-приглашение готова!');\n    } else if (result.copied) {\n      game.ui.toast(automatic ? 'Комната готова — ссылка скопирована.' : 'Ссылка-приглашение скопирована!');\n    } else if (!result.cancelled) {\n      game.ui.toast(automatic ? 'Комната готова — нажмите «ССЫЛКА», чтобы отправить приглашение.' : link);\n    }\n    return result;\n  };\n  $('#copyInvite').addEventListener('click', () => {\n    const mode = game.room?.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;\n    game.shareRoomInvite({ code: $('#roomCode').textContent.trim(), mode });\n  });`
);
replaceOnce(
  'client/net/networkBindings.js',
  `    game.ui.lobby(message, game.net.id);`,
  `    game.ui.lobby(message, game.net.id);\n    if (game.pendingReplayShare && message.mode === GAME_MODE.COOP && message.code) {\n      const pending = game.pendingReplayShare;\n      game.pendingReplayShare = null;\n      queueMicrotask(() =>\n        game.shareRoomInvite?.({\n          code: message.code,\n          mode: GAME_MODE.COOP,\n          automatic: true,\n          partnerName: pending.partnerName\n        })\n      );\n    }`
);

// Profile markup + styles -----------------------------------------------------------------------
replaceOnce(
  'client/index.html',
  `          <div id="recentPartnerCard" class="recent-partner-card hidden">\n            <div><strong id="recentPartnerName">Wobbler</strong><small id="recentPartnerMeta"></small></div>\n            <button id="recentPartnerInvite" class="button button-primary" disabled>ПРИГЛАСИТЬ СНОВА</button>\n          </div>`,
  `          <div id="recentPartnerCard" class="recent-partner-card hidden">\n            <div class="recent-partner-copy"><strong id="recentPartnerName">Wobbler</strong><small id="recentPartnerMeta"></small></div>\n            <div class="recent-partner-actions">\n              <button id="recentPartnerInvite" class="button button-primary" disabled>ИГРАТЬ СНОВА</button>\n              <button id="recentPartnerAvoid" class="button button-secondary" disabled>НЕ ПОДБИРАТЬ СНОВА</button>\n              <button id="recentPartnerReport" class="button button-secondary" disabled>ПОЖАЛОВАТЬСЯ</button>\n            </div>\n            <div id="recentPartnerReportReasons" class="social-report-reasons hidden" role="group" aria-label="Причина жалобы">\n              <button type="button" data-social-report="afk">AFK</button>\n              <button type="button" data-social-report="griefing">МЕШАЕТ ПРОХОЖДЕНИЮ</button>\n              <button type="button" data-social-report="offensive-name">ОСКОРБИТЕЛЬНОЕ ИМЯ</button>\n              <button type="button" data-social-report="exploit-cheat">ЭКСПЛОЙТЫ / ЧИТ</button>\n            </div>\n          </div>`
);
write(
  'client/styles.css',
  read('client/styles.css') + `\n\n/* #55 — compact social safety actions inside the existing recent-partner card. */\n.recent-partner-actions {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, auto));\n  gap: 7px;\n}\n.social-report-reasons {\n  grid-column: 1 / -1;\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 6px;\n}\n.social-report-reasons button {\n  min-height: 34px;\n  border: 1px solid #ffffff24;\n  border-radius: 9px;\n  color: #fff;\n  background: #ffffff0d;\n  font-size: 8px;\n  font-weight: 900;\n  cursor: pointer;\n}\n@media (max-width: 760px) {\n  .recent-partner-actions { grid-template-columns: 1fr; }\n}\n`
);

// Regression tests ------------------------------------------------------------------------------
replaceOnce(
  'server/migrations.test.mjs',
  'assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6]);',
  'assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6, 7]);'
);
replaceOnce(
  'server/migrations.test.mjs',
  '    { version: 6, applied_at: 123 }\n  ]);',
  '    { version: 6, applied_at: 123 },\n    { version: 7, applied_at: 123 }\n  ]);'
);
replaceOnce(
  'server/migrations.test.mjs',
  "    'recent_partners'\n  ]) {",
  "    'recent_partners',\n    'matchmaking_avoids',\n    'social_reports'\n  ]) {"
);
replaceOnce(
  'server/migrations.test.mjs',
  "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_partners').get().count, 0);",
  "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_partners').get().count, 0);\n  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM matchmaking_avoids').get().count, 0);\n  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_reports').get().count, 0);"
);
replaceOnce(
  'server/socialProfile.test.mjs',
  `    lastChapterId: 'ch4',\n    lastPlayedAt: 2000\n  });`,
  `    lastChapterId: 'ch4',\n    lastPlayedAt: 2000,\n    avoided: false\n  });`
);
replaceOnce(
  'server/invite.test.mjs',
  "import { buildInviteLink, readInvite } from '../client/core/invite.js';",
  "import { buildInviteLink, readInvite, shareInvite } from '../client/core/invite.js';"
);
write(
  'server/invite.test.mjs',
  read('server/invite.test.mjs') + `\n\ntest('share invite использует системный share и безопасно откатывается к clipboard', async () => {\n` +
    `  const shared = [];\n` +
    `  const shareResult = await shareInvite({ title: 'Кооп', url: 'https://game.example/?room=ABCDE', navigatorRef: { share: async payload => shared.push(payload) } });\n` +
    `  assert.equal(shareResult.shared, true);\n` +
    `  assert.equal(shared[0].url, 'https://game.example/?room=ABCDE');\n` +
    `  const copied = [];\n` +
    `  const fallback = await shareInvite({ title: 'Кооп', url: 'https://game.example/?room=FGHIJ', navigatorRef: { share: async () => { throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' }); }, clipboard: { writeText: async value => copied.push(value) } } });\n` +
    `  assert.equal(fallback.copied, true);\n` +
    `  assert.deepEqual(copied, ['https://game.example/?room=FGHIJ']);\n` +
    `});\n`
);
replaceOnce(
  'server/test.js',
  '  matchmakingStatus,\n  addVerificationFindings',
  '  matchmakingStatus,\n  coopMatchCompatible,\n  addVerificationFindings'
);
write(
  'server/test.js',
  read('server/test.js') + `\n\ntest('quick matchmaking не соединяет account pair после avoid', () => {\n` +
    `  const requester = { readyState: 1, accountId: 'a' };\n` +
    `  const candidate = { ws: { readyState: 1, accountId: 'b' }, chapterId: 'ch4' };\n` +
    `  const safety = { shouldAvoid: (a, b) => a === 'a' && b === 'b' };\n` +
    `  assert.equal(coopMatchCompatible(requester, candidate, 'ch4', safety), false);\n` +
    `  assert.equal(coopMatchCompatible(requester, candidate, 'ch3', { shouldAvoid: () => false }), false);\n` +
    `  assert.equal(coopMatchCompatible(requester, candidate, null, { shouldAvoid: () => false }), true);\n` +
    `});\n`
);

const pkg = JSON.parse(read('package.json'));
pkg.version = '2.5.0';
if (!pkg.scripts.test.includes('server/socialSafety.test.mjs')) {
  pkg.scripts.test = pkg.scripts.test.replace(
    'server/socialProfile.test.mjs',
    'server/socialProfile.test.mjs server/socialSafety.test.mjs'
  );
}
write('package.json', JSON.stringify(pkg, null, 2) + '\n');
const lock = JSON.parse(read('package-lock.json'));
lock.version = '2.5.0';
lock.packages[''].version = '2.5.0';
write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
