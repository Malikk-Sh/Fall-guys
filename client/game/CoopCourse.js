import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { CourseBuilder, PLAYER_FOOT } from './CourseBuilder.js';
import { chapterLayout, coopSpawnFor, LANE_WIDTH } from '/shared/coopChapters.js';
import { COOP_ROLE } from '/shared/protocol.js';

// Постройка кооперативной главы из данных.
//
// Ключевое отличие от гоночной трассы: почти всё состояние здесь ВЫВОДИМОЕ. Нажата ли плита,
// выдвинут ли пролёт, существует ли мост — всё это однозначно определяется позициями двух игроков,
// а обе позиции у каждого клиента уже есть: своя из физики, напарника из буфера снапшотов. Значит,
// оба клиента приходят к одному состоянию сами, и по сети ничего передавать не нужно.
//
// По сети идут только те действия, которые нельзя вывести из позиции: наводка луча (это намерение,
// а не положение) и удар катапульты (импульс, применяемый к другому игроку). Их шлёт инициатор,
// сервер проверяет и ретранслирует.

// Цвет пролёта, когда он выдвинут и когда убран.
const SPAN_ACTIVE = COLORS.mint;
const SPAN_IDLE = COLORS.purpleDark;

// Насколько глубоко проседает нажатая плита — чисто визуальная обратная связь.
const PLATE_PRESS_DEPTH = 0.12;

// Радиус срабатывания плиты. Заметно больше самой плиты: попадать в пиксель на телефоне
// неприятно, а промах здесь ничего не решает по смыслу.
const PLATE_RADIUS = 1.5;

// Дальность луча ИСКРЫ и максимальный угол отклонения от направления взгляда.
export const BEAM_RANGE = 26;
export const BEAM_CONE = Math.cos(0.55);

// Ближе этого по горизонтали направление на излучатель теряет смысл: игрок стоит практически
// под ним, и любой поворот камеры менял бы наводку рывками.
const BEAM_NEAR = 2.5;

// На каком расстоянии удар ГРУЗА приводит в действие катапульту.
const SLAM_RADIUS = 3.2;

export class CoopCourse extends CourseBuilder {
  constructor(scene, spec, { quality = 'high' } = {}) {
    super(scene, { quality });
    this.spec = spec;
    this.group.name = `coop-${spec.chapterId}`;

    this.plates = new Map();
    this.spans = new Map();
    this.emitters = new Map();
    this.catapults = [];
    this.winds = [];
    this.syncGates = [];
    this.stageNames = [];

    // Кто из игроков сейчас держит луч на каком излучателе. Приходит по сети.
    this.activeBeams = new Map();
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
      case 'beamSpan':
        this.addSpan(piece, 'beam');
        break;
      case 'syncSpan':
        this.addSpan(piece, 'sync');
        break;
      case 'movingSpan':
        this.addMovingSpan(piece);
        break;
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
    if (prop.type === 'perch') return this.addPerch(prop, piece);
    if (prop.type === 'emitter') return this.addEmitter(prop, piece);
    if (prop.type === 'wind') return this.addWind(prop, piece);
  }

