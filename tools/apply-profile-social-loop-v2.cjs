'use strict';

const fs = require('fs');

const lines = (...values) => values.join('\n');

function replaceOnce(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ': expected one anchor, found ' + count);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

function appendOnce(path, marker, block) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(marker)) return false;
  source = source.trimEnd() + '\n\n' + block.trim() + '\n';
  fs.writeFileSync(path, source);
  return true;
}

// Migration 006: recent co-op partners only. Existing account_stats/chapter_progress/achievements
// remain the authoritative progression store.
replaceOnce(
  'server/migrations/index.js',
  lines(
    "const rewardPlatform = require('./005_reward_platform');",
    '',
    'const MIGRATIONS = Object.freeze([initial, accountProgress, authSessions, serverInventory, rewardPlatform]);'
  ),
  lines(
    "const rewardPlatform = require('./005_reward_platform');",
    "const recentPartners = require('./006_recent_partners');",
    '',
    'const MIGRATIONS = Object.freeze([',
    '  initial,',
    '  accountProgress,',
    '  authSessions,',
    '  serverInventory,',
    '  rewardPlatform,',
    '  recentPartners',
    ']);'
  ),
  'register migration 006'
);

replaceOnce(
  'server/migrations.test.mjs',
  'assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5]);',
  'assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6]);',
  'migration versions'
);
replaceOnce(
  'server/migrations.test.mjs',
  lines('    { version: 5, applied_at: 123 }', '  ]);'),
  lines('    { version: 5, applied_at: 123 },', '    { version: 6, applied_at: 123 }', '  ]);'),
  'migration history'
);
replaceOnce(
  'server/migrations.test.mjs',
  lines("    'account_loadout',", "    'reward_grants'"),
  lines("    'account_loadout',", "    'reward_grants',", "    'recent_partners'"),
  'recent partners table coverage'
);
replaceOnce(
  'server/migrations.test.mjs',
  lines(
    "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);",
    '  db.close();'
  ),
  lines(
    "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);",
    "  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_partners').get().count, 0);",
    '  db.close();'
  ),
  'legacy migration social table'
);

// Account domain: recent-partner writes happen only from the game server. Profile is a read model
// over the already-authoritative progression tables plus the recent partner edge.
replaceOnce(
  'server/accounts.js',
  lines(
    '  count() {',
    '    return Number(this.statements.count.get().count);',
    '  }'
  ),
  lines(
    '  // Последний напарник записывается только после завершённого сервером кооперативного матча.',
    '  // Клиент не присылает partner id, поэтому сам подделать эту историю не может.',
    '  recordCoopPartners({ accountIds, chapterId, playedAt = Date.now() }) {',
    "    const chapter = String(chapterId || '');",
    "    if (!/^ch(?:10|[1-9])$/.test(chapter)) return 0;",
    '    const ids = [',
    '      ...new Set(',
    '        (Array.isArray(accountIds) ? accountIds : [])',
    "          .map(id => String(id || ''))",
    '          .filter(id => id && this.statements.byId.get(id))',
    '      )',
    '    ];',
    '    if (ids.length < 2) return 0;',
    '    const at = Number.isFinite(playedAt) && playedAt >= 0 ? Math.round(playedAt) : Date.now();',
    '    let writes = 0;',
    "    this.db.exec('BEGIN IMMEDIATE');",
    '    try {',
    '      for (const accountId of ids) {',
    '        for (const partnerId of ids) {',
    '          if (accountId === partnerId) continue;',
    '          this.statements.upsertRecentPartner.run(accountId, partnerId, chapter, at);',
    '          writes++;',
    '        }',
    '      }',
    "      this.db.exec('COMMIT');",
    '    } catch (error) {',
    "      this.db.exec('ROLLBACK');",
    '      throw error;',
    '    }',
    '    return writes;',
    '  }',
    '',
    '  profile(accountId) {',
    "    const id = String(accountId || '');",
    '    if (!this.statements.byId.get(id)) return null;',
    '    const progress = this.progress(id);',
    "    const campaignAchievement = progress.achievements.find(item => item.id === 'coop-campaign-complete');",
    '    const recent = this.statements.recentPartner.get(id);',
    '    return {',
    '      stats: {',
    '        ...progress.stats,',
    '        coopFlawless: Number(this.statements.flawlessCount.get(id)?.count || 0)',
    '      },',
    '      achievements: progress.achievements,',
    '      campaign: {',
    '        completed: Boolean(campaignAchievement),',
    '        completedAt: campaignAchievement?.unlockedAt || null,',
    '        chaptersCompleted: progress.stats.coopChaptersCompleted,',
    '        totalChapters: 10',
    '      },',
    '      recentPartner: recent',
    '        ? {',
    '            id: recent.partner_account_id,',
    '            name: recent.display_name,',
    '            matchesTogether: Number(recent.matches_together || 0),',
    '            lastChapterId: recent.last_chapter_id,',
    '            lastPlayedAt: recent.last_played_at',
    '          }',
    '        : null',
    '    };',
    '  }',
    '',
    '  count() {',
    '    return Number(this.statements.count.get().count);',
    '  }'
  ),
  'account social methods'
);

