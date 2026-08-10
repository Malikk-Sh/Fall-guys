'use strict';

const fs = require('fs');

function replaceOnce(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

function appendOnce(path, marker, block) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(marker)) return false;
  source = `${source.trimEnd()}\n${block.trim()}\n`;
  fs.writeFileSync(path, source);
  return true;
}

// --- migrations -------------------------------------------------------------------------------
replaceOnce(
  'server/migrations/index.js',
  "const rewardPlatform = require('./005_reward_platform');\n\nconst MIGRATIONS = Object.freeze([initial, accountProgress, authSessions, serverInventory, rewardPlatform]);",
  "const rewardPlatform = require('./005_reward_platform');\nconst recentPartners = require('./006_recent_partners');\n\nconst MIGRATIONS = Object.freeze([\n  initial,\n  accountProgress,\n  authSessions,\n  serverInventory,\n  rewardPlatform,\n  recentPartners\n]);",
  'register migration 006'
);

replaceOnce(
  'server/migrations.test.mjs',
  "assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5]);",
  "assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6]);",
  'migration version list'
);
replaceOnce(
  'server/migrations.test.mjs',
  "    { version: 5, applied_at: 123 }\n  ]);",
  "    { version: 5, applied_at: 123 },\n    { version: 6, applied_at: 123 }\n  ]);",
  'migration applied list'
);
replaceOnce(
  'server/migrations.test.mjs',
  "    'account_loadout',\n    'reward_grants'",
  "    'account_loadout',\n    'reward_grants',\n    'recent_partners'",
  'migration table coverage'
);
replaceOnce(
  'server/migrations.test.mjs',
  "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);\n  db.close();",
  "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);\n  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_partners').get().count, 0);\n  db.close();",
  'migration legacy recent partners'
);

// --- account domain ----------------------------------------------------------------------------
replaceOnce(
  'server/accounts.js',
  "  count() {\n    return Number(this.statements.count.get().count);\n  }",
  `  // Последний напарник — server-owned social history. Клиент не присылает partner id: запись\n  // появляется только после завершённого сервером кооперативного матча. Для двух игроков пишем две\n  // направленные строки, чтобы у каждого профиль можно было читать одним дешёвым запросом.\n  recordCoopPartners({ accountIds, chapterId, playedAt = Date.now() }) {\n    const chapter = String(chapterId || '');\n    if (!/^ch(?:10|[1-9])$/.test(chapter)) return 0;\n    const ids = [\n      ...new Set(\n        (Array.isArray(accountIds) ? accountIds : [])\n          .map(id => String(id || ''))\n          .filter(id => id && this.statements.byId.get(id))\n      )\n    ];\n    if (ids.length < 2) return 0;\n    const at = Number.isFinite(playedAt) && playedAt >= 0 ? Math.round(playedAt) : Date.now();\n    let writes = 0;\n    this.db.exec('BEGIN IMMEDIATE');\n    try {\n      for (const accountId of ids) {\n        for (const partnerId of ids) {\n          if (accountId === partnerId) continue;\n          this.statements.upsertRecentPartner.run(accountId, partnerId, chapter, at);\n          writes++;\n        }\n      }\n      this.db.exec('COMMIT');\n    } catch (error) {\n      this.db.exec('ROLLBACK');\n      throw error;\n    }\n    return writes;\n  }\n\n  // Профиль — отдельное read-model представление существующего authoritative прогресса. Оно не\n  // дублирует counters: всё выводится из account_stats/chapter_progress/achievements и recent partner.\n  profile(accountId) {\n    const id = String(accountId || '');\n    if (!this.statements.byId.get(id)) return null;\n    const progress = this.progress(id);\n    const campaignAchievement = progress.achievements.find(item => item.id === 'coop-campaign-complete');\n    const recent = this.statements.recentPartner.get(id);\n    return {\n      stats: {\n        ...progress.stats,\n        coopFlawless: Number(this.statements.flawlessCount.get(id)?.count || 0)\n      },\n      achievements: progress.achievements,\n      campaign: {\n        completed: Boolean(campaignAchievement),\n        completedAt: campaignAchievement?.unlockedAt || null,\n        chaptersCompleted: progress.stats.coopChaptersCompleted,\n        totalChapters: 10\n      },\n      recentPartner: recent\n        ? {\n            id: recent.partner_account_id,\n            name: recent.display_name,\n            matchesTogether: Number(recent.matches_together || 0),\n            lastChapterId: recent.last_chapter_id,\n            lastPlayedAt: recent.last_played_at\n          }\n        : null\n    };\n  }\n\n  count() {\n    return Number(this.statements.count.get().count);\n  }`,
  'accounts social profile methods'
);

