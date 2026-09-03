import * as THREE from 'three';
import { COLORS, courseName, courseSpec, dailyCourseSpec, dailySeed, randomSeed } from './core/Config.js';
import { InputManager } from './core/InputManager.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { Sfx } from './audio/sfx.js';
import { Music, MUSIC_MODE } from './audio/Music.js';
import { Effects } from './game/Effects.js';
import { Course } from './game/Course.js';
import { CoopCourse } from './game/CoopCourse.js';
import { coopSpawnFor } from '/shared/coopChapters.js';
import { GAME_MODE } from '/shared/protocol.js';
import { Player } from './game/Player.js';
import { resolvePlayerCrowd } from './game/PlayerCollisions.js';
import { resolveTether } from './game/CoopSignatureMechanics.js';
import { raceUnrankedReason } from './game/ResultsPresentation.js';
import { CameraController } from './game/CameraController.js';
import { PostFX } from './game/PostFX.js';
import { NetworkManager } from './net/NetworkManager.js';
import { bindNetwork } from './net/networkBindings.js';
import { Perf } from './core/Perf.js';
import { Quality } from './core/Quality.js';
import { UI } from './ui/UI.js';
import { bindMenu } from './ui/menuBindings.js';
import { APP_STATE, createAppStates } from './core/AppStates.js';
import { StateRouter } from './core/StateRouter.js';
import { RaceSession } from './game/RaceSession.js';
import { CoopSession } from './game/CoopSession.js';
import { CoopController } from './game/CoopController.js';
import { AccountFlow } from './core/AccountFlow.js';
import { resolvePlatform, supportsOnlinePlay } from './core/PlatformResolver.js';
import { applyOnlinePlayGate } from './core/onlinePlayGate.js';
import { cosmeticLoadoutFromIds } from './core/cosmetics.js';
import { racersStillRunning, spectateTarget } from './core/spectate.js';
import { Settings } from './core/settings.js';
import { SettingsPanel } from './ui/settingsPanel.js';

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
    // Настройки создаются до ввода и камеры: обе спрашивают их с первого кадра, а применить
    // раскладку задним числом — значит показать игроку чужую и переставить у него под руками.
    this.settings = new Settings();
    this.settings.apply();
    this.input = new InputManager(this.canvas, document, this.settings);
    this.input.enabled = false;
    this.state = new StateRouter(this, createAppStates());
    this.session = new RaceSession();
    this.coop = new CoopSession();
    this.coopControl = new CoopController(this);
    // Площадка определяется один раз при старте и дальше только читается: сборка объявила её файлом
    // `platform-config.js`, и меняться в течение сессии ей неоткуда.
    //
    // Шлюз отрабатывает ЗДЕСЬ, а не в `pwa-entry.js`: тот исполняется позже и как раз поднимает
    // меню, которому уже не должно достаться онлайн-вкладок.
    this.platform = resolvePlatform();
    this.onlinePlay = supportsOnlinePlay(this.platform);
    applyOnlinePlayGate(this.platform);

    this.account = new AccountFlow(this);
    this.ui.onCosmeticChange = () => {
      if (this.mode === 'preview' && this.previewSpec) this.buildPreview(this.previewSpec);
    };

    this.clockLast = performance.now();
    this.accumulator = 0;
    this.running = false;
    this.mode = 'preview';
    this.remotes = new Map();
    this.startToken = 0;
    // Досмотр: свой забег кончился, гонка — нет. Управление снято, трасса на экране осталась.
    this.spectating = false;
    this.spectateId = null;
    this.finishedPlace = null;
    this.finishedTime = null;
    // Итоги открыты досрочно: гонка идёт, и выбор на карточке пока не имеет силы.
    this.resultsPending = false;
    this.menuRandomSeed = randomSeed();
    this.quality = new Quality();
    this.perf = new Perf({ enabled: new URL(location.href).searchParams.has('perf') });

    this.audio = new AudioEngine();
    this.sfx = new Sfx(this.audio);
    this.music = new Music(this.audio);
    // Шкафу нужны те же процедурные сигналы и та же настройка уменьшенной анимации, что и
    // остальной игре: отдельного звукового движка и отдельного переключателя у косметики нет.
    this.ui.sfx = this.sfx;
    this.ui.settings = this.settings;

    this.createRenderer();
    this.createScene();
    this.cameraController = new CameraController(this.camera, this.settings);
    this.postFX = new PostFX(this.renderer, this.scene, this.camera, this.detectQuality());
    this.effects = new Effects(this.scene, this.detectQuality());

    bindMenu(this);
    // Панель создаётся после привязки меню: её кнопка живёт в подвале меню, и порядок здесь —
    // не эстетика, а условие того, что кнопка вообще найдётся.
    this.settingsPanel = new SettingsPanel(this.settings);
    this.installAudioUnlock();
    this.installLifecycle();

    // Вход в аккаунт не блокирует запуск игры: сеть может отвечать долго или не отвечать вовсе,
    // а меню должно появиться сразу. Имя и рекорды подставятся, когда ответ придёт.
    //
    // Обещание сохраняем: вход в комнату его дожидается. Иначе игрок, нажавший «создать комнату» в
    // первые мгновения после загрузки, попадал бы туда без личности — и его результат не привязался
    // бы к аккаунту.
    //
    // На площадке входа нет вовсе: наш сервер однодоменный, и запрос ушёл бы на чужой адрес, дав
    // только 404 в консоли и ложное «сервер не ответил» в интерфейсе. Без аккаунта `save()` сама
    // ничего не отправляет, а личные рекорды пишет `UI` в localStorage, поэтому одиночная игра от
    // этого не теряет ничего. Обещание держим разрешённым, чтобы ожидающие его места не зависли.
    this.accountReady = this.onlinePlay ? this.account.signIn() : this.account.applyGuestState();

    this.previewSpec = dailyCourseSpec('normal');
    this.buildPreview(this.previewSpec);
    // Приглашение и восстановление сессии — оба про сетевую игру, и оба поднимают сокет. На
    // площадке он всё равно не откроется (`originAllowed` пускает только свой origin), поэтому
    // единственным их следствием была бы вечная «переподключаемся» поверх одиночной игры.
    if (this.onlinePlay) this.handleInvite();
    // После полной перезагрузки в URL уже нет invite-параметров, но sessionStorage хранит токен.
    // Подключаем сеть без нового клика, иначе клиент так и останется в меню и не отправит resume.
    if (this.onlinePlay && NetworkManager.hasSavedSession()) this.ensureNetwork();
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

  // Автоподстройка качества по бюджету кадра.
  //

  // Рамка теней следует за игроком.
  //

  // Действующее качество: выбор игрока, а в режиме «auto» — результат измерения.
  detectQuality() {
    return this.quality.effective();
  }

  // Применить действующее качество к тому, что его использует. Решение принимает Quality, здесь
  // только последствия: плотность пикселей, тени, постобработка, лимит частиц.
  applyRendererQuality() {
    const level = this.detectQuality();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, level === 'low' ? 1 : 1.65));
    this.renderer.shadowMap.enabled = level === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.postFX?.setQuality(level);
    // Частицы создаются с лимитом под качество и раньше не пересоздавались при его смене:
    // переключение на высокое качество не давало эффекта до перезагрузки страницы.
    if (this.effects && this.effects.quality !== level) this.effects.setQuality(level);
  }

  // Автоподстройка по бюджету кадра. Решение и сообщение игроку — разные вещи: первое считает
  // Quality по замерам Perf, второе делает игра, потому что тостами занимается она.
  updateAdaptiveQuality(now) {
    const changed = this.quality.adapt(now, { running: this.running, perf: this.perf });
    if (!changed) return;
    this.applyRendererQuality();
    this.ui.toast(changed === 'low' ? 'Качество снижено — держим плавность.' : 'Качество повышено.');
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
  }
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
  resize() {
    const width = Math.max(1, innerWidth);
    const height = Math.max(1, innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.postFX?.setSize(width, height);
    this.applyRendererQuality();
  }

  // Браузер не позволяет запустить звук до первого действия пользователя. Слушаем первое
  // касание, клик или нажатие клавиши и на нём инициализируем аудио.
  installAudioUnlock() {
    const unlock = () => {
      this.audio.unlock();
      const racePresentation = [
        APP_STATE.COUNTDOWN,
        APP_STATE.RACE,
        APP_STATE.SPECTATE,
        APP_STATE.RESULTS
      ].includes(this.state.name);
      this.music.start(racePresentation ? MUSIC_MODE.RACE : MUSIC_MODE.MENU);
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
  }

  // --- аккаунт --------------------------------------------------------------------------------

  ensureNetwork() {
    if (this.net) return this.net;
    this.net = new NetworkManager(this.ui);
    bindNetwork(this);
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
      ? new CoopCourse(this.scene, spec, { quality: this.detectQuality() })
      : new Course(this.scene, spec, { quality: this.detectQuality() });
    this.lastSpec = this.course.spec;
  }

  buildPreview(spec) {
    this.mode = 'preview';
    this.buildCourse(spec);
    this.player = new Player(this.scene, this.course, this.effects, {
      remote: true,
      color: COLORS.pink,
      accent: COLORS.yellow,
      cosmetics: this.ui.cosmeticLoadout()
    });
    this.player.teleport(this.course.spawnFor(0));
    this.camera.position.set(10, 7, 17);
    this.camera.lookAt(0, 1, -7);
    this.state.transition(APP_STATE.MENU);
    // До первого жеста start только запоминает режим; после возврата из гонки контекст уже
    // разблокирован, и та же строка сразу поднимает спокойную тему меню.
    this.music.start(MUSIC_MODE.MENU);
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
    this.endSpectate();
    this.accumulator = 0;
    this.buildCourse(spec);
    // Состав комнаты мог прийти РАНЬШЕ, чем построен уровень: так бывает при возвращении в идущий
    // матч, где напарник уже ушёл. Тогда обновление состава ушло в пустоту, и глава начиналась бы
    // с закрытыми преградами, которые открыть некому.
    this.coopControl.refreshSolo();
    // Пока связь цела, забег идёт в зачёт. Сессия хранит причину, по которой он перестал.
    this.session.start({ mode, spec: this.course.spec, startedAt: startAt });

    // Цвет персонажа зависит от роли: игрок должен узнавать себя и напарника мгновенно.
    const myColor = mode === 'coop' ? (this.coop.mySlot === 1 ? COLORS.orange : COLORS.cyan) : COLORS.pink;
    this.player = new Player(this.scene, this.course, this.effects, {
      color: myColor,
      accent: COLORS.yellow,
      cosmetics: this.ui.cosmeticLoadout(),
      sfx: this.sfx,
      haptics: this.settings,
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
    this.music.start(MUSIC_MODE.RACE);
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
    if (this.mode === 'coop') {
      this.ui.awaitPartnerFinish();
      return;
    }
    // Вернувшийся в уже пройденный им забег попадает туда же, куда попал бы, не обрываясь, —
    // на досмотр. Раньше он получал всплывающую подсказку и оставался с ней наедине: карточка
    // итогов по концу матча ему не показывалась вовсе, потому что показывать было некуда.
    this.ui.toast('Вы уже финишировали — досматриваем гонку.');
    this.beginSpectate();
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
        serverBest: this.account.recordFor('solo', this.course.spec)
      });
      // Забег без зачёта рекордом не считается — ни локально, ни на сервере.
      if (!this.session.unranked) this.account.save('solo', this.course.spec, time);
    } else {
      this.input.enabled = false;
      // Финиш вместе с последним состоянием — одной операцией. Отдельная отправка позиции
      // отставала на кадр и приводила либо к отказу сервера, либо к хвостовому пакету после
      // перехода комнаты в «результаты».
      this.net?.finish(this.player.snapshot(), time);
      this.ui.toast('Финиш! Подтверждаем результат…');
    }
  }

  // Победный эффект того, кто финишировал. У удалённого игрока он же, но упрощённый: в комнате на
  // шестнадцать человек шестнадцать полных финишей подряд — это не праздник, а просадка.
  playFinishEffect(playerId) {
    const actor = playerId === this.net?.id ? this.player : this.remotes.get(playerId);
    actor?.character?.cosmetics?.playFinish();
  }

  // Эмоция.
  //
  // Локальный показ идёт сразу и не ждёт сервера: ответ нужен остальным, а не нажавшему. Если
  // предмет не проигрался локально (не выбран, неизвестен), в сеть он не уходит вовсе.
  playEmote(emoteId) {
    if (!emoteId || !this.player) return false;
    if (!this.player.character.playEmote(emoteId)) return false;
    this.sfx?.emote?.();
    this.net?.sendEmote(emoteId);
    return true;
  }

  // Эмоция другого игрока. Сюда приходит уже проверенное сервером событие, но ID всё равно
  // проходит через каталог: доверять форме сообщения и доверять его содержимому — разные вещи.
  receiveEmote(message) {
    if (!message?.id || message.id === this.net?.id) return;
    this.remotes.get(message.id)?.character?.playEmote(message.emoteId);
  }

  // Создание и удаление моделей удалённых игроков. Сами позиции берутся не отсюда, а из буфера
  // снапшотов в момент отрисовки — см. updateRemotes.
  syncRemoteRoster() {
    if (!this.net || !this.course) return;
    const active = new Set(this.net.snapshots.activeIds());
    for (const id of active) {
      if (id === this.net.id) continue;
      const info = this.room?.players.find(p => p.id === id);
      const cosmeticKey = JSON.stringify(info?.loadout || null);
      const current = this.remotes.get(id);
      // На resume MATCH_START может прийти раньше ROOM_STATE. Если модель успела создаться без
      // public profile, пересобираем её один раз, когда authoritative loadout доедет следом.
      if (current && current.socialCosmeticKey !== cosmeticKey) {
        current.dispose();
        this.remotes.delete(id);
      }
      if (this.remotes.has(id)) continue;
      const remote = new Player(this.scene, this.course, this.effects, {
        remote: true,
        color:
          this.mode === 'coop'
            ? this.coop.slotFor(id) === 1
              ? COLORS.orange
              : COLORS.cyan
            : info?.color || COLORS.cyan,
        accent: COLORS.yellow,
        cosmetics: cosmeticLoadoutFromIds(info?.loadout),
        name: info?.name || 'Wobbler'
      });
      remote.socialCosmeticKey = cosmeticKey;
      this.remotes.set(id, remote);
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
    // Победная косметика — презентация ПОСЛЕ подтверждения сервера, а не вместо него. Эффект
    // ничего не объявляет и не меняет: к этому моменту финиш уже засчитан, и решение принято.
    this.playFinishEffect(message.id);
    if (message.id !== this.net.id) {
      if (!document.querySelector('#finish').classList.contains('hidden'))
        this.ui.updateBoard(this.latestBoard, this.net.id);
      return;
    }
    this.session.confirmFinish(message.time);
    // В коопе свой финиш — ещё не конец главы: она засчитывается, только когда дошли оба.
    // Карточку показывает `results`, а до тех пор игрок ждёт напарника, а не смотрит на итоги.
    if (this.mode === 'coop') {
      this.state.transition(APP_STATE.RESULTS);
      this.music.setIntensity(0);
      this.ui.awaitPartnerFinish();
      return;
    }
    const raceTime = message.time ?? this.session.finalTime;
    this.finishedTime = raceTime;
    // Место в гонке определяется в момент финиша и больше не меняется: все, кто ещё бежит,
    // придут позже и встанут ниже. Поэтому его можно показывать сразу, не дожидаясь конца матча.
    const own = this.latestBoard.findIndex(entry => entry.id === this.net.id);
    this.finishedPlace = own < 0 ? null : own + 1;
    // Рекорд сохраняется по своему финишу, а не по концу матча: это личный результат, и он уже
    // известен. Показ итогов может подождать, запись — нет.
    //
    // Условие то же, что и у плашки, и намеренно одно на двоих: разойдись они — игрок увидел бы
    // «без зачёта» при сохранённом рекорде или наоборот. Комнатная причина берётся из сессии,
    // личная — из своей строки доски; `session.unranked` в одиночку тут уже не годится, потому что
    // проверка движения в гонке личная и в сессию больше не попадает.
    const ownEntry = this.latestBoard.find(entry => entry.id === this.net.id);
    if (!raceUnrankedReason(this.session.unranked, ownEntry))
      this.account.save('race', this.course?.spec, raceTime);

    // Гонка продолжается без нас — досматриваем её.
    //
    // Раньше здесь сразу поднималась карточка итогов, и матч заканчивался для игрока в самый
    // интересный момент: чем кончилась борьба позади, он узнавал готовой строкой в таблице.
    // Число ещё бегущих приходит с сервера — сам клиент достоверно посчитать его не может.
    if (message.racing > 0) return this.beginSpectate();
    this.showRaceResults();
  }

  // Свой забег кончился, гонка идёт дальше.
  //
  // Состояние отдельное, а не «результаты с открытым HUD»: в нём физика своего игрока не
  // считается, зато ввод продолжает жить — им поворачивают камеру, — а кадр смотрит на чужой забег.
  beginSpectate() {
    this.spectating = true;
    this.spectateId = null;
    this.spectateShownId = undefined;
    this.state.transition(APP_STATE.SPECTATE);
    this.ui.spectateBegin({ place: this.finishedPlace, time: this.finishedTime });
  }

  endSpectate() {
    if (!this.spectating) return;
    this.spectating = false;
    this.spectateId = null;
    this.spectateShownId = undefined;
    this.ui.spectateEnd();
  }

  // Кто сейчас в кадре. null означает «смотреть не на кого» — камера остаётся на своём игроке.
  spectateActor() {
    const racers = racersStillRunning(this.remotes, this.latestBoard, this.net?.id, this.room?.players);
    this.spectateId = spectateTarget(racers, this.spectateId);
    const actor = this.spectateId ? this.remotes.get(this.spectateId) : null;
    // Подпись обновляется только при смене соперника: перерисовывать её каждый кадр значило бы
    // шестьдесят раз в секунду пересобирать разметку ради неизменного текста.
    if (this.spectateShownId !== this.spectateId) {
      this.spectateShownId = this.spectateId;
      const info = this.room?.players.find(item => item.id === this.spectateId);
      this.ui.spectateWatching(info ? { name: info.name, bot: !!info.bot } : null);
    }
    return actor || null;
  }

  // Карточка итогов гонки. Вызывается либо сразу по своему финишу, если гонка на этом кончилась,
  // либо когда матч завершился, либо когда игрок сам попросил не досматривать.
  //
  // pending — итоги открыты досрочно, гонка ещё идёт. Разница не косметическая: реванш и возврат
  // в лобби сервер принимает только на экране результатов КОМНАТЫ, а она до конца матча остаётся
  // в игре. Показанные в этот момент кнопки не работали бы вовсе — на каждое нажатие приходил бы
  // отказ WRONG_STATE.
  showRaceResults({ pending = false } = {}) {
    this.endSpectate();
    this.resultsPending = pending;
    this.state.transition(APP_STATE.RESULTS);
    this.music.setIntensity(0);
    // Своё время берётся из протокола, если локально его нет. Так бывает у вернувшегося по
    // resume: собственного финиша он не видел, но в таблице тот уже записан.
    const own = this.latestBoard.find(entry => entry.id === this.net?.id);
    this.ui.finishMulti({
      time: this.finishedTime ?? own?.time ?? this.session.finalTime,
      board: this.latestBoard,
      selfId: this.net?.id,
      // Причина «без зачёта» — своя, а не комнатная; разбор в `raceUnrankedReason`.
      unranked: raceUnrankedReason(this.session.unranked, own),
      canChoose: !pending
    });
  }

  // Итоги матча. В гонке карточка уже показана по своему финишу, здесь только доска обновляется;
  // в коопе это и есть момент, когда глава считается пройденной.
  receiveResults(message) {
    if (message.unranked) this.markUnranked(message.unranked);
    this.latestBoard = message.board || this.latestBoard || [];
    if (this.mode !== 'coop') {
      // Матч кончился — досматривать больше нечего, показываем итоги. Открытые досрочно тоже
      // перерисовываем: теперь комната на экране результатов, и выбор наконец имеет силу.
      if (this.spectating || this.resultsPending) return this.showRaceResults();
      if (!document.querySelector('#finish').classList.contains('hidden'))
        this.ui.updateBoard(this.latestBoard, this.net.id);
      return;
    }
    this.state.transition(APP_STATE.RESULTS);
    this.music.setIntensity(0);
    const coopTime = message.coopTime ?? this.session.finalTime;
    if (!this.session.unranked) this.account.save('coop', this.course?.spec, coopTime);
    this.ui.finishCoop({
      time: coopTime,
      chapter: this.course?.spec || null,
      board: this.latestBoard,
      selfId: this.net?.id,
      revives: this.coop.revives,
      receivedRevives: this.coop.receivedRevives,
      downs: this.coop.downs,
      matchId: this.net?.matchId,
      unranked: this.session.unranked,
      serverBest: this.account.recordFor('coop', this.course?.spec),
      hasNextChapter: message.hasNextChapter === true
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

  // Выход из идущего матча.
  //
  // Подтверждение вторым нажатием, а не окном с двумя кнопками. Причина в телефоне: кнопка живёт
  // в HUD рядом с таймером, задеть её большим пальцем легко, и одно случайное касание не должно
  // стоить забега. Отдельное модальное окно решило бы то же самое, но посреди игры оно перекрывает
  // трассу — а игрок в этот момент бежит.
  // «К ИТОГАМ» — для тех, кому досматривать чужой забег незачем.
  //
  // Без этой кнопки досмотр стал бы ловушкой: гонка кончается, когда дошли все, и один
  // задумавшийся соперник держал бы остальных на трассе сколько угодно.
  bindSpectateSkip() {
    const button = document.querySelector('#spectateSkip');
    if (!button) return;
    button.addEventListener('click', () => {
      this.sfx.uiConfirm();
      // Гонка при этом продолжается, поэтому итоги открываются без кнопок выбора: до конца матча
      // сервер их всё равно не примет.
      if (this.spectating) this.showRaceResults({ pending: true });
    });
  }

  bindLeaveMatch() {
    const button = document.querySelector('#leaveMatch');
    if (!button) return;
    const CONFIRM_MS = 3500;
    let armedUntil = 0;
    let timer = null;
    const disarm = () => {
      armedUntil = 0;
      clearTimeout(timer);
      button.textContent = 'ВЫЙТИ';
      button.classList.remove('armed');
    };
    button.addEventListener('click', () => {
      const now = Date.now();
      const confirming = now <= armedUntil;
      if (confirming) this.sfx.uiBack();
      else this.sfx.uiClick();
      if (!confirming) {
        armedUntil = now + CONFIRM_MS;
        button.textContent = 'ТОЧНО?';
        button.classList.add('armed');
        clearTimeout(timer);
        timer = setTimeout(disarm, CONFIRM_MS);
        return;
      }
      disarm();
      this.goHome();
    });
  }

  // Кооператив в одиночку: напарник ушёл насовсем.
  //

  goHome() {
    this.startToken++;
    this.running = false;
    this.endSpectate();
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

  fixedStep(dt) {
    const elapsed = this.courseElapsed();
    // Препятствия обновляются ДО игрока: перенос движущейся платформой считается по её сдвигу
    // за этот шаг, и игрок должен увидеть уже новую позицию платформы.
    this.course?.update(dt, elapsed, this.mode === 'preview' ? null : this.sfx);
    if (!this.player || this.mode === 'preview') return;
    if (!this.running && !this.spectating) return;
    // На досмотре ввод продолжает обрабатываться — им поворачивают камеру, — но шага физики за
    // ним больше не следует: свой забег кончился.
    this.input.update();
    if (!this.running) return;
    if (this.mode === 'coop') {
      const actors = this.coopControl.actors();
      const tether = this.course?.spec?.mechanics?.tether;
      const partner = actors.find(actor => actor.id !== this.net?.id);
      if (tether && partner && !this.player.downed) resolveTether(this.player, partner, dt, tether);
      // Пересчёт до шага игрока: пролёт должен появиться раньше, чем по нему пойдут.
      this.course.updateCoop(actors, this.raceNow(), this.sfx);
      this.coopControl.updateRoleActions();
      this.coopControl.tryRevivePartner();
      // Подсказка обучения — после пересчёта состояния: решённая задача должна убрать её
      // в том же кадре, а не в следующем.
      const lesson = this.course.activeLesson(actors);
      this.ui.coopLesson(lesson ? lesson.text : null);
    }
    // Упавший ждёт напарника и не управляется.
    if (!this.player.downed) this.player.step(dt, this.input, this.cameraController.yaw, elapsed);
    // Удалённые игроки остаются интерполированными «мягкими телами». Толпа мешает занять одну
    // точку и слегка передаёт импульс, но не может жёстко исправлять локальную физику.
    if (this.mode === 'multi' && !this.player.downed) {
      resolvePlayerCrowd(this.player, this.remotes.entries(), dt, this.net?.id);
    }

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
        // Время трассы уходит вместе с состоянием: по нему сервер сверяет опору под игроком с
        // подвижной платформой, а момент приёма пакета для этого не годится.
        if (!this.player.finished)
          this.net.sendState(this.player.snapshot(), { courseTime: this.courseElapsed() });
        this.net.tick();
        this.syncRemoteRoster();
      }
      this.updateRemotes(frameDt);

      // Кого показывает кадр. На досмотре это соперник, который ещё бежит; во всех остальных
      // случаях — свой игрок. Одна переменная на камеру, тени, звук и HUD: разъедься они, зритель
      // смотрел бы на одного, а полосу прогресса видел бы чужую.
      const focus = (this.spectating && this.spectateActor()) || this.player;

      this.cameraController.update(
        frameDt,
        focus,
        this.input,
        this.course,
        this.coopControl.partnerPosition()
      );
      this.updateShadow(focus.visualPosition);
      this.updateAudioScene(focus);
      if (this.mode === 'coop') this.coopControl.updatePartnerMarker();

      const elapsed = this.session.elapsed(this.raceNow());
      this.ui.updateHud({
        time: elapsed,
        checkpoint: focus.checkpoint,
        total: this.course.spec.segmentCount,
        progress: this.course.progress(focus.position, focus.checkpoint),
        stage: this.course.stageAt(focus.checkpoint),
        // Своё место на досмотре уже определено и не меняется. Считать его заново по расстоянию
        // до финиша нельзя: стоящий на ленте оказался бы первым в любой гонке.
        place: this.mode === 'multi' ? (this.spectating ? this.finishedPlace : this.placement()) : null,
        link: this.net ? { quality: this.net.quality, latency: this.net.latency } : null
      });
    }

    this.postFX.render();
    this.state.render(alpha);
    this.updateAdaptiveQuality(time);
    this.perf.paint(time, this.renderer, {
      качество: this.quality.label(),
      напарников: this.remotes.size
    });
    requestAnimationFrame(next => this.loop(next));
  }

  // actor — тот, кого показывает кадр: обычно свой игрок, на досмотре — соперник.
  updateAudioScene(actor = this.player) {
    if (!this.audio.ready) return;
    // Слушатель — это камера: панорама звуков напарника считается относительно направления взгляда.
    this.audio.setListener(this.camera.position, this.cameraController.yaw);

    // Приглушение при падении: чем ниже игрок провалился, тем сильнее срезаются верхние частоты.
    const depth = Math.max(0, -actor.position.y) / 8;
    this.audio.setMuffle(Math.min(1, depth));

    // Музыка нарастает по мере прохождения трассы — на досмотре по трассе того, за кем смотрят.
    // Иначе она замирала бы на своём финише, и чужая борьба шла бы под тишину.
    if (this.running || this.spectating) {
      this.music.setIntensity(this.course.progress(actor.position, actor.checkpoint));
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