replaceOnce(
  'server/accounts.js',
  lines(
    '    achievements: db.prepare(',
    "      'SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ? ORDER BY unlocked_at'",
    '    )'
  ),
  lines(
    '    achievements: db.prepare(',
    "      'SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ? ORDER BY unlocked_at'",
    '    ),',
    '    upsertRecentPartner: db.prepare(`',
    '      INSERT INTO recent_partners',
    '        (account_id, partner_account_id, matches_together, last_chapter_id, last_played_at)',
    '      VALUES (?, ?, 1, ?, ?)',
    '      ON CONFLICT (account_id, partner_account_id) DO UPDATE SET',
    '        matches_together = matches_together + 1,',
    '        last_chapter_id = excluded.last_chapter_id,',
    '        last_played_at = excluded.last_played_at',
    '    `),',
    '    recentPartner: db.prepare(`',
    '      SELECT rp.partner_account_id, a.display_name, rp.matches_together,',
    '             rp.last_chapter_id, rp.last_played_at',
    '      FROM recent_partners rp',
    '      JOIN accounts a ON a.id = rp.partner_account_id',
    '      WHERE rp.account_id = ?',
    '      ORDER BY rp.last_played_at DESC, rp.partner_account_id ASC',
    '      LIMIT 1',
    '    `)'
  ),
  'account social statements'
);

replaceOnce(
  'server/index.js',
  lines(
    '    if (room.mode === GAME_MODE.COOP && coopTime) {',
    '      for (const player of room.players.values()) {',
    '        if (!player.accountId) continue;',
    '        accounts.recordCoopCompletion({',
    '          accountId: player.accountId,',
    '          chapterId: room.chapterId,',
    '          timeMs: coopTime,',
    '          revives: player.coopRevives || 0,',
    '          falls: player.coopFalls || 0',
    '        });',
    '      }',
    '    }'
  ),
  lines(
    '    if (room.mode === GAME_MODE.COOP && coopTime) {',
    '      const accountIds = [];',
    '      for (const player of room.players.values()) {',
    '        if (!player.accountId) continue;',
    '        accountIds.push(player.accountId);',
    '        accounts.recordCoopCompletion({',
    '          accountId: player.accountId,',
    '          chapterId: room.chapterId,',
    '          timeMs: coopTime,',
    '          revives: player.coopRevives || 0,',
    '          falls: player.coopFalls || 0',
    '        });',
    '      }',
    '      accounts.recordCoopPartners({ accountIds, chapterId: room.chapterId });',
    '    }'
  ),
  'authoritative recent partner recording'
);

// Profile API is session-authenticated and deliberately separate from /session so opening the
// profile does not mint an unused one-time WebSocket ticket.
replaceOnce(
  'server/bootstrap.js',
  lines(
    '  progress: core.accounts.progress(account.id),',
    '  inventory: inventory.syncEntitlements(account.id)'
  ),
  lines(
    '  progress: core.accounts.progress(account.id),',
    '  profile: core.accounts.profile(account.id),',
    '  inventory: inventory.syncEntitlements(account.id)'
  ),
  'profile in authenticated account payload'
);

replaceOnce(
  'server/authRoutes.js',
  "  app.post('/api/auth/recovery', json, (req, res) => {",
  lines(
    "  app.post('/api/auth/profile', json, (req, res) => {",
    '    const session = requireSession(req, res);',
    '    if (!session) return undefined;',
    '    return res.json({ ok: true, profile: accounts.profile(session.accountId) });',
    '  });',
    '',
    "  app.post('/api/auth/recovery', json, (req, res) => {"
  ),
  'profile route'
);

