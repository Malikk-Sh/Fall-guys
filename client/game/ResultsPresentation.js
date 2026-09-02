import { formatTime } from '../core/Config.js';
import { cosmeticLoadoutFromIds } from '../core/cosmetics.js';

const STYLESHEET_ID = 'resultsUxStylesheet';
const PRESENTATION_CLASS = 'results-presentation-enabled';
const READY_CLASS = 'results-ready';
const CARD_CLASS = 'results-show-card';
const RESULT_ACTION_IDS = ['again', 'newCourse', 'nextChapter', 'rematch', 'returnLobby'];
const PHASE_CLASSES = Object.freeze([
  CARD_CLASS,
  'results-show-time',
  'results-show-stats',
  'results-show-highlights',
  'results-show-actions'
]);
const VICTORY_POSE_MS = 820;
export const VICTORY_CELEBRATIONS = Object.freeze(['wave', 'jump', 'spin', 'tiny-dance']);
const EMPTY_VICTORY_CHANNELS = Object.freeze({
  leftArmX: 0,
  leftArmZ: 0,
  rightArmX: 0,
  rightArmZ: 0,
  leftLegX: 0,
  rightLegX: 0,
  visualY: 0,
  visualYaw: 0,
  visualTiltZ: 0,
  headY: 0,
  faceY: 0
});

export function resultsRevealPlan(reducedMotion = false) {
  return reducedMotion
    ? { card: 0, time: 0, stats: 16, highlights: 32, actions: 48, complete: 48 }
    : { card: 620, time: 700, stats: 800, highlights: 930, actions: 1080, complete: 1080 };
}

export function isResultsSkipKey(code) {
  return code === 'Enter' || code === 'Space' || code === 'NumpadEnter';
}

export function primaryResultAction(mode, visible = {}) {
  if (mode === 'coop' && visible.nextChapter) return 'nextChapter';
  if (mode === 'multi' && visible.rematch) return 'rematch';
  if (mode === 'single' && visible.again) return 'again';
  return RESULT_ACTION_IDS.find(id => visible[id]) || null;
}

export function racePodiumEntries(board = [], roster = [], selfId = null) {
  if (!Array.isArray(board)) return [];
  const rosterById = new Map(
    (Array.isArray(roster) ? roster : []).filter(player => player?.id).map(player => [player.id, player])
  );
  return board.slice(0, 3).map((player, index) => {
    const member = player?.id ? rosterById.get(player.id) : null;
    return {
      place: index + 1,
      id: player?.id || null,
      name: player?.name || member?.name || 'Wobbler',
      time: Number.isFinite(player?.time) ? player.time : null,
      color: Number.isFinite(member?.color)
        ? member.color
        : Number.isFinite(player?.color)
          ? player.color
          : 0xff4f91,
      bot: Boolean(player?.bot || member?.bot),
      self: Boolean(player?.id && player.id === selfId),
      loadout: member?.loadout || player?.loadout || null
    };
  });
}

export function racePodiumSkin(loadout, fallbackColor = 0xff4f91) {
  const resolved = cosmeticLoadoutFromIds(loadout);
  const body = resolved.body;
  const visor = resolved.visor;
  const antenna = resolved.antenna;
  const bodyColor = body?.colors?.body ?? body?.render?.primary ?? fallbackColor;
  const accentColor = body?.colors?.accent ?? body?.render?.accent ?? 0xffde59;
  const visorColor = visor?.color ?? visor?.render?.primary;
  const antennaColor = antenna?.color ?? antenna?.render?.primary;
  return {
    body: Number.isFinite(bodyColor) ? bodyColor : fallbackColor,
    accent: Number.isFinite(accentColor) ? accentColor : 0xffde59,
    visor: Number.isFinite(visorColor) ? visorColor : 0xdffcff,
    antenna: Number.isFinite(antennaColor) ? antennaColor : accentColor,
    bodyId: body?.id || 'classic',
    visorId: visor?.id || 'none',
    antennaId: antenna?.id || 'none'
  };
}

export function validResultsRevealPlan(plan) {
  if (!plan) return false;
  const values = [plan.card, plan.time, plan.stats, plan.highlights, plan.actions, plan.complete];
  const finite = values.every(Number.isFinite);
  const ordered = values.every((value, index) => index === 0 || value >= values[index - 1]);
  return finite && ordered;
}

