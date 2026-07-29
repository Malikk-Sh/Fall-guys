import { DIFFICULTIES, courseName, formatTime, ordinal } from '../core/Config.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

export class UI {
  constructor() {
    this.mode = 'single';
    this.quality = 'auto';
    this.toastTimer = 0;
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
  hud(on, { multiplayer = false, touch = false } = {}) {
    this.racing = on;
    this.elements.hud.classList.toggle('hidden', !on);
    this.elements.touch.classList.toggle('hidden', !on || !touch);
    $('#placeBox').classList.toggle('hidden', !multiplayer);
    $('#pingBox').classList.toggle('hidden', !multiplayer);
  }
  updateHud({ time, checkpoint, total, progress, stage, place, ping }) {
    $('#timer').textContent = formatTime(time);
    $('#checks').textContent = `${checkpoint} / ${total}`;
    $('#progressFill').style.width = `${Math.round(progress * 100)}%`;
    $('#stageName').textContent = stage;
    if (place) $('#place').textContent = ordinal(place);
    if (Number.isFinite(ping)) $('#ping').textContent = `${Math.round(ping)}ms`;
  }
  checkpoint(index, total) {
    const banner = $('#checkpointBanner');
    banner.querySelector('strong').textContent = `${index} / ${total}`;
    banner.classList.remove('hidden');
    void banner.offsetWidth;
    setTimeout(() => banner.classList.add('hidden'), 920);
  }
  async countdown(startAt) {
    const overlay = $('#countdown'),
      label = overlay.querySelector('span');
    overlay.classList.remove('hidden');
    let last = '';
    while (Date.now() < startAt + 420) {
      const left = startAt - Date.now(),
        value = left > 2000 ? '3' : left > 1000 ? '2' : left > 0 ? '1' : 'GO!';
      if (value !== last) {
        label.textContent = value;
        label.style.animation = 'none';
        void label.offsetWidth;
        label.style.animation = '';
        last = value;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    overlay.classList.add('hidden');
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
