import { GAME_MODE } from '/shared/protocol.js';

const $ = selector => document.querySelector(selector);
const MODE_ORDER = ['single', 'multi', 'coop'];

// Пять стандартных жестов интерфейса. Длительности короткие намеренно: motion должен объяснять
// переход, а не заставлять игрока ждать украшение.
const MOTION = Object.freeze({
  screenExit: 120,
  screenEnter: 180,
  cardEnter: 180,
  buttonConfirm: 180,
  rewardReveal: 420
});

const STYLE = `
/* Главное меню: одно главное действие, остальное уходит на второй уровень. */
body.menu-polish .feature-pills,
body.menu-polish #single .profile-strip,
body.menu-polish #coop .coop-profile,
body.menu-polish .menu-footer #controlHint,
body.menu-polish .legacy-chapter-picker {
  display: none !important;
}

body.menu-polish .menu-card {
  width: min(458px, calc(100vw - 32px));
}

body.menu-polish .mode-panel {
  transform-origin: 50% 30%;
}

body.menu-polish #raceFind,
body.menu-polish #coopFind {
  min-height: 62px;
  padding: 15px 18px;
  border-radius: 16px;
  font-size: 18px;
}

body.menu-polish .menu-disclosure {
  width: 100%;
  min-height: 38px;
  margin: -2px 0 0;
  border: 0;
  border-radius: 10px;
  color: rgba(255, 255, 255, 0.72);
  background: transparent;
  font: inherit;
  font-size: 0.67rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-align: center;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}

body.menu-polish .menu-disclosure:hover,
body.menu-polish .menu-disclosure:focus-visible,
body.menu-polish .menu-disclosure[aria-expanded='true'] {
  color: #fff;
  background: rgba(255, 255, 255, 0.07);
}

body.menu-polish .private-room-panel {
  display: grid;
  gap: 9px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(17, 10, 56, 0.34);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
}

body.menu-polish .private-room-panel .button-primary {
  min-height: 46px;
  font-size: 0.8rem;
}

body.menu-polish #multi > .field,
body.menu-polish #coop .toggle-row {
  opacity: 0.82;
}

body.menu-polish .coop-lead {
  margin-bottom: 2px;
  color: rgba(255, 255, 255, 0.62);
  font-size: 0.62rem;
  line-height: 1.42;
}

/* Карточка — единственный выбор главы. Невыбранные компактны, выбранная раскрывает детали. */
body.menu-polish .campaign-card {
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    box-shadow 140ms ease,
    transform 140ms ease;
}

body.menu-polish .campaign-card:not(.selected) .campaign-preview,
body.menu-polish .campaign-card:not(.selected) .campaign-stats {
  display: none;
}

body.menu-polish .campaign-card.selected {
  grid-column: 1 / -1;
  padding: 12px;
  border-color: var(--cyan);
  background:
    radial-gradient(circle at 100% 0, rgba(84, 224, 255, 0.2), transparent 44%),
    rgba(84, 224, 255, 0.08);
  box-shadow:
    inset 0 0 0 1px var(--cyan),
    0 8px 24px rgba(10, 7, 42, 0.2);
}

body.menu-polish .campaign-card.selected .campaign-copy b {
  font-size: 0.72rem;
}

body.menu-polish .campaign-card.selected .campaign-copy small {
  white-space: normal;
}

body.menu-polish .coop-hint {
  margin-top: 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.045);
}

body.menu-polish .menu-footer {
  justify-content: flex-start;
  gap: 7px;
  margin-top: 12px;
}

body.menu-polish .menu-footer .icon-button {
  min-width: 0;
}

body.menu-polish #soundToggle {
  width: 42px;
  padding-inline: 0;
  font-size: 16px;
  text-align: center;
}

body.menu-polish .settings-card {
  overflow-y: auto;
}

body.menu-polish .settings-essentials {
  display: grid;
  gap: 9px;
  margin: 7px 0 16px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.055);
}

body.menu-polish .settings-essentials-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

body.menu-polish .settings-essentials-head strong {
  color: var(--yellow);
  font-size: 0.7rem;
  letter-spacing: 0.09em;
}

body.menu-polish .settings-essentials-head small {
  color: rgba(255, 255, 255, 0.45);
  font-size: 0.52rem;
  text-align: right;
}

body.menu-polish .settings-essentials .audio-panel {
  display: grid !important;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

body.menu-polish .settings-essentials #quality {
  width: 100%;
  min-height: 38px;
}

/* reward-reveal: затемнение → медаль → результат → детали. */
.motion-result-reveal #medal {
  animation: motion-reward-reveal 420ms cubic-bezier(0.18, 0.9, 0.3, 1.25) 40ms both !important;
}

.motion-result-reveal #finishEyebrow,
.motion-result-reveal #finishTitle {
  animation: motion-result-line 180ms ease-out 145ms both;
}

.motion-result-reveal #finishTime,
.motion-result-reveal #unrankedNote,
.motion-result-reveal #finishStats {
  animation: motion-result-line 180ms ease-out 235ms both;
}

.motion-result-reveal #finishHighlights,
.motion-result-reveal #board,
.motion-result-reveal #again,
.motion-result-reveal #newCourse,
.motion-result-reveal #nextChapter,
.motion-result-reveal #rematch,
.motion-result-reveal #returnLobby,
.motion-result-reveal #resultsTimer,
.motion-result-reveal .back {
  animation: motion-result-line 180ms ease-out 320ms both;
}

#finish:not(.hidden) {
  background: rgba(27, 15, 73, 0.1);
  animation: motion-result-dim 140ms ease-out both;
}

.motion-button-confirm {
  animation: motion-button-confirm 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2) !important;
}

@keyframes motion-result-dim {
  from {
    background: rgba(27, 15, 73, 0);
  }
  to {
    background: rgba(27, 15, 73, 0.1);
  }
}

@keyframes motion-reward-reveal {
  0% {
    opacity: 0;
    transform: translateY(-22px) rotate(-12deg) scale(0.55);
  }
  70% {
    opacity: 1;
    transform: translateY(2px) rotate(2deg) scale(1.06);
  }
  100% {
    opacity: 1;
    transform: none;
  }
}

@keyframes motion-result-line {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes motion-button-confirm {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(0.96);
  }
  72% {
    transform: scale(1.025);
  }
  100% {
    transform: scale(1);
  }
}

@media (max-width: 620px) {
  body.menu-polish .screen-menu {
    padding-inline: calc(16px + var(--safe-right)) calc(16px + var(--safe-left));
  }

  body.menu-polish .campaign-grid {
    gap: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  body.menu-polish .campaign-card {
    transition: none;
  }
}

body.reduced-motion.menu-polish .campaign-card {
  transition: none;
}
`;

