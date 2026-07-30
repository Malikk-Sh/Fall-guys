import { DIFFICULTIES, courseName, formatTime, ordinal } from '../core/Config.js';

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
      onChange?.(chapter);
    };
    select.addEventListener('change', apply);
    apply();
  }

  // Ссылка-приглашение. На телефоне диктовать пятисимвольный код неудобно и легко ошибиться,
  // а ссылку можно отправить в любой мессенджер одним касанием.
  inviteLink(code) {
    const url = new URL(location.href);
    url.hash = '';
    url.search = `?room=${encodeURIComponent(code)}`;
    return url.toString();
  }

  // Код комнаты из адреса, если игрок пришёл по приглашению.
  static invitedCode() {
    try {
      const code = new URL(location.href).searchParams.get('room');
      return code ? code.trim().toUpperCase().slice(0, 5) : null;
    } catch {
      return null;
    }
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
      ? 'JOYSTICK · JUMP · DIVE · SWIPE TO LOOK'
      : 'WASD · SPACE · SHIFT · DRAG TO LOOK';
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
  preview(seed, difficulty) {
    $('#courseName').textContent = courseName(seed);
    const key = `wobble-best-${seed}-${difficulty}`,
      best = Number(localStorage.getItem(key));
    $('#bestTime').textContent = best ? `BEST ${formatTime(best)}` : 'BEST —:—';
  }
  singleSettings() {
    return { type: $('#runType').value, difficulty: $('#difficulty').value };
  }
  playerName() {
    return ($('#name').value.trim() || 'Wobbler').slice(0, 16);
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
      ? 'Everyone must be ready before you launch.'
      : 'Ready up — the host will start the race.';
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
      name.textContent = `${player.id === data.host ? '♛ ' : ''}${player.name}${player.id === selfId ? ' (you)' : ''}`;
      const state = document.createElement('b');
      state.className = player.ready ? 'ready' : '';
      state.textContent = player.ready ? 'READY' : 'WAITING';
      row.append(avatar, name, state);
      list.append(row);
    }
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
        value = left > 2000 ? '3' : left > 1000 ? '2' : left > 0 ? '1' : 'GO!';
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
  finishSolo({ time, respawns, seed, difficulty }) {
    this.hud(false);
    this.show('finish');
    const par = DIFFICULTIES[difficulty].parPerSegment * DIFFICULTIES[difficulty].segments * 1000,
      ratio = time / par,
      medal = ratio <= 1 ? 'GOLD' : ratio <= 1.28 ? 'SILVER' : ratio <= 1.65 ? 'BRONZE' : 'FINISH';
    $('#finishTitle').textContent = medal === 'FINISH' ? 'COURSE CLEARED!' : `${medal} RUN!`;
    $('#medal').textContent =
      medal === 'GOLD' ? '★' : medal === 'SILVER' ? '◆' : medal === 'BRONZE' ? '●' : '✓';
    $('#finishTime').textContent = formatTime(time);
    $('#finishStats').innerHTML =
      `<span>${courseName(seed)}</span><span>${respawns} RESPAWN${respawns === 1 ? '' : 'S'}</span><span>${DIFFICULTIES[difficulty].label.toUpperCase()}</span>`;
    $('#board').replaceChildren();
    $('#again').classList.remove('hidden');
    $('#newCourse').classList.remove('hidden');
    $('#rematch').classList.add('hidden');
    $('#returnLobby').classList.add('hidden');
    const key = `wobble-best-${seed}-${difficulty}`,
      old = Number(localStorage.getItem(key));
    if (!old || time < old) {
      localStorage.setItem(key, String(Math.round(time)));
      this.toast(old ? 'New personal best!' : 'First time saved!');
    }
  }
  finishMulti({ time, board, selfId, canRematch = true }) {
    this.hud(false);
    this.show('finish');
    const own = board.findIndex(p => p.id === selfId),
      place = own < 0 ? board.length : own + 1;
    $('#finishTitle').textContent = place === 1 ? 'CROWNED!' : `${ordinal(place).toUpperCase()} PLACE`;
    $('#medal').textContent = place === 1 ? '♛' : '★';
    $('#finishTime').textContent = formatTime(time);
    $('#finishStats').innerHTML = '<span>ONLINE PARTY</span><span>LIVE RESULTS</span>';
    this.updateBoard(board, selfId);
    $('#again').classList.add('hidden');
    $('#newCourse').classList.add('hidden');
    $('#rematch').classList.toggle('hidden', !canRematch);
    $('#returnLobby').classList.remove('hidden');
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
      name.textContent = `${player.name}${player.id === selfId ? ' (you)' : ''}`;
      const time = document.createElement('span');
      time.textContent = formatTime(player.time);
      row.append(rank, color, name, time);
      list.append(row);
    });
  }
  setQuality(value) {
    this.quality = value;
    $('#quality').textContent = `${value.toUpperCase()} QUALITY`;
  }
}
