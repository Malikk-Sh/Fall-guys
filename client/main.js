import * as THREE from 'three';
import { COLORS, courseName, courseSpec, dailyCourseSpec, dailySeed, randomSeed } from './core/Config.js';
import { InputManager } from './core/InputManager.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { Sfx } from './audio/sfx.js';
import { Music } from './audio/Music.js';
import { Effects } from './game/Effects.js';
import { Course } from './game/Course.js';
import { CoopCourse } from './game/CoopCourse.js';
import { updateRoleActions } from './game/CoopActions.js';
import { COOP_CHAPTERS, coopSpawnFor } from '/shared/coopChapters.js';
import { GAME_MODE, ROOM_STATE } from '/shared/protocol.js';
import { Player } from './game/Player.js';
import { CameraController } from './game/CameraController.js';
import { PostFX } from './game/PostFX.js';
import { NetworkManager } from './net/NetworkManager.js';
import { Perf } from './core/Perf.js';
import { UI } from './ui/UI.js';
import { APP_STATE, createAppStates } from './core/AppStates.js';
import { StateRouter } from './core/StateRouter.js';
import { RaceSession } from './game/RaceSession.js';
import { CoopSession } from './game/CoopSession.js';
import {
  ensureAccount,
  listAccounts,
  currentAccount as accountForRecords,
  createAccount,
  loginAccount,
  renameAccount,
  rememberAccount,
  switchAccount,
  submitRecord
} from './core/account.js';

// Шаг физики. 60 Гц — компромисс: достаточно часто, чтобы столкновения не «протыкались», и
// достаточно редко, чтобы на слабых устройствах хватало времени на отрисовку.
const FIXED_DT = 1 / 60;

// Предохранитель от «спирали смерти»: если кадр занял очень много времени (вкладка была свёрнута,
// система тормозила), нельзя пытаться доработать все пропущенные шаги — это займёт ещё больше
// времени, и отставание будет только расти. Лишнее время просто отбрасывается.
const MAX_SUBSTEPS = 5;

// Насколько долгий сон вкладки считать «долгим». Короткое переключение окна ничего не ломает:
// история снапшотов ещё свежая, оценка часов ещё верна. Дольше секунды — уже нет.
const WAKE_RESYNC_MS = 1000;

class Game {
  constructor() {
    this.ui = new UI();
    this.canvas = document.querySelector('#game');
    this.input = new InputManager(this.canvas);
    this.input.enabled = false;
    this.state = new StateRouter(this, createAppStates());
    this.session = new RaceSession();
    this.coop = new CoopSession();

    this.clockLast = performance.now();
    this.accumulator = 0;
    this.running = false;
    this.mode = 'preview';
    this.remotes = new Map();
    this.startToken = 0;
    this.menuRandomSeed = randomSeed();
    this.qualityChoice = 'auto';
    // Догадка по железу — только начальное приближение. Дальше качество ведёт измерение кадров.
    this.autoQuality = this.guessQuality();
    this.quality = this.autoQuality;
    this.raisedAt = 0;
    this.perf = new Perf({ enabled: new URL(location.href).searchParams.has('perf') });

    this.audio = new AudioEngine();
    this.sfx = new Sfx(this.audio);
    this.music = new Music(this.audio);

    this.createRenderer();
    this.createScene();
    this.cameraController = new CameraController(this.camera);
    this.postFX = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.effects = new Effects(this.scene, this.quality);

    this.bindUI();
    this.installAudioUnlock();
    this.installLifecycle();

    // Вход в аккаунт не блокирует запуск игры: сеть может отвечать долго или не отвечать вовсе,
    // а меню должно появиться сразу. Имя и рекорды подставятся, когда ответ придёт.
    //
    // Обещание сохраняем: вход в комнату его дожидается. Иначе игрок, нажавший «создать комнату» в
    // первые мгновения после загрузки, попадал бы туда без личности — и его результат не привязался
    // бы к аккаунту.
    this.accountReady = this.signIn();

    this.previewSpec = dailyCourseSpec('normal');
    this.buildPreview(this.previewSpec);
    this.handleInvite();
    // После полной перезагрузки в URL уже нет invite-параметров, но sessionStorage хранит токен.
    // Подключаем сеть без нового клика, иначе клиент так и останется в меню и не отправит resume.
    if (NetworkManager.hasSavedSession()) this.ensureNetwork();
    this.resize();
    requestAnimationFrame(time => this.loop(time));
    this.ui.preview(this.previewSpec);
    this.ui.setLoading(true);
  }

  // Игрок пришёл по ссылке вида ?room=ABCDE&mode=race — открываем нужный режим и подставляем код,
  // чтобы от нажатия на ссылку до игры оставалось одно действие.
  handleInvite() {
    const invite = UI.invitedRoom();
    if (!invite) return;
    this.ui.selectMode(invite.mode === GAME_MODE.COOP ? 'coop' : 'multi');
    document.querySelector('#coopCode').value = invite.code;
    document.querySelector('#code').value = invite.code;
    this.ui.toast(`Приглашение в комнату ${invite.code} — введите имя и войдите.`);
    // Убираем параметр из адреса: перезагрузка страницы не должна пытаться войти повторно.
    history.replaceState(null, '', location.pathname);
  }

  // Действующее качество. В режиме «auto» это результат измерения (`autoQuality`), а не догадки:
  // догадка по числу ядер и памяти работает грубо — слабый телефон с восемью ядрами получал
  // высокое качество и играл в двадцать кадров.
  detectQuality() {
    if (this.qualityChoice !== 'auto') return this.qualityChoice;
    return this.autoQuality || this.guessQuality();
  }