function prefersReducedMotion(ui = null) {
  if (ui?.settings) return Boolean(ui.settings.reducedMotion);
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function animate(node, keyframes, options, ui = null) {
  if (!node || prefersReducedMotion(ui) || typeof node.animate !== 'function') return null;
  try {
    return node.animate(keyframes, { fill: 'both', ...options });
  } catch {
    return null;
  }
}

function animateCardEnter(node, ui, delay = 0) {
  return animate(
    node,
    [
      { opacity: 0, transform: 'translateY(9px) scale(.94)' },
      { opacity: 1, transform: 'translateY(-1px) scale(1.012)', offset: 0.72 },
      { opacity: 1, transform: 'none' }
    ],
    { duration: MOTION.cardEnter, delay, easing: 'cubic-bezier(.18,.88,.28,1.15)' },
    ui
  );
}

function installStyles() {
  if ($('#menuPolishStyles')) return;
  const style = document.createElement('style');
  style.id = 'menuPolishStyles';
  style.textContent = STYLE;
  document.head.append(style);
  document.body.classList.add('menu-polish');
}

function makeDisclosure({ panel, primary, controls, id, label }) {
  if (!panel || !primary || $(`#${id}`)) return null;
  const drawer = document.createElement('div');
  drawer.id = `${id}Panel`;
  drawer.className = 'private-room-panel hidden';
  for (const control of controls.filter(Boolean)) drawer.append(control);

  const toggle = document.createElement('button');
  toggle.id = id;
  toggle.type = 'button';
  toggle.className = 'menu-disclosure';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', drawer.id);

  const setOpen = open => {
    drawer.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = `${label} ${open ? '⌄' : '›'}`;
    if (open) animateCardEnter(drawer, globalThis.__WOBBLE_GAME__?.ui || null);
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  primary.addEventListener('click', () => setOpen(false));
  setOpen(false);
  primary.after(toggle, drawer);
  return { toggle, drawer, setOpen };
}

function simplifyMarkup() {
  const multi = $('#multi');
  const coop = $('#coop');
  makeDisclosure({
    panel: multi,
    primary: $('#raceFind'),
    controls: [$('#create'), multi?.querySelector('.join-row')],
    id: 'raceFriendsToggle',
    label: 'ИГРАТЬ С ДРУЗЬЯМИ'
  });
  makeDisclosure({
    panel: coop,
    primary: $('#coopFind'),
    controls: [$('#coopCreate'), coop?.querySelector('.join-row')],
    id: 'coopFriendsToggle',
    label: 'ИГРАТЬ С ДРУЗЬЯМИ'
  });

  $('#coopChapter')?.closest('label')?.classList.add('legacy-chapter-picker');

  const settingsCard = $('#settings .settings-card');
  const audio = $('.audio-panel');
  const quality = $('#quality');
  if (settingsCard && audio && !$('#settingsEssentials')) {
    const section = document.createElement('section');
    section.id = 'settingsEssentials';
    section.className = 'settings-essentials';
    section.innerHTML = `
      <div class="settings-essentials-head">
        <strong>ЗВУК И ГРАФИКА</strong><small>То, что не нужно держать на экране старта</small>
      </div>`;
    section.append(audio);
    if (quality) section.append(quality);
    settingsCard.insertBefore(section, $('#settingsBody'));
  }

  const settingsScreen = $('#settings');
  settingsScreen?.querySelector('.settings-card')?.setAttribute('aria-label', 'Настройки');
  const settingsEyebrow = settingsScreen?.querySelector('.eyebrow');
  if (settingsEyebrow) settingsEyebrow.textContent = 'НАСТРОЙКИ';

  const settingsButton = $('#openSettings');
  if (settingsButton) {
    settingsButton.textContent = 'НАСТРОЙКИ';
    settingsButton.setAttribute('aria-label', 'Открыть настройки');
  }

  const footer = $('.menu-footer');
  if (footer && !$('#soundToggle')) {
    const sound = document.createElement('button');
    sound.id = 'soundToggle';
    sound.type = 'button';
    sound.className = 'icon-button';
    sound.textContent = '🔊';
    sound.setAttribute('aria-label', 'Выключить звук');
    sound.setAttribute('aria-pressed', 'false');
    footer.insertBefore(sound, settingsButton || footer.firstChild);
  }

  if ($('#connectStatus')) {
    $('#connectStatus').textContent = 'Быстрый подбор соберёт соперников автоматически.';
  }
  if ($('#coopStatus')) {
    $('#coopStatus').textContent = 'Выберите главу — напарника найдём автоматически.';
  }
}

function syncModeTabs(mode) {
  document.querySelectorAll('.mode-tab').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function installModeMotion(ui) {
  if (ui.__menuPolishModeMotion) return;
  ui.__menuPolishModeMotion = true;
  const original = ui.selectMode.bind(ui);
  let token = 0;
  let exitAnimation = null;
  let enterAnimation = null;

  ui.selectMode = mode => {
    const target = $(`#${mode}`);
    const currentId = MODE_ORDER.find(id => !$(`#${id}`)?.classList.contains('hidden'));
    const current = currentId ? $(`#${currentId}`) : null;
    if (!target || current === target || prefersReducedMotion(ui) || typeof target.animate !== 'function') {
      token++;
      exitAnimation?.cancel();
      enterAnimation?.cancel();
      exitAnimation = null;
      enterAnimation = null;
      MODE_ORDER.forEach(id => {
        const panel = $(`#${id}`);
        if (panel) panel.style.pointerEvents = '';
      });
      original(mode);
      return;
    }

    const direction = Math.sign(MODE_ORDER.indexOf(mode) - MODE_ORDER.indexOf(currentId)) || 1;
    const mine = ++token;
    exitAnimation?.cancel();
    enterAnimation?.cancel();
    ui.mode = mode;
    syncModeTabs(mode);
    current.style.pointerEvents = 'none';

    exitAnimation = animate(
      current,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: `translateX(${-14 * direction}px) scale(.985)` }
      ],
      { duration: MOTION.screenExit, easing: 'cubic-bezier(.4,0,1,1)' },
      ui
    );

    Promise.resolve(exitAnimation?.finished || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (mine !== token) return;
        exitAnimation?.cancel();
        exitAnimation = null;
        current.classList.add('hidden');
        current.style.pointerEvents = '';
        target.classList.remove('hidden');
        target.style.pointerEvents = 'none';
        enterAnimation = animate(
          target,
          [
            { opacity: 0, transform: `translateX(${18 * direction}px) scale(.985)` },
            {
              opacity: 1,
              transform: `translateX(${-2 * direction}px) scale(1.006)`,
              offset: 0.72
            },
            { opacity: 1, transform: 'none' }
          ],
          { duration: MOTION.screenEnter, easing: 'cubic-bezier(.16,.9,.28,1.14)' },
          ui
        );
        Promise.resolve(enterAnimation?.finished || Promise.resolve())
          .catch(() => {})
          .then(() => {
            if (mine !== token) return;
            enterAnimation?.cancel();
            enterAnimation = null;
            target.style.pointerEvents = '';
            if (mode === 'coop') animateCampaignCards(ui);
          });
      });
  };
}

