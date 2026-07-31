// Боты для проверки проходимости кооперативных глав.
//
// Зачем это нужно. Прежние тесты проверяли механизмы по отдельности: нажимается ли плита,
// выдвигается ли пролёт. Все они проходили — и при этом главы оказались непроходимыми. Потому что
// «пролёт выдвинулся» и «по нему можно перейти» — разные утверждения, и второе из первого не
// следует. Классический пример: пролёт держался, пока ОБА стоят на плитах, значит сойти с плиты
// и перейти не мог никто.
//
// Бот не проверяет механизмы. Бот играет: жмёт те же кнопки, что и человек, двигается той же
// физикой и должен дойти до финиша. Если он не дошёл — глава непроходима, и неважно, какие
// внутренние проверки при этом были зелёными.
//
// Ввод бота реализует интерфейс InputManager (`movement`, `consume`, `isHeld`, `update`), поэтому
// `Player.step` не отличает бота от человека. Никаких телепортаций: перемещение только бегом,
// прыжком и рывком — иначе тест доказывал бы проходимость трассы, по которой никто не ходит.

import * as THREE from 'three';
import { Player } from '../client/game/Player.js';
import { CoopCourse } from '../client/game/CoopCourse.js';
import { updateRoleActions } from '../client/game/CoopActions.js';

export const FIXED_DT = 1 / 60;

// Ввод, которым управляет бот. Те же поля, что выставляют обработчики клавиатуры и экранных кнопок.
class BotInput {
  constructor() {
    this.moveX = 0;
    this.moveForward = 0;
    this.jumpQueued = false;
    this.diveQueued = false;
    this.holding = { jump: false, dive: false };
  }
  update() {}
  movement() {
    const length = Math.hypot(this.moveX, this.moveForward);
    return {
      x: length > 1 ? this.moveX / length : this.moveX,
      forward: length > 1 ? this.moveForward / length : this.moveForward,
      magnitude: Math.min(1, length)
    };
  }
  isHeld(action) {
    return this.holding[action] === true;
  }
  consume(action) {
    const key = `${action}Queued`;
    const value = !!this[key];
    this[key] = false;
    return value;
  }
  release() {
    this.moveX = this.moveForward = 0;
    this.holding.jump = false;
    this.holding.dive = false;
  }
}

// Заглушки подсистем, до которых боту нет дела. Частицы и звук на физику не влияют.
const NO_EFFECTS = { burst() {}, trail() {}, ring() {} };

export class Bot {
  constructor(course, slot, scene) {
    this.slot = slot;
    this.input = new BotInput();
    // Без имени: табличка рисуется на canvas, которого в Node нет, а на физику она не влияет.
    this.player = new Player(scene, course, NO_EFFECTS, { remote: false });
    this.player.teleport(new THREE.Vector3().copy(course.spawnFor(0, slot)));
    this.course = course;
    this.id = `bot${slot}`;
    // Куда «смотрит камера». Бот держит взгляд по направлению движения, как обычно делает игрок.
    this.yaw = 0;
    this._forward = new THREE.Vector3();
  }

  get position() {
    return this.player.position;
  }

  // Состояние в том виде, в каком его ждёт CoopCourse.updateCoop.
  get actor() {
    return { id: this.id, position: this.player.position, grounded: this.player.grounded };
  }

  // Взгляд в сторону точки: от него зависит направление бега.
  lookAt(x, z) {
    const dx = x - this.player.position.x;
    const dz = z - this.player.position.z;
    this.yaw = Math.atan2(-dx, -dz);
  }

  // Бег в сторону точки. Возвращает оставшееся расстояние.
  steerTo(x, z) {
    const dx = x - this.player.position.x;
    const dz = z - this.player.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.001) {
      this.input.moveX = this.input.moveForward = 0;
      return 0;
    }
    // Движение задаётся относительно взгляда, поэтому направление переводится в координаты камеры.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const nx = dx / distance;
    const nz = dz / distance;
    this.input.moveForward = -(sin * nx + cos * nz);
    this.input.moveX = cos * nx - sin * nz;
    return distance;
  }
}