replaceOnce(
  'server/accounts.js',
  "    achievements: db.prepare(\n      'SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ? ORDER BY unlocked_at'\n    )",
  `    achievements: db.prepare(\n      'SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ? ORDER BY unlocked_at'\n    ),\n    upsertRecentPartner: db.prepare(\`\n      INSERT INTO recent_partners\n        (account_id, partner_account_id, matches_together, last_chapter_id, last_played_at)\n      VALUES (?, ?, 1, ?, ?)\n      ON CONFLICT (account_id, partner_account_id) DO UPDATE SET\n        matches_together = matches_together + 1,\n        last_chapter_id = excluded.last_chapter_id,\n        last_played_at = excluded.last_played_at\n    \`),\n    recentPartner: db.prepare(\`\n      SELECT rp.partner_account_id, a.display_name, rp.matches_together,\n             rp.last_chapter_id, rp.last_played_at\n      FROM recent_partners rp\n      JOIN accounts a ON a.id = rp.partner_account_id\n      WHERE rp.account_id = ?\n      ORDER BY rp.last_played_at DESC, rp.partner_account_id ASC\n      LIMIT 1\n    \`)`,
  'accounts recent partner statements'
);

// --- game server records social edge only after authoritative coop completion -------------------
replaceOnce(
  'server/index.js',
  `    if (room.mode === GAME_MODE.COOP && coopTime) {\n      for (const player of room.players.values()) {\n        if (!player.accountId) continue;\n        accounts.recordCoopCompletion({\n          accountId: player.accountId,\n          chapterId: room.chapterId,\n          timeMs: coopTime,\n          revives: player.coopRevives || 0,\n          falls: player.coopFalls || 0\n        });\n      }\n    }`,
  `    if (room.mode === GAME_MODE.COOP && coopTime) {\n      const accountIds = [];\n      for (const player of room.players.values()) {\n        if (!player.accountId) continue;\n        accountIds.push(player.accountId);\n        accounts.recordCoopCompletion({\n          accountId: player.accountId,\n          chapterId: room.chapterId,\n          timeMs: coopTime,\n          revives: player.coopRevives || 0,\n          falls: player.coopFalls || 0\n        });\n      }\n      accounts.recordCoopPartners({ accountIds, chapterId: room.chapterId });\n    }`,
  'record coop recent partners'
);

// --- authenticated profile API -----------------------------------------------------------------
replaceOnce(
  'server/bootstrap.js',
  "  progress: core.accounts.progress(account.id),\n  inventory: inventory.syncEntitlements(account.id)",
  "  progress: core.accounts.progress(account.id),\n  profile: core.accounts.profile(account.id),\n  inventory: inventory.syncEntitlements(account.id)",
  'bootstrap profile payload'
);

replaceOnce(
  'server/authRoutes.js',
  "  app.post('/api/auth/recovery', json, (req, res) => {",
  `  // Профиль обновляется отдельно от /session: открытие profile screen не должно выпускать новый\n  // одноразовый WebSocket ticket, который пользователь даже не собирался использовать.\n  app.post('/api/auth/profile', json, (req, res) => {\n    const session = requireSession(req, res);\n    if (!session) return undefined;\n    return res.json({ ok: true, profile: accounts.profile(session.accountId) });\n  });\n\n  app.post('/api/auth/recovery', json, (req, res) => {`,
  'authenticated profile route'
);