  // Начальное приближение по характеристикам устройства. Нужно только чтобы первые секунды
  // не оказались заведомо провальными: дальше решение принимает Perf по времени кадров.
  guessQuality() {
    const constrained =
      (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (matchMedia('(pointer:coarse)').matches && devicePixelRatio > 2.5);
    return constrained ? 'low' : 'high';
  }

  // Автоподстройка качества по бюджету кадра.
  //
  // Работает только в режиме «auto»: если игрок выбрал качество руками, менять его за него нельзя —
  // это его решение, даже если оно стоит кадров.
  updateAdaptiveQuality(now) {
    if (this.qualityChoice !== 'auto' || !this.running) return;
    const verdict = this.perf.verdict(now);
    if (!verdict) return;

    if (verdict < 0) {
      if (this.autoQuality === 'low') return;
      // Понижение сразу после попытки возврата означает, что возврат был ошибкой.
      if (this.raisedAt && now - this.raisedAt < 60_000) this.perf.raiseFailed();
      this.autoQuality = 'low';
      this.applyRendererQuality();
      this.perf.reset();
      this.ui.toast('Качество снижено — держим плавность.');
      return;
    }

    if (this.autoQuality === 'high') return;
    this.autoQuality = 'high';
    this.raisedAt = now;
    this.applyRendererQuality();
    this.perf.reset();
    this.ui.toast('Качество повышено.');
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
    this.postFX?.setQuality(this.quality);
    // Частицы создаются с лимитом под качество и раньше не пересоздавались при его смене:
    // переключение на высокое качество не давало эффекта до перезагрузки страницы.
    if (this.effects && this.effects.quality !== this.quality) this.effects.setQuality(this.quality);
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
    this.sun.shadow.mapSize.set(2048, 2048);
    // Рамка теней теперь узкая и ездит за игроком (см. updateShadow), поэтому на ту же карту теней
    // приходится в разы меньше площади — тени стали заметно чётче при том же расходе памяти.
    this.sun.shadow.camera.left = -20;
    this.sun.shadow.camera.right = 20;
    this.sun.shadow.camera.top = 20;
    this.sun.shadow.camera.bottom = -20;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const fill = new THREE.DirectionalLight(0x7feeff, 1.1);
    fill.position.set(-12, 8, -18);
    this.scene.add(fill);

    this._shadowFocus = new THREE.Vector3();
    this._previewTarget = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._marker = new THREE.Vector3();
  }

  // Рамка теней следует за игроком.
  //
  // Раньше ортографическая камера тени была прибита к началу координат с рамкой примерно 44×42, а
  // трасса уходит по Z до -139. То есть теней не было нигде дальше второго сегмента — персонаж
  // просто переставал отбрасывать тень, и глубина сцены разваливалась.
  updateShadow(focus) {
    // Привязка к сетке размером в один тексель карты теней. Без неё тень мелко «кипит» по краям
    // при движении камеры: рамка сдвигается на доли текселя, и растеризация каждый кадр иная.
    const texelSize = 40 / this.sun.shadow.mapSize.width;
    const snappedX = Math.round(focus.x / texelSize) * texelSize;
    const snappedZ = Math.round(focus.z / texelSize) * texelSize;

    this._shadowFocus.set(snappedX, 0, snappedZ);
    this.sun.target.position.copy(this._shadowFocus);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(snappedX + 18, 28, snappedZ + 15);
  }

  // Браузер не позволяет запустить звук до первого действия пользователя. Слушаем первое
  // касание, клик или нажатие клавиши и на нём инициализируем аудио.
  installAudioUnlock() {
    const unlock = () => {
      this.audio.unlock();
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
  }

  // --- аккаунт --------------------------------------------------------------------------------

  // Автовход в последний аккаунт. При первом заходе аккаунт заводится сам: игрок не должен
  // регистрироваться, чтобы просто побегать.
  async signIn() {
    const { account, records, online } = await ensureAccount({});
    this.applyAccount(account, { online, records });
    if (!online) this.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');
  }

  // `records` не передают, когда менялось только имя: рекорды при этом те же, и пересобирать их
  // из уже разобранной карты было бы лишним кругом.
  applyAccount(account, { online = true, records = null } = {}) {
    if (records) {
      this.serverRecords = new Map(
        records.map(record => [`${record.mode}:${record.courseKey}`, record.time])
      );
    }
    this.ui.setAccount(account, { online });
    this.ui.setAccountList(listAccounts());
    // Меню показывает рекорд текущей трассы, а он у каждого аккаунта свой.
    if (this.previewSpec) this.ui.preview(this.previewSpec, this.serverRecordFor('solo', this.previewSpec));
  }

  serverRecordFor(mode, spec) {
    if (!spec) return null;
    const key = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    return this.serverRecords?.get(`${mode}:${key}`) ?? null;
  }

  // Личный рекорд уходит на сервер после любого режима.
  //
  // Соло и кооп сервер проверить не может — он просто верит присланному времени, поэтому эти
  // результаты остаются личными и в общую таблицу не попадают. Общий топ по-прежнему только у
  // гонки, где каждое положение игрока проверено.
  async saveServerRecord(mode, spec, time) {
    const account = accountForRecords();
    if (!account || !Number.isFinite(time) || time <= 0) return;
    const courseKey = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    try {
      const saved = await submitRecord({ secret: account.secret, mode, courseKey, timeMs: Math.round(time) });
      if (saved?.best) this.serverRecords?.set(`${mode}:${courseKey}`, saved.best);
    } catch {
      // Рекорд не уехал — забег от этого не перестаёт быть пройденным, а локальная запись уже есть.
    }
  }

  async handleAccountAction(action, value) {
    const ui = this.ui;
    try {
      if (action === 'switch') {
        switchAccount(value);
        ui.accountStatus('Переключаюсь…');
        return this.signIn();
      }
      if (action === 'create') {
        const created = await createAccount('Wobbler');
        if (!created) return ui.accountStatus('Не вышло создать аккаунт — сервер не ответил.');
        rememberAccount(created);
        this.applyAccount(created, { records: created.records });
        return ui.accountStatus('Новый аккаунт готов. Загляните в «МОЙ КОД», чтобы не потерять его.');
      }
      if (action === 'login') {
        const entered = await loginAccount(value);
        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');
        // Код сохраняем ровно тот, что ввёл игрок: сервер его обратно не присылает.
        rememberAccount({ ...entered, secret: value });
        this.applyAccount({ ...entered, secret: value }, { records: entered.records });
        return ui.accountStatus(`Вошли как ${entered.name}.`);
      }
      if (action === 'rename') {
        const account = accountForRecords();
        if (!account) return ui.accountStatus('Сначала нужен аккаунт.');
        const renamed = await renameAccount(account.secret, value);
        if (!renamed) return ui.accountStatus('Переименовать не вышло — сервер не ответил.');
        rememberAccount({ ...renamed, secret: account.secret });
        this.applyAccount({ ...renamed, secret: account.secret });
        return ui.accountStatus('Имя изменено.');
      }
    } catch {
      ui.accountStatus('Не получилось — попробуйте ещё раз.');
    }
    return undefined;
  }

  bindUI() {
    this.ui.onAccountAction = (action, value) => this.handleAccountAction(action, value);
    const $ = s => document.querySelector(s);
    const click = (selector, handler) =>
      $(selector).addEventListener('click', event => {
        this.sfx.uiClick();
        handler(event);
      });

    click('#play', () => this.startSingle(false));
    click('#again', () => this.startRace('single', this.lastSpec));
    click('#newCourse', () => this.startSingle(true));
    click('#create', async () => {
      await this.accountReady;
      const net = this.ensureNetwork();
      net.createRoom({
        name: this.ui.playerName(),
        playerId: this.ui.playerId(),
        difficulty: $('#difficulty').value
      });
    });
    click('#join', async () => {
      await this.accountReady;
      const net = this.ensureNetwork();
      net.joinRoom({
        name: this.ui.playerName(),
        playerId: this.ui.playerId(),
        code: $('#code').value.trim().toUpperCase()
      });
    });
    click('#ready', () => {
      this.ready = !this.ready;
      this.net?.send('ready', { ready: this.ready });
      $('#ready').textContent = this.ready ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
    });
    click('#start', () => this.net?.send('start'));
    $('#lobbyDifficulty').addEventListener('change', e =>
      this.net?.send('configure', { difficulty: e.target.value })
    );
    // Голоса на экране результатов. Кнопки НЕ гасим: выбор можно менять, пока комната не решила.
    // Раньше нажатая кнопка гасла навсегда, и разошедшиеся голоса запирали обоих без выхода.
    // Экран переключит авторитетное состояние комнаты, а не локальная догадка.
    click('#rematch', () => {
      if (!this.net?.matchId) return;
      this.net.send('rematch', { matchId: this.net.matchId });
    });
    click('#returnLobby', () => {
      if (!this.net?.matchId) return;
      this.net.send('returnLobby', { matchId: this.net.matchId });
    });
    $('#copyInvite').addEventListener('click', async () => {
      const mode = this.room?.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;
      const link = this.ui.inviteLink($('#roomCode').textContent.trim(), mode);
      try {
        // На телефоне системное «Поделиться» удобнее буфера обмена: ссылка сразу уходит в
        // мессенджер, а не требует переключения приложений вручную.
        if (navigator.share) {
          const title = mode === GAME_MODE.COOP ? 'Wobble Rush — кооп' : 'Wobble Rush — гонка';
          await navigator.share({ title, url: link });
        } else await navigator.clipboard.writeText(link);
        this.ui.toast('Ссылка-приглашение готова!');
      } catch {
        this.ui.toast(link);
      }
    });
    $('#copyCode').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#roomCode').textContent);
        this.ui.toast('Код комнаты скопирован!');
      } catch {
        this.ui.toast('Выделите код и скопируйте вручную.');
      }
    });
    document.querySelectorAll('.back').forEach(button =>
      button.addEventListener('click', () => {
        this.sfx.uiClick();
        this.goHome();
      })
    );