function installScreenMotion(ui) {
  if (ui.__menuPolishScreenMotion) return;
  ui.__menuPolishScreenMotion = true;
  const original = ui.show.bind(ui);
  ui.show = id => {
    original(id);
    if (!id || prefersReducedMotion(ui)) return;
    requestAnimationFrame(() => {
      if (id === 'lobby') {
        animateCardEnter($('#lobby .lobby-card'), ui);
        return;
      }
      if (id === 'menu') {
        const animation = animate(
          $('#menu .menu-card'),
          [
            { opacity: 0, transform: 'translateX(-14px) scale(.99)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: MOTION.screenEnter, easing: 'cubic-bezier(.16,.9,.28,1.1)' },
          ui
        );
        Promise.resolve(animation?.finished || Promise.resolve())
          .catch(() => {})
          .then(() => animation?.cancel());
        return;
      }
      if (id !== 'finish') return;
      const card = $('#finish .finish-card');
      animateCardEnter(card, ui);
      if (!card) return;
      card.classList.remove('motion-result-reveal');
      void card.offsetWidth;
      card.classList.add('motion-result-reveal');
    });
  };
}

function animateCampaignCards(ui) {
  if (ui.__campaignCardsEntered || prefersReducedMotion(ui)) return;
  const cards = [...document.querySelectorAll('#coopCampaign .campaign-card')];
  if (!cards.length) return;
  ui.__campaignCardsEntered = true;
  cards.forEach((card, index) => animateCardEnter(card, ui, Math.min(150, index * 18)));
}

function installButtonMotion(ui) {
  if (document.body.dataset.buttonMotionBound === '1') return;
  document.body.dataset.buttonMotionBound = '1';
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.button-primary');
    if (!button || button.disabled || prefersReducedMotion(ui)) return;
    button.classList.remove('motion-button-confirm');
    void button.offsetWidth;
    button.classList.add('motion-button-confirm');
    setTimeout(() => button.classList.remove('motion-button-confirm'), MOTION.buttonConfirm + 30);
  });

  const unlock = $('#unlockToast');
  if (!unlock) return;
  new MutationObserver(() => {
    if (unlock.classList.contains('hidden')) return;
    animate(
      unlock,
      [
        { opacity: 0, transform: 'translateY(16px) scale(.84)' },
        { opacity: 1, transform: 'translateY(-2px) scale(1.04)', offset: 0.72 },
        { opacity: 1, transform: 'none' }
      ],
      { duration: MOTION.rewardReveal, easing: 'cubic-bezier(.18,.9,.3,1.2)' },
      ui
    );
  }).observe(unlock, { attributes: true, attributeFilter: ['class'] });
}