// --- client account/profile transport -----------------------------------------------------------
replaceOnce(
  'client/core/account.js',
  "    progress: data.progress || null,\n    inventory: data.inventory || null",
  "    progress: data.progress || null,\n    profile: data.profile || null,\n    inventory: data.inventory || null",
  'client serverAccount profile'
);
replaceOnce(
  'client/core/account.js',
  "export async function authConfig(options) {",
  `export async function accountProfile(options) {\n  const { ok, data } = await post('/api/auth/profile', {}, options);\n  return ok ? data.profile || null : null;\n}\n\nexport async function authConfig(options) {`,
  'client profile api helper'
);

replaceOnce(
  'client/core/AccountFlow.js',
  "  ensureAccount,\n  listAccounts,",
  "  ensureAccount,\n  accountProfile,\n  listAccounts,",
  'AccountFlow profile import'
);
replaceOnce(
  'client/core/AccountFlow.js',
  "    setServerCosmeticEquipHandler((slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId));",
  "    setServerCosmeticEquipHandler((slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId));\n    this.game.ui.onProfileRefresh = () => this.refreshProfile();",
  'AccountFlow profile refresh binding'
);
replaceOnce(
  'client/core/AccountFlow.js',
  "    this.game.ui.setAccountProgress(progress);\n    this.game.ui.setAccountList(listAccounts());",
  "    this.game.ui.setAccountProgress(progress);\n    this.game.ui.setServerProfile(online ? account?.profile || null : null);\n    this.game.ui.setAccountList(listAccounts());",
  'AccountFlow apply server profile'
);
replaceOnce(
  'client/core/AccountFlow.js',
  "  recordFor(mode, spec) {",
  `  async refreshProfile() {\n    try {\n      const profile = await accountProfile();\n      if (profile) this.game.ui.setServerProfile(profile);\n      return profile;\n    } catch {\n      return null;\n    }\n  }\n\n  recordFor(mode, spec) {`,
  'AccountFlow refresh method'
);