// Finish cosmetic задаёт стиль празднования стабильно, чтобы выбранный образ ощущался частью
// результата. Без finish-предмета берётся один из четырёх базовых жестов — случайность происходит
// ровно один раз при открытии results и не попадает ни в gameplay, ни в network state.
export function victoryCelebrationKind(finishId = null, randomValue = Math.random()) {
  if (typeof finishId === 'string' && finishId) {
    let hash = 0;
    for (let index = 0; index < finishId.length; index++) hash = (hash * 31 + finishId.charCodeAt(index)) >>> 0;
    return VICTORY_CELEBRATIONS[hash % VICTORY_CELEBRATIONS.length];
  }
  const value = Number.isFinite(randomValue) ? Math.max(0, Math.min(0.999_999, randomValue)) : 0;
  return VICTORY_CELEBRATIONS[Math.floor(value * VICTORY_CELEBRATIONS.length)];
}

// Pure presentation pose. `out` переиспользуется RAF-циклом, поэтому новых объектов на кадр нет.
// Все каналы относятся к `Character.visual` и его существующим anchors/limbs; root transform,
// PlayerDimensions и физика здесь принципиально недоступны.
export function victoryCelebrationPose(kind, progress, out = {}) {
  Object.assign(out, EMPTY_VICTORY_CHANNELS);
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  const envelope = Math.sin(t * Math.PI);

  switch (kind) {
    case 'jump': {
      out.visualY = Math.sin(t * Math.PI) * 0.24;
      out.leftArmZ = 0.78 * envelope;
      out.rightArmZ = -0.78 * envelope;
      out.leftLegX = 0.22 * Math.sin(t * Math.PI * 2) * envelope;
      out.rightLegX = -out.leftLegX;
      out.headY = -0.08 * envelope;
      out.faceY = -0.05 * envelope;
      break;
    }
    case 'spin': {
      const turn = t * t * (3 - 2 * t);
      out.visualYaw = turn * Math.PI * 2;
      out.leftArmZ = 0.7 * envelope;
      out.rightArmZ = -0.7 * envelope;
      out.visualY = Math.sin(t * Math.PI) * 0.06;
      break;
    }
    case 'tiny-dance': {
      const beat = Math.sin(t * Math.PI * 5);
      out.leftArmX = (-0.72 + beat * 0.42) * envelope;
      out.rightArmX = (-0.72 - beat * 0.42) * envelope;
      out.leftLegX = beat * 0.26 * envelope;
      out.rightLegX = -beat * 0.26 * envelope;
      out.visualY = Math.abs(beat) * 0.08 * envelope;
      out.visualTiltZ = beat * 0.16 * envelope;
      out.headY = beat * 0.08 * envelope;
      out.faceY = beat * 0.05 * envelope;
      break;
    }
    case 'wave':
    default: {
      const wave = Math.sin(t * Math.PI * 6) * envelope;
      out.leftArmZ = 0.52 * envelope;
      out.rightArmZ = -1.06 * envelope;
      out.rightArmX = wave * 0.24;
      out.headY = -0.18 * envelope;
      out.faceY = -0.12 * envelope;
      break;
    }
  }
  return out;
}

// Причина «без зачёта» на карточке гонки: СВОЯ, а не комнатная.
//
// Причины делятся на два сорта, и путать их нельзя. Комнатные — напарник вышел, связь оборвалась,
// комнату добрали ботами — приходят отдельным сообщением и относятся ко всем сразу; они и живут в
// сессии. Проверка движения личная: сервер записывает строку в таблицу каждому проверенному игроку
// отдельно, поэтому общая плашка означала бы, что человеку, чей рекорд записан, сообщают обратное.
//
// Берётся признак проверки, а не имя сработавшего сигнала: `segment-too-fast` и прочие — материал
// для журнала, а плашке нужна одна понятная строка, и она у неё уже есть.
//
// Порядок именно такой: комнатная причина старше. Если забег и так не в зачёте из-за обрыва, то
// сообщать о непройденной проверке — значит назвать вторую причину вместо первой.
export function raceUnrankedReason(sessionUnranked = null, ownEntry = null) {
  if (sessionUnranked) return sessionUnranked;
  return ownEntry?.verified === false ? 'verification' : null;
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  // Адрес считается от САМОГО МОДУЛЯ, а не от корня: абсолютный путь ломается и на подпути
  // площадки, и на глубоком маршруте нашего SPA. См. tools/buildPortal.mjs.
  link.href = new URL('../results-ux.css', import.meta.url).href;
  root.head.append(link);
}