    const refreshPreview = () => {
      const settings = this.ui.singleSettings();
      this.previewSpec =
        settings.type === 'daily'
          ? dailyCourseSpec(settings.difficulty)
          : courseSpec(this.menuRandomSeed, settings.difficulty);
      this.ui.preview(this.previewSpec);
      if (!this.running && this.mode === 'preview') this.buildPreview(this.previewSpec);
    };
    $('#runType').addEventListener('change', e => {
      if (e.target.value === 'random') this.menuRandomSeed = randomSeed();
      refreshPreview();
    });
    $('#difficulty').addEventListener('change', refreshPreview);

    click('#quality', () => {
      const values = ['auto', 'low', 'high'];
      const next = values[(values.indexOf(this.qualityChoice) + 1) % values.length];
      this.qualityChoice = next;
      // Возврат в «auto» начинает подбор заново: прошлые измерения относились к другой картинке.
      if (next === 'auto') {
        this.autoQuality = this.guessQuality();
        this.perf.reset();
      }
      this.ui.setQuality(next);
      this.applyRendererQuality();
      this.ui.toast(`Качество графики: ${next.toUpperCase()}.`);
      if (this.mode === 'preview') this.buildPreview(this.previewSpec);
    });

    // Режим камеры переключается внутри контроллера (клавиша C или кнопка на экране), а показать
    // это должен интерфейс. Событие вместо прямого вызова — чтобы контроллер камеры не знал про UI.
    addEventListener('camera-mode-change', event => {
      const free = event.detail === 'free';
      this.ui.toast(
        free ? 'КАМЕРА: СВОБОДНАЯ — смотрит, куда повернули.' : 'КАМЕРА: СЛЕЖЕНИЕ — сама встаёт за спину.'
      );
      $('#cameraMode').classList.toggle('camera-free', free);
    });
    $('#cameraMode').classList.toggle('camera-free', this.cameraController.mode === 'free');

    // Кооператив: выбор главы и вход в комнату.
    this.ui.fillChapters(COOP_CHAPTERS, chapter => {
      this.coopChapterId = chapter.id;
    });
    click('#coopCreate', async () => {
      await this.accountReady;
      const net = this.ensureNetwork();
      net.createRoom({
        name: this.ui.coopName(),
        playerId: this.ui.playerId(),
        mode: GAME_MODE.COOP,
        difficulty: this.ui.coopChapter()
      });
    });
    click('#coopJoin', async () => {
      await this.accountReady;
      const net = this.ensureNetwork();
      net.joinRoom({
        name: this.ui.coopName(),
        playerId: this.ui.playerId(),
        code: $('#coopCode').value.trim().toUpperCase()
      });
    });