replaceOnce(
  'client/core/account.js',
  lines(
    '    progress: data.progress || null,',
    '    inventory: data.inventory || null'
  ),
  lines(
    '    progress: data.progress || null,',
    '    profile: data.profile || null,',
    '    inventory: data.inventory || null'
  ),
  'client profile payload'
);
replaceOnce(
  'client/core/account.js',
  'export async function authConfig(options) {',
  lines(
    'export async function accountProfile(options) {',
    "  const { ok, data } = await post('/api/auth/profile', {}, options);",
    '  return ok ? data.profile || null : null;',
    '}',
    '',
    'export async function authConfig(options) {'
  ),
  'client profile endpoint'
);

replaceOnce(
  'client/core/AccountFlow.js',
  lines('  ensureAccount,', '  listAccounts,'),
  lines('  ensureAccount,', '  accountProfile,', '  listAccounts,'),
  'AccountFlow profile import'
);
replaceOnce(
  'client/core/AccountFlow.js',
  '    setServerCosmeticEquipHandler((slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId));',
  lines(
    '    setServerCosmeticEquipHandler((slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId));',
    '    this.game.ui.onProfileRefresh = () => this.refreshProfile();'
  ),
  'AccountFlow profile refresh binding'
);
replaceOnce(
  'client/core/AccountFlow.js',
  lines(
    '    this.game.ui.setAccountProgress(progress);',
    '    this.game.ui.setAccountList(listAccounts());'
  ),
  lines(
    '    this.game.ui.setAccountProgress(progress);',
    '    this.game.ui.setServerProfile(online ? account?.profile || null : null);',
    '    this.game.ui.setAccountList(listAccounts());'
  ),
  'AccountFlow initial profile'
);
replaceOnce(
  'client/core/AccountFlow.js',
  '  recordFor(mode, spec) {',
  lines(
    '  async refreshProfile() {',
    '    try {',
    '      const profile = await accountProfile();',
    '      if (profile) this.game.ui.setServerProfile(profile);',
    '      return profile;',
    '    } catch {',
    '      return null;',
    '    }',
    '  }',
    '',
    '  recordFor(mode, spec) {'
  ),
  'AccountFlow refresh method'
);

// Profile presentation uses a canonical shared catalog for known achievements. Unknown IDs from the
// database never become HTML or arbitrary presentation data.
replaceOnce(
  'client/ui/UI.js',
  "import { GAME_MODE } from '/shared/protocol.js';",
  lines(
    "import { GAME_MODE } from '/shared/protocol.js';",
    'import {',
    '  ACHIEVEMENT_CATALOG,',
    '  CAMPAIGN_BADGE_GLYPH,',
    '  CAMPAIGN_PROFILE_TITLE,',
    '  DEFAULT_PROFILE_TITLE',
    "} from '/shared/achievements.js';"
  ),
  'achievement presentation import'
);
replaceOnce(
  'client/ui/UI.js',
  lines('    this.bindAccountPanel();', '  }'),
  lines('    this.bindAccountPanel();', '    this.bindProfilePanel();', '  }'),
  'bind profile panel'
);

