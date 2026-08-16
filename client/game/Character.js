import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { PLAYER_VISUAL_SCALE } from './PlayerDimensions.js';
import { CosmeticRenderer } from './cosmetics/CosmeticRenderer.js';

const standard = (color, roughness = 0.28, metalness = 0.02) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
function capsule(radius, length, color, segments = 10) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, segments), standard(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Точки крепления косметики.
//
// Раньше косметика жила прямо в конструкторе: визор был третьим ребёнком `visual`, антенна —
// шестым, и любой предмет, который захотел бы встать иначе, требовал бы правки индексов. Сейчас у
// персонажа есть именованные якоря, а всё остальное — снаружи, в CosmeticRenderer. Индексы вроде
// `visual.children[n]` для новой системы не используются намеренно: они ломаются от любой правки
// порядка добавления и ломаются молча.
const ANCHOR_POSITIONS = Object.freeze({
  faceAnchor: [0, 1.19, -0.5],
  headAnchor: [0, 1.6, 0],
  backAnchor: [0, 0.92, 0.42],
  bodyAnchor: [0, 0, 0],
  trailAnchor: [0, 0.3, 0.3],
  fxAnchor: [0, 1, 0]
});

export class Character {
  constructor(
    scene,
    { color = COLORS.pink, accent = COLORS.yellow, name = '', remote = false, cosmetics = null } = {}
  ) {
    this.group = new THREE.Group();
    this.group.scale.setScalar(PLAYER_VISUAL_SCALE);
    this.visual = new THREE.Group();
    this.group.add(this.visual);
    this.remote = remote;
    this.name = name;
    this.phase = Math.random() * Math.PI * 2;
    this.landPulse = 0;
    this.state = 'idle';
    this.baseColor = color;
    this.baseAccent = accent;

    const bodyColor = cosmetics?.body?.render?.primary ?? cosmetics?.body?.colors?.body ?? color;
    const accentColor = cosmetics?.body?.render?.accent ?? cosmetics?.body?.colors?.accent ?? accent;
    const body = capsule(0.48, 0.58, bodyColor, 14);
    body.scale.set(1.06, 1, 0.93);
    body.position.y = 0.82;
    this.visual.add(body);
    this.bodyMesh = body;
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10), standard(accentColor, 0.24));
    belly.scale.set(1, 0.68, 0.18);
    belly.position.set(0, 0.78, -0.43);
    belly.castShadow = true;
    this.visual.add(belly);
    this.bellyMesh = belly;

    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.31, 16, 10),
      standard(cosmetics?.visor?.render?.primary ?? cosmetics?.visor?.color ?? 0xdffcff, 0.12, 0.1)
    );
    visor.scale.set(1, 0.58, 0.2);
    visor.position.set(0, 1.18, -0.46);
    visor.castShadow = true;
    this.visual.add(visor);
    this.baseVisor = visor;

    const eyeMat = standard(COLORS.ink, 0.22);
    const eyes = [];
    for (const x of [-0.105, 0.105]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), eyeMat);
      eye.position.set(x, 1.2, -0.525);
      eye.scale.z = 0.35;
      this.visual.add(eye);
      eyes.push(eye);
    }
    this.eyes = eyes;

    const antenna = new THREE.Group(),
      stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 0.22, 7),
        standard(cosmetics?.antenna?.render?.primary ?? cosmetics?.antenna?.color ?? accentColor)
      );
    stem.position.y = 0.11;
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      standard(cosmetics?.antenna?.render?.primary ?? cosmetics?.antenna?.color ?? accentColor, 0.2)
    );
    tip.position.y = 0.25;
    antenna.add(stem, tip);
    antenna.position.y = 1.6;
    this.visual.add(antenna);
    this.antenna = antenna;
    this.baseAntenna = antenna;
    this.antennaParts = [stem, tip];

    this.leftArm = this.limb(-0.53, 0.9, bodyColor, true);
    this.rightArm = this.limb(0.53, 0.9, bodyColor, true);
    this.leftLeg = this.limb(-0.25, 0.28, bodyColor, false);
    this.rightLeg = this.limb(0.25, 0.28, bodyColor, false);
    this.visual.add(this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
    for (const leg of [this.leftLeg, this.rightLeg]) {
      const boot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 7), standard(COLORS.purpleDark, 0.3));
      boot.scale.set(1.05, 0.65, 1.3);
      boot.position.set(0, -0.42, -0.08);
      boot.castShadow = true;
      leg.add(boot);
    }

    // Якоря добавляются последними и намеренно пусты: их наполняет косметический слой.
    for (const [name_, [x, y, z]] of Object.entries(ANCHOR_POSITIONS)) {
      const anchor = new THREE.Group();
      anchor.position.set(x, y, z);
      this.visual.add(anchor);
      this[name_] = anchor;
    }

    // Мелочи, которые с десяти метров уже не различить. Держим их списком, чтобы уровень
    // детализации мог убрать их одним движением, не разбирая иерархию заново каждый кадр.
    this.trinkets = [belly, visor, antenna, ...eyes];
    this.limbs = [this.leftArm, this.rightArm, this.leftLeg, this.rightLeg];
    this.shadowCasters = [body, belly, visor];
    this.detail = 'full';

    if (name) this.addNameplate(name);
    this.group.position.set(0, 1.15, 7);
    scene.add(this.group);
    this.scene = scene;

    // Косметика ставится после того, как рига собрана целиком: рендерер обращается к якорям и
    // базовым деталям, и до их создания ему нечего крепить.
    this.cosmetics = new CosmeticRenderer(this, cosmetics, {
      remote,
      detail: this.detail,
      seed: name || (remote ? 'remote' : 'local')
    });
  }

  // Перекраска корпуса под body-предмет. Отдельный метод, потому что цвет задают двое: конструктор
  // при создании и косметический слой при смене образа, и обоим нужен один и тот же путь.
  setBodyMaterials({ primary, accent, belly }) {
    this.bodyMesh.material.color.setHex(primary);
    this.bellyMesh.material.color.setHex(belly ?? accent);
    for (const limb of this.limbs) {
      for (const part of limb.children) {
        if (part.isMesh && part.geometry.type === 'CapsuleGeometry') part.material.color.setHex(primary);
      }
    }
  }

  setAntennaColor(color) {
    for (const part of this.antennaParts) part.material.color.setHex(color);
  }

  /** Смена образа на живом персонаже. Используется превью в шкафу и повторным спавном. */
  setCosmetics(loadout) {
    this.cosmetics.apply(loadout);
  }

  // Уровень детализации удалённого игрока.
  //
  // Три ступени, и убирают они разное. `full` — всё как есть. `simple` снимает отбрасывание тени:
  // персонаж остаётся целым, но исчезает из прохода теней, а он тем дороже, чем больше в нём
  // объектов. `minimal` прячет мелочи, которые с такого расстояния занимают меньше пикселя, и
  // табличку с именем — она уже не читается и только засоряет дальний план.
  //
  // Само по себе это экономит немного. Главное — в `animate`: на «minimal» анимация не считается
  // вовсе, а это четырнадцать вызовов затухания и тригонометрия на каждого игрока каждый кадр.
  setDetail(level) {
    if (this.detail === level) return;
    this.detail = level;
    const minimal = level === 'minimal';
    for (const mesh of this.trinkets) mesh.visible = !minimal;
    for (const mesh of this.shadowCasters) mesh.castShadow = level === 'full';
    for (const limb of this.limbs) for (const part of limb.children) part.castShadow = level === 'full';
    if (this.nameplate) this.nameplate.visible = !minimal;
    // Косметика знает про уровни детализации своё: у предмета есть собственное правило, а у
    // следа — бюджет частиц. Поэтому уровень передаётся дальше, а не решается здесь.
    this.cosmetics?.setDetail(level);
    // Базовые визор и антенна возвращаются в игру только если их не перекрыл косметический
    // предмет: иначе выход из minimal возвращал бы деталь, поверх которой надета другая.
    if (!minimal) this.cosmetics?.refreshVisibility();
  }
  limb(x, y, color, arm) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const part = capsule(arm ? 0.105 : 0.14, arm ? 0.32 : 0.3, color, 8);
    part.position.y = arm ? -0.2 : -0.22;
    part.rotation.z = arm ? (x < 0 ? -0.1 : 0.1) : 0;
    pivot.add(part);
    return pivot;
  }
  addNameplate(name) {
    const label = String(name || 'Wobbler').slice(0, 16);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 72;
    const ctx = canvas.getContext('2d');

    // Компактная тёмная плашка вместо огромного белого strokeText. Старый спрайт был почти шире
    // персонажа втрое и рисовался с depthTest:false, поэтому несколько стоящих рядом имён
    // превращались в бело-чёрный «штрихкод» поверх всей сцены.
    const left = 18;
    const top = 10;
    const width = canvas.width - left * 2;
    const height = 50;
    const radius = 20;
    ctx.beginPath();
    ctx.moveTo(left + radius, top);
    ctx.lineTo(left + width - radius, top);
    ctx.quadraticCurveTo(left + width, top, left + width, top + radius);
    ctx.lineTo(left + width, top + height - radius);
    ctx.quadraticCurveTo(left + width, top + height, left + width - radius, top + height);
    ctx.lineTo(left + radius, top + height);
    ctx.quadraticCurveTo(left, top + height, left, top + height - radius);
    ctx.lineTo(left, top + radius);
    ctx.quadraticCurveTo(left, top, left + radius, top);
    ctx.closePath();
    ctx.fillStyle = 'rgba(35, 22, 83, 0.88)';
    ctx.fill();

    ctx.font = '900 27px Trebuchet MS';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, canvas.width / 2, top + height / 2 + 1, width - 24);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        alphaTest: 0.04
      })
    );
    sprite.position.y = 2.02;
    sprite.scale.set(2.55, 0.57, 1);
    this.group.add(sprite);
    this.nameplate = sprite;
  }
  setColor(color, accent) {
    this.bodyMesh.material.color.setHex(color);
    this.bellyMesh.material.color.setHex(accent);
  }

  /** Эмоция. Возвращает false, если ID не проигрался, — тогда и в сеть его отправлять незачем. */
  playEmote(emoteId) {
    return Boolean(this.cosmetics?.playEmote(emoteId));
  }

  animate(
    dt,
    { speed = 0, grounded = true, vertical = 0, diving = false, knockedDown = false, recovering = false } = {}
  ) {
    this.phase += dt * (4 + speed * 1.25);
    const run = Math.min(1, speed / 7),
      swing = Math.sin(this.phase) * run;
    if (knockedDown && this.state !== 'knockdown') this.fallSide = Math.sin(this.phase) < 0 ? -1 : 1;
    this.state = knockedDown
      ? 'knockdown'
      : diving
        ? 'dive'
        : !grounded
          ? 'air'
          : run > 0.08
            ? 'run'
            : 'idle';

    // Эмоция прерывается сменой состояния движения: прыжок, подкат и сбивание важнее позы, а поза,
    // пережившая их, выглядела бы как застрявшая анимация. Сбивание тут особенно: поза эмоции,
    // оставшаяся на лежащем персонаже, читалась бы как поломка, а не как шутка.
    if (
      this.cosmetics?.emoteActive &&
      (this.state === 'air' || this.state === 'dive' || this.state === 'knockdown')
    ) {
      this.cosmetics.cancelEmote();
    }

    // На дальней дистанции поза не читается: движется силуэт, а не руки и ноги. Считать её —
    // чистая трата кадра, и тем большая, чем больше игроков в гонке.
    if (this.detail === 'minimal') {
      this.cosmetics?.update(dt, { speed, grounded, vertical, diving, state: this.state });
      return;
    }

    // Пока играет эмоция, поза принадлежит ей целиком: два источника, пишущие в одни и те же
    // повороты, дали бы дрожь вместо движения.
    if (this.cosmetics?.emoteActive) {
      this.cosmetics.update(dt, { speed, grounded, vertical, diving, state: this.state });
      return;
    }

    if (this.state === 'knockdown') {
      const side = this.fallSide || 1;
      this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, 1.05, 8, dt);
      this.rightArm.rotation.x = THREE.MathUtils.damp(this.rightArm.rotation.x, -0.72, 8, dt);
      this.leftLeg.rotation.x = THREE.MathUtils.damp(this.leftLeg.rotation.x, 0.58, 8, dt);
      this.rightLeg.rotation.x = THREE.MathUtils.damp(this.rightLeg.rotation.x, -0.46, 8, dt);
      this.visual.rotation.x = THREE.MathUtils.damp(this.visual.rotation.x, -1.28, 10, dt);
      this.visual.rotation.z = THREE.MathUtils.damp(this.visual.rotation.z, side * 0.38, 9, dt);
      this.visual.position.y = THREE.MathUtils.damp(this.visual.position.y, -0.24, 11, dt);
      this.visual.scale.set(1.04, 0.94, 1.04);
      this.antenna.rotation.z = THREE.MathUtils.damp(this.antenna.rotation.z, side * 0.72, 8, dt);
      this.landPulse = Math.max(0, this.landPulse - dt * 4.4);
      // След и эффекты продолжают жить и на лежащем: сбивание отнимает управление, а не косметику.
      this.cosmetics?.update(dt, { speed, grounded, vertical, diving, state: this.state });
      return;
    }

    if (this.state === 'run') {
      this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, swing * 0.82, 13, dt);
      this.rightArm.rotation.x = THREE.MathUtils.damp(this.rightArm.rotation.x, -swing * 0.82, 13, dt);
      this.leftLeg.rotation.x = THREE.MathUtils.damp(this.leftLeg.rotation.x, -swing * 0.68, 15, dt);
      this.rightLeg.rotation.x = THREE.MathUtils.damp(this.rightLeg.rotation.x, swing * 0.68, 15, dt);
    } else if (this.state === 'air') {
      const arm = -0.9 - Math.max(0, vertical) * 0.025;
      this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, arm, 10, dt);
      this.rightArm.rotation.x = THREE.MathUtils.damp(this.rightArm.rotation.x, arm, 10, dt);
      this.leftLeg.rotation.x = THREE.MathUtils.damp(this.leftLeg.rotation.x, 0.28, 10, dt);
      this.rightLeg.rotation.x = THREE.MathUtils.damp(this.rightLeg.rotation.x, -0.28, 10, dt);
    } else {
      for (const limb of [this.leftArm, this.rightArm, this.leftLeg, this.rightLeg])
        limb.rotation.x = THREE.MathUtils.damp(limb.rotation.x, 0, 8, dt);
    }
    const diveAngle = diving ? -1.24 : 0;
    const poseDamping = recovering ? 5 : diving ? 13 : 9;
    this.visual.rotation.x = THREE.MathUtils.damp(this.visual.rotation.x, diveAngle, poseDamping, dt);
    const targetY =
      Math.sin(this.phase * 0.5) * 0.025 * (1 - run) + Math.abs(Math.sin(this.phase)) * run * 0.055;
    this.visual.position.y = THREE.MathUtils.damp(this.visual.position.y, targetY, recovering ? 5 : 14, dt);
    this.visual.rotation.z = THREE.MathUtils.damp(
      this.visual.rotation.z,
      Math.sin(this.phase * 0.5) * 0.018 * (1 - run),
      recovering ? 5 : 12,
      dt
    );
    this.antenna.rotation.z = Math.sin(this.phase * 0.85) * 0.14;
    this.landPulse = Math.max(0, this.landPulse - dt * 4.4);
    const squash = Math.sin(this.landPulse * Math.PI) * 0.16;
    this.visual.scale.set(1 + squash * 0.55, 1 - squash, 1 + squash * 0.55);

    this.cosmetics?.update(dt, { speed, grounded, vertical, diving, state: this.state });
  }
  landed(strength = 1) {
    this.landPulse = Math.min(1, 0.45 + strength * 0.4);
    this.cosmetics?.landed(strength);
  }
  // Возврат позы к нейтральной, мгновенно и без затухания.
  //
  // Поза сбивания живёт на visual: наклон −1.28 рад, крен и смещение вниз на 0.24 (см. ветку
  // knockdown в animate). Логические таймеры игрока к ней отношения не имеют, поэтому сброс
  // состояния её не убирал — и после падения с моста, где падение до y < −8 успевает закончиться
  // раньше сбивания, игрок возрождался лежащим и распрямлялся уже на новом месте.
  //
  // Конечности сюда не входят намеренно: их углы затухают сами в обычной ветке update, а мгновенно
  // выпрямлять их значило бы менять вид любого возрождения, а не только после сбивания.
  resetPose() {
    this.visual.rotation.set(0, 0, 0);
    this.visual.position.set(0, 0, 0);
  }
  dispose() {
    this.cosmetics?.dispose();
    this.scene.remove(this.group);
  }
}