// Мир: трасса, двое ботов и часы. Шаг мира повторяет порядок из Game.fixedStep.
export class World {
  constructor(chapterSpec) {
    this.scene = new THREE.Scene();
    this.course = new CoopCourse(this.scene, chapterSpec, { quality: 'low' });
    // Имена оставлены прежними, чтобы не переписывать все сценарии: это просто «первый» и
    // «второй» игрок, никакой разницы в способностях между ними больше нет.
    this.spark = new Bot(this.course, 0, this.scene);
    this.anchor = new Bot(this.course, 1, this.scene);
    this.bots = [this.spark, this.anchor];
    this.elapsed = 0;
    this.events = [];
  }

  actors() {
    return this.bots.map(bot => bot.actor);
  }

  // Один шаг симуляции — тот же порядок, что в игре: сперва состояние мира, потом действия,
  // потом физика. Порядок важен: пролёт должен появиться раньше, чем по нему пойдут.
  step() {
    this.elapsed += FIXED_DT;
    const nowMs = this.elapsed * 1000;
    const actors = this.actors();
    this.course.update(FIXED_DT, this.elapsed);
    this.course.updateCoop(actors, nowMs);

    for (const bot of this.bots) {
      updateRoleActions(bot.player, this.course, bot.input, bot.yaw, {
        onCatapult: id => this.launch(bot, id)
      });
    }

    for (const bot of this.bots) {
      if (!bot.player.downed) bot.player.step(FIXED_DT, bot.input, bot.yaw, this.elapsed);
      // Упал в пропасть — глава дальше не проверяется, это и есть провал попытки.
      if (bot.player.position.y < -12) bot.fell = true;
    }
  }

  // Подброс катапультой: инициатор считает импульс, цель его применяет — как и по сети.
  launch(bot, catapultId) {
    const { actor, catapult } = this.course.launchCandidate(catapultId, this.actors());
    this.events.push({ t: this.elapsed, who: bot.id, what: 'catapult', id: catapultId, hit: !!actor });
    if (!actor || actor.id === bot.id) return;
    const target = this.bots.find(item => item.id === actor.id);
    target?.player.applyLaunch({ x: 0, y: catapult.power, z: -catapult.power * catapult.forward });
  }

  // Прогон до выполнения условия. Возвращает true, если условие достигнуто за отведённое время.
  //
  // `drive` вызывается каждый шаг и задаёт ввод обоих ботов — это и есть «что делают игроки».
  run(seconds, drive, until) {
    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      drive(this, i * FIXED_DT);
      this.step();
      if (this.bots.some(bot => bot.fell)) return false;
      if (until && until(this)) return true;
    }
    return until ? false : true;
  }

  dispose() {
    this.course.dispose();
  }
}

// Держать прыжок ритмично: боту нужно прыгать, пока он бежит к цели через неровности.
export function hop(bot, elapsed, period = 0.7) {
  if (elapsed % period < FIXED_DT) bot.input.jumpQueued = true;
}

// Сквозное прохождение главы двумя ботами.
//
// Отдельные проверки препятствий доказывают, что каждое из них разрешимо. Они не доказывают, что
// глава проходится целиком: между препятствиями есть переходы, а после каждого решения надо ещё
// добраться до следующего. Именно на этом «между» глава и разваливалась.
//
// План строится из разметки автоматически: боты идут вперёд и, натыкаясь на преграду, применяют
// действие, которое она требует. Никаких заранее записанных координат — иначе тест устареет при
// первой же правке главы и станет проверять несуществующий уровень.
export class Runner {
  constructor(chapterSpec, layout) {
    this.world = new World(chapterSpec);
    this.layout = layout;
    this.log = [];
  }

  // Твёрдая земля перед точкой z: куда безопасно подойти.
  // Преграды идут по порядку, поэтому решаем их одну за другой.
  obstacles() {
    return this.layout.pieces
      .filter(p => ['gateSpan', 'syncSpan'].includes(p.kind))
      .sort((a, b) => b.z - a.z);
  }