replaceOnce(
  'client/ui/UI.js',
  lines(
    '  accountStatus(text) {',
    "    $('#accountStatus').textContent = text || '';",
    '  }'
  ),
  lines(
    '  accountStatus(text) {',
    "    $('#accountStatus').textContent = text || '';",
    '  }',
    '',
    '  bindProfilePanel() {',
    "    const screen = $('#profile');",
    '    const toggle = show => {',
    "      screen.classList.toggle('hidden', !show);",
    "      $('#profileOpen').setAttribute('aria-expanded', String(show));",
    '      if (show) {',
    '        this.renderServerProfile();',
    '        this.onProfileRefresh?.();',
    '      }',
    '    };',
    '    this.toggleProfileScreen = toggle;',
    "    $('#profileOpen').addEventListener('click', () => toggle(true));",
    "    $('#profileClose').addEventListener('click', () => toggle(false));",
    "    screen.addEventListener('click', event => {",
    '      if (event.target === screen) toggle(false);',
    '    });',
    "    addEventListener('keydown', event => {",
    "      if (event.key === 'Escape' && !screen.classList.contains('hidden')) toggle(false);",
    '    });',
    "    $('#recentPartnerInvite').addEventListener('click', () => {",
    '      const partner = this.serverProfile?.recentPartner;',
    '      if (partner) this.onRecentPartnerInvite?.(partner);',
    '    });',
    '  }',
    '',
    '  setServerProfile(profile) {',
    '    this.serverProfile = profile || null;',
    '    this.renderServerProfile();',
    '  }',
    '',
    '  renderServerProfile() {',
    "    const screen = $('#profile');",
    '    if (!screen) return;',
    '    const profile = this.serverProfile;',
    '    const stats = profile?.stats || {};',
    '    const unlocked = new Map((profile?.achievements || []).map(item => [item.id, item]));',
    "    const campaignComplete = Boolean(profile?.campaign?.completed || unlocked.has('coop-campaign-complete'));",
    '    const completed = Math.min(10, Number(profile?.campaign?.chaptersCompleted || 0));',
    '',
    "    $('#profileName').textContent = this.account?.name || 'Wobbler';",
    "    $('#profileTitle').textContent = campaignComplete ? CAMPAIGN_PROFILE_TITLE : DEFAULT_PROFILE_TITLE;",
    "    $('#profileBadge').textContent = campaignComplete ? CAMPAIGN_BADGE_GLYPH : '◇';",
    "    $('#profileBadge').classList.toggle('completed', campaignComplete);",
    "    $('#profileCampaign').textContent = campaignComplete",
    "      ? 'КАМПАНИЯ ПРОЙДЕНА · 10/10'",
    "      : 'ПРИКЛЮЧЕНИЕ · ' + completed + '/10 ГЛАВ';",
    "    $('#profileStatMatches').textContent = Number(stats.coopMatchesCompleted || 0);",
    "    $('#profileStatChapters').textContent = Number(stats.coopChaptersCompleted || 0);",
    "    $('#profileStatRevives').textContent = Number(stats.coopRevives || 0);",
    "    $('#profileStatFlawless').textContent = Number(stats.coopFlawless || 0);",
    '',
    "    const achievements = $('#profileAchievements');",
    '    achievements.replaceChildren();',
    '    for (const item of ACHIEVEMENT_CATALOG) {',
    '      const earned = unlocked.get(item.id);',
    "      const card = document.createElement('div');",
    "      card.className = 'profile-achievement';",
    "      card.classList.toggle('locked', !earned);",
    "      const glyph = document.createElement('i');",
    "      glyph.textContent = earned ? item.glyph : '·';",
    "      const copy = document.createElement('span');",
    "      const name = document.createElement('strong');",
    '      name.textContent = item.name;',
    "      const detail = document.createElement('small');",
    "      detail.textContent = earned ? 'ПОЛУЧЕНО · ' + item.detail : item.detail;",
    '      copy.append(name, detail);',
    '      card.append(glyph, copy);',
    '      achievements.append(card);',
    '    }',
    '',
    '    const partner = profile?.recentPartner;',
    "    $('#recentPartnerEmpty').classList.toggle('hidden', Boolean(partner));",
    "    $('#recentPartnerCard').classList.toggle('hidden', !partner);",
    "    const invite = $('#recentPartnerInvite');",
    '    invite.disabled = !partner;',
    '    if (!partner) return;',
    "    $('#recentPartnerName').textContent = partner.name || 'Wobbler';",
    '    const chapter = this.coopChapters?.find(item => item.id === partner.lastChapterId);',
    "    const chapterName = chapter?.title || String(partner.lastChapterId || '').toUpperCase() || 'КООП';",
    "    $('#recentPartnerMeta').textContent =",
    "      'ВМЕСТЕ ' + Number(partner.matchesTogether || 0) + ' · ПОСЛЕДНЯЯ: ' + chapterName;",
    '  }'
  ),
  'profile UI methods'
);

replaceOnce(
  'client/ui/UI.js',
  lines(
    '    this.renderAccountPanel();',
    '    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);'
  ),
  lines(
    '    this.renderAccountPanel();',
    '    this.renderServerProfile();',
    '    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);'
  ),
  'profile follows account name'
);

