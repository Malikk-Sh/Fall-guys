// Бот-соперник для онлайн-гонки.
//
// Чем он отличается от ботов из bots.mjs. Те доказывают проходимость трассы: их задача — дойти,
// и дойти как можно надёжнее. Здесь задача обратная и куда более тонкая: дойти ХУЖЕ, чем машина
// умеет, но по-человечески — и всегда дойти.
//
// Почему это не решается одной ручкой «медленнее». Замер существующего бота показал ровно две
// доступные точки: по центру трассы он финиширует за 18–23 с при теоретическом минимуме около 16,
// то есть обгоняет почти любого живого игрока; а единственный параметр разнообразия (wander,
// блуждание по ширине) не ослабляет его, а роняет в пропасть — 4 из 6 трасс при 0.4 и 1 из 6 при
// 0.9. Между «почти чемпион» и «не доходит» не было ничего.
//
// Отсюда устройство этого файла. Навигация остаётся прежней и безопасной — по середине опоры, где
// бот не падает случайно. Слабость же вносится намеренно и порциями, каждая из которых имитирует
// конкретную человеческую ошибку и, главное, ОБРАТИМА:
//
//   темп       — бежит не в полную силу, как человек, который не выжимает максимум;
//   заминка    — останавливается перед препятствием, «примеряясь», прежде чем идти;
//   промах     — не прыгает там, где надо, падает и возвращается на чекпоинт.
//
// Промах — единственный источник больших потерь времени, и он же главное, чем живой забег
// отличается от машинного: человек теряет секунды не на медленном беге, а на падениях.

import * as THREE from 'three';
import { Player } from '../client/game/Player.js';

export const FIXED_DT = 1 / 60;

// Уровни. Числа получены замером (см. raceBot.test.mjs): цель — чтобы уровни давали различимые
// полосы времени и при этом КАЖДЫЙ доходил до финиша на любой трассе.
//
// Слабость НЕ выражается медленным бегом, и это не сразу очевидно.
//
// Первая попытка задавала уровень темпом — долей отклонения джойстика. Она провалилась дважды.
// Сперва низкий темп лишал бота разгона, и часть разрывов он не брал ни с какой попытки: слабый
// уровень доходил до финиша в 4 случаях из 8. Затем, когда перед разрывом темп стали поднимать до
// полного, уровни схлопнулись — на трассах, где разрывы часты, полный темп держится почти всё
// время, и разница между «новичком» и «уверенным» составила 0.4 секунды.
//
// Поэтому темп у всех уровней высокий и почти одинаковый: он отвечает за то, чтобы бот вообще
// проходил трассу, а не за его силу. Разницу дают потери времени, каждая из которых безопасна и
// обратима:
//
//   hesitate/pause — вероятность остановиться перед препятствием и надолго ли;
//   mistake        — вероятность не прыгнуть над разрывом: падение и возврат на чекпоинт;
//   falls          — сколько таких падений допускается за весь забег.
//
// Ограничение на число падений здесь не украшение. Возрождение возвращает бота на чекпоинт, то
// есть иногда в предыдущий сегмент, — а вход в сегмент заново разыгрывает промах. Без потолка это
// зацикливалось: замер давал забеги на 125 секунд при среднем сорок, и «новичок» превращался не в
// слабого соперника, а в зрелище. Человек на одной трассе столько раз не падает.
//
// Обе растут монотонно от сильного уровня к слабому, и ни одна не мешает боту дойти.
export const BOT_SKILLS = Object.freeze({
  rookie: Object.freeze({
    id: 'rookie',
    label: 'новичок',
    pace: 0.88,
    mistake: 0.5,
    hesitate: 0.75,
    pause: 1.1,
    falls: 3
  }),
  steady: Object.freeze({
    id: 'steady',
    label: 'уверенный',
    pace: 0.94,
    mistake: 0.22,
    hesitate: 0.4,
    pause: 0.6,
    falls: 2
  }),
  sharp: Object.freeze({
    id: 'sharp',
    label: 'быстрый',
    pace: 1,
    mistake: 0.07,
    hesitate: 0.12,
    pause: 0.3,
    falls: 1
  })
});

export const BOT_SKILL_IDS = Object.freeze(Object.keys(BOT_SKILLS));

// Имена. Намеренно обычные и человеческие: бот помечен отдельным признаком в протоколе, и подменять
// пометку странным именем не нужно — игрок должен узнавать бота по метке, а не по «BOT_7734».
const NAMES = Object.freeze([
  'Вихрь',
  'Пружина',
  'Кувырок',
  'Обвал',
  'Зигзаг',
  'Прыгун',
  'Комета',
  'Шустрик',
  'Пирожок',
  'Батут',
  'Сальто',
  'Молния',
  'Кубарем',
  'Ветерок',
  'Улитка'
]);