// --- profile UI ---------------------------------------------------------------------------------
replaceOnce(
  'client/ui/UI.js',
  "import { GAME_MODE } from '/shared/protocol.js';",
  `import { GAME_MODE } from '/shared/protocol.js';\nimport {\n  ACHIEVEMENT_CATALOG,\n  CAMPAIGN_BADGE_GLYPH,\n  CAMPAIGN_PROFILE_TITLE,\n  DEFAULT_PROFILE_TITLE\n} from '/shared/achievements.js';`,
  'UI achievement catalog import'
);
replaceOnce(
  'client/ui/UI.js',
  "    this.bindAccountPanel();\n  }",
  "    this.bindAccountPanel();\n    this.bindProfilePanel();\n  }",
  'UI bind profile panel'
);
replaceOnce(
  'client/ui/UI.js',
  "  accountStatus(text) {\n    $('#accountStatus').textContent = text || '';\n  }",
  `  accountStatus(text) {\n    $('#accountStatus').textContent = text || '';\n  }\n\n  bindProfilePanel() {\n    const screen = $('#profile');\n    const toggle = show => {\n      screen.classList.toggle('hidden', !show);\n      $('#profileOpen').setAttribute('aria-expanded', String(show));\n      if (show) {\n        this.renderServerProfile();\n        this.onProfileRefresh?.();\n      }\n    };\n    this.toggleProfileScreen = toggle;\n    $('#profileOpen').addEventListener('click', () => toggle(true));\n    $('#profileClose').addEventListener('click', () => toggle(false));\n    screen.addEventListener('click', event => {\n      if (event.target === screen) toggle(false);\n    });\n    addEventListener('keydown', event => {\n      if (event.key === 'Escape' && !screen.classList.contains('hidden')) toggle(false);\n    });\n    $('#recentPartnerInvite').addEventListener('click', () => {\n      const partner = this.serverProfile?.recentPartner;\n      if (partner) this.onRecentPartnerInvite?.(partner);\n    });\n  }\n\n  setServerProfile(profile) {\n    this.serverProfile = profile || null;\n    this.renderServerProfile();\n  }\n\n  renderServerProfile() {\n    const screen = $('#profile');\n    if (!screen) return;\n    const profile = this.serverProfile;\n    const stats = profile?.stats || {};\n    const unlocked = new Map((profile?.achievements || []).map(item => [item.id, item]));\n    const campaignComplete = Boolean(profile?.campaign?.completed || unlocked.has('coop-campaign-complete'));\n    const completed = Math.min(10, Number(profile?.campaign?.chaptersCompleted || 0));\n\n    $('#profileName').textContent = this.account?.name || 'Wobbler';\n    $('#profileTitle').textContent = campaignComplete ? CAMPAIGN_PROFILE_TITLE : DEFAULT_PROFILE_TITLE;\n    $('#profileBadge').textContent = campaignComplete ? CAMPAIGN_BADGE_GLYPH : '◇';\n    $('#profileBadge').classList.toggle('completed', campaignComplete);\n    $('#profileCampaign').textContent = campaignComplete\n      ? 'КАМПАНИЯ ПРОЙДЕНА · 10/10'\n      : `ПРИКЛЮЧЕНИЕ · ${completed}/10 ГЛАВ`;\n    $('#profileStatMatches').textContent = Number(stats.coopMatchesCompleted || 0);\n    $('#profileStatChapters').textContent = Number(stats.coopChaptersCompleted || 0);\n    $('#profileStatRevives').textContent = Number(stats.coopRevives || 0);\n    $('#profileStatFlawless').textContent = Number(stats.coopFlawless || 0);\n\n    const achievements = $('#profileAchievements');\n    achievements.replaceChildren();\n    for (const item of ACHIEVEMENT_CATALOG) {\n      const earned = unlocked.get(item.id);\n      const card = document.createElement('div');\n      card.className = 'profile-achievement';\n      card.classList.toggle('locked', !earned);\n      const glyph = document.createElement('i');\n      glyph.textContent = earned ? item.glyph : '·';\n      const copy = document.createElement('span');\n      const name = document.createElement('strong');\n      name.textContent = item.name;\n      const detail = document.createElement('small');\n      detail.textContent = earned ? 'ПОЛУЧЕНО · ' + item.detail : item.detail;\n      copy.append(name, detail);\n      card.append(glyph, copy);\n      achievements.append(card);\n    }\n\n    const partner = profile?.recentPartner;\n    $('#recentPartnerEmpty').classList.toggle('hidden', Boolean(partner));\n    $('#recentPartnerCard').classList.toggle('hidden', !partner);\n    const invite = $('#recentPartnerInvite');\n    invite.disabled = !partner;\n    if (!partner) return;\n    $('#recentPartnerName').textContent = partner.name || 'Wobbler';\n    const chapter = this.coopChapters?.find(item => item.id === partner.lastChapterId);\n    const chapterName = chapter?.title || String(partner.lastChapterId || '').toUpperCase() || 'КООП';\n    $('#recentPartnerMeta').textContent =\n      `ВМЕСТЕ ${Number(partner.matchesTogether || 0)} · ПОСЛЕДНЯЯ: ${chapterName}`;\n  }`,
  'UI profile methods'
);
replaceOnce(
  'client/ui/UI.js',
  "    this.renderAccountPanel();\n    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);",
  "    this.renderAccountPanel();\n    this.renderServerProfile();\n    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);",
  'UI account rerenders profile'
);

replaceOnce(
  'client/ui/UI.js',
  `    $('#lobbyHint').textContent = host\n      ? 'Все игроки должны быть готовы перед стартом.'\n      : 'Отметьтесь готовым — гонку запустит хост.';`,
  `    if (this.pendingRecentPartnerInviteName && data.mode === GAME_MODE.COOP) {\n      this.recentPartnerInviteRoomCode = data.code;\n      this.recentPartnerInviteName = this.pendingRecentPartnerInviteName;\n      this.pendingRecentPartnerInviteName = null;\n    }\n    if (this.recentPartnerInviteRoomCode === data.code && data.players.length > 1) {\n      this.recentPartnerInviteRoomCode = null;\n      this.recentPartnerInviteName = null;\n    }\n    const waitingRecentPartner =\n      data.mode === GAME_MODE.COOP &&\n      this.recentPartnerInviteRoomCode === data.code &&\n      data.players.length === 1;\n    $('#lobbyHint').textContent = waitingRecentPartner\n      ? `Комната для ${this.recentPartnerInviteName} готова — отправьте её кнопкой «ССЫЛКА».`\n      : host\n        ? 'Все игроки должны быть готовы перед стартом.'\n        : 'Отметьтесь готовым — гонку запустит хост.';`,
  'UI recent partner lobby hint'
);