  // Провести пару через одни ворота.
  //
  // Фиксации больше нет: мост живёт, только пока на какой-нибудь плите кто-то стоит. Значит,
  // проход обязан быть пятитактным, и именно это здесь и проверяется — если хоть один такт
  // невозможен, глава непроходима, как бы честно ни выдвигался пролёт.
  //
  //   1. первый встаёт на ближнюю плиту — мост появился;
  //   2. второй переходит;
  //   3. первый сходит с плиты — мост исчез, но второй уже на той стороне;
  //   4. второй встаёт на дальнюю плиту — мост появился снова;
  //   5. первый переходит.
  passGate(piece) {
    const { world } = this;
    const near = piece.z + piece.length / 2;
    const far = piece.z - piece.length / 2;
    const plates = piece.requires.map(id => world.course.plates.get(id)).filter(Boolean);
    if (plates.length !== piece.requires.length) return this.fail(`${piece.id}: плита не найдена`);

    const nearPlate = plates.filter(plate => plate.z > near).sort((a, b) => b.z - a.z)[0];
    const farPlate = plates.filter(plate => plate.z < far).sort((a, b) => b.z - a.z)[0];

    // Плита только за пропастью — значит, переправляет катапульта, а не мост.
    if (!nearPlate && farPlate) return this.passCatapultGate(piece, farPlate);
    if (!nearPlate) return this.fail(`${piece.id}: нет плиты перед пропастью`);
    if (!farPlate) return this.fail(`${piece.id}: нет плиты за пропастью — первому не перейти`);

    // Кто держит, а кто идёт — не важно: персонажи одинаковые.
    const holder = world.spark;
    const mover = world.anchor;
    const span = () => world.course.spans.get(piece.id);

    // Такт 1: держащий встаёт на ближнюю плиту.
    const held = world.run(
      16,
      () => {
        holder.lookAt(nearPlate.x, nearPlate.z - 10);
        holder.steerTo(nearPlate.x, nearPlate.z);
        mover.lookAt(0, far - 20);
        mover.steerTo(0, near + 3);
      },
      () => span().active
    );
    if (!held) return this.fail(`${piece.id}: держащий не смог выдвинуть мост`);

    // Такт 2: второй переходит, пока первый держит.
    const crossed = world.run(
      20,
      () => {
        holder.lookAt(nearPlate.x, nearPlate.z - 10);
        holder.steerTo(nearPlate.x, nearPlate.z);
        mover.lookAt(farPlate.x, farPlate.z - 10);
        mover.steerTo(farPlate.x, farPlate.z);
      },
      () => mover.position.z < far - 1 && mover.player.grounded
    );
    if (!crossed) return this.fail(`${piece.id}: переходящий не добрался до той стороны`);

    // Такты 3 и 4: держащий сходит, перешедший встаёт на дальнюю плиту. Мост при этом обязан
    // исчезнуть и появиться снова — иначе фиксация вернулась незамеченной.
    const swapped = world.run(
      20,
      () => {
        holder.lookAt(0, near + 20);
        holder.steerTo(0, near + 4);
        mover.lookAt(farPlate.x, farPlate.z - 10);
        mover.steerTo(farPlate.x, farPlate.z);
      },
      () => world.course.plates.get(farPlate.id).pressed && span().active
    );
    if (!swapped) return this.fail(`${piece.id}: перешедший не смог открыть мост с той стороны`);

    // Такт 5: первый переходит следом.
    const followed = world.run(
      22,
      () => {
        holder.lookAt(0, far - 20);
        holder.steerTo(0, far - 5);
        mover.lookAt(farPlate.x, farPlate.z);
        mover.steerTo(farPlate.x, farPlate.z);
      },
      () => holder.position.z < far - 2 && holder.player.grounded
    );
    if (!followed) return this.fail(`${piece.id}: держащий не смог перейти по мосту напарника`);
    this.log.push(`${piece.id}: ворота пройдены в пять тактов`);
    return true;
  }