// Свой генератор случайных чисел, а не Math.random.
//
// Забег бота обязан воспроизводиться: без этого упавший тест невозможно разобрать, а жалобу
// «бот прошёл сквозь стену» — проверить. Сид складывается из сида трассы и номера бота, поэтому
// в одном матче боты ведут себя по-разному, а один и тот же матч повторяется в точности.
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const NO_EFFECTS = {
  burst: () => {},
  trail: () => {},
  ring: () => {},
  confetti: () => {},
  dust: () => {}
};

// Ввод бота: та же форма, что даёт InputManager живому игроку, поэтому Player.step не отличает
// одного от другого. Никаких прямых записей в позицию — только «нажатия».
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
  consume(action) {
    if (action === 'jump' && this.jumpQueued) {
      this.jumpQueued = false;
      return true;
    }
    if (action === 'dive' && this.diveQueued) {
      this.diveQueued = false;
      return true;
    }
    return false;
  }
  isHeld(action) {
    return !!this.holding[action];
  }
}

// Поле забега: одна трасса, одни часы, сколько угодно ботов.
//
// Существует ровно ради того, чтобы часы трассы были ОДНИ. Общая трасса — не только экономия
// памяти, но и общее изменяемое состояние: Course.updateDynamic считает подхват движущейся плиты
// как разницу с её прошлым положением. Пока каждый бот сам двигал трассу под своё время, второй
// бот отматывал плиту назад к своему моменту, и эта отмотка прилетала подхватом всем, кто на плите
// стоял: ботов срывало с движущихся плит на ровном месте. Одиночные тесты этого не видели — с одним
// ботом отматывать нечего.
//
// Поэтому шаг устроен так: трасса сдвигается один раз, затем по ней шагают все.
export class BotField {
  constructor(course, bots = []) {
    this.course = course;
    this.bots = bots;
    this.elapsed = 0;
  }

  step(dt = FIXED_DT) {
    this.elapsed += dt;
    this.course.update(dt, this.elapsed);
    for (const bot of this.bots) bot.step(dt);
  }

  // Новый забег на той же трассе: часы с нуля, боты — с начала.
  reset(run = 0) {
    this.elapsed = 0;
    for (const bot of this.bots) bot.reset(run);
  }

  dispose() {
    for (const bot of this.bots) bot.dispose();
    this.bots = [];
    this.course.dispose();
  }
}

export class RaceBot {
  // course приходит СНАРУЖИ и общий на комнату.
  //
  // Каждый бот со своей копией трассы стоил бы около мегабайта памяти и полутора десятков
  // миллисекунд на создание (замер: 8 ботов — 9 МБ и 130 мс). Геометрия у всех в комнате одна и
  // та же, и держать её в одном экземпляре не оптимизация, а очевидное следствие этого факта.
  //
  // Двигает трассу не бот, а поле (BotField): общих часов на всех ровно одни. Подробности — там же.
  constructor(course, { skill = 'steady', seed = 1, index = 0, name = null } = {}) {
    this.skill = BOT_SKILLS[skill] || BOT_SKILLS.steady;
    this.index = index;
    this.name = name || NAMES[(seed + index * 7) % NAMES.length];
    this.course = course;
    this.baseSeed = seed * 2654435761 + index * 40503;
    this.scene = new THREE.Scene();
    this.input = new BotInput();
    this.player = null;
    this.reset();
  }

  // Состояние ОДНОГО забега. Вынесено из конструктора ради реванша: комната после него остаётся та
  // же, и боты в ней те же — с теми же именами и уровнем, — но бежать они обязаны заново, а не
  // стоять на финишной ленте с прошлого раза.
  //
  // run сдвигает генератор: без него повторный забег на той же трассе повторялся бы посекундно,
  // потому что случайность бота детерминирована сидом.
  reset(run = 0) {
    this.player?.dispose();
    this.player = new Player(this.scene, this.course, NO_EFFECTS);
    this.random = seededRandom(this.baseSeed + run * 0x9e3779b1);
    this.elapsed = 0;
    this.frame = 0;

    // Заминка: сколько секунд ещё стоять. Разыгрывается перед препятствием.
    this.hesitation = 0;
    // Промах: пока он «заряжен», бот не прыгает над разрывом и падает.
    this.fumbling = false;
    // Сегмент, на котором последний раз разыгрывали ошибку. По одной попытке на сегмент, иначе
    // слабый бот ошибается по десять раз подряд на одном месте и не доходит вовсе.
    this.lastDecisionSegment = -1;
    this.finishedAt = null;
    // Сторож застревания: дальняя точка, которой бот достиг, и когда это было. Разрыв берётся
    // разгоном, и если темп слишком низок, бот может не долететь — причём не один раз, а вечно,
    // потому что следующая попытка будет ровно такой же. Живой игрок в такой ситуации меняет
    // подход; боту хватает того, что он перестаёт себя сдерживать.
    this.bestZ = Infinity;
    this.stuckSince = 0;
    // Остаток бюджета падений.
    this.fallsLeft = this.skill.falls;
  }

