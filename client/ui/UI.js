import {
  DIFFICULTIES,
  courseName,
  evaluateCourseObjectives,
  formatGap,
  formatTime,
  ordinal
} from '../core/Config.js';
import { coopKey, readBest, saveBest, soloKey } from '../core/records.js';
import { resolvePlatform, supportsOnlinePlay } from '../core/PlatformResolver.js';
import { voteTally } from '../core/voting.js';
import { buildInviteLink, readInvite } from '../core/invite.js';
import { readProfile, recordCoopProfile, recordSoloProfile } from '../core/profile.js';
import {
  cosmeticLoadout,
  cosmeticLoadoutFromIds,
  nextCosmeticGoal,
  readCosmetics,
  readEmoteLoadout,
  unlockedCosmetics
} from '../core/cosmetics.js';
import { COSMETIC_BY_ID, COSMETIC_CATALOG, COSMETIC_SLOTS, SLOT_META } from '/shared/cosmetics.js';
import { Wardrobe } from './wardrobe.js';
import { GAME_MODE } from '/shared/protocol.js';
import {
  ACHIEVEMENT_CATALOG,
  CAMPAIGN_BADGE_GLYPH,
  CAMPAIGN_PROFILE_TITLE,
  DEFAULT_PROFILE_TITLE
} from '/shared/achievements.js';

const COSMETIC_CATALOG_SIZE = COSMETIC_CATALOG.length;

// Лучшее из двух рекордов. Серверный и локальный могут разойтись: играли без связи, играли с
// другого устройства, сбрасывали данные браузера. Показывать надо лучший — он и есть рекорд.
function bestOf(...times) {
  const valid = times.filter(time => Number.isFinite(time) && time > 0);
  return valid.length ? Math.min(...valid) : null;
}

const $ = selector => document.querySelector(selector);

// Пометка бота. Отдельной функцией, потому что рисуется в двух местах — в составе комнаты и в
// итоговой таблице, — и расходиться этим двум пометкам нельзя.
function botBadge() {
  const badge = document.createElement('b');
  badge.className = 'bot-badge';
  badge.textContent = 'БОТ';
  badge.title = 'Соперник под управлением компьютера';
  return badge;
}
const selectAll = selector => [...document.querySelectorAll(selector)];
const cssColor = (value, fallback = 0xff4f91) =>
  `#${Number(Number.isFinite(value) ? value : fallback)
    .toString(16)
    .padStart(6, '0')
    .slice(-6)}`;

export class UI {
  constructor() {
    this.mode = 'single';
    this.quality = 'auto';
    this.toastTimer = 0;
    this.lessonText = null;
    this.elements = {
      menu: $('#menu'),
      lobby: $('#lobby'),
      finish: $('#finish'),
      hud: $('#hud'),
      touch: $('#touch')
    };
    selectAll('.mode-tab').forEach(button =>
      button.addEventListener('click', () => this.selectMode(button.dataset.mode))
    );
    this.selectMode('single');
    this.profile(readProfile());
    this.setInputMethod(
      document.body.dataset.input ||
        (matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0 ? 'touch' : 'keyboard')
    );
    addEventListener('inputmethodchange', e => this.setInputMethod(e.detail));
    this.bindAccountPanel();
    this.bindProfilePanel();
  }

  // --- аккаунт --------------------------------------------------------------------------------
  //
  // Имя игрока теперь одно на всю игру и живёт в аккаунте. Раньше их было два независимых поля —
  // в гонке и в коопе, — и каждое хранилось само по себе: игрок переименовывался в одном месте и
  // не понимал, почему в другом остался прежним.

