import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { CourseBuilder, PLAYER_FOOT } from './CourseBuilder.js';
import { RUN_SPEED } from './Player.js';
import { chapterLayout, coopSpawnFor, LANE_WIDTH } from '/shared/coopChapters.js';
import { crossedCheckpoint } from '/shared/courseProgress.js';

// Постройка кооперативной главы из данных.
//
// Ключевое отличие от гоночной трассы: почти всё состояние здесь ВЫВОДИМОЕ. Нажата ли плита,
// выдвинут ли пролёт, в какой фазе пресс — всё это однозначно определяется позициями игроков и
// общим временем, а и то и другое у каждого клиента уже есть: своя позиция из физики, позиция
// напарника из буфера снапшотов, время — общее серверное. Значит, оба клиента приходят к одному
// состоянию сами, и по сети ничего передавать не нужно.
//
// По сети идёт единственное действие, которое из позиции не выводится: удар катапульты (импульс,
// применяемый к ДРУГОМУ игроку). Его шлёт инициатор, сервер проверяет и ретранслирует.

// Потолок сноса — доля беговой скорости.
//
// Ветер обязан уметь почти остановить, но не тащить назад: движение спиной вперёд читается как
// поломка управления, а не как сильный порыв. Рельс стоит в коде, а не в данных, потому что force
// в shared/coopChapters.js правится на глаз при балансировке, и промах там не должен выводить
// участок за грань проходимого.
const WIND_MAX = RUN_SPEED * 0.78;

// Попутный ветер помогает заметно слабее, чем встречный мешает.
//
// Симметрия здесь вредна: при равном вкладе порыв в спину разгонял до полутора беговых скоростей,
// и участок проходился не по расписанию ветра, а по тому, повезло ли поймать порыв. Ощущалось это
// как сбой — «иду то слишком медленно, то слишком быстро».
const WIND_TAILWIND = 0.4;

// Цвет пролёта, когда он выдвинут и когда убран.
const SPAN_ACTIVE = COLORS.mint;
const SPAN_IDLE = COLORS.purpleDark;

// Насколько глубоко проседает нажатая плита — чисто визуальная обратная связь.
const PLATE_PRESS_DEPTH = 0.12;

// Радиус срабатывания плиты. Заметно больше самой плиты: попадать в пиксель на телефоне
// неприятно, а промах здесь ничего не решает по смыслу.
const PLATE_RADIUS = 1.6;

// На каком расстоянии удар сверху приводит в действие катапульту.
const SLAM_RADIUS = 3.2;

export class CoopCourse extends CourseBuilder {
  constructor(scene, spec, { quality = 'high' } = {}) {
    super(scene, { quality });
    this.spec = spec;
    this.group.name = `coop-${spec.chapterId}`;

    this.plates = new Map();
    this.spans = new Map();
    this.catapults = [];
    this.conveyors = [];
    this.fans = [];
    this.pendulums = [];
    this.crushers = [];
    this.tiles = [];
    this.syncGates = [];
    this.stageNames = [];
    // Игрок остался один: напарник вышел или оборвался посреди главы. Ставится снаружи по составу
    // комнаты — сам уровень о сети ничего не знает. См. updateCoop.
    this.solo = false;

    // Отметки пересечения черты синхронности: id ворот → { playerId: время }.
    this.syncCrossings = new Map();
    // Уроки, которые уже усвоены. Однажды понятое не разучивается обратно.
    this.learned = new Set();

    this._tmp = new THREE.Vector3();
    this.build();
  }

  build() {
    const layout = chapterLayout(this.spec.chapterId);
    for (const piece of layout.pieces) this.addPiece(piece);
    for (const z of layout.checkpoints) this.addArch(z);
    this.addFinishGate();
    this.addScenery(layout);
  }

  addPiece(piece) {
    switch (piece.kind) {
      case 'floor':
        this.addFloor(piece);
        break;
      case 'gateSpan':
        this.addSpan(piece, 'gate');
        break;
      case 'syncSpan':
        this.addSpan(piece, 'sync');
        break;
      case 'movingSpan':
        this.addMovingSpan(piece);
        break;
      case 'splitSpan':
        this.addSplitSpan(piece);
        break;
      case 'collapsing':
        this.addCollapsing(piece);
        break;
    }
  }

  addSplitSpan(piece) {
    const laneWidth = (LANE_WIDTH - piece.laneGap) / 2;
    const offset = piece.laneGap / 2 + laneWidth / 2;
    for (const [x, y] of [
      [-offset, piece.leftY || 0],
      [offset, piece.rightY || 0]
    ]) {
      this.box({
        x,
        y,
        z: piece.z,
        w: laneWidth,
        h: 1,
        d: piece.length,
        color: x < 0 ? COLORS.cyan : COLORS.orange,
        bevel: true
      });
    }
  }

  addFloor(piece) {
    this.box({
      x: 0,
      y: 0,
      z: piece.z,
      w: LANE_WIDTH,
      h: 1,
      d: piece.length,
      color: COLORS.purple,
      bevel: true
    });
    for (const prop of piece.props || []) this.addProp(prop, piece);
  }

  addProp(prop, piece) {
    if (prop.type === 'plate') return this.addPlate(prop, piece);
    if (prop.type === 'catapult') return this.addCatapult(prop, piece);
    if (prop.type === 'conveyor') return this.addConveyor(prop, piece);
    if (prop.type === 'fan') return this.addFan(prop, piece);
    if (prop.type === 'pendulum') return this.addPendulum(prop, piece);
    if (prop.type === 'crusher') return this.addCrusher(prop, piece);
  }