// --- menu social loop ---------------------------------------------------------------------------
replaceOnce(
  'client/ui/menuBindings.js',
  "  game.ui.onAccountAction = (action, value) => game.account.handleAction(action, value);\n  const $ = s => document.querySelector(s);",
  `  game.ui.onAccountAction = (action, value) => game.account.handleAction(action, value);\n  game.ui.onRecentPartnerInvite = async partner => {\n    await game.accountReady;\n    const chapter = COOP_CHAPTERS.find(item => item.id === partner?.lastChapterId) || COOP_CHAPTERS[0];\n    $('#coopChapter').value = chapter.id;\n    $('#coopChapter').dispatchEvent(new Event('change'));\n    game.ui.selectMode('coop');\n    game.ui.toggleProfileScreen?.(false);\n    game.ui.pendingRecentPartnerInviteName = partner?.name || 'напарника';\n    const net = game.ensureNetwork();\n    net.createRoom({\n      name: game.ui.coopName(),\n      playerId: game.ui.playerId(),\n      mode: GAME_MODE.COOP,\n      difficulty: chapter.id\n    });\n  };\n  const $ = s => document.querySelector(s);`,
  'menu recent partner invite flow'
);

// --- markup -------------------------------------------------------------------------------------
replaceOnce(
  'client/index.html',
  `        <div class="account-bar">\n          <button id="accountChip" class="account-chip" aria-haspopup="dialog" aria-expanded="false">\n            <span class="account-dot" aria-hidden="true"></span>\n            <b id="accountName">…</b>\n            <small>сменить</small>\n          </button>\n        </div>`,
  `        <div class="account-bar">\n          <button id="accountChip" class="account-chip" aria-haspopup="dialog" aria-expanded="false">\n            <span class="account-dot" aria-hidden="true"></span>\n            <b id="accountName">…</b>\n            <small>сменить</small>\n          </button>\n          <button id="profileOpen" class="profile-chip" aria-haspopup="dialog" aria-expanded="false">\n            <b>ПРОФИЛЬ</b><small>статы · награды</small>\n          </button>\n        </div>`,
  'profile open button'
);

replaceOnce(
  'client/index.html',
  "    <!-- Экран настроек управления. Содержимое собирается из схемы в client/core/settings.js —",
  `    <section id="profile" class="screen center-screen hidden">\n      <div class="profile-card glass" role="dialog" aria-label="Профиль игрока">\n        <button id="profileClose" class="close-button" aria-label="Закрыть">×</button>\n        <span class="eyebrow">ПРОФИЛЬ</span>\n        <div class="profile-hero">\n          <div id="profileBadge" class="profile-badge" aria-hidden="true">◇</div>\n          <div class="profile-identity">\n            <small id="profileTitle">ИСКАТЕЛЬ НЕБЕС</small>\n            <h2 id="profileName">Wobbler</h2>\n            <p id="profileCampaign">ПРИКЛЮЧЕНИЕ · 0/10 ГЛАВ</p>\n          </div>\n        </div>\n        <div class="profile-stats" aria-label="Серверная статистика">\n          <span><small>КООП-МАТЧИ</small><b id="profileStatMatches">0</b></span>\n          <span><small>ГЛАВЫ</small><b id="profileStatChapters">0</b></span>\n          <span><small>СПАСЕНИЯ</small><b id="profileStatRevives">0</b></span>\n          <span><small>БЕЗ ПАДЕНИЙ</small><b id="profileStatFlawless">0</b></span>\n        </div>\n        <section class="profile-section" aria-labelledby="profileAchievementsTitle">\n          <div class="profile-section-head">\n            <small id="profileAchievementsTitle">ДОСТИЖЕНИЯ</small><span>SERVER VERIFIED</span>\n          </div>\n          <div id="profileAchievements" class="profile-achievements"></div>\n        </section>\n        <section class="profile-section" aria-labelledby="recentPartnerTitle">\n          <div class="profile-section-head">\n            <small id="recentPartnerTitle">НЕДАВНИЙ НАПАРНИК</small><span>СЫГРАТЬ СНОВА</span>\n          </div>\n          <p id="recentPartnerEmpty" class="recent-partner-empty">\n            Завершите кооперативную главу — последний напарник появится здесь.\n          </p>\n          <div id="recentPartnerCard" class="recent-partner-card hidden">\n            <div><strong id="recentPartnerName">Wobbler</strong><small id="recentPartnerMeta"></small></div>\n            <button id="recentPartnerInvite" class="button button-primary" disabled>ПРИГЛАСИТЬ СНОВА</button>\n          </div>\n        </section>\n      </div>\n    </section>\n\n    <!-- Экран настроек управления. Содержимое собирается из схемы в client/core/settings.js —`,
  'profile screen markup'
);