replaceOnce(
  'client/ui/UI.js',
  lines(
    "    $('#lobbyHint').textContent = host",
    "      ? 'Все игроки должны быть готовы перед стартом.'",
    "      : 'Отметьтесь готовым — гонку запустит хост.';"
  ),
  lines(
    '    if (this.pendingRecentPartnerInviteName && data.mode === GAME_MODE.COOP) {',
    '      this.recentPartnerInviteRoomCode = data.code;',
    '      this.recentPartnerInviteName = this.pendingRecentPartnerInviteName;',
    '      this.pendingRecentPartnerInviteName = null;',
    '    }',
    '    if (this.recentPartnerInviteRoomCode === data.code && data.players.length > 1) {',
    '      this.recentPartnerInviteRoomCode = null;',
    '      this.recentPartnerInviteName = null;',
    '    }',
    '    const waitingRecentPartner =',
    '      data.mode === GAME_MODE.COOP &&',
    '      this.recentPartnerInviteRoomCode === data.code &&',
    '      data.players.length === 1;',
    "    $('#lobbyHint').textContent = waitingRecentPartner",
    "      ? 'Комната для ' +",
    '        this.recentPartnerInviteName +',
    "        ' готова — отправьте её кнопкой «ССЫЛКА».'",
    '      : host',
    "        ? 'Все игроки должны быть готовы перед стартом.'",
    "        : 'Отметьтесь готовым — гонку запустит хост.';"
  ),
  'recent partner lobby invite hint'
);

replaceOnce(
  'client/ui/menuBindings.js',
  lines(
    '  game.ui.onAccountAction = (action, value) => game.account.handleAction(action, value);',
    '  const $ = s => document.querySelector(s);'
  ),
  lines(
    '  game.ui.onAccountAction = (action, value) => game.account.handleAction(action, value);',
    '  game.ui.onRecentPartnerInvite = async partner => {',
    '    await game.accountReady;',
    '    const chapter = COOP_CHAPTERS.find(item => item.id === partner?.lastChapterId) || COOP_CHAPTERS[0];',
    "    $('#coopChapter').value = chapter.id;",
    "    $('#coopChapter').dispatchEvent(new Event('change'));",
    "    game.ui.selectMode('coop');",
    '    game.ui.toggleProfileScreen?.(false);',
    "    game.ui.pendingRecentPartnerInviteName = partner?.name || 'напарника';",
    '    const net = game.ensureNetwork();',
    '    net.createRoom({',
    '      name: game.ui.coopName(),',
    '      playerId: game.ui.playerId(),',
    '      mode: GAME_MODE.COOP,',
    '      difficulty: chapter.id',
    '    });',
    '  };',
    '  const $ = s => document.querySelector(s);'
  ),
  'recent partner invite action'
);

// Dedicated profile screen. The existing account dialog remains for identity/recovery/cosmetics.
replaceOnce(
  'client/index.html',
  lines(
    '        <div class="account-bar">',
    '          <button id="accountChip" class="account-chip" aria-haspopup="dialog" aria-expanded="false">',
    '            <span class="account-dot" aria-hidden="true"></span>',
    '            <b id="accountName">…</b>',
    '            <small>сменить</small>',
    '          </button>',
    '        </div>'
  ),
  lines(
    '        <div class="account-bar">',
    '          <button id="accountChip" class="account-chip" aria-haspopup="dialog" aria-expanded="false">',
    '            <span class="account-dot" aria-hidden="true"></span>',
    '            <b id="accountName">…</b>',
    '            <small>сменить</small>',
    '          </button>',
    '          <button id="profileOpen" class="profile-chip" aria-haspopup="dialog" aria-expanded="false">',
    '            <b>ПРОФИЛЬ</b><small>статы · награды</small>',
    '          </button>',
    '        </div>'
  ),
  'profile menu button'
);