function visibleResultActions(root) {
  return Object.fromEntries(
    RESULT_ACTION_IDS.map(id => {
      const node = root?.getElementById?.(id);
      return [id, Boolean(node && !node.classList.contains('hidden'))];
    })
  );
}

function cssColor(value, fallback = 0xff4f91) {
  return `#${Number(Number.isFinite(value) ? value : fallback)
    .toString(16)
    .padStart(6, '0')
    .slice(-6)}`;
}

export class ResultsPresentation {
  constructor({
    windowRef = globalThis,
    root = globalThis.document,
    getGame = () => globalThis.__WOBBLE_GAME__
  } = {}) {
    this.window = windowRef;
    this.root = root;
    this.getGame = getGame;
    this.finish = null;
    this.observer = null;
    this.boardObserver = null;
    this.timers = [];
    this.visible = false;
    this.presenting = false;
    this.poseFrame = 0;
    this.pose = null;
    this.onClick = event => this.handleClick(event);
    this.onKeyDown = event => this.handleKeyDown(event);
  }

  init() {
    if (!this.root?.body) return this;
    installStylesheet(this.root);
    this.root.body.classList.add(PRESENTATION_CLASS);
    this.finish = this.root.getElementById('finish');
    if (!this.finish) return this;

    this.ensureLayout();
    this.finish.addEventListener('click', this.onClick, true);
    this.window?.addEventListener?.('keydown', this.onKeyDown, true);
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => this.sync());
      this.observer.observe(this.finish, { attributes: true, attributeFilter: ['class'] });
      const board = this.root.getElementById('board');
      if (board) {
        this.boardObserver = new Observer(() => this.renderPodium());
        this.boardObserver.observe(board, { childList: true });
      }
    }
    this.sync();
    return this;
  }

  destroy() {
    this.cancelTimers();
    this.stopVictoryPose();
    this.observer?.disconnect?.();
    this.boardObserver?.disconnect?.();
    this.observer = null;
    this.boardObserver = null;
    this.finish?.removeEventListener?.('click', this.onClick, true);
    this.window?.removeEventListener?.('keydown', this.onKeyDown, true);
    this.finish?.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish?.removeAttribute?.('data-results-state');
    this.root?.body?.classList.remove(PRESENTATION_CLASS);
    this.presenting = false;
    this.visible = false;
  }

  ensureLayout() {
    const card = this.finish?.querySelector?.('.finish-card');
    if (!card) return;

    let scroll = this.root.getElementById('resultsScroll');
    if (!scroll) {
      scroll = this.root.createElement('div');
      scroll.id = 'resultsScroll';
      scroll.className = 'results-scroll';
      const highlights = this.root.getElementById('finishHighlights');
      if (highlights) card.insertBefore(scroll, highlights);
      if (highlights) scroll.append(highlights);
      const board = this.root.getElementById('board');
      if (board) scroll.append(board);
    }

    if (!this.root.getElementById('racePodium')) {
      const podium = this.root.createElement('section');
      podium.id = 'racePodium';
      podium.className = 'results-podium hidden';
      podium.setAttribute('aria-label', 'Первые три места');
      scroll.prepend(podium);
    }

    if (!this.root.getElementById('resultsActions')) {
      const first = this.root.getElementById(RESULT_ACTION_IDS[0]);
      if (!first) return;
      const actions = this.root.createElement('div');
      actions.id = 'resultsActions';
      actions.className = 'results-actions';
      card.insertBefore(actions, first);
      for (const id of RESULT_ACTION_IDS) {
        const button = this.root.getElementById(id);
        if (button) actions.append(button);
      }
      const timer = this.root.getElementById('resultsTimer');
      const back = card.querySelector('.text-button.back');
      if (timer) actions.append(timer);
      if (back) actions.append(back);
    }
  }

  sync() {
    if (!this.finish) return;
    const visible = !this.finish.classList.contains('hidden');
    if (visible && !this.visible) this.start();
    else if (!visible && this.visible) this.reset();
    this.visible = visible;
  }

  start() {
    this.cancelTimers();
    this.stopVictoryPose();
    this.ensureLayout();
    this.renderPodium();
    this.refreshActionHierarchy();
    this.presenting = true;
    this.finish.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish.dataset.resultsState = 'presenting';

    const game = this.getGame?.();
    const reducedMotion = Boolean(game?.settings?.reducedMotion);
    const plan = resultsRevealPlan(reducedMotion);
    this.presentFinishMoment(game, reducedMotion);
    this.schedule(CARD_CLASS, plan.card);
    this.schedule('results-show-time', plan.time);
    this.schedule('results-show-stats', plan.stats);
    this.schedule('results-show-highlights', plan.highlights);
    this.schedule('results-show-actions', plan.actions);
    this.timers.push(this.window.setTimeout(() => this.complete(false), plan.complete));
  }

  renderPodium() {
    const podium = this.root?.getElementById?.('racePodium');
    if (!podium) return;
    const game = this.getGame?.();
    const entries =
      game?.mode === 'multi' ? racePodiumEntries(game.latestBoard, game.room?.players, game.net?.id) : [];
    podium.replaceChildren();
    podium.classList.toggle('hidden', entries.length === 0);
    if (!entries.length) return;

    const label = this.root.createElement('strong');
    label.className = 'results-podium-label';
    label.textContent = 'ПОДИУМ';
    const stage = this.root.createElement('div');
    stage.className = 'results-podium-stage';

    for (const entry of entries) {
      const skin = racePodiumSkin(entry.loadout, entry.color);
      const slot = this.root.createElement('article');
      slot.className = `results-podium-slot results-podium-place-${entry.place}`;
      slot.classList.toggle('results-podium-self', entry.self);
      if (entry.id) slot.dataset.playerId = entry.id;

      const rank = this.root.createElement('b');
      rank.className = 'results-podium-rank';
      rank.textContent = entry.place === 1 ? '♛' : String(entry.place);

      const avatar = this.root.createElement('i');
      avatar.className = 'results-podium-wobbler';
      avatar.style.setProperty('--podium-body', cssColor(skin.body));
      avatar.style.setProperty('--podium-accent', cssColor(skin.accent, 0xffde59));
      avatar.style.setProperty('--podium-visor', cssColor(skin.visor, 0xdffcff));
      avatar.style.setProperty('--podium-antenna', cssColor(skin.antenna, skin.accent));
      avatar.dataset.cosmeticBody = skin.bodyId;
      avatar.dataset.cosmeticVisor = skin.visorId;
      avatar.dataset.cosmeticAntenna = skin.antennaId;
      avatar.setAttribute('aria-hidden', 'true');

      const name = this.root.createElement('span');
      name.className = 'results-podium-name';
      name.textContent = `${entry.name}${entry.self ? ' (вы)' : ''}`;
      if (entry.bot) {
        const bot = this.root.createElement('b');
        bot.className = 'bot-badge';
        bot.textContent = 'БОТ';
        bot.title = 'Соперник под управлением компьютера';
        name.append(bot);
      }

      const time = this.root.createElement('small');
      time.className = 'results-podium-time';
      time.textContent = Number.isFinite(entry.time) ? formatTime(entry.time) : '—';

      slot.append(rank, avatar, name, time);
      stage.append(slot);
    }

    podium.append(label, stage);
  }

  presentFinishMoment(game, reducedMotion) {
    if (!game) return;
    // Multiplayer/co-op cosmetics are already fired from receiveFinish after the authoritative server
    // event. Single-player has no server finish message, so its cosmetic is started here after the
    // local RaceSession has already fixed the result and switched to RESULTS.
    if (game.mode === 'single') game.player?.character?.cosmetics?.playFinish?.();
    game.settings?.vibrate?.(0.56);
    if (reducedMotion) return;
    game.cameraController?.addImpulse?.({ pitch: -0.018, fov: 1.1, shake: 0.025, duration: 0.18 });
    this.startVictoryPose(game.player);
  }

  schedule(className, delay) {
    this.timers.push(
      this.window.setTimeout(() => {
        if (!this.presenting || !this.visible) return;
        this.finish.classList.add(className);
      }, delay)
    );
  }

  handleClick(event) {
    if (!this.presenting || !this.visible) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.complete(true);
  }

  handleKeyDown(event) {
    if (!this.presenting || !this.visible || !isResultsSkipKey(event.code)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.complete(true);
  }

  complete(skipped = false) {
    if (!this.finish || !this.presenting) return false;
    this.cancelTimers();
    this.stopVictoryPose();
    this.presenting = false;
    this.finish.classList.add(READY_CLASS, ...PHASE_CLASSES);
    this.finish.dataset.resultsState = skipped ? 'skipped' : 'ready';
    this.refreshActionHierarchy();
    return true;
  }

  refreshActionHierarchy() {
    const visible = visibleResultActions(this.root);
    const primary = primaryResultAction(this.getGame?.()?.mode, visible);
    for (const id of RESULT_ACTION_IDS) {
      const button = this.root?.getElementById?.(id);
      if (!button) continue;
      button.classList.toggle('results-primary', id === primary);
      button.classList.toggle('results-secondary', visible[id] && id !== primary && id !== 'returnLobby');
      button.classList.toggle('results-tertiary', visible[id] && id !== primary && id === 'returnLobby');
    }
  }

  startVictoryPose(actor) {
    const character = actor?.character;
    if (!character) return;
    const finishId = character.cosmetics?.loadout?.finish?.id || null;
    this.pose = {
      actor,
      kind: victoryCelebrationKind(finishId),
      startedAt: this.window.performance?.now?.() || 0,
      channels: { ...EMPTY_VICTORY_CHANNELS },
      leftArmX: character.leftArm.rotation.x,
      leftArmZ: character.leftArm.rotation.z,
      rightArmX: character.rightArm.rotation.x,
      rightArmZ: character.rightArm.rotation.z,
      leftLegX: character.leftLeg.rotation.x,
      rightLegX: character.rightLeg.rotation.x,
      visualY: character.visual.position.y,
      visualYaw: character.visual.rotation.y,
      visualTiltZ: character.visual.rotation.z,
      headY: character.headAnchor.rotation.y,
      faceY: character.faceAnchor.rotation.y
    };
    const tick = now => {
      if (!this.pose || !this.presenting) return;
      const progress = Math.max(0, Math.min(1, (now - this.pose.startedAt) / VICTORY_POSE_MS));
      const channels = victoryCelebrationPose(this.pose.kind, progress, this.pose.channels);
      character.leftArm.rotation.x = this.pose.leftArmX + channels.leftArmX;
      character.leftArm.rotation.z = this.pose.leftArmZ + channels.leftArmZ;
      character.rightArm.rotation.x = this.pose.rightArmX + channels.rightArmX;
      character.rightArm.rotation.z = this.pose.rightArmZ + channels.rightArmZ;
      character.leftLeg.rotation.x = this.pose.leftLegX + channels.leftLegX;
      character.rightLeg.rotation.x = this.pose.rightLegX + channels.rightLegX;
      character.visual.position.y = this.pose.visualY + channels.visualY;
      character.visual.rotation.y = this.pose.visualYaw + channels.visualYaw;
      character.visual.rotation.z = this.pose.visualTiltZ + channels.visualTiltZ;
      character.headAnchor.rotation.y = this.pose.headY + channels.headY;
      character.faceAnchor.rotation.y = this.pose.faceY + channels.faceY;
      if (progress >= 1) return this.stopVictoryPose();
      this.poseFrame = this.window.requestAnimationFrame?.(tick) || 0;
    };
    this.poseFrame = this.window.requestAnimationFrame?.(tick) || 0;
  }

  stopVictoryPose() {
    if (this.poseFrame) this.window?.cancelAnimationFrame?.(this.poseFrame);
    this.poseFrame = 0;
    const character = this.pose?.actor?.character;
    if (character) {
      character.leftArm.rotation.x = this.pose.leftArmX;
      character.leftArm.rotation.z = this.pose.leftArmZ;
      character.rightArm.rotation.x = this.pose.rightArmX;
      character.rightArm.rotation.z = this.pose.rightArmZ;
      character.leftLeg.rotation.x = this.pose.leftLegX;
      character.rightLeg.rotation.x = this.pose.rightLegX;
      character.visual.position.y = this.pose.visualY;
      character.visual.rotation.y = this.pose.visualYaw;
      character.visual.rotation.z = this.pose.visualTiltZ;
      character.headAnchor.rotation.y = this.pose.headY;
      character.faceAnchor.rotation.y = this.pose.faceY;
    }
    this.pose = null;
  }

  reset() {
    this.cancelTimers();
    this.stopVictoryPose();
    this.presenting = false;
    this.finish?.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish?.removeAttribute?.('data-results-state');
  }

  cancelTimers() {
    for (const timer of this.timers) this.window?.clearTimeout?.(timer);
    this.timers.length = 0;
  }
}

export function installResultsPresentation(options = {}) {
  const presentation = new ResultsPresentation(options);
  presentation.init();
  return presentation;
}