// --- CSS ----------------------------------------------------------------------------------------
appendOnce(
  'client/styles.css',
  '/* Profile & Social Loop */',
  `/* Profile & Social Loop */\n.account-bar {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;\n  gap: 8px;\n}\n.profile-chip {\n  display: grid;\n  align-content: center;\n  min-width: 102px;\n  border: 1px solid #ffffff26;\n  border-radius: 12px;\n  padding: 7px 10px;\n  color: #fff;\n  background: #ffffff0d;\n  cursor: pointer;\n}\n.profile-chip b {\n  color: var(--yellow);\n  font-size: 10px;\n  letter-spacing: 0.08em;\n}\n.profile-chip small {\n  margin-top: 2px;\n  color: #aaa4ca;\n  font-size: 7px;\n  white-space: nowrap;\n}\n.profile-card {\n  width: min(620px, calc(100vw - 32px));\n  max-height: calc(100vh - 32px - var(--safe-top) - var(--safe-bottom));\n  overflow-y: auto;\n  border-radius: 26px;\n  padding: 22px;\n}\n.profile-hero {\n  display: grid;\n  grid-template-columns: auto 1fr;\n  align-items: center;\n  gap: 16px;\n  margin: 14px 0 16px;\n}\n.profile-badge {\n  display: grid;\n  place-items: center;\n  width: 74px;\n  height: 74px;\n  border: 2px solid #ffffff38;\n  border-radius: 23px;\n  color: #8d82bd;\n  background: #ffffff0a;\n  font-size: 38px;\n  box-shadow: inset 0 -10px #0002;\n}\n.profile-badge.completed {\n  color: var(--yellow);\n  border-color: #ffdd4c99;\n  background: radial-gradient(circle at 50% 35%, #ffef9560, #ffdd4c12 58%, #ffffff08 59%);\n  text-shadow: 0 0 18px #ffdd4c88;\n}\n.profile-identity {\n  min-width: 0;\n}\n.profile-identity small {\n  color: var(--cyan);\n  font-size: 10px;\n  font-weight: 950;\n  letter-spacing: 0.12em;\n}\n.profile-identity h2 {\n  overflow: hidden;\n  margin: 4px 0;\n  font-size: clamp(25px, 7vw, 38px);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.profile-identity p {\n  margin: 0;\n  color: #b9b2dd;\n  font-size: 10px;\n  font-weight: 850;\n  letter-spacing: 0.08em;\n}\n.profile-stats {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n  gap: 8px;\n  margin-bottom: 18px;\n}\n.profile-stats span {\n  display: grid;\n  gap: 4px;\n  min-width: 0;\n  padding: 11px 8px;\n  border: 1px solid #ffffff18;\n  border-radius: 12px;\n  background: #ffffff08;\n  text-align: center;\n}\n.profile-stats small {\n  overflow: hidden;\n  color: #aaa4ca;\n  font-size: 7px;\n  font-weight: 900;\n  text-overflow: ellipsis;\n}\n.profile-stats b {\n  color: #fff;\n  font-size: 20px;\n}\n.profile-section {\n  margin-top: 15px;\n}\n.profile-section-head {\n  display: flex;\n  justify-content: space-between;\n  gap: 10px;\n  margin-bottom: 8px;\n  color: #aaa4ca;\n  font-size: 8px;\n  font-weight: 900;\n  letter-spacing: 0.1em;\n}\n.profile-section-head span {\n  color: #6fded7;\n}\n.profile-achievements {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 7px;\n}\n.profile-achievement {\n  display: grid;\n  grid-template-columns: 34px minmax(0, 1fr);\n  align-items: center;\n  gap: 8px;\n  min-height: 58px;\n  padding: 9px;\n  border: 1px solid #62eeb933;\n  border-radius: 11px;\n  background: #62eeb90b;\n}\n.profile-achievement.locked {\n  opacity: 0.5;\n  border-color: #ffffff16;\n  background: #ffffff06;\n}\n.profile-achievement i {\n  display: grid;\n  place-items: center;\n  width: 32px;\n  height: 32px;\n  border-radius: 10px;\n  color: var(--yellow);\n  background: #ffffff0d;\n  font-size: 18px;\n  font-style: normal;\n}\n.profile-achievement span {\n  display: grid;\n  min-width: 0;\n  gap: 3px;\n}\n.profile-achievement strong {\n  font-size: 10px;\n}\n.profile-achievement small {\n  color: #aaa4ca;\n  font-size: 8px;\n  line-height: 1.25;\n}\n.recent-partner-empty {\n  margin: 0;\n  padding: 12px;\n  border: 1px dashed #ffffff24;\n  border-radius: 11px;\n  color: #aaa4ca;\n  font-size: 10px;\n  line-height: 1.4;\n}\n.recent-partner-card {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 12px;\n  padding: 12px;\n  border: 1px solid #4ce0df55;\n  border-radius: 13px;\n  background: #4ce0df0b;\n}\n.recent-partner-card > div {\n  display: grid;\n  min-width: 0;\n  gap: 4px;\n}\n.recent-partner-card strong {\n  overflow: hidden;\n  font-size: 15px;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.recent-partner-card small {\n  color: #83eee5;\n  font-size: 8px;\n  font-weight: 850;\n  letter-spacing: 0.05em;\n}\n.recent-partner-card .button {\n  min-height: 42px;\n  padding: 9px 12px;\n  font-size: 9px;\n}\n@media (max-width: 560px) {\n  .profile-card {\n    padding: 18px 14px;\n  }\n  .profile-stats {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n  .profile-achievements {\n    grid-template-columns: 1fr;\n  }\n  .recent-partner-card {\n    grid-template-columns: 1fr;\n  }\n  .recent-partner-card .button {\n    width: 100%;\n  }\n}`
);