  // Ворота, открываемые с той стороны: ГРУЗ бьёт по катапульте, ИСКРА улетает через пропасть и
  // встаёт на плиту, после чего ГРУЗ спокойно переходит по выдвинувшемуся пролёту.
  passCatapultGate(piece, hold) {
    const { world } = this;
    const far = piece.z - piece.length / 2;
    // Ближайшая катапульта перед пропастью.
    const catapult = world.course.catapults.filter(c => c.z > piece.z).sort((a, b) => a.z - b.z)[0];
    if (!catapult) return this.fail(`${piece.id}: плита за пропастью, но катапульты нет`);

    const fired = world.run(
      24,
      () => {
        world.spark.lookAt(catapult.x, catapult.launchZ - 10);
        world.spark.steerTo(catapult.x, catapult.launchZ);
        world.anchor.lookAt(catapult.x, catapult.slamZ - 10);
        const d = world.anchor.steerTo(catapult.x, catapult.slamZ);
        if (d < 2 && world.anchor.player.grounded) world.anchor.input.jumpQueued = true;
        if (!world.anchor.player.grounded && world.anchor.player.velocity.y < 0) {
          world.anchor.input.diveQueued = true;
        }
      },
      () => world.spark.position.y > 4
    );
    if (!fired) return this.fail(`${piece.id}: катапульта не сработала`);

    const landed = world.run(
      10,
      () => {
        world.spark.input.holding.jump = true;
        world.spark.lookAt(hold.x, hold.z - 10);
        world.spark.steerTo(hold.x, hold.z);
      },
      () => world.course.spans.get(piece.id).active
    );
    if (!landed) return this.fail(`${piece.id}: ИСКРА не долетела до плиты за пропастью`);

    const crossed = world.run(
      20,
      () => {
        world.spark.steerTo(hold.x, hold.z);
        world.anchor.lookAt(0, far - 20);
        world.anchor.steerTo(0, far - 5);
      },
      () => world.anchor.position.z < far - 2 && world.anchor.player.grounded
    );
    if (!crossed) return this.fail(`${piece.id}: ГРУЗ не смог перейти, пока ИСКРА держит плиту`);
    this.log.push(`${piece.id}: ворота с катапультой пройдены`);
    return true;
  }

  // Ворота синхронности: черту надо пересечь почти одновременно.
  passSync(piece) {
    const { world } = this;
    const near = piece.z + piece.length / 2;
    const far = piece.z - piece.length / 2;
    // Отходим вместе, потом идём в ногу.
    world.run(3, () => {
      for (const bot of world.bots) {
        bot.lookAt(bot.position.x, near + 20);
        bot.steerTo(bot.position.x, near + 8);
      }
    });
    const passed = world.run(
      20,
      () => {
        for (const bot of world.bots) {
          bot.lookAt(bot.position.x, far - 20);
          bot.steerTo(bot.position.x, far - 5);
        }
      },
      // Проверяем не только координату, но и что оба ЖИВЫ и стоят на ногах. Иначе падение сквозь
      // исчезнувший пролёт засчитывалось бы как успех: координата за время падения тоже
      // проскакивает нужную отметку. Ровно так этот тест и обманул меня в первый раз.
      () => world.bots.every(bot => bot.position.z < far - 2 && bot.player.grounded)
    );
    if (!passed) return this.fail(`${piece.id}: синхронные ворота не пройдены`);
    this.log.push(`${piece.id}: синхронные ворота пройдены`);
    return true;
  }

  // Пробежать вперёд до отметки, прыгая через узкие пропасти и подбрасывая друг друга.
  advanceTo(z, seconds = 26) {
    const { world } = this;
    return world.run(
      seconds,
      () => {
        for (const bot of world.bots) {
          bot.input.holding.jump = true;
          bot.lookAt(bot.position.x, z - 20);
          bot.steerTo(bot.position.x, z);
          // Прыжок при подходе к краю: узкие пропасти берутся сами.
          if (bot.player.grounded && !this.solidAhead(bot)) bot.input.jumpQueued = true;
        }
      },
      () => world.bots.every(bot => bot.position.z < z + 1 && bot.player.grounded)
    );
  }

  // Есть ли пол на пару шагов вперёд.
  solidAhead(bot) {
    const probe = bot.player.position.clone();
    probe.z -= 2.2;
    return !!this.world.course.surfaceAt(probe, probe.y + 0.1, -0.1);
  }

  fail(reason) {
    this.log.push(`ПРОВАЛ ${reason}`);
    return false;
  }

  dispose() {
    this.world.dispose();
  }
}