replaceOnce(
  'client/index.html',
  '    <!-- Экран настроек управления. Содержимое собирается из схемы в client/core/settings.js —',
  lines(
    '    <section id="profile" class="screen center-screen hidden">',
    '      <div class="profile-card glass" role="dialog" aria-label="Профиль игрока">',
    '        <button id="profileClose" class="close-button" aria-label="Закрыть">×</button>',
    '        <span class="eyebrow">ПРОФИЛЬ</span>',
    '        <div class="profile-hero">',
    '          <div id="profileBadge" class="profile-badge" aria-hidden="true">◇</div>',
    '          <div class="profile-identity">',
    '            <small id="profileTitle">ИСКАТЕЛЬ НЕБЕС</small>',
    '            <h2 id="profileName">Wobbler</h2>',
    '            <p id="profileCampaign">ПРИКЛЮЧЕНИЕ · 0/10 ГЛАВ</p>',
    '          </div>',
    '        </div>',
    '        <div class="profile-stats" aria-label="Серверная статистика">',
    '          <span><small>КООП-МАТЧИ</small><b id="profileStatMatches">0</b></span>',
    '          <span><small>ГЛАВЫ</small><b id="profileStatChapters">0</b></span>',
    '          <span><small>СПАСЕНИЯ</small><b id="profileStatRevives">0</b></span>',
    '          <span><small>БЕЗ ПАДЕНИЙ</small><b id="profileStatFlawless">0</b></span>',
    '        </div>',
    '        <section class="profile-section" aria-labelledby="profileAchievementsTitle">',
    '          <div class="profile-section-head">',
    '            <small id="profileAchievementsTitle">ДОСТИЖЕНИЯ</small><span>SERVER VERIFIED</span>',
    '          </div>',
    '          <div id="profileAchievements" class="profile-achievements"></div>',
    '        </section>',
    '        <section class="profile-section" aria-labelledby="recentPartnerTitle">',
    '          <div class="profile-section-head">',
    '            <small id="recentPartnerTitle">НЕДАВНИЙ НАПАРНИК</small><span>СЫГРАТЬ СНОВА</span>',
    '          </div>',
    '          <p id="recentPartnerEmpty" class="recent-partner-empty">',
    '            Завершите кооперативную главу — последний напарник появится здесь.',
    '          </p>',
    '          <div id="recentPartnerCard" class="recent-partner-card hidden">',
    '            <div><strong id="recentPartnerName">Wobbler</strong><small id="recentPartnerMeta"></small></div>',
    '            <button id="recentPartnerInvite" class="button button-primary" disabled>ПРИГЛАСИТЬ СНОВА</button>',
    '          </div>',
    '        </section>',
    '      </div>',
    '    </section>',
    '',
    '    <!-- Экран настроек управления. Содержимое собирается из схемы в client/core/settings.js —'
  ),
  'profile screen markup'
);