// --- e2e ----------------------------------------------------------------------------------------
replaceOnce(
  'e2e/multiplayer.spec.js',
  "  await setPlayerName(host, 'Хост E2E');\n  await host.locator('[data-mode=\"coop\"]').click();",
  `  await setPlayerName(host, 'Хост E2E');\n\n  // Профиль использует отдельный authenticated endpoint без выпуска лишнего WST. Проверяем не\n  // только разметку, но и настоящий серверный ответ из текущей HttpOnly session.\n  const profileResponsePromise = host.waitForResponse(response =>\n    response.url().endsWith('/api/auth/profile')\n  );\n  await host.locator('#profileOpen').click();\n  const profileResponse = await profileResponsePromise;\n  expect(profileResponse.status()).toBe(200);\n  await expect(host.locator('#profile')).toBeVisible();\n  await expect(host.locator('#profileName')).toHaveText('Хост E2E');\n  await expect(host.locator('#profileStatMatches')).toHaveText('0');\n  await expect(host.locator('#profileAchievements .profile-achievement')).toHaveCount(6);\n  await expect(host.locator('#recentPartnerInvite')).toBeDisabled();\n  await host.locator('#profileClose').click();\n\n  await host.locator('[data-mode=\"coop\"]').click();`,
  'e2e profile screen check'
);

// --- test runner --------------------------------------------------------------------------------
replaceOnce(
  'package.json',
  'server/socketAuthIntegration.test.mjs server/socialCosmetics.test.mjs server/migrations.test.mjs',
  'server/socketAuthIntegration.test.mjs server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/migrations.test.mjs',
  'package social profile test'
);

console.log('profile & social loop patches applied');