function selectedChapterIndex(ui, id) {
  const index = (ui.coopChapters || []).findIndex(chapter => chapter.id === id);
  return index >= 0 ? index + 1 : 1;
}

function installChapterCards(game) {
  const ui = game.ui;
  const select = $('#coopChapter');
  const grid = $('#coopCampaign');
  if (!select || !grid || !ui.coopChapters?.length || ui.__chapterCardsOwnSelection) return false;
  ui.__chapterCardsOwnSelection = true;

  let selectedId = select.value || ui.coopChapters[0].id;
  select.closest('label')?.remove();

  const syncCta = () => {
    const button = $('#coopFind');
    const span = button?.querySelector('span');
    if (!button || !span || button.dataset.searching === 'true') return;
    const desired = $('#coopAnyChapter')?.checked
      ? 'НАЙТИ НАПАРНИКА'
      : `ИГРАТЬ ГЛАВУ ${selectedChapterIndex(ui, selectedId)}`;
    if (span.textContent !== desired) span.textContent = desired;
  };

  const apply = id => {
    const chapter = ui.coopChapters.find(item => item.id === id) || ui.coopChapters[0];
    selectedId = chapter.id;
    game.coopChapterId = chapter.id;
    $('#coopHint').textContent = chapter.hint;
    ui.coopProfile(chapter.id);
    document.querySelectorAll('#coopCampaign .campaign-card').forEach(card => {
      const active = card.dataset.chapter === chapter.id;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-pressed', String(active));
    });
    syncCta();
  };

  ui.coopChapter = () => selectedId;
  ui.selectCoopChapter = id => apply(id);

  // Старые карточки всё ещё содержат обработчик legacy-select. Capture перехватывает клик раньше,
  // поэтому после удаления select единственным пользовательским выбором действительно является card.
  grid.addEventListener(
    'click',
    event => {
      const card = event.target.closest?.('.campaign-card');
      if (!card || !grid.contains(card)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      apply(card.dataset.chapter);
    },
    true
  );

  new MutationObserver(() => {
    document.querySelectorAll('#coopCampaign .campaign-card').forEach(card => {
      const active = card.dataset.chapter === selectedId;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-pressed', String(active));
    });
  }).observe(grid, { childList: true });

  $('#coopAnyChapter')?.addEventListener('change', syncCta);
  const button = $('#coopFind');
  if (button) {
    new MutationObserver(syncCta).observe(button, {
      attributes: true,
      attributeFilter: ['data-searching']
    });
  }

  // Replay из профиля раньше напрямую писал в удалённый select. Оставляем тот же createRoom,
  // но источник выбора теперь тот же, что и у обычного клика по campaign card.
  ui.onRecentPartnerInvite = async partner => {
    await game.accountReady;
    const chapter = ui.coopChapters.find(item => item.id === partner?.lastChapterId) || ui.coopChapters[0];
    apply(chapter.id);
    ui.selectMode('coop');
    ui.toggleProfileScreen?.(false);
    game.pendingReplayShare = { partnerName: partner?.name || 'напарника' };
    const net = game.ensureNetwork();
    net.createRoom({
      name: ui.coopName(),
      playerId: ui.playerId(),
      mode: GAME_MODE.COOP,
      difficulty: chapter.id
    });
  };

  apply(selectedId);
  return true;
}

function installSoundToggle(game) {
  const button = $('#soundToggle');
  if (!button || button.dataset.bound === '1') return;
  button.dataset.bound = '1';

  let lastAudibleMaster = Number(game.audio.volumes.master || 0);
  if (lastAudibleMaster <= 0) lastAudibleMaster = 0.8;

  const sync = () => {
    const master = Number(game.audio.volumes.master || 0);
    if (master > 0) lastAudibleMaster = master;
    const silent = game.audio.muted || master <= 0;
    button.textContent = silent ? '🔇' : '🔊';
    button.setAttribute('aria-pressed', String(silent));
    button.setAttribute('aria-label', silent ? 'Включить звук' : 'Выключить звук');
    button.title = silent ? 'Включить звук' : 'Выключить звук';
  };

  button.addEventListener('click', () => {
    game.audio.unlock();
    const master = Number(game.audio.volumes.master || 0);
    const silent = game.audio.muted || master <= 0;
    if (silent) {
      if (master <= 0) {
        game.audio.setVolume('master', lastAudibleMaster);
        const slider = $('#vol-master');
        if (slider) slider.value = String(lastAudibleMaster);
      }
      game.audio.setMuted(false);
    } else {
      game.audio.setMuted(true);
    }
    sync();
  });
  $('#vol-master')?.addEventListener('input', sync);
  sync();
}

function attachGame(game) {
  if (!game?.ui || game.ui.__menuPolishInstalled) return;
  game.ui.__menuPolishInstalled = true;
  installModeMotion(game.ui);
  installScreenMotion(game.ui);
  installButtonMotion(game.ui);
  installSoundToggle(game);
  installChapterCards(game);
}

function waitForGame() {
  let frames = 0;
  const tick = () => {
    const game = globalThis.__WOBBLE_GAME__;
    // bindMenu должен успеть заполнить список глав до удаления legacy-select.
    if (game?.ui?.coopChapters?.length) {
      attachGame(game);
      return;
    }
    if (frames++ < 1200) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function installMenuPolish() {
  if (document.body.dataset.menuPolish === '1') return;
  document.body.dataset.menuPolish = '1';
  installStyles();
  simplifyMarkup();
  waitForGame();
}