    this.ui.bindAudioControls({
      volumes: this.audio.volumes,
      onChange: (bus, value) => {
        this.audio.unlock();
        this.audio.setVolume(bus, value);
      }
    });
  }

  ensureNetwork() {
    if (this.net) return this.net;
    this.net = new NetworkManager(this.ui);

    // Состояние комнаты приходит одним и тем же типом сообщения в любом состоянии — и в лобби,
    // и на экране результатов. Раньше обработчик этого не различал и на каждое обновление открывал
    // лобби. Из-за этого первый же чужой голос за реванш закрывал карточку результатов: сервер
    // просто разослал новый состав комнаты, а клиент понял это как «матч окончен, все в лобби».
    this.net.on('lobby', message => {
      this.room = message;
      // Список игроков — авторитетный источник: событие присутствия могло прийти до того, как
      // напарник вообще появился в комнате, или потеряться при переподключении.
      this.coop.setPartnerAway(message.players.some(p => p.id !== this.net.id && p.away));
      this.ready = message.players.find(p => p.id === this.net.id)?.ready || false;

      if (message.state === ROOM_STATE.RESULTS)
        return this.ui.updateResultRoom(message, this.net.id, this.net.serverNow());
      // Забег идёт (или идёт отсчёт) — экран принадлежит игре, а не лобби.
      if (message.state !== ROOM_STATE.LOBBY) return;

      this.state.transition(APP_STATE.LOBBY, message);
      document.querySelector('#ready').textContent = this.ready ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
      this.ui.resetResultButtons();
      this.ui.lobby(message, this.net.id);
    });

    // Сервер не принял финиш: по его данным черта ещё не пересечена. Разрешаем повтор и ставим
    // игрока туда, где сервер его видит, — иначе он навсегда останется в «Подтверждаем результат…».
    this.net.on('finishRejected', message => {
      this.net.allowFinishRetry();
      this.session.reopenFinish();
      this.player.finished = false;
      this.running = true;
      this.input.enabled = true;
      if (message.position) {
        this.player.respawn(
          new THREE.Vector3(message.position.x, message.position.y, message.position.z),
          false
        );
      }
      this.ui.toast('Финиш не засчитан — добегите до ленты ещё раз.');
    });

    // Клиент старее сервера. Всплывающая подсказка тут не годится: она исчезнет через пять секунд,
    // а игра останется нерабочей. Нужен постоянный оверлей с единственным действием.
    this.net.on('versionMismatch', () => {
      this.running = false;
      this.input.enabled = false;
      this.ui.linkOverlay('failed', {
        title: 'Версия игры устарела',
        detail: 'Сервер обновился. Обновите страницу, чтобы продолжить играть по сети.',
        action: { label: 'ОБНОВИТЬ СТРАНИЦУ', onClick: () => location.reload() }
      });
    });

    // Вернуться в комнату не удалось: её уже нет или истёк срок. Это не «сеть лежит», а «идти
    // некуда», и вести себя надо иначе — увести в меню, а не крутить переподключение.
    this.net.on('sessionExpired', () => {
      this.ui.error('Комната больше не существует. Возвращаемся в меню.');
      this.goHome();
    });

    // `start` приходит и в начале забега, и при возвращении в уже идущий. Различает их поле
    // `resumed`: если оно есть, забег продолжается с того места, где сервер видел игрока.
    this.net.on('start', async message => {
      await this.startRace(
        message.mode === GAME_MODE.COOP ? 'coop' : 'multi',
        message.spec,
        message.at,
        message.slots
      );
      if (message.resumed) this.restoreRun(message.resumed);
    });
    this.net.on('presence', message => {
      if (message.id === this.net.id) return;
      this.coop.setPartnerAway(message.away);
      if (this.mode === 'coop') {
        this.ui.toast(message.away ? 'Напарник свернул игру — подождите.' : 'Напарник вернулся в игру.');
      }
    });
    this.net.on('coopEvent', message => this.receiveCoopEvent(message));
    this.net.on('finish', message => this.receiveFinish(message));
    this.net.on('results', message => this.receiveResults(message));

    // Сервер снял зачёт: кто-то оборвался или вышел. Говорим об этом сразу, а не на финише —
    // игрок вправе знать, что бежит уже не за рекорд, до того как добежит.
    this.net.on('unranked', message => {
      if (message.matchId && this.net.matchId && message.matchId !== this.net.matchId) return;
      this.markUnranked(message.reason || 'disconnect');
    });

    this.net.on('correction', message => {
      if (this.player && message.position) {
        this.player.checkpoint = Math.max(this.player.checkpoint, message.position.checkpoint || 0);
        this.player.respawn(
          new THREE.Vector3(message.position.x, message.position.y, message.position.z),
          false
        );
        if (message.reason === 'movement') this.ui.toast('Сервер поправил рассинхрон движения.');
      }
    });

    // Обрыв связи больше не означает конец сетевой игры: NetworkManager сам пробует переподключиться
    // и отдаёт 'disconnect' только когда все попытки исчерпаны.
    this.net.on('linkState', ({ state }) => this.showLinkState(state));
    this.net.on('connectionLost', () => this.showLinkState('reconnecting'));
    this.net.on('disconnect', () => {
      this.showLinkState('failed');
      this.fallbackToSolo();
    });
    this.net.on('resumed', () => this.showLinkState('online'));

    this.net.connect();
    return this.net;
  }

  showLinkState(state) {
    if (state === 'online' || state === 'offline') return this.ui.linkOverlay(null);
    const texts = {
      connecting: ['Подключение…', 'Устанавливаем связь с сервером.'],
      reconnecting: ['Связь потеряна', 'Восстанавливаем соединение. Игра продолжится сама.'],
      failed: ['Не удалось подключиться', 'Проверьте интернет и попробуйте снова.']
    };
    const [title, detail] = texts[state] || texts.connecting;
    this.ui.linkOverlay(state, {
      title,
      detail,
      action: state === 'failed' ? { label: 'В МЕНЮ', onClick: () => this.goHome() } : null
    });
  }

  startSingle(forceNew) {
    const settings = this.ui.singleSettings();
    const seed =
      settings.type === 'daily' && !forceNew ? dailySeed() : forceNew ? randomSeed() : this.menuRandomSeed;
    if (settings.type === 'random') this.menuRandomSeed = seed;
    const spec =
      settings.type === 'daily' && !forceNew
        ? dailyCourseSpec(settings.difficulty)
        : courseSpec(seed, settings.difficulty);
    this.startRace('single', spec);
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
    // Спека кооперативной главы отличается наличием chapterId: уровень собирается из данных,
    // а не генерируется из сида.
    this.course = spec.chapterId
      ? new CoopCourse(this.scene, spec, { quality: this.quality })
      : new Course(this.scene, spec, { quality: this.quality });
    this.lastSpec = this.course.spec;
  }

  buildPreview(spec) {
    this.mode = 'preview';
    this.buildCourse(spec);
    this.player = new Player(this.scene, this.course, this.effects, {
      remote: true,
      color: COLORS.pink,
      accent: COLORS.yellow
    });
    this.player.teleport(this.course.spawnFor(0));
    this.camera.position.set(10, 7, 17);
    this.camera.lookAt(0, 1, -7);
    this.state.transition(APP_STATE.MENU);
  }

  async startRace(mode, spec, startAt = Date.now() + 1900, slots = null) {
    const token = ++this.startToken;
    this.mode = mode;
    // Ролей нет; «место» определяет только точку появления, чтобы игроки не стояли в одной точке.
    if (mode === 'coop') {
      this.coop.start({
        selfId: this.net?.id,
        slots,
        partnerAway: this.room?.players.some(p => p.id !== this.net?.id && p.away)
      });
    } else {
      this.coop.reset();
    }
    // Времена кадров меню ничего не говорят о трассе: там пустая сцена и один персонаж.
    this.perf.reset();
    this.running = false;
    this.accumulator = 0;
    this.buildCourse(spec);
    // Пока связь цела, забег идёт в зачёт. Сессия хранит причину, по которой он перестал.
    this.session.start({ mode, spec: this.course.spec, startedAt: startAt });

    // Цвет персонажа зависит от роли: игрок должен узнавать себя и напарника мгновенно.
    const myColor = mode === 'coop' ? (this.coop.mySlot === 1 ? COLORS.orange : COLORS.cyan) : COLORS.pink;
    this.player = new Player(this.scene, this.course, this.effects, {
      color: myColor,
      accent: COLORS.yellow,
      sfx: this.sfx,
      // Модификатор дня меняет и мир, и управление. Мир его читает из spec сам, а игроку правило
      // передаётся здесь — одним источником, чтобы описание в лобби и ощущение в забеге не разошлись.
      modifier: this.course.spec.modifier || null,
      onCheckpoint: index => this.ui.checkpoint(index, this.course.spec.segmentCount),
      onRespawn: checkpoint => {
        if (mode !== 'single' && this.net?.matchId)
          this.net.send('respawn', { matchId: this.net.matchId, checkpoint });
      },
      onFinish: () => this.localFinish()
    });

    if (mode === 'coop') {
      const start = coopSpawnFor(this.course.spec, 0, this.coop.mySlot);
      this.player.teleport(new THREE.Vector3(start.x, start.y, start.z));
      this.ui.coopIntro(this.course.spec);
    }
    this.cameraController.reset(this.player, true);
    this.state.transition(APP_STATE.COUNTDOWN, {
      multiplayer: mode !== 'single',
      coop: mode === 'coop',
      touch: this.input.activeMethod === 'touch'
    });
    this.input.reset();
    this.input.enabled = false;

    // Момент старта приходит в СЕРВЕРНОМ времени. Сравнивать его с локальными часами нельзя —
    // именно из-за этого фаза препятствий раньше расходилась у разных игроков.
    this.audio.unlock();
    this.music.start();
    this.music.setIntensity(0);

    await this.ui.countdown(startAt, {
      now: () => this.raceNow(),
      onTick: value => this.sfx.countdown(value === 'ВПЕРЁД!')
    });
    if (token !== this.startToken) return;

    this.state.transition(APP_STATE.RACE);
    this.ui.toast(`${courseName(this.course.spec.seed)} — ВПЕРЁД!`);
  }

  // Сетевой ли сейчас режим. И гонка, и кооператив идут по сети и одинаково нуждаются в
  // отправке состояния, синхронизации часов и списке удалённых игроков.
  get online() {
    return this.mode === 'multi' || this.mode === 'coop';
  }

  // Единое «сейчас»: в сетевом режиме — оценка серверного времени, в одиночном — локальное.
  raceNow() {
    return this.online && this.net ? this.net.serverNow() : Date.now();
  }

  // Вернуть игрока туда, где его всё это время видел сервер.
  //
  // Вызывается после `startRace` при возвращении в уже идущий забег. Уровень к этому моменту
  // построен заново — это нормально, геометрия детерминирована, — но персонаж стоит на старте,
  // а сервер помнит его в середине главы. Без переноса возникает расхождение, которое сервер
  // тут же исправит коррекцией: игрока дёрнет обратно, и он не поймёт, что произошло.
  restoreRun({ position, checkpoint = 0, finished = false, downed = false }) {
    if (!this.player) return;
    this.player.checkpoint = Math.max(this.player.checkpoint, checkpoint);
    if (position) {
      this.player.respawn(new THREE.Vector3(position.x, position.y, position.z), false);
    }
    this.player.downed = downed;
    if (!finished) return;

    // Финишировавший не должен снова оказаться на трассе: для сервера он уже дошёл, и повторный
    // финиш тот не примет. Возвращаем его в то состояние, в котором он был до обрыва, — ожидание.
    this.player.finished = true;
    this.running = false;
    this.input.enabled = false;
    this.music.setIntensity(0);
    if (this.mode === 'coop') this.ui.awaitPartnerFinish();
    else this.ui.toast('Вы уже финишировали — ждём остальных.');
  }

  localFinish() {
    const time = this.session.finish(this.raceNow());
    this.postFX.pulse(1);
    if (this.mode === 'single') {
      this.state.transition(APP_STATE.RESULTS);
      this.music.setIntensity(0);
      this.ui.finishSolo({
        time,
        respawns: this.player.respawns,
        dashes: this.player.dashes,
        hits: this.player.hits,
        spec: this.course.spec,
        unranked: this.session.unranked,
        serverBest: this.serverRecordFor('solo', this.course.spec)
      });
      // Забег без зачёта рекордом не считается — ни локально, ни на сервере.
      if (!this.session.unranked) this.saveServerRecord('solo', this.course.spec, time);
    } else {
      this.input.enabled = false;
      // Финиш вместе с последним состоянием — одной операцией. Отдельная отправка позиции
      // отставала на кадр и приводила либо к отказу сервера, либо к хвостовому пакету после
      // перехода комнаты в «результаты».
      this.net?.finish(this.player.snapshot(), time);
      this.ui.toast('Финиш! Подтверждаем результат…');
    }
  }

  // Создание и удаление моделей удалённых игроков. Сами позиции берутся не отсюда, а из буфера
  // снапшотов в момент отрисовки — см. updateRemotes.
  syncRemoteRoster() {
    if (!this.net || !this.course) return;
    const active = new Set(this.net.snapshots.activeIds());
    for (const id of active) {
      if (id === this.net.id || this.remotes.has(id)) continue;
      const info = this.room?.players.find(p => p.id === id);
      this.remotes.set(
        id,
        new Player(this.scene, this.course, this.effects, {
          remote: true,
          color:
            this.mode === 'coop'
              ? this.coop.slotFor(id) === 1
                ? COLORS.orange
                : COLORS.cyan
              : info?.color || COLORS.cyan,
          accent: COLORS.yellow,
          name: info?.name || 'Wobbler'
        })
      );
    }
    for (const [id, remote] of this.remotes) {
      if (active.has(id)) continue;
      remote.dispose();
      this.remotes.delete(id);
    }
  }

  // Уровень детализации удалённых игроков по расстоянию до камеры.
  //
  // В кооперативе игроков всего двое и напарник почти всегда рядом — здесь это почти не работает.
  // Смысл появляется в гонке на шестнадцать человек: на старте все в кадре, и полтора десятка
  // анимированных персонажей с тенями — самая дорогая часть кадра на телефоне. Дальше половина
  // из них растягивается по трассе и превращается в силуэты, которым подробности не нужны.
  //
  // Пороги умышленно грубые, с большим зазором между ступенями: персонаж, стоящий ровно на
  // границе, иначе переключался бы туда-сюда каждый кадр, и это было бы заметно как мерцание.
  remoteDetail(position) {
    const distance = this.camera.position.distanceTo(position);
    if (distance < 24) return 'full';
    if (distance < 52) return 'simple';
    return 'minimal';
  }

  updateRemotes(dt) {
    if (!this.net) return;
    const renderTime = this.net.renderTime();
    for (const [id, remote] of this.remotes) {
      remote.applyRemote(
        this.net.snapshots.sample(id, renderTime),
        dt,
        this.remoteDetail(remote.visualPosition)
      );
    }
  }

  // Забег перестал идти в зачёт. Причина запоминается до конца матча: восстановленная связь
  // рекорд не возвращает — половину главы всё равно прошли не вдвоём.
  markUnranked(reason) {
    if (!this.session.markUnranked(reason)) return;
    this.ui.toast(
      reason === 'left'
        ? 'Напарник вышел — забег больше не идёт в зачёт.'
        : 'Соединение потеряно — результат не попадёт в таблицу.'
    );
  }

  receiveFinish(message) {
    this.latestBoard = message.board || [];
    if (message.unranked) this.markUnranked(message.unranked);
    if (message.id !== this.net.id) {
      if (!document.querySelector('#finish').classList.contains('hidden'))
        this.ui.updateBoard(this.latestBoard, this.net.id);
      return;
    }
    this.session.confirmFinish(message.time);
    this.state.transition(APP_STATE.RESULTS);
    this.music.setIntensity(0);
    // В коопе свой финиш — ещё не конец главы: она засчитывается, только когда дошли оба.
    // Карточку показывает `results`, а до тех пор игрок ждёт напарника, а не смотрит на итоги.
    if (this.mode === 'coop') {
      this.ui.awaitPartnerFinish();
      return;
    }
    const raceTime = message.time ?? this.session.finalTime;
    this.ui.finishMulti({
      time: raceTime,
      board: this.latestBoard,
      selfId: this.net.id,
      unranked: this.session.unranked
    });
    if (!this.session.unranked) this.saveServerRecord('race', this.course?.spec, raceTime);
  }

  // Итоги матча. В гонке карточка уже показана по своему финишу, здесь только доска обновляется;
  // в коопе это и есть момент, когда глава считается пройденной.
  receiveResults(message) {
    if (message.unranked) this.markUnranked(message.unranked);
    this.latestBoard = message.board || this.latestBoard || [];
    if (this.mode !== 'coop') {
      if (!document.querySelector('#finish').classList.contains('hidden'))
        this.ui.updateBoard(this.latestBoard, this.net.id);
      return;
    }
    this.state.transition(APP_STATE.RESULTS);
    this.music.setIntensity(0);
    const coopTime = message.coopTime ?? this.session.finalTime;
    if (!this.session.unranked) this.saveServerRecord('coop', this.course?.spec, coopTime);
    this.ui.finishCoop({
      time: coopTime,
      chapter: this.course?.spec || null,
      board: this.latestBoard,
      selfId: this.net?.id,
      revives: this.coop.revives,
      matchId: this.net?.matchId,
      unranked: this.session.unranked,
      serverBest: this.serverRecordFor('coop', this.course?.spec)
    });
  }

  fallbackToSolo() {
    if (this.mode === 'coop') {
      // В кооперативе продолжать в одиночку бессмысленно: главу физически не пройти одному.
      this.running = false;
      this.input.enabled = false;
      this.ui.error('Связь с напарником потеряна. Главу вдвоём придётся начать заново.');
      return;
    }
    if (this.mode !== 'multi' || !this.player || this.player.finished) return;
    // Гонка доигрывается в одиночку — но именно доигрывается, а не превращается в честный
    // одиночный забег: время без соперников в личные рекорды не идёт.
    this.markUnranked('connection');
    const serverNow = this.raceNow();
    this.mode = 'single';
    this.session.switchClock(serverNow, Date.now());
    for (const remote of this.remotes.values()) remote.dispose();
    this.remotes.clear();
    this.ui.hud(true, { multiplayer: false, touch: this.input.activeMethod === 'touch' });
    this.ui.error('Связь потеряна — забег продолжается в одиночном режиме.');
    this.net = null;
  }

  goHome() {
    this.startToken++;
    this.running = false;
    this.input.enabled = false;
    this.music.stop();
    this.audio.setMuffle(0);
    this.net?.close();
    this.net = null;
    this.room = null;
    this.ready = false;
    this.ui.racing = false;
    this.ui.elements.hud.classList.add('hidden');
    this.ui.elements.touch.classList.add('hidden');
    this.ui.linkOverlay(null);
    const settings = this.ui.singleSettings();
    this.previewSpec =
      settings.type === 'daily'
        ? dailyCourseSpec(settings.difficulty)
        : courseSpec(this.menuRandomSeed, settings.difficulty);
    this.ui.preview(this.previewSpec);
    this.buildPreview(this.previewSpec);
  }

  installLifecycle() {
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    document.addEventListener('visibilitychange', () => (document.hidden ? this.suspend() : this.wake()));
    // На iOS `visibilitychange` при переключении приложения срабатывает не всегда, а `pagehide`
    // срабатывает. Дублирующий вызов безвреден: `suspend` идемпотентен.
    addEventListener('pagehide', () => this.suspend());
    addEventListener('pageshow', () => {
      if (!document.hidden) this.wake();
    });
  }

  // Игру свернули. Задача — ничего не делать в фоне и предупредить напарника.
  suspend() {
    if (this.hiddenAt) return;
    this.hiddenAt = Date.now();
    this.input.reset();
    this.audio.setSuspended(true);
    this.net?.sendPresence(true);
  }

  // Вернулись. Главное здесь — не сделать вид, что прошедшего времени не было.
  wake() {
    if (!this.hiddenAt) return;
    const hiddenMs = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    this.audio.setSuspended(false);
    this.net?.sendPresence(false);

    // Пока вкладка была скрыта, кадры не шли. В одиночном режиме сдвигаем момент старта, чтобы
    // таймер не насчитал время простоя. В сетевом этого делать нельзя — там время серверное.
    if (this.mode === 'single' && this.running) this.session.shiftStart(hiddenMs);

    // Накопленное время выбрасываем целиком. Иначе первый же кадр после возвращения потратит все
    // разрешённые подшаги на симуляцию простоя — игрок увидит, как персонаж дёргается вперёд.
    this.accumulator = 0;
    this.resumedFrame = true;

    if (hiddenMs < WAKE_RESYNC_MS || !this.net) return;
    // После долгого сна оценка часов и история снапшотов описывают уже не ту реальность.
    // Историю чистим, чтобы напарник встал на своё текущее место, а не проигрывал прошлое;
    // часы переоцениваем заново.
    this.net.snapshots.clear();
    this.net.resyncClock();
  }

  resize() {
    const width = Math.max(1, innerWidth);
    const height = Math.max(1, innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.postFX?.setSize(width, height);
    this.applyRendererQuality();
  }

  placement() {
    const selfId = this.net?.id || 'self';
    const racers = [{ id: selfId, checkpoint: this.player.checkpoint, z: this.player.position.z }];
    for (const [id, remote] of this.remotes) {
      racers.push({ id, checkpoint: remote.checkpoint, z: remote.position.z });
    }
    racers.sort((a, b) => b.checkpoint - a.checkpoint || a.z - b.z);
    return racers.findIndex(r => r.id === selfId) + 1;
  }

  // Время с начала забега, по которому считается фаза всех препятствий.
  courseElapsed() {
    if (this.mode === 'preview') return performance.now() / 1000;
    return this.session.elapsed(this.raceNow()) / 1000;
  }

  // Один шаг симуляции. Всегда с постоянным dt.
  // Состояние кооп-объектов выводится из позиций обоих игроков — обе у нас уже есть.
  coopActors() {
    const actors = [];
    if (this.player && this.net) {
      actors.push({
        id: this.net.id,
        position: this.player.position,
        velocity: this.player.velocity,
        grounded: this.player.grounded,
        downed: this.player.downed
      });
    }
    for (const [id, remote] of this.remotes) {
      actors.push({
        id,
        position: remote.position,
        velocity: remote.velocity,
        grounded: false,
        downed: remote.downed
      });
    }
    return actors;
  }

  // Кооперативные действия. Удар сверху повешен на ту же кнопку, что и рывок: на телефоне нельзя
  // множить кнопки, а на земле и в воздухе смысл нажатия и так разный.
  updateRoleActions() {
    if (this.mode !== 'coop' || !this.player) return;
    updateRoleActions(this.player, this.course, this.input, this.cameraController.yaw, {
      onSlam: () => {
        this.sfx.slam();
        this.cameraController.addShake(0.3);
      },
      onCatapult: id => this.triggerCatapult(id)
    });
  }

  triggerCatapult(catapultId) {
    const { actor, catapult } = this.course.launchCandidate(catapultId, this.coopActors());
    this.course.triggerCatapultVisual(catapultId);
    this.cameraController.addShake(0.6);
    this.sfx.catapult(this.player.visualPosition);
    this.effects.burst(this.player.position, COLORS.yellow, 20, 1.3);
    if (!actor || actor.id === this.net.id) return;
    // Импульс считает инициатор, применяет — цель. Сервер ограничивает модуль и ретранслирует:
    // это единственное место, где один игрок меняет состояние другого.
    this.net?.sendCoopEvent('launch', {
      objectId: catapultId,
      vector: { x: 0, y: catapult.power, z: -catapult.power * catapult.forward }
    });
  }

  receiveCoopEvent(message) {
    if (!this.course || this.mode !== 'coop') return;
    const effect = this.coop.applyEvent(message);
    if (effect?.type === 'launch-self') {
      this.player?.applyLaunch(effect.vector);
      this.sfx.catapult();
      this.cameraController.addShake(0.5);
      return;
    }
    if (effect?.type === 'down-self') {
      this.player?.goDown(this.player.position);
      return;
    }
    if (effect?.type === 'revive-self') {
      this.player?.revive();
      this.sfx.revive();
    } else if (effect?.type === 'revive-partner') {
      this.sfx.revive(this.remotes.values().next().value?.visualPosition);
    }
  }

  // Оживление напарника прикосновением. Проверка простая: подошёл достаточно близко.
  tryRevivePartner() {
    if (this.mode !== 'coop') return;
    const partner = this.remotes.values().next().value;
    if (!partner) return;
    if (
      !this.coop.canRevive({
        localDowned: this.player?.downed,
        distance: this.player.position.distanceTo(partner.position)
      })
    )
      return;
    this.net?.sendCoopEvent('revive');
  }

  fixedStep(dt) {
    const elapsed = this.courseElapsed();
    // Препятствия обновляются ДО игрока: перенос движущейся платформой считается по её сдвигу
    // за этот шаг, и игрок должен увидеть уже новую позицию платформы.
    this.course?.update(dt, elapsed, this.mode === 'preview' ? null : this.sfx);
    if (!this.running || !this.player || this.mode === 'preview') return;
    this.input.update();
    if (this.mode === 'coop') {
      const actors = this.coopActors();
      // Пересчёт до шага игрока: пролёт должен появиться раньше, чем по нему пойдут.
      this.course.updateCoop(actors, this.raceNow(), this.sfx);
      this.updateRoleActions();
      this.tryRevivePartner();
      // Подсказка обучения — после пересчёта состояния: решённая задача должна убрать её
      // в том же кадре, а не в следующем.
      const lesson = this.course.activeLesson(actors);
      this.ui.coopLesson(lesson ? lesson.text : null);
    }
    // Упавший ждёт напарника и не управляется.
    if (!this.player.downed) this.player.step(dt, this.input, this.cameraController.yaw, elapsed);

    // Удары, накопленные препятствиями за шаг, уходят в тряску камеры. Препятствия про камеру
    // не знают — они только помечают силу удара на игроке, и это единственная причина, по которой
    // их можно гонять ботами без сцены.
    if (this.player.impact > 0) {
      this.cameraController.addShake(this.player.impact);
      this.player.impact = 0;
    }
  }

  loop(time) {
    // Первый кадр после возвращения из фона: между ним и предыдущим прошли минуты, и брать эту
    // разницу за длительность кадра нельзя ни для физики, ни для частиц. Считаем его обычным.
    if (this.resumedFrame) {
      this.resumedFrame = false;
      this.clockLast = time - FIXED_DT * 1000;
    }
    const rawFrameMs = time - this.clockLast;
    const frameDt = Math.min(0.25, Math.max(0.0001, rawFrameMs / 1000));
    this.clockLast = time;

    // Бюджет считается по фактическому промежутку между кадрами, а не по времени нашего кода.
    // Разница принципиальна: отрисовка возвращает управление раньше, чем видеокарта закончит
    // работу, поэтому «наше» время может укладываться в бюджет, пока игра идёт в тридцать кадров.
    // Промежуток между кадрами врать не умеет — он и есть то, что видит игрок.
    //
    // Сон вкладки из замеров исключён: первый кадр после возвращения покажет минуты и утащил бы
    // качество вниз ни за что.
    if (rawFrameMs > 0 && rawFrameMs < 250) this.perf.sample(rawFrameMs);

    // Аккумулятор фиксированного шага: физика всегда идёт одинаковыми порциями времени независимо
    // от частоты кадров. Раньше в неё подавалась дельта кадра, и высота прыжка на 144 Гц отличалась
    // от высоты на 60 Гц — игра буквально вела себя по-разному на разных мониторах.
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.fixedStep(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    const alpha = this.accumulator / FIXED_DT;

    this.effects.update(frameDt);
    this.postFX.update(frameDt);
    this.state.update(frameDt);

    if (this.mode === 'preview' && this.player) {
      this.player.character.animate(frameDt, { speed: 0, grounded: true });
      const angle = time * 0.00007;
      this._previewTarget.set(Math.sin(angle) * 12, 7.3, 10 + Math.cos(angle) * 5);
      this.camera.position.lerp(this._previewTarget, 1 - Math.exp(-2 * frameDt));
      this.camera.lookAt(0, 1, -7);
      this.updateShadow(this.player.visualPosition);
    } else if (this.player) {
      this.player.render(alpha);

      if (this.online && this.net) {
        // Финишировавший больше не участвует в забеге, и его позиция никому не нужна.
        if (!this.player.finished) this.net.sendState(this.player.snapshot());
        this.net.tick();
        this.syncRemoteRoster();
      }
      this.updateRemotes(frameDt);

      this.cameraController.update(frameDt, this.player, this.input, this.course, this.partnerPosition());
      this.updateShadow(this.player.visualPosition);
      this.updateAudioScene();
      if (this.mode === 'coop') this.updatePartnerMarker();

      const elapsed = this.session.elapsed(this.raceNow());
      this.ui.updateHud({
        time: elapsed,
        checkpoint: this.player.checkpoint,
        total: this.course.spec.segmentCount,
        progress: this.course.progress(this.player.position, this.player.checkpoint),
        stage: this.course.stageAt(this.player.checkpoint),
        place: this.mode === 'multi' ? this.placement() : null,
        link: this.net ? { quality: this.net.quality, latency: this.net.latency } : null
      });
    }

    this.postFX.render();
    this.state.render(alpha);
    this.updateAdaptiveQuality(time);
    this.perf.paint(time, this.renderer, {
      качество: this.qualityChoice === 'auto' ? `авто (${this.autoQuality})` : this.qualityChoice,
      напарников: this.remotes.size
    });
    requestAnimationFrame(next => this.loop(next));
  }

  // Экранное положение напарника для указателя. Пока он в кадре, указатель скрыт: лишняя
  // стрелка поверх видимого персонажа только загромождает экран.
  updatePartnerMarker() {
    const partner = this.remotes.values().next().value;
    if (!partner || !this.player) {
      this.ui.updatePartnerMarker({ screen: null });
      return;
    }
    const world = this._marker.copy(partner.visualPosition).setY(partner.visualPosition.y + 1.6);
    const projected = world.project(this.camera);
    // z > 1 означает, что точка позади камеры — проекция там зеркалится, и стрелку надо развернуть.
    const behind = projected.z > 1;
    const x = ((behind ? -projected.x : projected.x) * 0.5 + 0.5) * innerWidth;
    const y = ((behind ? -projected.y : -projected.y) * 0.5 + 0.5) * innerHeight;
    const onScreen =
      !behind && projected.x > -0.92 && projected.x < 0.92 && projected.y > -0.92 && projected.y < 0.92;
    this.ui.updatePartnerMarker({
      screen: { x, y },
      visible: onScreen,
      distance: this.player.visualPosition.distanceTo(partner.visualPosition),
      down: this.coop.partnerDown,
      away: this.coop.partnerAway
    });
  }

  // Позиция напарника для кооп-кадрирования камеры. В гонке возвращает null: подстраивать кадр
  // под произвольного соперника не нужно, это только мешало бы целиться в прыжок.
  partnerPosition() {
    if (this.mode !== 'coop') return null;
    const partner = this.remotes.values().next().value;
    return partner ? partner.visualPosition : null;
  }

  updateAudioScene() {
    if (!this.audio.ready) return;
    // Слушатель — это камера: панорама звуков напарника считается относительно направления взгляда.
    this.audio.setListener(this.camera.position, this.cameraController.yaw);

    // Приглушение при падении: чем ниже игрок провалился, тем сильнее срезаются верхние частоты.
    const depth = Math.max(0, -this.player.position.y) / 8;
    this.audio.setMuffle(Math.min(1, depth));

    // Музыка нарастает по мере прохождения трассы.
    if (this.running) {
      this.music.setIntensity(this.course.progress(this.player.position, this.player.checkpoint));
    }

    // Сигнал упавшего напарника слышен на любом расстоянии.
    for (const remote of this.remotes.values()) {
      if (remote.position.y < -4) this.sfx.bubble(remote.visualPosition);
    }
  }
}

let game;
try {
  game = new Game();
  window.__WOBBLE_GAME__ = game;
} catch (error) {
  const panel = document.querySelector('#error');
  panel.textContent = `Не удалось запустить 3D-графику: ${error.message}. Проверьте, включён ли WebGL.`;
  panel.classList.remove('hidden');
  document.querySelector('#loading')?.classList.add('hidden');
  console.error(error);
}