appendOnce(
  'client/styles.css',
  '/* Profile & Social Loop */',
  lines(
    '/* Profile & Social Loop */',
    '.account-bar {',
    '  display: grid;',
    '  grid-template-columns: minmax(0, 1fr) auto;',
    '  gap: 8px;',
    '}',
    '.profile-chip {',
    '  display: grid;',
    '  align-content: center;',
    '  min-width: 102px;',
    '  border: 1px solid #ffffff26;',
    '  border-radius: 12px;',
    '  padding: 7px 10px;',
    '  color: #fff;',
    '  background: #ffffff0d;',
    '  cursor: pointer;',
    '}',
    '.profile-chip b { color: var(--yellow); font-size: 10px; letter-spacing: 0.08em; }',
    '.profile-chip small { color: #aaa4ca; font-size: 7px; white-space: nowrap; }',
    '.profile-card {',
    '  width: min(620px, calc(100vw - 32px));',
    '  max-height: calc(100vh - 32px - var(--safe-top) - var(--safe-bottom));',
    '  overflow-y: auto;',
    '  border-radius: 26px;',
    '  padding: 22px;',
    '}',
    '.profile-hero { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 16px; margin: 14px 0 16px; }',
    '.profile-badge {',
    '  display: grid;',
    '  place-items: center;',
    '  width: 74px;',
    '  height: 74px;',
    '  border: 2px solid #ffffff38;',
    '  border-radius: 23px;',
    '  color: #8d82bd;',
    '  background: #ffffff0a;',
    '  font-size: 38px;',
    '  box-shadow: inset 0 -10px #0002;',
    '}',
    '.profile-badge.completed { color: var(--yellow); border-color: #ffdd4c99; text-shadow: 0 0 18px #ffdd4c88; }',
    '.profile-identity { min-width: 0; }',
    '.profile-identity small { color: var(--cyan); font-size: 10px; font-weight: 950; letter-spacing: 0.12em; }',
    '.profile-identity h2 { overflow: hidden; margin: 4px 0; font-size: clamp(25px, 7vw, 38px); text-overflow: ellipsis; white-space: nowrap; }',
    '.profile-identity p { margin: 0; color: #b9b2dd; font-size: 10px; font-weight: 850; letter-spacing: 0.08em; }',
    '.profile-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }',
    '.profile-stats span { display: grid; gap: 4px; padding: 11px 8px; border: 1px solid #ffffff18; border-radius: 12px; background: #ffffff08; text-align: center; }',
    '.profile-stats small { color: #aaa4ca; font-size: 7px; font-weight: 900; }',
    '.profile-stats b { font-size: 20px; }',
    '.profile-section { margin-top: 15px; }',
    '.profile-section-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; color: #aaa4ca; font-size: 8px; font-weight: 900; letter-spacing: 0.1em; }',
    '.profile-section-head span { color: #6fded7; }',
    '.profile-achievements { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }',
    '.profile-achievement { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 8px; min-height: 58px; padding: 9px; border: 1px solid #62eeb933; border-radius: 11px; background: #62eeb90b; }',
    '.profile-achievement.locked { opacity: 0.5; border-color: #ffffff16; background: #ffffff06; }',
    '.profile-achievement i { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: var(--yellow); background: #ffffff0d; font-size: 18px; font-style: normal; }',
    '.profile-achievement span { display: grid; min-width: 0; gap: 3px; }',
    '.profile-achievement strong { font-size: 10px; }',
    '.profile-achievement small { color: #aaa4ca; font-size: 8px; line-height: 1.25; }',
    '.recent-partner-empty { margin: 0; padding: 12px; border: 1px dashed #ffffff24; border-radius: 11px; color: #aaa4ca; font-size: 10px; line-height: 1.4; }',
    '.recent-partner-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border: 1px solid #4ce0df55; border-radius: 13px; background: #4ce0df0b; }',
    '.recent-partner-card > div { display: grid; min-width: 0; gap: 4px; }',
    '.recent-partner-card strong { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }',
    '.recent-partner-card small { color: #83eee5; font-size: 8px; font-weight: 850; letter-spacing: 0.05em; }',
    '.recent-partner-card .button { min-height: 42px; padding: 9px 12px; font-size: 9px; }',
    '@media (max-width: 560px) {',
    '  .profile-card { padding: 18px 14px; }',
    '  .profile-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
    '  .profile-achievements { grid-template-columns: 1fr; }',
    '  .recent-partner-card { grid-template-columns: 1fr; }',
    '  .recent-partner-card .button { width: 100%; }',
    '}'
  )
);

// Browser smoke: real session-authenticated profile endpoint and profile presentation on both
// desktop/mobile projects. Recent partner persistence itself is covered at the domain boundary.
replaceOnce(
  'e2e/multiplayer.spec.js',
  lines(
    "  await setPlayerName(host, 'Хост E2E');",
    '  const hostCosmetic = await equipServerCosmetic(host, `social-host-${testInfo.project.name}-${Date.now()}`);'
  ),
  lines(
    "  await setPlayerName(host, 'Хост E2E');",
    '  const profileResponsePromise = host.waitForResponse(response =>',
    "    response.url().endsWith('/api/auth/profile')",
    '  );',
    "  await host.locator('#profileOpen').click();",
    '  const profileResponse = await profileResponsePromise;',
    '  expect(profileResponse.status()).toBe(200);',
    "  await expect(host.locator('#profile')).toBeVisible();",
    "  await expect(host.locator('#profileName')).toHaveText('Хост E2E');",
    "  await expect(host.locator('#profileStatMatches')).toHaveText('0');",
    "  await expect(host.locator('#profileAchievements .profile-achievement')).toHaveCount(6);",
    "  await expect(host.locator('#recentPartnerInvite')).toBeDisabled();",
    "  await host.locator('#profileClose').click();",
    '  const hostCosmetic = await equipServerCosmetic(host, `social-host-${testInfo.project.name}-${Date.now()}`);'
  ),
  'profile browser smoke'
);

replaceOnce(
  'package.json',
  'server/socketAuthIntegration.test.mjs server/socialCosmetics.test.mjs server/migrations.test.mjs',
  'server/socketAuthIntegration.test.mjs server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/migrations.test.mjs',
  'social profile test runner'
);

console.log('profile & social loop patches applied');
