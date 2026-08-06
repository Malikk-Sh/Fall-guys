import {
  DIFFICULTIES,
  courseName,
  evaluateCourseObjectives,
  formatGap,
  formatTime,
  ordinal
} from '../core/Config.js';
import { coopKey, readBest, saveBest, soloKey } from '../core/records.js';
import { buildInviteLink, readInvite } from '../core/invite.js';
import {
  readProfile,
  recordCoopProfile,
  recordSoloProfile,
  playerId as readPlayerId
} from '../core/profile.js';
import { GAME_MODE } from '/shared/protocol.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

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
    $$('.mode-tab').forEach(button =>
      button.addEventListener('click', () => this.selectMode(button.dataset.mode))
    );
    this.selectMode('single');
    this.profile(readProfile());
    this.setInputMethod(
      document.body.dataset.input ||
        (matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0 ? 'touch' : 'keyboard')
    );
    addEventListener('inputmethodchange', e => this.setInputMethod(e.detail));
    $('#name').value = localStorage.getItem('wobble-name') || 'Wobbler';
    $('#name').addEventListener('change', () =>
      localStorage.setItem('wobble-name', $('#name').value.trim().slice(0, 16))
    );
  }
  selectMode(mode) {
    this.mode = mode;
    $$('.mode-tab').forEach(b => {
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
      onChange?.(chapter);
    };
    select.addEventListener('change', apply);
    apply();
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

  coopName() {
    return ($('#coopName').value.trim() || 'Wobbler').slice(0, 16);
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
  setInputMethod(method) {
    const touch = method === 'touch';
    $('#controlHint').textContent = touch
      ? 'ДЖОЙСТИК · ПРЫЖОК · РЫВОК · СВАЙП — КАМЕРА'
      : 'WASD · ПРОБЕЛ · SHIFT · МЫШЬ — КАМЕРА · C — РЕЖИМ';
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
    $('#connectStatus').textContent = message;
  }
  preview(spec) {
    $('#courseName').textContent = courseName(spec.seed);
    const best = readBest(soloKey(spec.seed, spec.difficulty));
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
    $('#profileRuns').textContent = data.completedRuns;
    $('#profileFlawless').textContent = data.flawlessRuns;
    $('#profileStreak').textContent = data.daily.streak;
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
    return ($('#name').value.trim() || 'Wobbler').slice(0, 16);
  }
  playerId() {
    return readPlayerId();
  }
  lobby(data, selfId) {
    this.show('lobby');
    $('#roomCode').textContent = data.code;
    $('#lobbyCourse').textContent = courseName(data.seed);
    $('#lobbyDifficulty').value = data.difficulty;
    const host = data.host === selfId;
    $('#lobbyDifficultyWrap').classList.toggle('locked', !host);
    $('#lobbyDifficulty').disabled = !host;
    $('#start').classList.toggle('hidden', !host);
    $('#start').disabled = !data.players.length || !data.players.every(p => p.ready);
    $('#lobbyHint').textContent = host
      ? 'Все игроки должны быть готовы перед стартом.'
      : 'Отметьтесь готовым — гонку запустит хост.';
    const list = $('#players');
    list.replaceChildren();
    for (const player of data.players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const avatar = document.createElement('i');
      avatar.className = 'player-avatar';
      avatar.style.background = `#${Number(player.color || 0xff4f91)
        .toString(16)
        .padStart(6, '0')}`;
      const name = document.createElement('span');
      name.textContent = `${player.id === data.host ? '♛ ' : ''}${player.name}${player.id === selfId ? ' (вы)' : ''}`;
      const state = document.createElement('b');
      state.className = player.ready ? 'ready' : '';
      state.textContent = player.ready ? 'ГОТОВ' : 'ОЖИДАНИЕ';
      row.append(avatar, name, state);
      list.append(row);
    }
    const verifiedTop = $('#verifiedTop');
    const race = data.mode === GAME_MODE.RACE;
    verifiedTop.classList.toggle('hidden', !race);
    if (race) this.loadVerifiedTop(data.seed, data.difficulty);
  }
  async loadVerifiedTop(seed, difficulty) {
    const key = `${seed}:${difficulty}`;
    if (this.verifiedTopKey === key) return;
    this.verifiedTopKey = key;
    const list = $('#verifiedTopList');
    const standing = $('#verifiedTopStanding');
    const count = $('#verifiedTopCount');
    list.replaceChildren();
    count.textContent = '';
    standing.textContent = 'ЗАГРУЗКА…';
    try {
      const params = new URLSearchParams({
        seed,
        difficulty,
        limit: '10',
        playerId: this.playerId()
      });
      const response = await fetch(`/leaderboard?${params}`);
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
  renderVerifiedTop({ entries = [], standing = null }) {
    const list = $('#verifiedTopList');
    const line = $('#verifiedTopStanding');
    const count = $('#verifiedTopCount');
    list.replaceChildren();
    count.textContent = standing?.total ? `ВСЕГО ${standing.total}` : '';

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
    // В кооперативе места нет — есть общая цель, поэтому счётчик места скрыт.
    $('#placeBox').classList.toggle('hidden', !multiplayer || coop);
    $('#pingBox').classList.toggle('hidden', !multiplayer);
    if (!on || !coop) $('#partnerHud').classList.add('hidden');
    if (!on) $('#coopIntro').classList.add('hidden');
    if (!on || !coop) this.coopLesson(null);
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
    const rematch = $('#rematch');
    rematch.disabled = false;
    rematch.textContent = 'РЕВАНШ';
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
    const active = data.players.filter(player => player.online);
    const self = active.find(player => player.id === selfId);
    const forRematch = active.filter(player => player.choice === 'rematch').length;
    const forLobby = active.filter(player => player.choice === 'lobby').length;

    // Кнопки остаются нажимаемыми: выбор меняют, пока комната не решила. Отметка «✓» показывает
    // свой выбор, счётчик — чужой. Без второго игрок не понимает, ждут его или он ждёт.
    const rematch = $('#rematch');
    rematch.disabled = false;
    rematch.textContent =
      (self?.choice === 'rematch' ? '✓ РЕВАНШ' : 'РЕВАНШ') + ` · ${forRematch}/${active.length}`;

    const back = $('#returnLobby');
    back.disabled = false;
    back.textContent =
      (self?.choice === 'lobby' ? '✓ В ЛОББИ' : 'В ЛОББИ') + ` · ${forLobby}/${active.length}`;

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
    note.textContent =
      reason === 'left'
        ? 'БЕЗ ЗАЧЁТА · напарник вышел посреди забега'
        : 'БЕЗ ЗАЧЁТА · связь оборвалась посреди забега';
  }

  // В коопе свой финиш — это ещё не конец: ждём напарника, а не показываем итоги.
  awaitPartnerFinish() {
    // HUD остаётся: игрок продолжает смотреть на трассу и видеть, где напарник. Управление к этому
    // моменту уже отключено вызывающей стороной, поэтому экранные кнопки убираем.
    this.elements.touch.classList.add('hidden');
    this.toast('Финиш! Ждём напарника — глава засчитывается только вдвоём.', 'info', 8000);
  }

  finishSolo({ time, respawns, dashes = 0, hits = 0, spec, unranked = null }) {
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
    $('#returnLobby').classList.add('hidden');
    // Забег без зачёта рекорд не переписывает — правило и его причина живут в core/records.js.
    const saved = saveBest(soloKey(seed, difficulty), time, { unranked });
    if (saved.improved) this.toast(saved.first ? 'Первое время сохранено!' : 'Новый личный рекорд!');
  }

  // Итоги кооп-главы. Мест здесь нет: команда либо прошла главу, либо нет, и время у неё общее —
  // по последнему дошедшему.
  finishCoop({ time, chapter, board, selfId, revives = 0, matchId = null, unranked = null }) {
    this.hud(false);
    this.show('finish');
    this.showUnranked(unranked);
    $('#finishEyebrow').textContent = 'КООПЕРАТИВ';
    $('#finishTitle').textContent = 'ГЛАВА ПРОЙДЕНА!';
    $('#medal').textContent = '✦';
    $('#finishTime').textContent = formatTime(time);
    const best = chapter ? this.recordChapterBest(chapter.chapterId, time, unranked) : null;
    const profile = recordCoopProfile(chapter, { time, revives, matchId, unranked });
    this.coopProfile(chapter?.chapterId, profile);
    $('#finishStats').innerHTML = [
      `<span>${chapter?.title || 'КООПЕРАТИВ'}</span>`,
      `<span>${chapter?.subtitle || 'ВДВОЁМ'}</span>`,
      best ? `<span>ЛУЧШЕЕ ${formatTime(best)}</span>` : '',
      `<span>СПАСЕНИЙ: ${revives}</span>`
    ].join('');
    this.updateBoard(board || [], selfId);
    $('#again').classList.add('hidden');
    $('#newCourse').classList.add('hidden');
    $('#rematch').classList.remove('hidden');
    $('#returnLobby').classList.remove('hidden');
    this.resetResultButtons();
  }

  // Лучшее время главы после возможного обновления либо null, если рекорда ещё нет.
  recordChapterBest(chapterId, time, unranked) {
    if (!chapterId) return null;
    const saved = saveBest(coopKey(chapterId), time, { unranked });
    if (saved.improved) this.toast(saved.first ? 'Первое время главы сохранено!' : 'Рекорд главы побит!');
    return saved.best;
  }

  finishMulti({ time, board, selfId, canRematch = true, unranked = null }) {
    this.hud(false);
    this.show('finish');
    this.showUnranked(unranked);
    // После возврата в лобби перечитываем таблицу: только что завершённый матч мог сменить лидера.
    this.verifiedTopKey = null;
    $('#finishEyebrow').textContent = 'ГОНКА ЗАВЕРШЕНА';
    const own = board.findIndex(p => p.id === selfId),
      place = own < 0 ? board.length : own + 1;
    $('#finishTitle').textContent = place === 1 ? 'КОРОНА ВАША!' : `${ordinal(place)}-Е МЕСТО`;
    $('#medal').textContent = place === 1 ? '♛' : '★';
    $('#finishTime').textContent = formatTime(time);
    $('#finishStats').innerHTML = '<span>ОНЛАЙН-ГОНКА</span><span>РЕЗУЛЬТАТЫ</span>';
    this.updateBoard(board, selfId);
    $('#again').classList.add('hidden');
    $('#newCourse').classList.add('hidden');
    $('#rematch').classList.toggle('hidden', !canRematch);
    $('#returnLobby').classList.remove('hidden');
    this.resetResultButtons();
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