  addPlate(prop, piece) {
    const heavy = prop.role === COOP_ROLE.ANCHOR;
    // Тяжёлая плита выглядит иначе, и это не украшение: игрок должен понимать, кому на неё вставать,
    // не читая подсказок.
    const color = heavy ? COLORS.orange : COLORS.cyan;
    const base = this.cylinder({ x: prop.x, y: 0.54, z: piece.z, r: 1.25, h: 0.22, color });
    const ring = this.cylinder({ x: prop.x, y: 0.66, z: piece.z, r: 0.85, h: 0.08, color: COLORS.white });
    this.plates.set(prop.id, {
      id: prop.id,
      role: prop.role,
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
    // Длинное плечо — площадка для ИСКРЫ, короткое — та часть, по которой бьёт ГРУЗ.
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.3, 9),
      this.material({ color: COLORS.yellow, roughness: 0.25 })
    );
    arm.castShadow = this.quality !== 'low';
    pivot.add(arm);
    this.group.add(pivot);
    this.cameraMeshes.push(arm);

    // Опора — она же коллайдер, чтобы на качели можно было встать.
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
    // Ударная площадка со стороны ГРУЗА — визуально отличается цветом.
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
      // Точка, где стоит ИСКРА, и точка, куда бьёт ГРУЗ.
      launchZ: piece.z - 3,
      slamZ: piece.z + 3,
      recoil: 0
    });
  }

  addPerch(prop, piece) {
    // Возвышение сбоку: с него виден излучатель, но спрыгнуть прямо на мост нельзя.
    this.box({
      x: prop.x,
      y: prop.height - 0.5,
      z: piece.z,
      w: 6,
      h: 1,
      d: 8,
      color: COLORS.blue,
      bevel: true
    });
    // Пандус, чтобы на площадку можно было забежать, а не только запрыгнуть.
    for (let i = 0; i < 4; i++) {
      this.box({
        x: prop.x + (prop.x < 0 ? 3.4 + i * 1.2 : -3.4 - i * 1.2),
        y: prop.height - 0.5 - (i + 1) * (prop.height / 5),
        z: piece.z,
        w: 1.4,
        h: 1,
        d: 6,
        color: COLORS.blue
      });
    }
  }

  addEmitter(prop, piece) {
    const post = this.cylinder({
      x: prop.x,
      y: prop.height - 0.8,
      z: piece.z - 3,
      r: 0.35,
      h: 1.6,
      color: COLORS.purpleDark
    });
    const lens = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7, 1),
      this.material({ color: COLORS.cyan, emissive: COLORS.cyan, emissiveIntensity: 0.6 })
    );
    lens.position.set(prop.x, prop.height, piece.z - 3);
    this.group.add(lens);

    // Луч рисуется отдельным вытянутым мешем, который появляется только когда его держат.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 1, 6),
      this.material({ color: COLORS.cyan, emissive: COLORS.cyan, emissiveIntensity: 2.6, opacity: 0.75 })
    );
    beam.visible = false;
    this.group.add(beam);

    this.emitters.set(prop.id, {
      id: prop.id,
      position: new THREE.Vector3(prop.x, prop.height, piece.z - 3),
      lens,
      beam,
      post,
      active: false
    });
  }

  addWind(prop, piece) {
    this.winds.push({
      zMin: piece.z - piece.length / 2,
      zMax: piece.z + piece.length / 2,
      force: prop.force
    });
    // Зона ветра обозначена полосами на полу: невидимая механика ощущается как несправедливая.
    const stripes = Math.max(2, Math.round(piece.length / 5));
    for (let i = 0; i < stripes; i++) {
      this.box({
        x: 0,
        y: 0.52,
        z: piece.z - piece.length / 2 + (i + 0.5) * (piece.length / stripes),
        w: LANE_WIDTH - 1,
        h: 0.04,
        d: 0.5,
        color: COLORS.white,
        collider: false,
        opacity: 0.35
      });
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
      emitter: piece.emitter || null,
      // Фиксатор: плита на дальней стороне, закрепляющая мост насовсем. Без него ИСКРА, которая
      // держала луч, сама перейти не сможет — мост исчезнет, едва она потеряет наводку.
      latch: piece.latch || null,
      latched: false,
      windowMs: piece.windowMs || 800,
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
  // `actors` — массив вида { id, role, position, grounded }. Здесь и свой игрок, и напарник:
  // именно поэтому состояние получается одинаковым у обоих клиентов без обмена сообщениями.
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
      let active = false;
      if (span.control === 'gate') {
        // Фиксатор на дальней стороне — обязательная часть конструкции, а не украшение.
        //
        // Без него ворота были головоломкой без решения: пролёт держится, пока плиты нажаты,
        // а нажать их можно только стоя на них. Сойти, чтобы перейти, значит убрать пролёт —
        // из-под себя или из-под напарника. Все проверки при этом были зелёными: пролёт ведь
        // честно выдвигался. Он просто ни для кого не был проходим.
        //
        // Схема поэтому трёхтактная, как и у светового моста: один держит плиту → второй
        // переходит → второй встаёт на фиксатор за пролётом и закрепляет его насовсем → первый
        // сходит с плиты и переходит следом.
        if (span.latch && this.plates.get(span.latch)?.pressed) span.latched = true;
        active = span.latched || span.requires.every(id => this.plates.get(id)?.pressed);
      } else if (span.control === 'beam') {
        // Фиксатор срабатывает один раз и больше не отпускает: он именно «закрепляет» мост.
        if (span.latch && this.plates.get(span.latch)?.pressed) span.latched = true;
        active = span.latched || this.emitters.get(span.emitter)?.active || false;
      } else if (span.control === 'sync') {
        active = this.syncSatisfied(span, actors, nowMs);
      }
      this.setSpanActive(span, active, sfx);
    }
  }

  standsOnPlate(actor, plate) {
    if (!actor) return false;
    // Тяжёлую плиту продавливает только ГРУЗ. Это и есть источник асимметрии: без напарника
    // нужной роли участок не проходится вообще.
    if (plate.role === COOP_ROLE.ANCHOR && actor.role !== COOP_ROLE.ANCHOR) return false;
    const dx = actor.position.x - plate.x;
    const dz = actor.position.z - plate.z;
    if (dx * dx + dz * dz > PLATE_RADIUS * PLATE_RADIUS) return false;
    // Проверка высоты нужна, чтобы плита не нажималась пролетающим над ней игроком.
    return Math.abs(actor.position.y - PLAYER_FOOT - plate.baseY) < 0.6;
  }

  // Ворота синхронности: оба должны пересечь черту в пределах окна.
  syncSatisfied(span, actors, nowMs) {
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
    return fresh && spread < span.windowMs;
  }

  // --- Обучение ------------------------------------------------------------------------------
  //
  // Какой урок показывать сейчас. Берётся ПОСЛЕДНИЙ из достигнутых и ещё не усвоенных: если игрок
  // подошёл к следующей задаче, не разобравшись с прошлой подсказкой, актуальна следующая —
  // висящая позади уже не помогает, а мешает.
  //
  // Условие усвоения выводится из того же состояния, что и сами механики, поэтому обучение не
  // требует ни одного дополнительного сетевого сообщения и одинаково у обоих игроков.
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
  // Разница существенная: пролёт выдвинут, только пока обе плиты нажаты, и пара, перешедшая по
  // нему, сходит с плит — состояние возвращается в исходное. Без запоминания подсказка «встаньте
  // на плиты» вернулась бы игрокам, которые уже стоят на той стороне.
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

  // Наводка луча приходит по сети: это намерение игрока, из позиции его не вывести.
  setBeam(playerId, emitterId) {
    if (emitterId) this.activeBeams.set(playerId, emitterId);
    else this.activeBeams.delete(playerId);
    const held = new Set(this.activeBeams.values());
    for (const emitter of this.emitters.values()) emitter.active = held.has(emitter.id);
  }

  // Ближайший излучатель, на который смотрит ИСКРА. Возвращает id либо null.
  // Наводка луча.
  //
  // Сравнение ведётся В ГОРИЗОНТАЛЬНОЙ ПЛОСКОСТИ, и это не мелочь. Раньше направление на излучатель
  // бралось в трёх измерениях, а направление взгляда было горизонтальным по построению (камера
  // даёт только рыскание). Излучатель стоит на столбе выше игрока, поэтому чем ближе к нему
  // подходишь, тем круче вверх смотрит вектор «на цель» — и тем меньше его скалярное произведение
  // с горизонтальным взглядом. В итоге навести можно было только издалека: с шести единиц и ближе
  // луч не включался вовсе, а обучение как раз велит подняться на площадку и встать рядом.
  //
  // Игрок при этом делал всё правильно, кнопку держал, и ничего не происходило.
  aimedEmitter(position, forward) {
    let best = null;
    let bestDistance = BEAM_RANGE;
    for (const emitter of this.emitters.values()) {
      const to = this._tmp.copy(emitter.position).sub(position);
      const distance = to.length();
      if (distance > bestDistance) continue;

      const horizontal = Math.hypot(to.x, to.z);
      // Стоя вплотную, целиться не во что: игрок и так у самого излучателя.
      if (horizontal > BEAM_NEAR) {
        if ((to.x / horizontal) * forward.x + (to.z / horizontal) * forward.z < BEAM_CONE) continue;
      }
      best = emitter.id;
      bestDistance = distance;
    }
    return best;
  }

  // Удар ГРУЗА рядом с катапультой. Возвращает id катапульты, если удар пришёлся в цель.
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

  update(dt, elapsed) {
    this.updateDynamic(elapsed);

    for (const emitter of this.emitters.values()) {
      emitter.lens.rotation.y += dt * 1.4;
      emitter.lens.scale.setScalar(emitter.active ? 1.25 : 1);
    }
    for (const catapult of this.catapults) {
      // Плечо отыгрывает удар и возвращается — движение подсказывает, что механизм сработал.
      catapult.recoil = Math.max(0, catapult.recoil - dt * 3.2);
      catapult.pivot.rotation.x = -catapult.recoil * 0.5;
    }
    for (const span of this.spans.values()) {
      if (!span.active) continue;
      // Лёгкое подрагивание активного пролёта: он держится «на честном слове» напарника.
      span.platform.mesh.position.y = Math.sin(elapsed * 5 + span.z) * 0.03;
    }
  }

  // Луч рисуется от игрока к излучателю. Вызывается при отрисовке, а не в шаге физики.
  renderBeams(sources) {
    for (const emitter of this.emitters.values()) {
      const from = sources.get(emitter.id);
      if (!from || !emitter.active) {
        emitter.beam.visible = false;
        continue;
      }
      const to = emitter.position;
      const mid = this._tmp.copy(from).add(to).multiplyScalar(0.5);
      const length = from.distanceTo(to);
      emitter.beam.visible = true;
      emitter.beam.position.copy(mid);
      emitter.beam.scale.set(1, length, 1);
      emitter.beam.lookAt(to);
      // Цилиндр вытянут по своей оси Y, а lookAt разворачивает по Z — компенсируем поворотом.
      emitter.beam.rotateX(Math.PI / 2);
    }
  }

  // Ветер и прочие постоянные воздействия.
  interact(player, elapsed, effects, sfx) {
    const position = player.position;
    for (const zone of this.winds) {
      if (position.z > zone.zMax || position.z < zone.zMin) continue;
      // ГРУЗ тяжёлый — его не сдувает. Это делает ветер задачей на прикрытие, а не помехой обоим.
      if (player.role === COOP_ROLE.ANCHOR) continue;
      const gust = Math.sin(elapsed * 1.6) * 0.4 + 0.8;
      player.velocity.x += zone.force * gust * (1 / 60);
      if (Math.random() < 0.06) {
        effects?.trail(this._tmp.copy(position).setY(position.y + 0.4), COLORS.white);
      }
    }
    void sfx;
  }

  checkpointFor(position, current) {
    let next = current;
    while (
      next < this.spec.checkpoints.length &&
      position.z < this.spec.checkpoints[next] &&
      position.y > -3 &&
      Math.abs(position.x) < LANE_WIDTH
    )
      next++;
    return next;
  }

  spawnFor(checkpoint, role = COOP_ROLE.SPARK) {
    const point = coopSpawnFor(this.spec, checkpoint, role);
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
    this.emitters.clear();
    this.catapults.length = 0;
    this.winds.length = 0;
    this.syncGates.length = 0;
    this.stageNames.length = 0;
    this.activeBeams.clear();
    this.syncCrossings.clear();
  }
}