  get position() {
    return this.player.position;
  }

  get finished() {
    return this.player.finished;
  }

  // Номер сегмента под ботом. Нужен, чтобы разыгрывать ошибку не чаще одного раза на препятствие.
  segmentIndex() {
    return Math.max(0, Math.floor((7 - this.player.position.z) / 18));
  }

  // Решение об ошибке принимается один раз на сегмент, при входе в него.
  decide() {
    const segment = this.segmentIndex();
    if (segment === this.lastDecisionSegment) return;
    this.lastDecisionSegment = segment;
    // Первый сегмент не трогаем: ошибка на старте выглядит как сломанный бот, а не как игрок.
    if (segment === 0) return;
    this.fumbling = this.fallsLeft > 0 && this.random() < this.skill.mistake;
    if (this.random() < this.skill.hesitate) {
      this.hesitation = this.skill.pause * (0.5 + this.random());
    }
  }

  step(dt = FIXED_DT) {
    this.elapsed += dt;
    this.frame += 1;
    const player = this.player;
    if (player.finished) {
      if (this.finishedAt === null) this.finishedAt = this.elapsed;
      return;
    }

    this.decide();

    // Заминка: стоим на месте. Именно стоим, а не идём медленно — человек перед незнакомым
    // препятствием останавливается и смотрит, а не крадётся.
    if (this.hesitation > 0) {
      this.hesitation = Math.max(0, this.hesitation - dt);
      this.input.moveX = 0;
      this.input.moveForward = 0;
      this.input.holding.jump = false;
      player.step(dt, this.input, 0, this.elapsed);
      return;
    }

    // Разрыв впереди?
    const probe = player.position.clone();
    probe.z -= 2;
    const gapAhead = !this.course.surfaceAt(probe, probe.y + 0.1, -0.1);

    // Не движется вперёд дольше трёх секунд — значит упёрся в разрыв, который не берёт своим
    // темпом. Замер это и показал: слабый уровень застревал на некоторых трассах навсегда,
    // потому что каждая следующая попытка повторяла предыдущую.
    if (player.position.z < this.bestZ - 0.5) {
      this.bestZ = player.position.z;
      this.stuckSince = this.elapsed;
    }
    const stuck = this.elapsed - this.stuckSince > 3;

    // Перед разрывом и при застревании — полный ход. Дальность прыжка зависит от горизонтальной
    // скорости, и сдерживать себя там, где надо перелететь, значит не долететь ни разу.
    const pace = gapAhead || stuck ? 1 : this.skill.pace;

    // Навигация: держимся середины и бежим вперёд. Ширина трассы не используется как источник
    // разнообразия — именно она роняла прежнего бота в пропасть.
    const dx = -player.position.x;
    const dz = -6;
    const length = Math.hypot(dx, dz);
    this.input.moveX = (dx / length) * pace;
    this.input.moveForward = -(dz / length) * pace;

    // Прыжок перед разрывом. Если на этом сегменте разыгран промах — не прыгаем: бот срывается,
    // теряет секунды на возвращении к чекпоинту и продолжает бег. Это главный источник разброса
    // времени и единственная ошибка, которая по-настоящему стоит игроку места в протоколе.
    // Застрявший прыгает всегда: промах уже стоил ему времени, повторять его незачем.
    if (player.grounded && ((gapAhead && (!this.fumbling || stuck)) || this.frame % 42 === 0)) {
      this.input.jumpQueued = true;
    }
    // Планирование при снижении — так же тянет время в воздухе живой игрок.
    this.input.holding.jump = !player.grounded && player.velocity.y < 0;
    // Рывок изредка: он ускоряет, поэтому у слабых уровней реже.
    if (player.grounded && this.frame % 90 === 0 && this.random() < this.skill.pace) {
      this.input.diveQueued = true;
    }

    const beforeY = player.position.y;
    player.step(dt, this.input, 0, this.elapsed);
    // Упал и вернулся на чекпоинт — промах отработан и списан с бюджета, дальше бежим честно.
    if (Math.abs(player.position.y - beforeY) > 4) {
      if (this.fumbling) this.fallsLeft -= 1;
      this.fumbling = false;
    }
  }

  // Состояние в том же виде, в каком его присылает живой клиент: сервер не должен различать
  // источник, иначе рассылка снапшотов обрастёт ветвлениями.
  snapshot() {
    return this.player.snapshot();
  }

  dispose() {
    this.player.dispose();
  }
}
