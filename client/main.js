import * as THREE from '/vendor/three.module.js';
import { COLORS, courseName, courseSpec, dailySeed, randomSeed } from './core/Config.js';
import { InputManager } from './core/InputManager.js';
import { Effects } from './game/Effects.js';
import { Course } from './game/Course.js';
import { Player } from './game/Player.js';
import { CameraController } from './game/CameraController.js';
import { NetworkManager } from './net/NetworkManager.js';
import { UI } from './ui/UI.js';

class Game {
  constructor() {
    this.ui = new UI();
    this.canvas = document.querySelector('#game');
    this.input = new InputManager(this.canvas);
    this.input.enabled = false;
    this.clockLast = performance.now();
    this.running = false;
    this.mode = 'preview';
    this.remotes = new Map();
    this.startToken = 0;
    this.menuRandomSeed = randomSeed();
    this.qualityChoice = 'auto';
    this.quality = this.detectQuality();
    this.createRenderer();
    this.createScene();
    this.cameraController = new CameraController(this.camera);
    this.effects = new Effects(this.scene, this.quality);
    this.bindUI();
    this.bindNetworkEvents();
    this.installLifecycle();
    this.previewSpec = courseSpec(dailySeed(), 'normal');
    this.buildPreview(this.previewSpec);
    this.resize();
    requestAnimationFrame(time => this.loop(time));
    this.ui.preview(this.previewSpec.seed, this.previewSpec.difficulty);
    this.ui.setLoading(true);
  }
  detectQuality() {
    if (this.qualityChoice !== 'auto') return this.qualityChoice;
    const constrained =
      (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (matchMedia('(pointer:coarse)').matches && devicePixelRatio > 2.5);
    return constrained ? 'low' : 'high';
  }
  createRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.detectQuality() === 'high',
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.applyRendererQuality();
  }
  applyRendererQuality() {
    this.quality = this.detectQuality();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality === 'low' ? 1 : 1.65));
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  createScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x83dff0);
    this.scene.fog = new THREE.Fog(0x93e5ef, 42, 145);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 190);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x6a4bb2, 2.45);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff7dc, 2.85);
    this.sun.position.set(18, 28, 15);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -22;
    this.sun.shadow.camera.right = 22;
    this.sun.shadow.camera.top = 30;
    this.sun.shadow.camera.bottom = -12;
    this.sun.shadow.camera.far = 90;
    this.scene.add(this.sun);
    const fill = new THREE.DirectionalLight(0x7feeff, 1.1);
    fill.position.set(-12, 8, -18);
    this.scene.add(fill);
  }
  bindUI() {
    const $ = s => document.querySelector(s);
    $('#play').addEventListener('click', () => this.startSingle(false));
    $('#again').addEventListener('click', () => this.startRace('single', this.lastSpec));
    $('#newCourse').addEventListener('click', () => this.startSingle(true));
    $('#create').addEventListener('click', () => {
      const net = this.ensureNetwork();
      net.send('create', { name: this.ui.playerName(), difficulty: $('#difficulty').value });
    });
    $('#join').addEventListener('click', () => {
      const net = this.ensureNetwork();
      net.send('join', { name: this.ui.playerName(), code: $('#code').value.trim().toUpperCase() });
    });
    $('#ready').addEventListener('click', () => {
      this.ready = !this.ready;
      this.net?.send('ready', { ready: this.ready });
      $('#ready').textContent = this.ready ? 'CANCEL READY' : 'READY UP';
    });
    $('#start').addEventListener('click', () => this.net?.send('start'));
    $('#lobbyDifficulty').addEventListener('change', e =>
      this.net?.send('configure', { difficulty: e.target.value })
    );
    $('#rematch').addEventListener('click', () => {
      this.net?.send('rematch');
      $('#rematch').disabled = true;
      $('#rematch').textContent = 'VOTE SENT';
    });
    $('#returnLobby').addEventListener('click', () => {
      this.net?.send('returnLobby');
      if (this.room) this.ui.lobby(this.room, this.net.id);
    });
    $('#copyCode').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#roomCode').textContent);
        this.ui.toast('Room code copied!');
      } catch {
        this.ui.toast('Select the room code and copy it manually.');
      }
    });
    document
      .querySelectorAll('.back')
      .forEach(button => button.addEventListener('click', () => this.goHome()));
    const refreshPreview = () => {
      const settings = this.ui.singleSettings();
      this.previewSpec = courseSpec(
        settings.type === 'daily' ? dailySeed() : this.menuRandomSeed,
        settings.difficulty
      );
      this.ui.preview(this.previewSpec.seed, this.previewSpec.difficulty);
      if (!this.running && this.mode === 'preview') this.buildPreview(this.previewSpec);
    };
    $('#runType').addEventListener('change', e => {
      if (e.target.value === 'random') this.menuRandomSeed = randomSeed();
      refreshPreview();
    });
    $('#difficulty').addEventListener('change', refreshPreview);
    $('#quality').addEventListener('click', () => {
      const values = ['auto', 'low', 'high'],
        next = values[(values.indexOf(this.qualityChoice) + 1) % values.length];
      this.qualityChoice = next;
      this.ui.setQuality(next);
      this.applyRendererQuality();
      this.ui.toast(`${next.toUpperCase()} graphics will be used for new courses.`);
      if (this.mode === 'preview') this.buildPreview(this.previewSpec);
    });
  }
  bindNetworkEvents() {
    this.networkBound = false;
  }
  ensureNetwork() {
    if (this.net) return this.net;
    this.net = new NetworkManager(this.ui);
    this.net.on('lobby', message => {
      this.room = message;
      this.ready = message.players.find(p => p.id === this.net.id)?.ready || false;
      document.querySelector('#ready').textContent = this.ready ? 'CANCEL READY' : 'READY UP';
      document.querySelector('#rematch').disabled = false;
      document.querySelector('#rematch').textContent = 'VOTE REMATCH';
      this.ui.lobby(message, this.net.id);
    });
    this.net.on('start', message => this.startRace('multi', message.spec, message.at));
    this.net.on('snapshot', message => this.receiveSnapshot(message));
    this.net.on('correction', message => {
      if (this.player && message.position) {
        this.player.checkpoint = Math.max(this.player.checkpoint, message.position.checkpoint || 0);
        this.player.respawn(
          new THREE.Vector3(message.position.x, message.position.y, message.position.z),
          false
        );
        if (message.reason === 'movement') this.ui.toast('Server corrected an unstable movement update.');
      }
    });
    this.net.on('finish', message => this.receiveFinish(message));
    this.net.on('disconnect', () => this.fallbackToSolo());
    this.net.connect();
    return this.net;
  }
  startSingle(forceNew) {
    const settings = this.ui.singleSettings();
    const seed =
      settings.type === 'daily' && !forceNew ? dailySeed() : forceNew ? randomSeed() : this.menuRandomSeed;
    if (settings.type === 'random') this.menuRandomSeed = seed;
    this.startRace('single', courseSpec(seed, settings.difficulty));
  }
  clearActors() {
    this.player?.dispose();
    this.player = null;
    for (const remote of this.remotes.values()) remote.dispose();
    this.remotes.clear();
  }
  buildCourse(spec) {
    this.clearActors();
    this.effects?.clear();
    this.course?.dispose();
    this.course = new Course(this.scene, spec, { quality: this.quality });
    this.lastSpec = this.course.spec;
  }
  buildPreview(spec) {
    this.mode = 'preview';
    this.running = false;
    this.input.enabled = false;
    this.buildCourse(spec);
    this.player = new Player(this.scene, this.course, this.effects, {
      remote: true,
      color: COLORS.pink,
      accent: COLORS.yellow
    });
    this.player.position.copy(this.course.spawnFor(0));
    this.camera.position.set(10, 7, 17);
    this.camera.lookAt(0, 1, -7);
  }
  async startRace(mode, spec, startAt = Date.now() + 1900) {
    const token = ++this.startToken;
    this.mode = mode;
    this.running = false;
    this.raceComplete = false;
    this.buildCourse(spec);
    this.player = new Player(this.scene, this.course, this.effects, {
      color: COLORS.pink,
      accent: COLORS.yellow,
      onCheckpoint: index => {
        this.ui.checkpoint(index, this.course.spec.segmentCount);
        if (mode === 'multi') this.net?.send('checkpoint', { checkpoint: index });
      },
      onRespawn: checkpoint => {
        if (mode === 'multi') this.net?.send('respawn', { checkpoint });
      },
      onFinish: () => this.localFinish()
    });
    this.cameraController.reset(this.player, true);
    this.ui.show();
    this.ui.hud(true, { multiplayer: mode === 'multi', touch: this.input.activeMethod === 'touch' });
    this.input.reset();
    this.input.enabled = false;
    this.startedAt = startAt;
    await this.ui.countdown(startAt);
    if (token !== this.startToken) return;
    this.running = true;
    this.input.enabled = true;
    this.startedAt = startAt;
    this.ui.toast(`${courseName(this.course.spec.seed)} — GO!`);
  }
  localFinish() {
    const time = Math.max(0, Date.now() - this.startedAt);
    this.finalTime = time;
    if (this.mode === 'single') {
      this.running = false;
      this.input.enabled = false;
      this.ui.finishSolo({
        time,
        respawns: this.player.respawns,
        seed: this.course.spec.seed,
        difficulty: this.course.spec.difficulty
      });
    } else {
      this.input.enabled = false;
      this.net?.send('finish', { clientTime: time });
      this.ui.toast('Finished! Confirming your placement…');
    }
  }
  receiveSnapshot(message) {
    if (!this.player || this.mode !== 'multi') return;
    const active = new Set();
    for (const state of message.players || []) {
      if (state.id === this.net.id) continue;
      active.add(state.id);
      let remote = this.remotes.get(state.id);
      if (!remote) {
        const info = this.room?.players.find(p => p.id === state.id);
        remote = new Player(this.scene, this.course, this.effects, {
          remote: true,
          color: info?.color || COLORS.cyan,
          accent: COLORS.yellow,
          name: info?.name || 'Wobbler'
        });
        this.remotes.set(state.id, remote);
      }
      remote.target = state;
    }
    for (const [id, remote] of this.remotes)
      if (!active.has(id)) {
        remote.dispose();
        this.remotes.delete(id);
      }
    this.latestBoard = message.finished || this.latestBoard;
  }
  receiveFinish(message) {
    this.latestBoard = message.board || [];
    if (message.id === this.net.id) {
      this.running = false;
      this.input.enabled = false;
      this.ui.finishMulti({
        time: message.time ?? this.finalTime,
        board: this.latestBoard,
        selfId: this.net.id
      });
    } else if (!document.querySelector('#finish').classList.contains('hidden'))
      this.ui.updateBoard(this.latestBoard, this.net.id);
  }
  fallbackToSolo() {
    if (this.mode !== 'multi' || !this.player || this.player.finished) return;
    const elapsed = Math.max(0, Date.now() - this.startedAt);
    this.mode = 'single';
    this.startedAt = Date.now() - elapsed;
    this.ui.hud(true, { multiplayer: false, touch: this.input.activeMethod === 'touch' });
    this.ui.error('Connection lost — this run is continuing in Single Player.');
    this.net = null;
  }
  goHome() {
    this.startToken++;
    this.running = false;
    this.input.enabled = false;
    this.net?.close();
    this.net = null;
    this.room = null;
    this.ready = false;
    this.ui.racing = false;
    this.ui.elements.hud.classList.add('hidden');
    this.ui.elements.touch.classList.add('hidden');
    this.ui.show('menu');
    const settings = this.ui.singleSettings();
    this.previewSpec = courseSpec(
      settings.type === 'daily' ? dailySeed() : this.menuRandomSeed,
      settings.difficulty
    );
    this.ui.preview(this.previewSpec.seed, this.previewSpec.difficulty);
    this.buildPreview(this.previewSpec);
  }
  installLifecycle() {
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        this.input.reset();
      } else if (this.hiddenAt && this.mode === 'single' && this.running) {
        this.startedAt += Date.now() - this.hiddenAt;
        this.hiddenAt = 0;
      }
    });
  }
  resize() {
    const width = Math.max(1, innerWidth),
      height = Math.max(1, innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.applyRendererQuality();
  }
  placement() {
    const racers = [
      { id: this.net?.id || 'self', checkpoint: this.player.checkpoint, z: this.player.position.z }
    ];
    for (const [id, remote] of this.remotes)
      racers.push({ id, checkpoint: remote.checkpoint, z: remote.position.z });
    racers.sort((a, b) => b.checkpoint - a.checkpoint || a.z - b.z);
    return racers.findIndex(r => r.id === (this.net?.id || 'self')) + 1;
  }
  loop(time) {
    const dt = Math.min(0.04, Math.max(0.001, (time - this.clockLast) / 1000));
    this.clockLast = time;
    const courseElapsed =
      this.mode === 'preview' ? time / 1000 : Math.max(0, (Date.now() - this.startedAt) / 1000);
    this.course?.update(dt, courseElapsed);
    this.effects.update(dt);
    if (this.mode === 'preview' && this.player) {
      this.player.character.animate(dt, { speed: 0, grounded: true });
      const target = new THREE.Vector3(0, 1, -7),
        angle = time * 0.00007;
      this.camera.position.lerp(
        new THREE.Vector3(Math.sin(angle) * 12, 7.3, 10 + Math.cos(angle) * 5),
        1 - Math.exp(-2 * dt)
      );
      this.camera.lookAt(target);
    } else if (this.player) {
      if (this.running) {
        this.input.update();
        this.player.update(dt, this.input, this.cameraController.yaw, courseElapsed);
        if (this.mode === 'multi') {
          this.net?.sendState(this.player.snapshot());
          this.net?.tick();
        }
      }
      for (const remote of this.remotes.values()) remote.applyRemote(remote.target, dt);
      this.cameraController.update(dt, this.player, this.input, this.course);
      const elapsed =
        this.finalTime && this.player.finished ? this.finalTime : Math.max(0, Date.now() - this.startedAt);
      this.ui.updateHud({
        time: elapsed,
        checkpoint: this.player.checkpoint,
        total: this.course.spec.segmentCount,
        progress: this.course.progress(this.player.position, this.player.checkpoint),
        stage: this.course.stageAt(this.player.checkpoint),
        place: this.mode === 'multi' ? this.placement() : null,
        ping: this.net?.latency
      });
    }
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(next => this.loop(next));
  }
}

let game;
try {
  game = new Game();
  window.__WOBBLE_GAME__ = game;
} catch (error) {
  const panel = document.querySelector('#error');
  panel.textContent = `3D graphics could not start: ${error.message}. Try enabling WebGL or switching browser.`;
  panel.classList.remove('hidden');
  document.querySelector('#loading')?.classList.add('hidden');
  console.error(error);
}