  bindAccountPanel() {
    const screen = $('#account');
    const toggle = show => {
      screen.classList.toggle('hidden', !show);
      $('#accountChip').setAttribute('aria-expanded', String(show));
      if (show) this.renderAccountPanel();
      else $('#accountCode').classList.add('hidden');
    };
    this.toggleAccountScreen = toggle;
    $('#accountChip').addEventListener('click', () => toggle(true));
    $('#accountClose').addEventListener('click', () => toggle(false));
    // Клик по затемнению и Escape закрывают окно — так же, как в любом другом диалоге.
    screen.addEventListener('click', event => {
      if (event.target === screen) toggle(false);
    });
    addEventListener('keydown', event => {
      if (event.key === 'Escape' && !screen.classList.contains('hidden')) toggle(false);
    });
    $('#accountSave').addEventListener('click', () =>
      this.onAccountAction?.('rename', $('#accountRename').value)
    );
    $('#accountNew').addEventListener('click', () => this.onAccountAction?.('create'));
    $('#accountEnter').addEventListener('click', () =>
      this.onAccountAction?.('login', $('#accountCodeInput').value)
    );
    $('#accountShowCode').addEventListener('click', () => {
      const box = $('#accountCode');
      const show = box.classList.contains('hidden');
      box.classList.toggle('hidden', !show);
      // Код показывается только по явной просьбе: он лежал бы на экране у всех, кто заглянет через
      // плечо, а восстановить его после утечки нечем — он и есть ключ от аккаунта.
      $('#accountCodeValue').textContent = show ? this.account?.secret || '—' : '';
    });
    $('#accountCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.account?.secret || '');
        this.accountStatus('Код скопирован.');
      } catch {
        this.accountStatus('Скопировать не вышло — выделите код вручную.');
      }
    });
  }

  accountStatus(text) {
    $('#accountStatus').textContent = text || '';
  }

  bindProfilePanel() {
    const screen = $('#profile');
    const toggle = show => {
      screen.classList.toggle('hidden', !show);
      $('#profileOpen').setAttribute('aria-expanded', String(show));
      if (show) {
        this.renderServerProfile();
        this.renderAvoidedPlayers();
        this.onProfileRefresh?.();
      }
    };
    this.toggleProfileScreen = toggle;
    $('#profileOpen').addEventListener('click', () => toggle(true));
    $('#profileClose').addEventListener('click', () => toggle(false));
    screen.addEventListener('click', event => {
      if (event.target === screen) toggle(false);
    });
    addEventListener('keydown', event => {
      if (event.key === 'Escape' && !screen.classList.contains('hidden')) toggle(false);
    });
    $('#recentPartnerInvite').addEventListener('click', () => {
      const partner = this.serverProfile?.recentPartner;
      if (partner) this.onRecentPartnerInvite?.(partner);
    });
    $('#recentPartnerAvoid').addEventListener('click', () => {
      const partner = this.serverProfile?.recentPartner;
      if (partner && !partner.avoided) this.onRecentPartnerAvoid?.(partner);
    });
    $('#recentPartnerReport').addEventListener('click', () =>
      $('#recentPartnerReportReasons').classList.toggle('hidden')
    );
    selectAll('[data-social-report]').forEach(button =>
      button.addEventListener('click', () => {
        const partner = this.serverProfile?.recentPartner;
        if (!partner) return;
        $('#recentPartnerReportReasons').classList.add('hidden');
        this.onRecentPartnerReport?.(partner, button.dataset.socialReport);
      })
    );
    $('#avoidedPlayersList').addEventListener('click', event => {
      const button = event.target.closest?.('[data-restore-avoid]');
      if (!button) return;
      const player = this.avoidedPlayers?.find(item => item.id === button.dataset.restoreAvoid);
      if (!player) return;
      if (button.dataset.confirmRestore !== '1') {
        selectAll('[data-restore-avoid]').forEach(item => {
          item.dataset.confirmRestore = '';
          item.textContent = 'ВЕРНУТЬ В ПОДБОР';
        });
        button.dataset.confirmRestore = '1';
        button.textContent = 'ПОДТВЕРДИТЬ';
        return;
      }
      button.disabled = true;
      Promise.resolve(this.onAvoidedPlayerRestore?.(player)).finally(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.dataset.confirmRestore = '';
        button.textContent = 'ВЕРНУТЬ В ПОДБОР';
      });
    });
  }

  setServerProfile(profile) {
    this.serverProfile = profile || null;
    this.renderServerProfile();
  }

  setAvoidedPlayers(players) {
    this.avoidedPlayers = Array.isArray(players) ? players : null;
    this.renderAvoidedPlayers();
  }

  renderAvoidedPlayers() {
    const list = $('#avoidedPlayersList');
    const empty = $('#avoidedPlayersEmpty');
    if (!list || !empty) return;
    list.replaceChildren();
    if (!Array.isArray(this.avoidedPlayers)) {
      empty.classList.remove('hidden');
      empty.textContent = 'Загрузка списка…';
      return;
    }
    empty.classList.toggle('hidden', this.avoidedPlayers.length > 0);
    empty.textContent = 'Вы никого не исключали из быстрого подбора.';
    for (const player of this.avoidedPlayers) {
      const row = document.createElement('div');
      row.className = 'avoided-player-row';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = player.name || 'Wobbler';
      const detail = document.createElement('small');
      detail.textContent = 'НЕ ПОПАДЁТ В ВАШ БЫСТРЫЙ ПОДБОР';
      copy.append(name, detail);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'button button-secondary';
      restore.dataset.restoreAvoid = player.id;
      restore.textContent = 'ВЕРНУТЬ В ПОДБОР';
      row.append(copy, restore);
      list.append(row);
    }
  }

  renderServerProfile() {
    const screen = $('#profile');
    if (!screen) return;
    const profile = this.serverProfile;
    const stats = profile?.stats || {};
    const unlocked = new Map((profile?.achievements || []).map(item => [item.id, item]));
    const campaignComplete = Boolean(profile?.campaign?.completed || unlocked.has('coop-campaign-complete'));
    const completed = Math.min(10, Number(profile?.campaign?.chaptersCompleted || 0));

    $('#profileName').textContent = this.account?.name || 'Wobbler';
    $('#profileTitle').textContent = campaignComplete ? CAMPAIGN_PROFILE_TITLE : DEFAULT_PROFILE_TITLE;
    $('#profileBadge').textContent = campaignComplete ? CAMPAIGN_BADGE_GLYPH : '◇';
    $('#profileBadge').classList.toggle('completed', campaignComplete);
    $('#profileCampaign').textContent = campaignComplete
      ? 'КАМПАНИЯ ПРОЙДЕНА · 10/10'
      : 'ПРИКЛЮЧЕНИЕ · ' + completed + '/10 ГЛАВ';
    $('#profileStatMatches').textContent = Number(stats.coopMatchesCompleted || 0);
    $('#profileStatChapters').textContent = Number(stats.coopChaptersCompleted || 0);
    $('#profileStatRevives').textContent = Number(stats.coopRevives || 0);
    $('#profileStatFlawless').textContent = Number(stats.coopFlawless || 0);

    const achievements = $('#profileAchievements');
    achievements.replaceChildren();
    for (const item of ACHIEVEMENT_CATALOG) {
      const earned = unlocked.get(item.id);
      const card = document.createElement('div');
      card.className = 'profile-achievement';
      card.classList.toggle('locked', !earned);
      const glyph = document.createElement('i');
      glyph.textContent = earned ? item.glyph : '·';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = item.name;
      const detail = document.createElement('small');
      detail.textContent = earned ? 'ПОЛУЧЕНО · ' + item.detail : item.detail;
      copy.append(name, detail);
      card.append(glyph, copy);
      achievements.append(card);
    }

    const partner = profile?.recentPartner;
    $('#recentPartnerEmpty').classList.toggle('hidden', Boolean(partner));
    $('#recentPartnerCard').classList.toggle('hidden', !partner);
    const invite = $('#recentPartnerInvite');
    const avoid = $('#recentPartnerAvoid');
    const report = $('#recentPartnerReport');
    invite.disabled = !partner;
    avoid.disabled = !partner || Boolean(partner?.avoided);
    avoid.textContent = partner?.avoided ? 'НЕ БУДЕМ ПОДБИРАТЬ' : 'НЕ ПОДБИРАТЬ СНОВА';
    report.disabled = !partner;
    $('#recentPartnerReportReasons').classList.add('hidden');
    if (!partner) return;
    $('#recentPartnerName').textContent = partner.name || 'Wobbler';
    const chapter = this.coopChapters?.find(item => item.id === partner.lastChapterId);
    const chapterName = chapter?.title || String(partner.lastChapterId || '').toUpperCase() || 'КООП';
    $('#recentPartnerMeta').textContent =
      'ВМЕСТЕ ' + Number(partner.matchesTogether || 0) + ' · ПОСЛЕДНЯЯ: ' + chapterName;
  }

  // Показывает текущий аккаунт. `online: false` — сервер не ответил: аккаунт остаётся рабочим для
  // игры, но рекорды никуда не уедут, и говорить об этом надо вслух.
  setAccount(account, { online = true } = {}) {
    this.account = account || null;
    // «ГОСТЬ» вместо «без аккаунта»: первое — состояние, в котором можно осознанно находиться,
    // второе звучит как неполадка. Разница не косметическая: гостевой режим полноценный, и
    // называть его отсутствием чего-то — значит подталкивать чинить то, что не сломано.
    $('#accountName').textContent = account?.name || 'ГОСТЬ';
    $('#accountChip').classList.toggle('offline', !online);
    $('#accountChip').classList.toggle('account-chip-guest', !account);
    // На площадке входа нет — там чип ведёт к шкафу, и звать «войти» было бы обманом: сама секция
    // входа скрыта шлюзом, и нажавший ничего бы не нашёл.
    const chipAction = supportsOnlinePlay(resolvePlatform()) ? (account ? 'сменить' : 'войти') : 'шкаф';
    $('#accountChip').querySelector('small').textContent = chipAction;
    this.renderAccountState();
    this.renderAccountPanel();
    this.renderServerProfile();
    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);
  }

  setAccountRecords(records) {
    this.accountRecords = records || new Map();
    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);
  }

  setAccountProgress(progress) {
    this.accountProgressData = progress || null;
    this.accountProgress = new Map((progress?.chapters || []).map(chapter => [chapter.chapterId, chapter]));
    this.accountAchievements = progress?.achievements || [];
    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters);
    this.renderCosmetics();
  }

  // Объяснение состояния личности. Оно же — единственное место, где игроку говорят, что именно он
  // теряет, оставаясь гостем: не «войдите», а что за этим стоит.
  renderAccountState() {
    const title = document.querySelector('#accountStateTitle');
    if (!title) return;
    const detail = document.querySelector('#accountStateDetail');
    const hint = document.querySelector('#accountStateHint');
    if (this.account) {
      title.textContent = `ВЫ ВОШЛИ · ${this.account.name || 'без имени'}`;
      if (detail) {
        detail.textContent =
          'Прогресс, награды и рекорды хранятся на сервере и доступны с любого устройства.';
      }
      if (hint) hint.textContent = 'Время забегов попадает в общую таблицу рекордов.';
      return;
    }
    title.textContent = 'ВЫ ИГРАЕТЕ ГОСТЕМ';
    // На площадке сетевые режимы скрыты шлюзом, и обещать «все режимы» значило бы описывать игру
    // ровно наоборот тому, что игрок видит в меню. Про таблицу рекордов там тоже говорить нечего:
    // войти некуда, сервера нет.
    const online = supportsOnlinePlay(resolvePlatform());
    if (detail) {
      detail.textContent = online
        ? 'Играть можно во все режимы. Прогресс хранится только в этом браузере и пропадёт вместе с его данными.'
        : 'Одиночные забеги и ежедневный вызов. Прогресс хранится только в этом браузере и пропадёт вместе с его данными.';
    }
    if (hint) {
      hint.textContent = online
        ? 'Место в таблице рекордов сохраняется только у вошедших игроков.'
        : 'Косметика и рекорды остаются на этом устройстве.';
    }
  }

  renderAccountPanel() {
    if ($('#account').classList.contains('hidden')) return;
    this.renderAccountState();
    $('#accountRename').value = this.account?.name || '';
    const list = $('#accountList');
    list.replaceChildren();
    for (const account of this.accountList || []) {
      const row = document.createElement('button');
      row.className = 'account-item';
      row.classList.toggle('account-item-current', account.current);
      row.textContent = account.name || 'Без имени';
      if (account.current)
        row.append(Object.assign(document.createElement('small'), { textContent: 'сейчас' }));
      else row.addEventListener('click', () => this.onAccountAction?.('switch', account.id));
      list.append(row);
    }
    this.renderCosmetics();
  }

  // Панель аккаунта показывает не весь каталог, а надетое.
  //
  // Раньше здесь была решётка со всеми предметами. С четырнадцатью это работало, с семьюдесятью
  // четырьмя — нет: панель превращалась в бесконечную ленту без фильтров и без превью. Полный
  // разбор переехал в шкаф, а здесь остался ответ на вопрос «что на мне сейчас».
  renderCosmetics() {
    const grid = $('#cosmeticGrid');
    if (!grid) return;
    const profile = this.profileData || readProfile();
    const equipped = readCosmetics(this.accountProgressData, profile);
    const emotes = readEmoteLoadout(this.accountProgressData, profile);
    grid.replaceChildren();

    for (const slot of COSMETIC_SLOTS) {
      const item = COSMETIC_BY_ID[equipped[slot]] || null;
      const card = document.createElement('div');
      card.className = 'cosmetic-card';
      card.dataset.slot = slot;
      card.dataset.cosmeticId = item?.id || 'none';
      card.classList.toggle('cosmetic-card-equipped', Boolean(item));
      const title = document.createElement('strong');
      title.textContent = `${SLOT_META[slot].icon} ${SLOT_META[slot].label}`;
      const value = document.createElement('small');
      value.textContent = item ? item.name : 'Пусто';
      card.append(title, value);
      grid.append(card);
    }

    const emoteCard = document.createElement('div');
    emoteCard.className = 'cosmetic-card';
    emoteCard.dataset.slot = 'emote';
    const emoteTitle = document.createElement('strong');
    emoteTitle.textContent = `${SLOT_META.emote.icon} ${SLOT_META.emote.label}`;
    const emoteValue = document.createElement('small');
    const chosen = emotes.filter(Boolean).length;
    emoteValue.textContent = chosen ? `${chosen} из ${emotes.length}` : 'Не выбраны';
    emoteCard.append(emoteTitle, emoteValue);
    grid.append(emoteCard);

    const unlocked = unlockedCosmetics(this.accountProgressData, profile);
    const counter = $('#wardrobeOwnedCount');
    if (counter) counter.textContent = `${unlocked.length} / ${COSMETIC_CATALOG_SIZE}`;

    const goal = nextCosmeticGoal(this.accountProgressData, profile);
    $('#cosmeticGoal').textContent = goal
      ? `СЛЕДУЮЩАЯ НАГРАДА · ${goal.label}: ${Math.min(goal.current, goal.target)}/${goal.target}`
      : 'ВСЕ ИГРОВЫЕ НАГРАДЫ ПОЛУЧЕНЫ';
    if (this.wardrobe) {
      this.wardrobe.setProgress(this.accountProgressData);
      this.wardrobe.setProfile(profile);
    }
  }

  // Шкаф создаётся лениво: до первого открытия он не нужен, а его превью — отдельный WebGL-контекст.
  openWardrobe() {
    if (!this.wardrobe) {
      this.wardrobe = new Wardrobe({
        onChange: () => {
          this.renderCosmetics();
          this.onCosmeticChange?.();
        },
        onEquipError: message => this.error(message),
        sfx: this.sfx || null
      });
    }
    this.wardrobe.setProgress(this.accountProgressData);
    this.wardrobe.setProfile(this.profileData || readProfile());
    // `reducedMotion` спрашивается при каждом открытии, а не запоминается при создании: настройку
    // доступности меняют ровно тогда, когда она понадобилась, — посреди сессии.
    this.wardrobe.setReducedMotion(Boolean(this.settings?.reducedMotion));
    this.wardrobe.show();
  }

  closeWardrobe() {
    this.wardrobe?.hide();
  }

  // Карточка «новый предмет». Логика — в шкафу; здесь только точка входа, чтобы AccountFlow не знал
  // про его устройство.
  announceUnlocks(ownedIds) {
    if (!this.wardrobe) {
      this.wardrobe = new Wardrobe({
        onChange: () => {
          this.renderCosmetics();
          this.onCosmeticChange?.();
        },
        onEquipError: message => this.error(message),
        sfx: this.sfx || null
      });
      this.wardrobe.setProgress(this.accountProgressData);
      this.wardrobe.setProfile(this.profileData || readProfile());
    }
    return this.wardrobe.announceUnlocks(ownedIds);
  }

  get wardrobeOpen() {
    return Boolean(this.wardrobe?.open);
  }

  setAccountList(accounts) {
    this.accountList = accounts;
    this.renderAccountPanel();
  }
  selectMode(mode) {
    this.mode = mode;
    selectAll('.mode-tab').forEach(b => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('#single').classList.toggle('hidden', mode !== 'single');
    $('#multi').classList.toggle('hidden', mode !== 'multi');
    $('#coop').classList.toggle('hidden', mode !== 'coop');
  }

  // Список глав в меню кооператива.
  fillChapters(chapters, onChange) {
    this.coopChapters = chapters;
    const select = $('#coopChapter');
    select.replaceChildren();
    for (const chapter of chapters) {
      const option = document.createElement('option');
      option.value = chapter.id;
      option.textContent = `${chapter.title} — ${chapter.subtitle}`;
      select.append(option);
    }
    const apply = () => {
      const chapter = chapters.find(item => item.id === select.value) || chapters[0];
      $('#coopHint').textContent = chapter.hint;
      this.coopProfile(chapter.id);
      selectAll('.campaign-card').forEach(card =>
        card.classList.toggle('selected', card.dataset.chapter === chapter.id)
      );
      onChange?.(chapter);
    };
    select.addEventListener('change', apply);
    this.renderCoopCampaign(chapters);
    apply();
  }

  renderCoopCampaign(chapters, profile = readProfile()) {
    const grid = $('#coopCampaign');
    if (!grid) return;
    grid.replaceChildren();
    const firstPending = chapters.find(chapter => !this.chapterProgress(profile, chapter.id).completed)?.id;
    chapters.forEach((chapter, index) => {
      const progress = this.chapterProgress(profile, chapter.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'campaign-card';
      card.dataset.chapter = chapter.id;
      card.classList.toggle('completed', progress.completed);
      card.classList.toggle('recommended', chapter.id === firstPending);
      card.setAttribute('aria-label', `Глава ${index + 1}: ${chapter.title}`);
      const medal = progress.flawless
        ? '✦ ЗОЛОТО'
        : progress.best
          ? '★ СЕРЕБРО'
          : progress.completed
            ? '● БРОНЗА'
            : '○ НЕ ПРОЙДЕНА';
      card.innerHTML = `
        <span class="campaign-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="campaign-copy"><b>${chapter.title}</b><small>${chapter.subtitle}</small></span>
        <span class="campaign-medal">${medal}</span>
        <span class="campaign-preview">${this.chapterMechanics(chapter)
          .map(item => `<i>${item}</i>`)
          .join('')}</span>
        <span class="campaign-stats">
          <small>ЛУЧШЕЕ <b>${progress.best ? formatTime(progress.best) : '—'}</b></small>
          <small>МЕСТО <b data-campaign-rank>—</b></small>
          <small>FLAWLESS <b>${progress.flawless}</b></small>
          <small>СПАСЕНИЯ <b>${progress.revives}</b></small>
        </span>
        ${chapter.id === firstPending ? '<em>РЕКОМЕНДУЕМ</em>' : ''}`;
      card.addEventListener('click', () => {
        $('#coopChapter').value = chapter.id;
        $('#coopChapter').dispatchEvent(new Event('change'));
      });
      grid.append(card);
      this.loadCampaignRank(chapter.id, card.querySelector('[data-campaign-rank]'));
    });
  }

  chapterProgress(profile, chapterId) {
    const stats = profile.coop.chapterStats?.[chapterId] || {};
    const server = this.accountProgress?.get(chapterId) || {};
    const best = bestOf(
      profile.coop.bestByChapter[chapterId],
      server.bestTime,
      this.accountRecords?.get(`${GAME_MODE.COOP}:${chapterId}`)
    );
    return {
      completed: (stats.runs || 0) > 0 || (server.completions || 0) > 0 || Boolean(best),
      best,
      flawless: Math.max(stats.flawless || 0, server.flawless || 0),
      revives: Math.max(stats.revives || 0, server.revives || 0)
    };
  }

  chapterMechanics(chapter) {
    const labels = new Set();
    if (chapter.mechanics?.energyCore) labels.add('ЭНЕРГОЯДРО');
    if (chapter.mechanics?.tether) labels.add('ТРОС');
    if (chapter.mechanics?.asymmetricSignals) labels.add('СИГНАЛЫ');
    const kinds = {
      gateSpan: 'МОСТ',
      syncSpan: 'СИНХРО',
      movingSpan: 'ПЛАТФОРМА',
      splitSpan: 'РАЗВИЛКА',
      collapsing: 'ОБВАЛ'
    };
    const props = {
      plate: 'ПЛИТЫ',
      catapult: 'КАЧЕЛИ',
      conveyor: 'ЛЕНТА',
      fan: 'ВЕТЕР',
      pendulum: 'МОЛОТ',
      crusher: 'ПРЕСС'
    };
    for (const segment of chapter.segments || []) {
      if (kinds[segment.kind]) labels.add(kinds[segment.kind]);
      for (const prop of segment.props || []) if (props[prop.type]) labels.add(props[prop.type]);
    }
    return [...labels].slice(0, 3);
  }

  async loadCampaignRank(chapterId, target) {
    // Заслон стоит ЯВНО, хотя сегодня до запроса и так не доходит.
    //
    // На площадке аккаунта нет, `playerId()` возвращает null, и следующая строка выходит раньше
    // `fetch` — замер в браузере подтверждает ноль запросов к нашему домену. Но держится это на
    // побочном следствии: стоит завести локальную личность или подставить `ui.account` иначе — и
    // десять запросов к чужому домену поедут сами, без единого действия игрока. Условие, от
    // которого зависит поведение, должно быть названо.
    if (!supportsOnlinePlay(resolvePlatform())) return;
    if (!target || !this.playerId()) return;
    try {
      const params = new URLSearchParams({ limit: '1', playerId: this.playerId(), chapter: chapterId });
      const response = await fetch(`/leaderboard/coop?${params}`);
      if (!response.ok) return;
      const { standing } = await response.json();
      if (target.isConnected && standing?.place) target.textContent = `#${standing.place}`;
    } catch {
      // Кампания остаётся полностью рабочей офлайн; место — необязательное серверное дополнение.
    }
  }

  // Ссылка-приглашение. На телефоне диктовать пятисимвольный код неудобно и легко ошибиться,
  // а ссылку можно отправить в любой мессенджер одним касанием.
  inviteLink(code, mode) {
    return buildInviteLink(location.href, code, mode);
  }

  // Код и режим комнаты из адреса, если игрок пришёл по приглашению.
  static invitedRoom() {
    return readInvite(location.href);
  }

  // Имя игрока одно на всю игру и берётся из аккаунта.
  //
  // Раньше его печатали дважды — отдельным полем в гонке и отдельным в коопе, — и каждое хранилось
  // само по себе: игрок переименовывался в одном месте и не понимал, почему в другом остался
  // прежним. Заодно это два лишних поля на главном экране.
  coopName() {
    return this.playerName();
  }

  coopChapter() {
    return $('#coopChapter').value;
  }

  // Заставка перед стартом главы: название и что именно предстоит сделать.
  coopIntro(spec) {
    const intro = $('#coopIntro');
    $('#coopIntroRole').textContent = 'ГЛАВА';
    $('#coopIntroTitle').textContent = spec.title;
    $('#coopIntroHint').textContent = spec.hint;
    intro.classList.remove('hidden');
    clearTimeout(this.introTimer);
    this.introTimer = setTimeout(() => intro.classList.add('hidden'), 5200);
  }

  // Обучающая подсказка первой главы. Показывает текст своей роли и держится, пока задача
  // не решена, — в отличие от карточки главы, которая исчезает по таймеру.
  //
  // Перерисовываем только при смене текста: элемент обновляется каждый кадр, а трогать DOM
  // шестьдесят раз в секунду ради одной и той же строки незачем.
  coopLesson(text) {
    const node = $('#coopLesson');
    if (!text) {
      if (this.lessonText !== null) {
        this.lessonText = null;
        node.classList.add('hidden');
      }
      return;
    }
    if (this.lessonText === text) return;
    this.lessonText = text;
    $('#coopLessonText').textContent = text;
    node.classList.remove('hidden');
  }

  // Указатель на напарника. Пока он в кадре — стрелка не нужна и только мешала бы;
  // как только уходит за край, она появляется у ближайшей границы экрана.
  updatePartnerMarker({ screen, visible, distance, down, away }) {
    const hud = $('#partnerHud');
    if (!screen) {
      hud.classList.add('hidden');
      return;
    }
    // Указатель прячется, только когда напарник виден и с ним всё в порядке. Упавший и отошедший
    // остаются отмеченными даже в кадре: неподвижный персонаж сам по себе ничего не объясняет.
    const quiet = visible && !down && !away;
    hud.classList.toggle('hidden', quiet);
    if (quiet) return;

    const margin = 46;
    const x = Math.max(margin, Math.min(innerWidth - margin, screen.x));
    const y = Math.max(margin, Math.min(innerHeight - margin, screen.y));
    hud.style.left = `${x}px`;
    hud.style.top = `${y}px`;
    hud.dataset.state = down ? 'down' : away ? 'away' : 'ok';
    $('#partnerArrow').style.transform = `rotate(${Math.atan2(screen.y - y, screen.x - x) + Math.PI / 2}rad)`;
    $('#partnerLabel').textContent = down ? 'НУЖНА ПОМОЩЬ' : away ? 'ОТОШЁЛ' : `${Math.round(distance)} м`;
  }

  updateCoopPing(text, screen = null) {
    const bubble = $('#coopPingBubble');
    if (!text || !screen) {
      bubble.classList.add('hidden');
      return;
    }
    bubble.textContent = text;
    bubble.style.left = `${Math.max(36, Math.min(innerWidth - 36, screen.x))}px`;
    bubble.style.top = `${Math.max(54, Math.min(innerHeight - 24, screen.y))}px`;
    bubble.classList.remove('hidden');
  }
  setInputMethod(method) {
    const touch = method === 'touch';
    $('#controlHint').textContent = touch
      ? 'ДЖОЙСТИК · ПРЫЖОК · РЫВОК · СВАЙП — КАМЕРА'
      : 'WASD · ПРОБЕЛ · SHIFT · МЫШЬ — КАМЕРА · C — РЕЖИМ · T — КОМАНДЫ';
    if (this.racing) this.elements.touch.classList.toggle('hidden', !touch);
  }
  show(id) {
    for (const [name, element] of Object.entries(this.elements))
      if (['menu', 'lobby', 'finish'].includes(name)) element.classList.toggle('hidden', name !== id);
    if (!id) for (const name of ['menu', 'lobby', 'finish']) this.elements[name].classList.add('hidden');
  }
  // Единый оверлей состояния соединения.
  //
  // Раньше о проблемах с сетью сообщали всплывающие подсказки: они исчезают через пару секунд,
  // и игрок, отошедший от экрана, возвращался к молчаливо сломанной игре, не понимая причины.
  // Оверлей висит, пока состояние не изменится, и всегда объясняет, что делать.
  linkOverlay(state, { title, detail, action } = {}) {
    const overlay = $('#linkOverlay');
    if (!state) {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    overlay.dataset.state = state;
    $('#linkTitle').textContent = title || '';
    $('#linkDetail').textContent = detail || '';
    const button = $('#linkAction');
    button.classList.toggle('hidden', !action);
    if (action) {
      button.textContent = action.label;
      button.onclick = action.onClick;
    }
  }

  setLoading(done) {
    $('#loading').classList.toggle('done', done);
    if (done) setTimeout(() => $('#loading').classList.add('hidden'), 450);
  }
  toast(message, type = 'info', duration = 2600) {
    const element = type === 'error' ? $('#error') : $('#toast');
    clearTimeout(this.toastTimer);
    element.textContent = message;
    element.classList.remove('hidden');
    this.toastTimer = setTimeout(() => element.classList.add('hidden'), duration);
  }
  error(message) {
    this.toast(message, 'error', 5200);
  }
  status(message) {
    $(this.mode === 'coop' ? '#coopStatus' : '#connectStatus').textContent = message;
  }
  // `serverBest` — рекорд из аккаунта. Он важнее локального: локальный принадлежит браузеру, а
  // серверный — игроку, и переезжает вместе с ним на другое устройство.
  preview(spec, serverBest = null) {
    $('#courseName').textContent = courseName(spec.seed);
    const best = bestOf(serverBest, readBest(soloKey(spec.seed, spec.difficulty)));
    $('#bestTime').textContent = best ? `РЕКОРД ${formatTime(best)}` : 'РЕКОРД —:—';
    const rule = $('#challengeRule');
    rule.classList.toggle('hidden', spec.challenge !== 'daily');
    if (spec.challenge === 'daily') {
      rule.querySelector('strong').textContent = spec.modifier.label;
      // Цель берётся из спеки, а не пишется здесь строкой: раньше подпись обещала «пройти без
      // падений» независимо от того, что на самом деле проверяется, и разойтись им было нечему
      // помешать.
      const goal = spec.objectives?.[0];
      rule.querySelector('span').textContent = goal
        ? `${spec.modifier.description} Цель: ${goal.label.toLowerCase()}.`
        : spec.modifier.description;
    }
  }
  profile(data) {
    this.profileData = data;
    $('#profileRuns').textContent = data.completedRuns;
    $('#profileFlawless').textContent = data.flawlessRuns;
    $('#profileStreak').textContent = data.daily.streak;
    this.renderCosmetics();
  }
  cosmeticLoadout() {
    return cosmeticLoadout(this.accountProgressData, this.profileData || readProfile());
  }
  coopProfile(chapterId, data = readProfile()) {
    $('#coopProfileChapters').textContent = data.coop.completedChapters;
    $('#coopProfileRevives').textContent = data.coop.totalRevives;
    const best = data.coop.bestByChapter[chapterId];
    $('#coopProfileBest').textContent = best ? formatTime(best) : '—';
  }
  singleSettings() {
    return { type: $('#runType').value, difficulty: $('#difficulty').value };
  }
  playerName() {
    return (this.account?.name || 'Wobbler').slice(0, 16);
  }
  // Личность игрока — это его аккаунт. Прежний анонимный идентификатор из профиля не переживал
  // очистку данных браузера и не переносился на другое устройство: рекорд, поставленный на телефоне,
  // на компьютере просто не существовал.
  playerId() {
    return this.account?.id || null;
  }
  accountToken() {
    return this.account?.secret || null;
  }
  // Текст ожидания в публичной комнате. Отдельным методом, потому что его перерисовывает таймер:
  // момент старта приходит от сервера один раз, а показывать надо убывающий остаток.
  fillHint(data) {
    // Считаем по `online`, а не по длине списка: оборвавшийся игрок остаётся в комнате ещё
    // тридцать секунд, и сервер набор по нему не засчитывает — клиент не должен обещать иного.
    const connected = data.players.filter(player => player.online).length;
    if (connected < (data.minPlayers || 2)) return `В гонке ${connected} — ждём соперников…`;
    if (!data.fillDeadline) return `В гонке ${connected} — скоро старт.`;
    const left = Math.max(0, Math.round((data.fillDeadline - Date.now()) / 1000));
    return `В гонке ${connected} — старт через ${left} с. Можно ждать ещё игроков.`;
  }

  startFillCountdown(data) {
    this.stopFillCountdown();
    if (!data.fillDeadline) return;
    this.fillTimer = setInterval(() => {
      const hint = document.querySelector('#lobbyHint');
      if (!hint) return this.stopFillCountdown();
      hint.textContent = this.fillHint(data);
      if (data.fillDeadline - Date.now() <= 0) this.stopFillCountdown();
    }, 1000);
  }

  stopFillCountdown() {
    if (!this.fillTimer) return;
    clearInterval(this.fillTimer);
    this.fillTimer = null;
  }

  lobby(data, selfId) {
    this.show('lobby');
    $('#roomCode').textContent = data.code;
    $('#lobbyCourse').textContent = courseName(data.seed);
    $('#lobbyDifficulty').value = data.difficulty;
    // Публичная комната подбора управляется сама: сложность в ней задана подбором, старт идёт по
    // таймеру, готовность не спрашивается. Показывать в ней хозяйские органы управления значило бы
    // предлагать кнопки, на которые сервер ответит отказом.
    const matchmade = data.fillDeadline !== undefined && data.minPlayers !== null && !!data.minPlayers;
    const host = data.host === selfId && !matchmade;
    $('#lobbyDifficultyWrap').classList.toggle('locked', !host);
    $('#lobbyDifficulty').disabled = !host;
    $('#start').classList.toggle('hidden', !host);
    // Ботов зовёт только хост приватной гоночной комнаты: в публичной состав определяет подбор,
    // а в кооперативе ботов пока нет. Прячем кнопку там, где сервер всё равно откажет.
    const canAddBots =
      host &&
      data.mode !== GAME_MODE.COOP &&
      !matchmade &&
      data.players.length < 16 &&
      !data.players.some(p => p.bot);
    $('#addBots').classList.toggle('hidden', !canAddBots);
    $('#start').disabled = !data.players.length || !data.players.every(p => p.ready);
    $('#ready').classList.toggle('hidden', matchmade);
    if (this.pendingRecentPartnerInviteName && data.mode === GAME_MODE.COOP) {
      this.recentPartnerInviteRoomCode = data.code;
      this.recentPartnerInviteName = this.pendingRecentPartnerInviteName;
      this.pendingRecentPartnerInviteName = null;
    }
    if (this.recentPartnerInviteRoomCode === data.code && data.players.length > 1) {
      this.recentPartnerInviteRoomCode = null;
      this.recentPartnerInviteName = null;
    }
    const waitingRecentPartner =
      data.mode === GAME_MODE.COOP &&
      this.recentPartnerInviteRoomCode === data.code &&
      data.players.length === 1;
    // Ожидающему в подборе нужно не «отметьтесь готовым», а состав и момент старта: он ничего не
    // нажимает и должен понимать, чего именно ждёт. Отсчёт держится здесь, на видимом экране, —
    // строка статуса в меню к этому моменту уже скрыта вместе с самим меню.
    if (matchmade) this.startFillCountdown(data);
    else this.stopFillCountdown();
    $('#lobbyHint').textContent = matchmade
      ? this.fillHint(data)
      : waitingRecentPartner
        ? 'Комната для ' + this.recentPartnerInviteName + ' готова — отправьте её кнопкой «ССЫЛКА».'
        : host
          ? 'Все игроки должны быть готовы перед стартом.'
          : 'Отметьтесь готовым — гонку запустит хост.';
    const list = $('#players');
    list.replaceChildren();
    for (const player of data.players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const loadout = cosmeticLoadoutFromIds(player.loadout);
      row.dataset.playerId = player.id;
      // Список слотов берётся из каталога, а не переписывается здесь: пропущенный в этой строке
      // слот означал бы, что новая часть образа просто не доезжает до состава комнаты.
      for (const slot of COSMETIC_SLOTS) {
        row.dataset[`cosmetic${slot[0].toUpperCase()}${slot.slice(1)}`] = loadout[slot]?.id || 'none';
      }

      const avatar = document.createElement('i');
      avatar.className = 'player-avatar';
      const bodyColor = loadout.body?.colors?.body ?? player.color ?? 0xff4f91;
      const accentColor = loadout.body?.colors?.accent ?? 0xffde59;
      avatar.style.setProperty('--body-color', cssColor(bodyColor));
      avatar.style.setProperty('--visor-color', cssColor(loadout.visor?.color, 0xdffcff));
      avatar.style.setProperty('--antenna-color', cssColor(loadout.antenna?.color, accentColor));

      const copy = document.createElement('div');
      copy.className = 'player-copy';
      const name = document.createElement('span');
      name.textContent = `${player.id === data.host ? '♛ ' : ''}${player.name}${player.id === selfId ? ' (вы)' : ''}`;
      // Соперника-бота видно с первой секунды, а не только в итогах. Выдавать бота за человека —
      // обман, который игрок всё равно раскроет по поведению, и тогда он перестанет верить и
      // таблице рекордов.
      if (player.bot) name.append(botBadge());
      const cosmetics = document.createElement('small');
      cosmetics.className = 'player-cosmetics';
      cosmetics.textContent =
        [
          loadout.body?.id !== 'classic' ? loadout.body?.name : null,
          loadout.visor?.name,
          loadout.antenna?.name
        ]
          .filter(Boolean)
          .join(' · ') || 'КЛАССИКА';
      copy.append(name, cosmetics);

      const state = document.createElement('b');
      state.className = player.ready ? 'ready' : '';
      state.textContent = player.ready ? 'ГОТОВ' : 'ОЖИДАНИЕ';
      row.append(avatar, copy, state);
      list.append(row);
    }
    // Таблица показывается там, где время мерил сервер: в гонке и в кооперативе. У соло сервера
    // нет вовсе, и его результат в общую таблицу не идёт — см. loadVerifiedTop.
    const coop = data.mode === GAME_MODE.COOP;
    const hasBoard = data.mode === GAME_MODE.RACE || (coop && data.chapterId);
    $('#verifiedTop').classList.toggle('hidden', !hasBoard);
    if (hasBoard) this.loadVerifiedTop(data.mode, coop ? data.chapterId : `${data.seed}:${data.difficulty}`);
  }
  // Ключ трассы приходит готовым: правило, по которому он считается, живёт в общем с сервером
  // модуле (courseKeyFor), а не повторяется здесь.
  async loadVerifiedTop(mode, courseKey) {
    const key = `${mode}:${courseKey}`;
    if (this.verifiedTopKey === key) return;
    this.verifiedTopKey = key;
    const list = $('#verifiedTopList');
    const standing = $('#verifiedTopStanding');
    const count = $('#verifiedTopCount');
    list.replaceChildren();
    count.textContent = '';
    standing.textContent = 'ЗАГРУЗКА…';
    try {
      const coop = mode === GAME_MODE.COOP;
      const params = new URLSearchParams({ limit: '10', playerId: this.playerId() });
      if (coop) params.set('chapter', courseKey);
      else {
        const [seed, difficulty] = courseKey.split(':');
        params.set('seed', seed);
        params.set('difficulty', difficulty);
      }
      const response = await fetch(`/leaderboard${coop ? '/coop' : ''}?${params}`);
      if (!response.ok) throw new Error('leaderboard unavailable');
      const data = await response.json();
      this.renderVerifiedTop(data);
    } catch {
      standing.textContent = 'ТАБЛИЦА НЕДОСТУПНА';
      // Ключ сбрасывается, чтобы следующий заход в лобби попробовал снова: иначе одна неудачная
      // загрузка оставила бы игрока без таблицы до перезагрузки страницы.
      this.verifiedTopKey = null;
    }
  }
  renderVerifiedTop({ entries = [], standing = null, movementVerified = true }) {
    const list = $('#verifiedTopList');
    const line = $('#verifiedTopStanding');
    const count = $('#verifiedTopCount');
    list.replaceChildren();
    // В коопе сервер мерил время, но не проверял движение: разметка главы рукотворная, коридоров
    // у неё нет. Обещать «подтверждено» одинаково для обеих таблиц значило бы врать в одной из них.
    count.textContent = standing?.total
      ? `ВСЕГО ${standing.total}${movementVerified ? '' : ' · ВРЕМЯ ПО СЕРВЕРУ'}`
      : '';

    if (!entries.length) {
      line.textContent = 'ПОКА НЕТ РЕЗУЛЬТАТОВ — ПЕРВОЕ МЕСТО СВОБОДНО';
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('li');
      row.className = 'verified-row';
      if (entry.self) row.classList.add('verified-row-self');
      const place = document.createElement('span');
      place.className = 'verified-place';
      place.textContent = entry.place;
      const name = document.createElement('span');
      name.className = 'verified-name';
      name.textContent = entry.name;
      const time = document.createElement('span');
      time.className = 'verified-time';
      time.textContent = formatTime(entry.time);
      row.append(place, name, time);
      list.append(row);
    }

    // Своя строка показывается отдельно, даже когда она есть в списке: игроку важнее видеть своё
    // место и отставание одной фразой, чем выискивать подсвеченную строку глазами.
    if (!standing) {
      line.textContent = 'ВЫ ЭТУ ТРАССУ ЕЩЁ НЕ ПРОХОДИЛИ';
      return;
    }
    line.textContent =
      standing.gap === null
        ? `ВЫ ПЕРВЫЙ · ${formatTime(standing.time)}`
        : `ВЫ ${standing.place}-Й · ${formatTime(standing.time)} · ОТСТАВАНИЕ ${formatGap(standing.gap)}`;
  }
  hud(on, { multiplayer = false, touch = false, coop = false } = {}) {
    this.racing = on;
    this.elements.hud.classList.toggle('hidden', !on);
    this.elements.touch.classList.toggle('hidden', !on || !touch);
    // Эмоции показываются там, где их видят другие, — в сетевых режимах. В одиночном забеге
    // кнопка была бы украшением, занимающим место рядом с камерой.
    this.emoteControl?.setVisible(on && multiplayer);
    // В кооперативе места нет — есть общая цель, поэтому счётчик места скрыт.
    $('#placeBox').classList.toggle('hidden', !multiplayer || coop);
    $('#pingBox').classList.toggle('hidden', !multiplayer);
    if (!on || !coop) $('#partnerHud').classList.add('hidden');
    $('#coopPingButton').classList.toggle('hidden', !on || !coop);
    if (!on || !coop) {
      $('#coopPingMenu').classList.add('hidden');
      this.updateCoopPing(null);
    }
    if (!on) $('#coopIntro').classList.add('hidden');
    if (!on || !coop) this.coopLesson(null);
    // Баннер досмотра живёт поверх HUD и уходит вместе с ним: пережить его он не должен ни в
    // одном из путей — ни через итоги, ни через выход в меню.
    if (!on) this.spectateEnd();
  }
  updateHud({ time, checkpoint, total, progress, stage, place, link }) {
    $('#timer').textContent = formatTime(time);
    $('#checks').textContent = `${checkpoint} / ${total}`;
    $('#progressFill').style.width = `${Math.round(progress * 100)}%`;
    $('#stageName').textContent = stage;
    if (place) $('#place').textContent = ordinal(place);
    if (link) this.setLinkQuality(link);
  }
  // Качество связи словами. Игроку «Плохая» объясняет рывки, а «120 мс» — нет.
  // Числовая задержка остаётся в подсказке для тех, кому она нужна.
  setLinkQuality({ quality, latency }) {
    const labels = {
      good: 'ХОРОШАЯ',
      unstable: 'НЕСТАБИЛЬНАЯ',
      poor: 'ПЛОХАЯ',
      reconnecting: 'ВОССТАНОВЛЕНИЕ',
      offline: 'НЕТ СВЯЗИ',
      unknown: '…'
    };
    const box = $('#pingBox');
    const value = $('#ping');
    if (value.textContent !== labels[quality]) value.textContent = labels[quality] || '…';
    box.dataset.quality = quality;
    box.title = Number.isFinite(latency) ? `Задержка ${Math.round(latency)} мс` : '';
  }

  checkpoint(index, total) {
    const banner = $('#checkpointBanner');
    banner.querySelector('strong').textContent = `${index} / ${total}`;
    banner.classList.remove('hidden');
    void banner.offsetWidth;
    setTimeout(() => banner.classList.add('hidden'), 920);
  }
  // Обратный отсчёт. `now` передаётся снаружи, потому что в сетевой игре момент старта задан в
  // серверном времени: сравнивать его с локальными часами нельзя, иначе у игроков с расходящимися
  // системными часами отсчёт закончится в разные моменты.
  async countdown(startAt, { now = () => Date.now(), onTick = null } = {}) {
    const overlay = $('#countdown'),
      label = overlay.querySelector('span');
    overlay.classList.remove('hidden');
    let last = '';
    while (now() < startAt + 420) {
      const left = startAt - now(),
        value = left > 2000 ? '3' : left > 1000 ? '2' : left > 0 ? '1' : 'ВПЕРЁД!';
      if (value !== last) {
        label.textContent = value;
        // Перезапуск CSS-анимации: без принудительного пересчёта макета браузер не считает
        // повторное присвоение того же имени анимации изменением и не проигрывает её заново.
        label.style.animation = 'none';
        void label.offsetWidth;
        label.style.animation = '';
        last = value;
        onTick?.(value);
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    overlay.classList.add('hidden');
  }

  // Регуляторы громкости. Значения приходят из AudioEngine, который хранит их в localStorage.
  bindAudioControls({ volumes, onChange }) {
    for (const bus of ['master', 'sfx', 'music']) {
      const slider = $(`#vol-${bus}`);
      if (!slider) continue;
      slider.value = String(Math.round((volumes[bus] ?? 0.8) * 100));
      slider.addEventListener('input', () => onChange(bus, Number(slider.value) / 100));
    }
  }
  // Кнопки экрана результатов в исходное состояние. Голоса считаются заново для каждого матча,
  // а `disabled` мог остаться с прошлого.
  resetResultButtons() {
    const next = $('#nextChapter');
    next.disabled = false;
    next.textContent = 'ИГРАТЬ ДАЛЬШЕ ВМЕСТЕ';
    const rematch = $('#rematch');
    rematch.disabled = false;
    rematch.textContent = 'ЕЩЁ РАЗ';
    const back = $('#returnLobby');
    back.disabled = false;
    back.textContent = 'В ЛОББИ';
    // Отсчёт прошлого экрана обязан остановиться: интервал, переживший закрытие карточки,
    // продолжал бы писать в невидимый элемент до конца сессии.
    this.showResultsTimer(null);
  }

  // Обновление карточки результатов, пока комната ещё в RESULTS.
  //
  // Раньше любое обновление состава комнаты открывало лобби, поэтому первый же голос за реванш
  // закрывал результаты обоим. Теперь состояние RESULTS приходит сюда и меняет только то, что
  // действительно изменилось, — счёт голосов.
  updateResultRoom(data, selfId, serverNow = Date.now()) {
    // Голосуют только люди — и в знаменателе стоят тоже только они. Правило и его цена описаны
    // в voteTally: бот в счёте означал ожидание голоса, которого не будет.
    const votes = voteTally(data.players, selfId);
    const self = votes.self;

    // Кнопки остаются нажимаемыми: выбор меняют, пока комната не решила. Отметка «✓» показывает
    // свой выбор, счётчик — чужой. Без второго игрок не понимает, ждут его или он ждёт.
    const next = $('#nextChapter');
    next.disabled = false;
    next.classList.toggle('hidden', data.mode !== GAME_MODE.COOP);
    next.textContent =
      (self?.choice === 'next' ? '✓ ИГРАТЬ ДАЛЬШЕ ВМЕСТЕ' : 'ИГРАТЬ ДАЛЬШЕ ВМЕСТЕ') +
      ` · ${votes.next}/${votes.total}`;

    const rematch = $('#rematch');
    rematch.disabled = false;
    rematch.textContent =
      (self?.choice === 'rematch' ? '✓ ЕЩЁ РАЗ' : 'ЕЩЁ РАЗ') + ` · ${votes.rematch}/${votes.total}`;

    const back = $('#returnLobby');
    back.disabled = false;
    back.textContent =
      (self?.choice === 'lobby'
        ? `✓ ${data.mode === GAME_MODE.COOP ? 'ВЫЙТИ' : 'В ЛОББИ'}`
        : data.mode === GAME_MODE.COOP
          ? 'ВЫЙТИ'
          : 'В ЛОББИ') + ` · ${votes.lobby}/${votes.total}`;

    this.showResultsTimer(data.resultsDeadline, serverNow);
  }

  // Обратный отсчёт до автоматического возврата в лобби.
  //
  // Считается от присланного сервером МОМЕНТА по синхронизированным часам: остаток, присланный
  // числом секунд, начал бы врать при первой же задержке пакета. Тикает локально, потому что
  // состояние комнаты рассылается только при смене голосов — иначе цифра застыла бы.
  showResultsTimer(deadline, serverNow = Date.now()) {
    const note = $('#resultsTimer');
    if (!note) return;
    clearInterval(this._resultsTick);
    this._resultsTick = null;
    if (!deadline) {
      note.textContent = '';
      return;
    }
    // Расхождение локальных часов с серверными на момент получения. Дальше отсчитываем локально:
    // за двадцать секунд оно не изменится, а лишних сообщений не потребуется.
    const skew = serverNow - Date.now();
    const render = () => {
      const left = Math.max(0, Math.ceil((deadline - (Date.now() + skew)) / 1000));
      note.textContent = left ? `Без общего решения — в лобби через ${left} с` : 'Возвращаемся в лобби…';
      if (!left) {
        clearInterval(this._resultsTick);
        this._resultsTick = null;
      }
    };
    render();
    this._resultsTick = setInterval(render, 1000);
  }

  // Плашка «без зачёта» на карточке финиша. Причина названа прямо: игрок должен понимать,
  // почему его время никуда не записалось, иначе это выглядит как потерянный рекорд.
  showUnranked(reason) {
    const note = $('#unrankedNote');
    note.classList.toggle('hidden', !reason);
    if (!reason) return;
    // Причина называется своя, а не первая попавшаяся.
    //
    // Раньше веток было две: «напарник вышел» и всё остальное — «связь оборвалась». Из-за этого
    // забег, отклонённый проверкой честности, объявлялся игроку обрывом связи: человек шёл чинить
    // интернет вместо того, чтобы узнать, что произошло на самом деле.
    const reasons = {
      left: 'напарник вышел посреди забега',
      disconnect: 'связь оборвалась посреди забега',
      verification: 'проверка забега не подтвердила результат'
    };
    note.textContent = `БЕЗ ЗАЧЁТА · ${reasons[reason] || 'результат не засчитан'}`;
  }

  // В коопе свой финиш — это ещё не конец: ждём напарника, а не показываем итоги.
  // Начало досмотра: HUD остаётся на экране и с этой минуты рассказывает про чужой забег, а своё
  // место и время переезжают в баннер — иначе игрок потерял бы собственный результат из виду.
  //
  // Экранные кнопки убираются: управлять больше нечем. Зона обзора при этом продолжает работать —
  // она ловит касание по свободной части экрана, а не по кнопке.
  spectateBegin({ place = null, time = null } = {}) {
    this.elements.touch.classList.add('hidden');
    const own = place ? `ВЫ ФИНИШИРОВАЛИ · ${ordinal(place)}-Е МЕСТО` : 'ВЫ ФИНИШИРОВАЛИ';
    $('#spectateSelf').textContent = time ? `${own} · ${formatTime(time)}` : own;
    this.spectateWatching(null);
    $('#spectate').classList.remove('hidden');
  }

  // За кем смотрим. null — пока не за кем: все либо дошли, либо потеряли связь.
  spectateWatching(target) {
    const line = $('#spectateWatching');
    if (!line) return;
    line.replaceChildren();
    if (!target?.name) {
      line.append('ЖДЁМ ОСТАЛЬНЫХ');
      return;
    }
    line.append(`СМОТРИМ ЗА: ${target.name}`);
    if (target.bot) line.append(botBadge());
  }

  spectateEnd() {
    $('#spectate')?.classList.add('hidden');
  }

  awaitPartnerFinish() {
    // HUD остаётся: игрок продолжает смотреть на трассу и видеть, где напарник. Управление к этому
    // моменту уже отключено вызывающей стороной, поэтому экранные кнопки убираем.
    this.elements.touch.classList.add('hidden');
    this.toast('Финиш! Ждём напарника — глава засчитывается только вдвоём.', 'info', 8000);
  }

  finishSolo({ time, respawns, dashes = 0, hits = 0, spec, unranked = null, serverBest = null }) {
    this.hud(false);
    this.show('finish');
    this.showUnranked(unranked);
    $('#finishEyebrow').textContent = 'ТРАССА ПРОЙДЕНА';
    const { seed, difficulty } = spec;
    const par = DIFFICULTIES[difficulty].parPerSegment * DIFFICULTIES[difficulty].segments * 1000,
      ratio = time / par,
      medal = ratio <= 1 ? 'GOLD' : ratio <= 1.28 ? 'SILVER' : ratio <= 1.65 ? 'BRONZE' : 'FINISH';
    const medalTitles = { GOLD: 'ЗОЛОТОЙ ЗАБЕГ!', SILVER: 'СЕРЕБРЯНЫЙ ЗАБЕГ!', BRONZE: 'БРОНЗОВЫЙ ЗАБЕГ!' };
    $('#finishTitle').textContent = medal === 'FINISH' ? 'ТРАССА ПОКОРЕНА!' : medalTitles[medal];
    $('#medal').textContent =
      medal === 'GOLD' ? '★' : medal === 'SILVER' ? '◆' : medal === 'BRONZE' ? '●' : '✓';
    $('#finishTime').textContent = formatTime(time);
    const objectives = evaluateCourseObjectives(spec, { respawns, time, dashes, hits });
    const previousBest = bestOf(serverBest, readBest(soloKey(seed, difficulty)));
    const profile = recordSoloProfile(spec, { objectives, unranked, respawns });
    this.profile(profile);
    $('#finishStats').innerHTML = [
      `<span>${courseName(seed)}</span>`,
      `<span>ВОЗВРАЩЕНИЙ: ${respawns}</span>`,
      `<span>${DIFFICULTIES[difficulty].label.toUpperCase()}</span>`,
      // Подпись берётся у самой цели. Раньше здесь стояло «БЕЗ ПАДЕНИЙ» для любой цели —
      // с одной целью это было незаметно, с пулом стало бы прямой ложью.
      ...objectives.map(goal => `<span>${goal.label} ${goal.complete ? '✓' : '✗'}</span>`),
      spec.challenge === 'daily' ? `<span>СЕРИЯ: ${profile.daily.streak}</span>` : ''
    ].join('');
    $('#board').replaceChildren();
    $('#again').classList.remove('hidden');
    $('#newCourse').classList.remove('hidden');
    $('#rematch').classList.add('hidden');
    $('#nextChapter').classList.add('hidden');
    $('#returnLobby').classList.add('hidden');
    // Забег без зачёта рекорд не переписывает — правило и его причина живут в core/records.js.
    const saved = saveBest(soloKey(seed, difficulty), time, { unranked });
    // Поздравляем только за настоящее улучшение. Серверный рекорд может быть лучше локального —
    // например, поставлен с телефона, — и тогда «новый рекорд» на экране был бы неправдой.
    const previous = bestOf(serverBest, saved.improved ? null : saved.best);
    if (saved.improved && (!previous || time < previous)) {
      this.toast(saved.first && !serverBest ? 'Первое время сохранено!' : 'Новый личный рекорд!');
    }
    const goal = nextCosmeticGoal(this.accountProgressData, profile);
    this.setFinishHighlights([
      saved.improved && previousBest
        ? {
            title: `НОВЫЙ РЕКОРД −${formatTime(previousBest - time)}`,
            detail: `Было ${formatTime(previousBest)}`
          }
        : previousBest
          ? {
              title:
                time <= previousBest
                  ? 'ЛУЧШЕЕ ВРЕМЯ ПОВТОРЕНО'
                  : `ДО РЕКОРДА ${formatTime(time - previousBest)}`,
              detail: `Ваш рекорд ${formatTime(previousBest)}`
            }
          : { title: 'ПЕРВОЕ ВРЕМЯ', detail: 'Теперь есть точка для сравнения' },
      respawns === 0
        ? { title: 'БЕЗ ПАДЕНИЙ', detail: 'Чистое прохождение трассы' }
        : { title: `ВОЗВРАЩЕНИЯ: ${respawns}`, detail: 'Следующая цель — пройти без падений' },
      goal
        ? {
            title: `${goal.label.toUpperCase()} ${Math.min(goal.current, goal.target)}/${goal.target}`,
            detail: 'Прогресс к следующей косметической награде'
          }
        : null
    ]);
    this.applyFinishCosmetic();
  }

  // Итоги кооп-главы. Мест здесь нет: команда либо прошла главу, либо нет, и время у неё общее —
  // по последнему дошедшему.
  finishCoop({
    time,
    chapter,
    board,
    selfId,
    revives = 0,
    receivedRevives = 0,
    downs = 0,
    matchId = null,
    unranked = null,
    serverBest = null
  }) {
    this.hud(false);
    this.show('finish');
    this.showUnranked(unranked);
    $('#finishEyebrow').textContent = 'КООПЕРАТИВ';
    $('#finishTitle').textContent = 'ГЛАВА ПРОЙДЕНА!';
    $('#medal').textContent = '✦';
    $('#finishTime').textContent = formatTime(time);
    const localPrevious = chapter ? readBest(coopKey(chapter.chapterId)) : null;
    const previousBest = bestOf(serverBest, localPrevious);
    const saved = chapter ? saveBest(coopKey(chapter.chapterId), time, { unranked }) : { best: null };
    const best = bestOf(serverBest, saved.best);
    const profile = recordCoopProfile(chapter, { time, revives, matchId, unranked });
    this.coopProfile(chapter?.chapterId, profile);
    if (this.coopChapters) this.renderCoopCampaign(this.coopChapters, profile);
    $('#finishStats').innerHTML = [
      `<span>${chapter?.title || 'КООПЕРАТИВ'}</span>`,
      `<span>${chapter?.subtitle || 'ВДВОЁМ'}</span>`,
      best ? `<span>ЛУЧШЕЕ ${formatTime(best)}</span>` : '',
      `<span>СПАСЕНИЙ: ${revives}</span>`
    ].join('');
    const goal = nextCosmeticGoal(this.accountProgressData, profile);
    this.setFinishHighlights([
      saved.improved && previousBest && time < previousBest
        ? {
            title: `НОВЫЙ РЕКОРД −${formatTime(previousBest - time)}`,
            detail: `Было ${formatTime(previousBest)}`
          }
        : previousBest
          ? {
              title:
                time <= previousBest
                  ? 'ЛУЧШЕЕ ВРЕМЯ ПОВТОРЕНО'
                  : `МЕДЛЕННЕЕ НА ${formatTime(time - previousBest)}`,
              detail: `Лучшее ${formatTime(previousBest)}`
            }
          : { title: 'ПЕРВОЕ ПРОХОЖДЕНИЕ', detail: 'Время главы сохранено' },
      downs === 0
        ? { title: 'БЕЗ ПАДЕНИЙ', detail: 'Вы прошли главу без спасения' }
        : receivedRevives > 0
          ? {
              title: `НАПАРНИК СПАС ВАС ${receivedRevives} ${this.timesLabel(receivedRevives)}`,
              detail: `Падений за главу: ${downs}`
            }
          : { title: `ПАДЕНИЙ: ${downs}`, detail: 'Попробуйте пройти следующую главу без падений' },
      revives > 0
        ? { title: `ВЫ СПАСЛИ НАПАРНИКА ${revives} ${this.timesLabel(revives)}`, detail: 'Командная работа' }
        : null,
      goal
        ? {
            title: `${goal.label.toUpperCase()} ${Math.min(goal.current, goal.target)}/${goal.target}`,
            detail: 'До следующей косметической награды'
          }
        : null
    ]);
    this.applyFinishCosmetic();
    if (!unranked && chapter?.chapterId) this.loadResultStanding(chapter.chapterId);
    this.updateBoard(board || [], selfId);
    $('#again').classList.add('hidden');
    $('#newCourse').classList.add('hidden');
    $('#rematch').classList.remove('hidden');
    $('#nextChapter').classList.remove('hidden');
    $('#returnLobby').classList.remove('hidden');
    this.resetResultButtons();
    $('#returnLobby').textContent = 'ВЫЙТИ';
  }

  setFinishHighlights(items) {
    const box = $('#finishHighlights');
    box.replaceChildren();
    for (const item of items.filter(Boolean).slice(0, 4)) {
      const card = document.createElement('div');
      card.className = 'finish-highlight';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      card.append(title, detail);
      box.append(card);
    }
  }

  async loadResultStanding(chapterId) {
    try {
      const params = new URLSearchParams({ chapter: chapterId, playerId: this.playerId() || '' });
      const response = await fetch(`/leaderboard/coop?${params}`);
      if (!response.ok) return;
      const { standing } = await response.json();
      if (!standing) return;
      const top = Math.max(1, Math.ceil((standing.place / standing.total) * 100));
      const items = [...$('#finishHighlights').children].map(card => ({
        title: card.querySelector('strong')?.textContent || '',
        detail: card.querySelector('span')?.textContent || ''
      }));
      items.unshift({
        title: `№${standing.place} В ЭТОЙ ГЛАВЕ`,
        detail: `ТОП ${top}% · участников ${standing.total}`
      });
      this.setFinishHighlights(items);
    } catch {
      // Наградная карточка остаётся полезной и без таблицы; сетевую ошибку здесь не показываем.
    }
  }

  applyFinishCosmetic() {
    const finish = this.cosmeticLoadout().finish;
    if (finish?.glyph) $('#medal').textContent = finish.glyph;
  }

  timesLabel(value) {
    return Number(value) === 1 ? 'РАЗ' : 'РАЗА';
  }

  // canChoose = false — итоги открыты досрочно, гонка ещё идёт. Реванш и возврат в лобби сервер
  // принимает только на экране результатов КОМНАТЫ; показанные раньше, они отвечали бы отказом.
  finishMulti({ time, board, selfId, canRematch = true, unranked = null, canChoose = true }) {
    this.hud(false);
    this.show('finish');
    this.showUnranked(unranked);
    // После возврата в лобби перечитываем таблицу: только что завершённый матч мог сменить лидера.
    this.verifiedTopKey = null;
    // Открытые досрочно итоги не должны объявлять гонку законченной: она идёт, и в таблице ниже
    // пока не все.
    $('#finishEyebrow').textContent = canChoose ? 'ГОНКА ЗАВЕРШЕНА' : 'ВЫ ФИНИШИРОВАЛИ';
    const own = board.findIndex(p => p.id === selfId),
      place = own < 0 ? board.length : own + 1;
    $('#finishTitle').textContent = place === 1 ? 'КОРОНА ВАША!' : `${ordinal(place)}-Е МЕСТО`;
    $('#medal').textContent = place === 1 ? '♛' : '★';
    $('#finishTime').textContent = formatTime(time);
    $('#finishStats').innerHTML = '<span>ОНЛАЙН-ГОНКА</span><span>РЕЗУЛЬТАТЫ</span>';
    this.setFinishHighlights([]);
    this.applyFinishCosmetic();
    this.updateBoard(board, selfId);
    $('#again').classList.add('hidden');
    $('#newCourse').classList.add('hidden');
    $('#rematch').classList.toggle('hidden', !canRematch || !canChoose);
    $('#nextChapter').classList.add('hidden');
    $('#returnLobby').classList.toggle('hidden', !canChoose);
    this.resetResultButtons();
    // Вместо кнопок — объяснение, почему их пока нет. Пустое место на их месте выглядело бы
    // поломкой карточки, а «выйти в меню» внизу остаётся: запирать досмотревшего нельзя.
    if (!canChoose) $('#resultsTimer').textContent = 'Гонка ещё идёт — выбор появится, когда дойдут все';
  }
  updateBoard(board, selfId) {
    const list = $('#board');
    list.replaceChildren();
    board.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = `board-row ${index === 0 ? 'winner' : ''}`;
      const rank = document.createElement('b');
      rank.textContent = index + 1;
      const color = document.createElement('i');
      color.style.background = `#${Number(player.color || 0xff4f91)
        .toString(16)
        .padStart(6, '0')}`;
      const name = document.createElement('span');
      name.textContent = `${player.name}${player.id === selfId ? ' (вы)' : ''}`;
      if (player.bot) name.append(botBadge());
      const time = document.createElement('span');
      time.textContent = formatTime(player.time);
      row.append(rank, color, name, time);
      list.append(row);
    });
  }
  setQuality(value) {
    this.quality = value;
    const labels = { auto: 'АВТО', high: 'ВЫСОКОЕ', low: 'НИЗКОЕ' };
    $('#quality').textContent = `${labels[value] || value.toUpperCase()} КАЧЕСТВО`;
  }
}