  // Плита. Нажимается кем угодно: ролей нет, важно только что кто-то на ней стоит.
  addPlate(prop, piece) {
    const base = this.cylinder({
      x: prop.x,
      y: 0.54,
      z: piece.z,
      r: 1.25,
      h: 0.22,
      color: COLORS.cyan
    });
    const ring = this.cylinder({ x: prop.x, y: 0.66, z: piece.z, r: 0.85, h: 0.08, color: COLORS.white });
    this.plates.set(prop.id, {
      id: prop.id,
      x: prop.x,
      z: piece.z,
      baseY: 0.54,
      mesh: base,
      ring,
      pressed: false
    });
  }

  addCatapult(prop, piece) {
    const pivot = new THREE.Group();
    pivot.position.set(prop.x, 0.9, piece.z);
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.3, 9),
      this.material({ color: COLORS.yellow, roughness: 0.25 })
    );
    arm.castShadow = this.quality !== 'low';
    pivot.add(arm);
    this.group.add(pivot);
    this.cameraMeshes.push(arm);

    // Длинное плечо — площадка для того, кого подбрасывают, и она же коллайдер. Кто именно на неё
    // встанет, значения не имеет: ролей нет, стороны выбирают сами игроки.
    const seat = this.box({
      x: prop.x,
      y: 0.55,
      z: piece.z - 3,
      w: 3,
      h: 0.5,
      d: 3,
      color: COLORS.yellow
    });
    this.cylinder({ x: prop.x, y: 0.55, z: piece.z, r: 0.6, h: 1.1, color: COLORS.purpleDark });
    // Ударная площадка — по ней бьют сверху. Отличается цветом, чтобы стороны не путались.
    this.box({
      x: prop.x,
      y: 0.55,
      z: piece.z + 3,
      w: 3,
      h: 0.5,
      d: 3,
      color: COLORS.orange,
      emissive: COLORS.orange,
      emissiveIntensity: 0.9
    });

    this.catapults.push({
      id: prop.id,
      x: prop.x,
      z: piece.z,
      power: prop.power,
      forward: prop.forward,
      pivot,
      seat,
      launchZ: piece.z - 3,
      slamZ: piece.z + 3,
      recoil: 0
    });
  }

  // Конвейер: полосы на полу показывают направление, сила прикладывается в interact.
  addConveyor(prop, piece) {
    const arrows = [];
    const stripes = Math.max(3, Math.round(piece.length / 3));
    for (let i = 0; i < stripes; i++) {
      arrows.push(
        this.box({
          x: 0,
          y: 0.53,
          z: piece.z - piece.length / 2 + (i + 0.5) * (piece.length / stripes),
          w: LANE_WIDTH - 1.5,
          h: 0.05,
          d: 0.9,
          color: COLORS.mint,
          collider: false,
          emissive: COLORS.mint,
          emissiveIntensity: 0.7
        }).mesh
      );
    }
    this.conveyors.push({
      zMin: piece.z - piece.length / 2,
      zMax: piece.z + piece.length / 2,
      z: piece.z,
      length: piece.length,
      force: prop.force,
      arrows
    });
  }

  // Вентилятор: сдувает вбок.
  //
  // Ветер невидим, поэтому его рисуют целиком: сами турбины с вращающимися лопастями, полосы
  // потока, летящие поперёк дорожки, и разметка зоны на полу. Игрок должен видеть три вещи —
  // где дует, куда дует и насколько сильно прямо сейчас. Без третьего ветер читается как
  // случайность: пройти удалось или не удалось, а почему — непонятно.
  addFan(prop, piece) {
    const fromLeft = prop.force > 0;
    const wallX = fromLeft ? -LANE_WIDTH / 2 - 0.4 : LANE_WIDTH / 2 + 0.4;
    const rows = Math.max(2, Math.round(piece.length / 6));
    const rotors = [];
    const streaks = [];

    // Разметка зоны на полу: видно ещё на подходе, до того как потащит.
    this.box({
      x: 0,
      y: 0.52,
      z: piece.z,
      w: LANE_WIDTH - 0.6,
      h: 0.04,
      d: piece.length,
      color: COLORS.blue,
      collider: false,
      opacity: 0.22,
      emissive: COLORS.blue,
      emissiveIntensity: 0.35
    });

    for (let i = 0; i < rows; i++) {
      const z = piece.z - piece.length / 2 + (i + 0.5) * (piece.length / rows);

      // Корпус турбины — задняя стенка снаружи дорожки. Лопасти висят ПЕРЕД ней, иначе их
      // не видно: в первой версии крестовина оказалась внутри корпуса и вращалась впустую.
      const hubY = 2.3;
      this.box({
        x: wallX,
        y: hubY,
        z,
        w: 0.5,
        h: 3.6,
        d: 3.6,
        color: COLORS.purpleDark,
        collider: false
      });
      // Ось. Кубик, а не цилиндр: helper строит цилиндры только вертикально, а ось здесь
      // горизонтальная — на таком размере разницы всё равно не видно.
      this.box({
        x: wallX + (fromLeft ? 0.55 : -0.55),
        y: hubY,
        z,
        w: 1.1,
        h: 0.6,
        d: 0.6,
        color: COLORS.white,
        collider: false
      });
      // Лопасти: крестовина, вращающаяся вокруг оси ветра. Скорость вращения — это и есть
      // индикатор силы порыва, читаемый боковым зрением, не отрываясь от дороги.
      // Крестовина собирается сразу вокруг оси X — той самой, вдоль которой дует. Наклонять
      // группу через rotation.z нельзя: эйлеровы углы в порядке XYZ применяются как Z→Y→X, то
      // есть наклон лёг бы ДО вращения, и лопасти крутились бы вокруг мировой вертикали. Со
      // стороны это выглядит не вращением, а разворотом вентилятора на месте.
      const rotor = new THREE.Group();
      rotor.position.set(wallX + (fromLeft ? 0.8 : -0.8), hubY, z);
      for (let blade = 0; blade < 4; blade++) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.22, 0.5, 1.5),
          this.material({ color: COLORS.cyan, emissive: COLORS.cyan, emissiveIntensity: 1.1 })
        );
        mesh.geometry.translate(0, 0, 0.85);
        mesh.rotation.x = (blade * Math.PI) / 2;
        rotor.add(mesh);
      }
      this.group.add(rotor);
      rotors.push(rotor);

      // Полосы потока. Их положение анимируется в update: неподвижные линии не читаются как ветер.
      for (let s = 0; s < 3; s++) {
        const streak = this.box({
          x: 0,
          y: 0.9 + s * 0.85,
          z: z + (s - 1) * 1.1,
          w: 3.4,
          h: 0.08,
          d: 0.22,
          color: COLORS.white,
          collider: false,
          opacity: 0.5,
          emissive: COLORS.white,
          emissiveIntensity: 0.6
        }).mesh;
        // Своя копия материала на каждую полосу: прозрачность анимируется отдельно, а материалы
        // кэшируются по внешнему виду — правка общего объекта погасила бы половину сцены разом.
        streak.material = streak.material.clone();
        streaks.push({ mesh: streak, offset: (i * 3 + s) / (rows * 3) });
      }
    }

    this.fans.push({
      zMin: piece.z - piece.length / 2,
      zMax: piece.z + piece.length / 2,
      force: prop.force,
      period: prop.period,
      // Фаза сдвинута по координате: соседние вентиляторы не должны дуть в такт, иначе участок
      // проходится не по расписанию, а по удаче.
      phase: (Math.abs(piece.z) * 0.13) % prop.period,
      fromLeft,
      rotors,
      streaks,
      // Текущая сила порыва, 0..1. Считается в update и читается в interact.
      gust: 0,
      spin: 0
    });
  }

  // Маятник: качающийся молот. Жёсткая опасность — отбрасывает, но не убивает.
  addPendulum(prop, piece) {
    const pivot = new THREE.Group();
    pivot.position.set(prop.x, 6, piece.z);
    this.group.add(pivot);

    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 5, 6),
      this.material({ color: COLORS.purpleDark })
    );
    rod.position.y = -2.5;
    pivot.add(rod);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.6, 1.6),
      this.material({ color: COLORS.pink, emissive: COLORS.pink, emissiveIntensity: 0.5 })
    );
    head.position.y = -5.2;
    head.castShadow = this.quality !== 'low';
    pivot.add(head);
    this.cameraMeshes.push(head);

    this.pendulums.push({
      id: prop.id,
      x: prop.x,
      z: piece.z,
      range: prop.range,
      speed: prop.speed,
      knock: prop.knock,
      pivot,
      head,
      // Мировая позиция головы: по ней считается попадание, и её надо пересчитывать каждый кадр.
      world: new THREE.Vector3(prop.x, 0.8, piece.z)
    });
  }

  // Пресс. Смертельная опасность, но честная: три такта, и первый из них — предупреждение.
  // Внезапная смерть читается как несправедливость, а не как ошибка игрока.
  addCrusher(prop, piece) {
    const head = this.box({
      x: prop.x,
      y: 6,
      z: piece.z,
      w: prop.width,
      h: 1.6,
      d: prop.width,
      color: COLORS.orange,
      collider: false
    }).mesh;
    // Отметка на полу: куда именно ударит. Без неё непонятно, где безопасно стоять.
    const mark = this.box({
      x: prop.x,
      y: 0.52,
      z: piece.z,
      w: prop.width,
      h: 0.05,
      d: prop.width,
      color: COLORS.orange,
      collider: false,
      opacity: 0.4
    }).mesh;
    // Направляющие: делают механизм читаемым сбоку и подсказывают высоту.
    for (const dx of [-prop.width / 2, prop.width / 2]) {
      this.box({
        x: prop.x + dx,
        y: 4,
        z: piece.z,
        w: 0.2,
        h: 8,
        d: 0.2,
        color: COLORS.purpleDark,
        collider: false
      });
    }

    this.crushers.push({
      id: prop.id,
      x: prop.x,
      z: piece.z,
      width: prop.width,
      period: prop.period,
      warn: prop.warn,
      strike: prop.strike,
      // Фаза сдвинута по координате: два пресса рядом не должны бить одновременно, иначе
      // участок проходится не по расписанию, а по удаче.
      phase: (Math.abs(prop.x) * 0.37 + Math.abs(piece.z) * 0.11) % prop.period,
      head,
      mark,
      danger: false,
      // Такт, в котором пресс был на прошлом кадре. null — «ещё не знаем»: на первом кадре
      // звук такта играть нельзя, иначе глава начиналась бы с удара из ниоткуда.
      beat: null
    });
  }

  // Осыпающиеся плитки: пол, который исчезает вскоре после того, как на него наступили.
  //
  // В кооперативе интереснее, чем в одиночку: второй бежит по уже подломленным плиткам и должен
  // выбирать другой ряд. Поэтому плитки возвращаются — иначе идущий вторым остался бы без пола.
  addCollapsing(piece) {
    const lanes = piece.lanes;
    const rows = Math.max(3, Math.round(piece.length / 3.2));
    const laneWidth = (LANE_WIDTH - 1) / lanes;
    const rowDepth = piece.length / rows;

    for (let r = 0; r < rows; r++) {
      for (let l = 0; l < lanes; l++) {
        const x = -LANE_WIDTH / 2 + 0.5 + laneWidth * (l + 0.5);
        const z = piece.z + piece.length / 2 - rowDepth * (r + 0.5);
        const platform = this.box({
          x,
          y: 0,
          z,
          w: laneWidth - 0.2,
          h: 1,
          d: rowDepth - 0.2,
          color: COLORS.blue,
          bevel: true
        });
        this.tiles.push({
          id: `${piece.id}-${r}-${l}`,
          platform,
          baseY: 0,
          delay: piece.delay,
          respawn: piece.respawn,
          // 0 — цела и никто не наступал; >0 — идёт отсчёт; после обрушения отсчёт возврата.
          timer: 0,
          fallen: false
        });
      }
    }
  }

  // Пролёт над пропастью. Тип определяет, чем он управляется, но геометрия и поведение общие:
  // выдвинут — по нему можно идти, убран — под ногами пустота.
  addSpan(piece, control) {
    const platform = this.box({
      x: 0,
      y: 0,
      z: piece.z,
      w: LANE_WIDTH - 2,
      h: 0.7,
      d: piece.length,
      color: SPAN_IDLE,
      bevel: true
    });
    // Убранный пролёт не должен держать: этим и создаётся преграда.
    platform.disabled = true;
    platform.mesh.visible = false;

    // Полупрозрачная «рамка» показывает, где появится пролёт, — иначе непонятно, чего ждать.
    this.box({
      x: 0,
      y: 0.05,
      z: piece.z,
      w: LANE_WIDTH - 2,
      h: 0.06,
      d: piece.length,
      color: COLORS.white,
      collider: false,
      opacity: 0.18
    });

    this.spans.set(piece.id, {
      id: piece.id,
      control,
      platform,
      requires: piece.requires || [],
      // Защёлка осталась ТОЛЬКО у ворот синхронности: там она часть механики, а не костыль.
      // У обычных ворот её больше нет — мост живёт, пока на плите кто-то стоит.
      latched: false,
      windowMs: piece.windowMs || 900,
      z: piece.z,
      length: piece.length,
      active: false
    });

    if (control === 'sync') this.syncGates.push(piece.id);
  }

  addMovingSpan(piece) {
    const platform = this.box({
      x: 0,
      y: 0.4,
      z: piece.z,
      w: 6,
      h: 0.6,
      d: piece.length,
      color: COLORS.pink,
      bevel: true
    });
    platform.motion = { axis: 'x', origin: 0, range: piece.range, speed: piece.speed, phase: 0 };
    this.dynamic.push(platform);
  }

  addArch(z) {
    for (const x of [-LANE_WIDTH / 2 + 0.6, LANE_WIDTH / 2 - 0.6]) {
      this.box({ x, y: 1.9, z, w: 0.18, h: 2.8, d: 0.18, color: COLORS.mint, collider: false });
    }
    this.box({
      x: 0,
      y: 3.25,
      z,
      w: LANE_WIDTH - 0.8,
      h: 0.2,
      d: 0.2,
      color: COLORS.mint,
      collider: false,
      emissive: COLORS.mint,
      emissiveIntensity: 1.8
    });
    this.stageNames.push(`УЧАСТОК ${this.stageNames.length + 1}`);
  }

  addFinishGate() {
    const z = this.spec.finishZ;
    this.box({ x: 0, y: 1.02, z: z + 2, w: LANE_WIDTH, h: 0.7, d: 6, color: COLORS.yellow, bevel: true });
    for (const x of [-5, 5]) {
      this.box({ x, y: 3.15, z, w: 0.42, h: 4.3, d: 0.52, color: 0xffffff, collider: false });
    }
    this.box({
      x: 0,
      y: 1.42,
      z,
      w: 10,
      h: 0.08,
      d: 0.7,
      color: COLORS.pink,
      collider: false,
      emissive: COLORS.pink,
      emissiveIntensity: 2.2
    });
    this.stageNames.push('ФИНИШ');
  }

  addScenery(layout) {
    // Немного плавающих блоков по бокам — глубина сцены без нагрузки на физику.
    const count = this.quality === 'low' ? 10 : 20;
    const span = Math.abs(layout.endZ) + 30;
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? -1 : 1;
      this.box({
        x: side * (12 + ((i * 7) % 26)),
        y: -3 + ((i * 5) % 14),
        z: 10 - ((i * 13) % span),
        w: 1 + ((i * 3) % 3),
        h: 2 + ((i * 7) % 5),
        d: 1 + ((i * 5) % 3),
        color: [COLORS.cyan, COLORS.pink, COLORS.orange, COLORS.blue][i % 4],
        collider: false
      });
    }
  }

  // --- Состояние кооперативных объектов ---------------------------------------------------------

  // Пересчёт по позициям обоих игроков. Вызывается каждый шаг физики.
  //
  // `actors` — массив вида { id, position, grounded }. Здесь и свой игрок, и напарник: именно
  // поэтому состояние получается одинаковым у обоих клиентов без обмена сообщениями.
  updateCoop(actors, nowMs, sfx = null) {
    for (const plate of this.plates.values()) {
      const pressed = actors.some(actor => this.standsOnPlate(actor, plate));
      if (pressed !== plate.pressed) {
        plate.pressed = pressed;
        plate.mesh.position.y = plate.baseY - (pressed ? PLATE_PRESS_DEPTH : 0);
        plate.ring.position.y = plate.baseY + 0.12 - (pressed ? PLATE_PRESS_DEPTH : 0);
        this._tmp.set(plate.x, plate.baseY, plate.z);
        if (pressed) sfx?.platePress(this._tmp);
        else sfx?.plateRelease(this._tmp);
      }
    }

    for (const span of this.spans.values()) {
      // Напарника больше нет — все кооперативные преграды открыты.
      //
      // Иначе оставшийся упирается в первую же плиту, которую некому держать, и стоит там до
      // конца времён: выйти из идущего матча было нечем, а перезагрузка страницы возвращает в тот
      // же матч. Плиты за пропастью не спасает даже фиксация моста — нажать их одному физически
      // нельзя, они на той стороне.
      //
      // Головоломка при этом теряется, и это осознанная цена. Забег с обрывом связи всё равно уже
      // помечен «без зачёта» (см. markUnranked на сервере), так что терять нечего, а альтернатива —
      // запертый игрок.
      if (this.solo) {
        this.setSpanActive(span, true, sfx);
        continue;
      }
      let active = false;
      if (span.control === 'gate') {
        // Мост существует ровно столько, сколько на какой-нибудь из его плит кто-то СТОИТ.
        // Никакой фиксации: сошёл — моста нет. Плиты стоят по обе стороны пропасти, поэтому
        // проход всегда один и тот же: первый держит → второй переходит → первый сходит →
        // второй встаёт на дальнюю плиту → первый переходит.
        //
        // Достаточно ЛЮБОЙ из плит: их бывает несколько по разные стороны дорожки, и игроку не
        // должно быть важно, до какой он добежал.
        active = span.requires.some(id => this.plates.get(id)?.pressed);
      } else if (span.control === 'sync') {
        active = this.syncSatisfied(span, actors, nowMs);
      }
      this.setSpanActive(span, active, sfx);
    }
  }

  // Остался один. Возвращает true, если состояние изменилось: игроку об этом надо сказать, но
  // ровно один раз, а вызывается это на каждом обновлении состава комнаты.
  setSolo(value) {
    const next = !!value;
    if (this.solo === next) return false;
    this.solo = next;
    return true;
  }

  standsOnPlate(actor, plate) {
    if (!actor) return false;
    const dx = actor.position.x - plate.x;
    const dz = actor.position.z - plate.z;
    if (dx * dx + dz * dz > PLATE_RADIUS * PLATE_RADIUS) return false;
    // Проверка высоты нужна, чтобы плита не нажималась пролетающим над ней игроком.
    return Math.abs(actor.position.y - PLAYER_FOOT - plate.baseY) < 0.6;
  }

  // Ворота синхронности: оба должны пересечь черту в пределах окна.
  //
  // Условие ЗАЩЁЛКИВАЕТСЯ — и без этого ворота были непроходимы вовсе. Окно синхронности меньше
  // секунды, а перейти надо четырнадцать единиц, то есть почти две секунды бега: пролёт исчезал
  // прямо из-под идущих, примерно на середине. Пара делала всё правильно, попадала в окно,
  // ступала на появившийся пролёт — и падала.
  //
  // Задача этих ворот — заставить действовать одновременно, а не пробежать быстрее таймера,
  // который обогнать нельзя. Синхронность доказана в момент попадания в окно; дальше пролёт стоит.
  syncSatisfied(span, actors, nowMs) {
    if (span.latched) return true;
    const line = span.z + span.length / 2;
    let crossings = this.syncCrossings.get(span.id);
    if (!crossings) {
      crossings = new Map();
      this.syncCrossings.set(span.id, crossings);
    }
    for (const actor of actors) {
      // Отметку ставим, пока игрок стоит у самой черты, — так у него есть время подгадать момент.
      if (Math.abs(actor.position.z - line) < 3.5) crossings.set(actor.id, nowMs);
    }
    if (crossings.size < 2) return false;
    const times = [...crossings.values()];
    const spread = Math.max(...times) - Math.min(...times);
    const fresh = times.every(t => nowMs - t < span.windowMs);
    if (fresh && spread < span.windowMs) {
      span.latched = true;
      return true;
    }
    return false;
  }

  // --- Обучение ------------------------------------------------------------------------------
  //
  // Какой урок показывать сейчас. Берётся ПОСЛЕДНИЙ из достигнутых и ещё не усвоенных: если игрок
  // подошёл к следующей задаче, не разобравшись с прошлой подсказкой, актуальна следующая —
  // висящая позади уже не помогает, а мешает.
  activeLesson(actors) {
    const lessons = this.spec.lessons;
    if (!lessons?.length || !actors.length) return null;
    // Ведущий игрок: подсказка появляется, когда до задачи дошёл хотя бы один.
    const lead = Math.min(...actors.map(actor => actor.position.z));
    let found = null;
    for (const item of lessons) {
      if (lead > item.z) continue;
      if (this.learned.has(item.id)) continue;
      if (this.lessonDone(item.done, actors)) {
        this.learned.add(item.id);
        continue;
      }
      found = item;
    }
    return found;
  }

  // Условие `done` описывает МОМЕНТ, когда стало понятно, а не состояние, которое надо удерживать.
  // Разница существенная: пролёт выдвинут, только пока плита нажата, и пара, перешедшая по нему,
  // сходит с плиты — состояние возвращается в исходное. Без запоминания подсказка «встаньте на
  // плиту» вернулась бы игрокам, которые уже стоят на той стороне.
  lessonDone(done, actors) {
    if (done.span) return !!this.spans.get(done.span)?.active;
    if (done.plates) return done.plates.every(id => this.plates.get(id)?.pressed);
    // Отметку должны пройти оба: иначе подсказка исчезнет для того, кто ещё не перебрался.
    if (typeof done.past === 'number') return actors.every(actor => actor.position.z < done.past);
    return false;
  }

  setSpanActive(span, active, sfx = null) {
    if (span.active === active) return;
    span.active = active;
    this._tmp.set(0, 1, span.z);
    if (active) sfx?.spanExtend(this._tmp);
    else sfx?.spanRetract(this._tmp);
    span.platform.disabled = !active;
    span.platform.mesh.visible = active;
    span.platform.mesh.material = this.material({
      color: active ? SPAN_ACTIVE : SPAN_IDLE,
      emissive: active ? SPAN_ACTIVE : null,
      emissiveIntensity: active ? 1.6 : 1
    });
  }

  // Удар сверху рядом с катапультой. Возвращает id катапульты, если удар пришёлся в цель.
  slamTarget(position) {
    for (const catapult of this.catapults) {
      const dx = position.x - catapult.x;
      const dz = position.z - catapult.slamZ;
      if (dx * dx + dz * dz < SLAM_RADIUS * SLAM_RADIUS) return catapult.id;
    }
    return null;
  }

  // Кто стоит на длинном плече — того и подбросит.
  launchCandidate(catapultId, actors) {
    const catapult = this.catapults.find(item => item.id === catapultId);
    if (!catapult) return null;
    for (const actor of actors) {
      const dx = actor.position.x - catapult.x;
      const dz = actor.position.z - catapult.launchZ;
      if (dx * dx + dz * dz < 4.4 && actor.position.y < 3.5) return { actor, catapult };
    }
    return { actor: null, catapult };
  }

  triggerCatapultVisual(catapultId) {
    const catapult = this.catapults.find(item => item.id === catapultId);
    if (catapult) catapult.recoil = 1;
  }

  // --- Интерфейс, ожидаемый игроком --------------------------------------------------------------

  // `sfx` не обязателен: боты и тесты гоняют ту же логику без звука.
  update(dt, elapsed, sfx = null) {
    this.updateDynamic(elapsed);

    for (const catapult of this.catapults) {
      // Плечо отыгрывает удар и возвращается — движение подсказывает, что механизм сработал.
      catapult.recoil = Math.max(0, catapult.recoil - dt * 3.2);
      catapult.pivot.rotation.x = -catapult.recoil * 0.5;
    }

    for (const conveyor of this.conveyors) {
      // Полосы бегут в ту сторону, куда тянет лента: направление должно читаться без подсказки.
      const step = conveyor.length / conveyor.arrows.length;
      const shift = (-elapsed * conveyor.force * 0.6) % conveyor.length;
      conveyor.arrows.forEach((arrow, i) => {
        const offset = (i * step + shift + conveyor.length * 2) % conveyor.length;
        arrow.position.z = conveyor.z - conveyor.length / 2 + offset;
      });
    }

    for (const item of this.pendulums) {
      item.pivot.rotation.z = Math.sin(elapsed * item.speed + item.z * 0.1) * (item.range / 6);
      item.head.getWorldPosition(item.world);
    }

    // Ветер. Сила меняется по циклу «затишье → порыв»: примерно треть цикла дует слабо, и это
    // окно, в которое надо успеть перейти. Кривая намеренно несимметричная — порыв нарастает
    // быстрее, чем спадает, поэтому опоздать страшнее, чем выйти рано.
    for (const fan of this.fans) {
      const t = ((elapsed + fan.phase) % fan.period) / fan.period;
      // Порыв нарастает быстрее, чем спадает: перекос показателя сдвигает пик к началу цикла.
      // Опоздать в затишье должно быть страшнее, чем выйти рано, — иначе ждать нечего.
      const wave = Math.sin(Math.PI * Math.pow(t, 0.8));
      fan.gust = 0.1 + 0.9 * Math.pow(Math.max(0, wave), 1.35);
      fan.spin += dt * (2 + fan.gust * 22) * (fan.fromLeft ? 1 : -1);
      // Вокруг X — вдоль ветра. Единственная эйлерова компонента, так что порядок углов не важен.
      for (const rotor of fan.rotors) rotor.rotation.x = fan.spin;
      // Полосы летят поперёк дорожки со скоростью порыва и на пике становятся ярче.
      const travel = LANE_WIDTH + 4;
      for (const streak of fan.streaks) {
        const shift = (elapsed * (1.5 + fan.gust * 9) * 0.1 + streak.offset) % 1;
        const across = -travel / 2 + shift * travel;
        streak.mesh.position.x = fan.fromLeft ? across : -across;
        streak.mesh.scale.x = 0.6 + fan.gust * 1.5;
        streak.mesh.material.opacity = 0.18 + fan.gust * 0.55;
      }
      // Шум ветра — позиционный, поэтому слышно и то, что дует у напарника впереди. Дросселируется
      // внутри самого эффекта по его собственной длительности.
      if (fan.gust > 0.3 && sfx?.engine?.throttle(`wind-${fan.zMin}`, 0.45)) {
        this._tmp.set(0, 1.2, (fan.zMin + fan.zMax) / 2);
        sfx.wind(fan.gust, this._tmp);
      }
    }

    // Пресс. Такты считаются от ОБЩЕГО времени, поэтому фаза одинакова у обоих игроков без
    // единого сетевого сообщения.
    for (const crusher of this.crushers) {
      const t = (elapsed + crusher.phase) % crusher.period;
      const strikeUntil = crusher.warn + crusher.strike;
      let beat;
      if (t < crusher.warn) {
        // Такт 1: висит наверху и мигает. Предупреждение обязательно.
        beat = 'warn';
        crusher.head.position.y = 6;
        crusher.danger = false;
        const blink = Math.sin(t * 26) * 0.5 + 0.5;
        crusher.mark.material = this.material({
          color: COLORS.orange,
          emissive: COLORS.orange,
          emissiveIntensity: 0.4 + blink * 2.4,
          opacity: 0.4
        });
      } else if (t < strikeUntil) {
        // Такт 2: внизу. Здесь и убивает.
        beat = 'strike';
        crusher.head.position.y = 1.4;
        crusher.danger = true;
      } else {
        // Такт 3: поднимается. Окно, в которое надо проскочить.
        beat = 'rise';
        const rise = (t - strikeUntil) / (crusher.period - strikeUntil);
        crusher.head.position.y = 1.4 + rise * 4.6;
        crusher.danger = false;
      }
      // Звук привязан к смене такта, а не к самому такту: иначе он играл бы каждый кадр.
      if (beat !== crusher.beat) {
        if (crusher.beat !== null) {
          this._tmp.set(crusher.x, 1.6, crusher.z);
          if (beat === 'warn') sfx?.warn(this._tmp);
          // Удар звучит и мимо: промах на волосок должен ощущаться промахом на волосок.
          else if (beat === 'strike') sfx?.crush(this._tmp);
        }
        crusher.beat = beat;
      }
    }

    // Осыпающиеся плитки: отсчёт до обрушения и обратно до возврата.
    for (const tile of this.tiles) {
      if (tile.timer === 0) continue;
      tile.timer -= dt;
      if (tile.timer <= 0) {
        if (!tile.fallen) {
          tile.fallen = true;
          tile.timer = tile.respawn;
          tile.platform.disabled = true;
          tile.platform.mesh.visible = false;
          this.movePlatform(tile.platform, 'y', tile.baseY);
          sfx?.collapse(tile.platform.mesh.position);
        } else {
          // Возвращается: иначе идущий вторым остался бы без пола навсегда.
          tile.fallen = false;
          tile.timer = 0;
          tile.platform.disabled = false;
          tile.platform.mesh.visible = true;
        }
      } else if (!tile.fallen) {
        // Дрожит перед обрушением — то же предупреждение, что и мигание пресса.
        this.movePlatform(tile.platform, 'y', tile.baseY + Math.sin(tile.timer * 40) * 0.06);
      }
    }

    for (const span of this.spans.values()) {
      if (!span.active) continue;
      // Лёгкое подрагивание активного пролёта: он держится «на честном слове» напарника.
      this.movePlatform(span.platform, 'y', Math.sin(elapsed * 5 + span.z) * 0.03);
    }
  }

  // Постоянные воздействия: лента, вентилятор, молот, пресс, осыпающиеся плитки.
  //
  // Все действуют на всех одинаково — ролей нет, и «эта опасность не для тебя» больше не бывает.
  // Задача препятствий не в том, чтобы разделить игроков по способностям, а в том, чтобы им
  // приходилось договариваться, кто идёт первым и кто кого ждёт.
  interact(player, elapsed, effects, sfx) {
    const position = player.position;
    const dt = 1 / 60;

    for (const zone of this.conveyors) {
      if (position.z > zone.zMax || position.z < zone.zMin) continue;
      // Лента действует через ноги: в прыжке над ней не тянет.
      if (!player.grounded) continue;
      // Тяга применяется к ПОЗИЦИИ, а не к скорости — по той же причине, что и снос ветром.
      //
      // Через скорость лента не работала вовсе. Торможение управления в Player.step тянет скорость
      // к желаемой каждый кадр с коэффициентом 18, и от прибавки force/60 в равновесии оставалось
      // около 4 %: при силе 3.2 стоящего игрока сносило на 0.08 единицы в секунду вместо 3.2.
      // Замер по трём главам с лентой дал 0.082, 0.064 и 0.000 — то есть препятствия не было.
      //
      // Ровно та же ошибка была у вентилятора и там уже исправлена. Лента её пережила, потому что
      // её никто не мерил: полосы на полу бегут независимо от того, тянет она или нет, и уровень
      // выглядит работающим.
      position.z += zone.force * dt;
      // Небольшая добавка к скорости поверх тяги: без неё персонаж едет, не наклоняясь и не
      // перебирая ногами, и это читается как ошибка физики, а не как движущийся пол.
      player.velocity.z += zone.force * dt * 1.5;
    }

    for (const zone of this.fans) {
      if (position.z > zone.zMax || position.z < zone.zMin) continue;
      // Потолок и ослабление попутного считаются до применения: см. WIND_MAX и WIND_TAILWIND.
      //
      // Сравнивается именно НАМЕРЕНИЕ игрока, не его скорость. По скорости получалась петля:
      // ветер сносит стоящего, снос попадает в velocity.x, и со следующего шага собственный
      // снос начинает считаться «попутным бегом» — ветер глушит сам себя ровно тогда, когда
      // работает. Стоящему на месте (intentX = 0) дует в полную силу.
      let push = THREE.MathUtils.clamp(zone.force * zone.gust, -WIND_MAX, WIND_MAX);
      if (push * (player.intentX || 0) > 0) push *= WIND_TAILWIND;
      // Снос применяется к ПОЗИЦИИ, а не к скорости.
      //
      // Через скорость ветер почти не ощущался: торможение управления в Player.step тянет
      // скорость к желаемой каждый кадр с коэффициентом 18, и от прибавки оставалась пара
      // процентов — на бумаге сила семь, на деле треть единицы в секунду. Снос позиции
      // торможению не подчиняется: бежать против ветра можно, стоять на месте — нет.
      position.x += push * dt;
      // Небольшая добавка к скорости поверх сноса: без неё персонаж едет боком, не наклоняясь,
      // и это читается как ошибка физики, а не как ветер.
      player.velocity.x += push * dt * 1.5;
      // В воздухе сдувает сильнее — ногами не за что держаться.
      if (!player.grounded) position.x += push * dt * 0.45;
      if (Math.random() < 0.05 + zone.gust * 0.25) {
        effects?.trail(this._tmp.copy(position).setY(position.y + 0.4 + Math.random()), COLORS.white);
      }
    }

    for (const item of this.pendulums) {
      const dx = position.x - item.world.x;
      const dz = position.z - item.world.z;
      if (dx * dx + dz * dz > 2.6 * 2.6) continue;
      if (Math.abs(position.y - item.world.y) > 2.2) continue;
      // Отбрасывает в ту сторону, с которой пришёл удар: случайное направление читалось бы
      // как сбой, а не как попадание.
      const away = Math.sign(dx) || 1;
      player.velocity.x = away * item.knock;
      player.velocity.y = Math.max(player.velocity.y, 4.5);
      effects?.burst(position, COLORS.pink, 14, 1.1);
      sfx?.bumper(position);
      player.impact = Math.max(player.impact, 0.45);
    }

    for (const crusher of this.crushers) {
      if (!crusher.danger) continue;
      if (Math.abs(position.x - crusher.x) > crusher.width / 2) continue;
      if (Math.abs(position.z - crusher.z) > crusher.width / 2) continue;
      if (position.y > 3) continue;
      // Смертельно: отправляет на чекпоинт. Предупреждение было — это уже ошибка игрока.
      effects?.burst(position, COLORS.orange, 24, 1.5);
      sfx?.puncher(position);
      player.impact = Math.max(player.impact, 0.85);
      player.respawn(this.spawnFor(player.checkpoint), true);
      return;
    }

    for (const tile of this.tiles) {
      if (tile.fallen || tile.timer !== 0) continue;
      if (Math.abs(position.x - tile.platform.x) > tile.platform.w / 2) continue;
      if (Math.abs(position.z - tile.platform.z) > tile.platform.d / 2) continue;
      if (Math.abs(position.y - PLAYER_FOOT - 0.5) > 0.6) continue;
      tile.timer = tile.delay;
      // Треск — то же предупреждение, что и мигание пресса, только его слышно, даже когда
      // смотришь на напарника.
      sfx?.crack(tile.platform.mesh.position);
    }
  }

  // То же общее правило, что и в гонке, и по той же причине — см. Course.checkpointFor. Здесь оно
  // заодно сводит рамку с серверной: клиент кооператива сверялся с `LANE_WIDTH` (12), а сервер —
  // с 11, то есть клиент был ШИРЕ сервера и мог засчитать арку, которую сервер не засчитает. Обе
  // величины лежат вдвое дальше края полосы, так что игрок разницы не заметит; заметил бы он
  // ровно то, из-за чего эта правка и делается.
  checkpointFor(previous, position, current) {
    if (current >= this.spec.checkpoints.length) return current;
    return crossedCheckpoint(previous, position, this.spec.checkpoints[current]) ? current + 1 : current;
  }

  // `slot` — порядковый номер игрока в комнате. Раньше здесь была роль; ролей больше нет.
  spawnFor(checkpoint, slot = 0) {
    const point = coopSpawnFor(this.spec, checkpoint, slot);
    return new THREE.Vector3(point.x, point.y, point.z);
  }

  progress(position, checkpoint) {
    const total = Math.abs(this.spec.finishZ - this.spec.start.z);
    const travelled = Math.max(0, this.spec.start.z - position.z);
    return Math.max(checkpoint / this.spec.segmentCount, Math.min(0.995, travelled / total));
  }

  stageAt(checkpoint) {
    return this.stageNames[Math.min(checkpoint, this.stageNames.length - 1)] || this.spec.title;
  }

  dispose() {
    super.dispose();
    this.plates.clear();
    this.spans.clear();
    this.catapults.length = 0;
    this.conveyors.length = 0;
    this.fans.length = 0;
    this.pendulums.length = 0;
    this.crushers.length = 0;
    this.tiles.length = 0;
    this.syncGates.length = 0;
    this.stageNames.length = 0;
    this.syncCrossings.clear();
  }
}
