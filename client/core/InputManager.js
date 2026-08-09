import { DEFAULT_BINDINGS } from './settings.js';

// Клавиши, которые браузер понимает по-своему: пробел листает страницу, стрелки её прокручивают.
// Отменять их поведение можно только когда они действительно назначены на действие в игре, иначе
// игра сломала бы прокрутку в меню ради клавиши, которую сама не использует.
const SCROLLING_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// Действия, у которых есть длительный режим: важен не только момент нажатия, но и то, что кнопку
// всё ещё держат.
const HOLD_ACTIONS = new Set(['jump', 'dive']);

// Доля экрана под джойстик. Всё, что вне её, отдано обзору — и наоборот. Число то же, что стояло
// в прежней жёсткой проверке `clientX < innerWidth * 0.34`; изменилось лишь то, что теперь оно
// умеет считаться от правого края.
const STICK_ZONE_WIDTH = 0.34;

export class InputManager {
  constructor(canvas, root = document, settings = null) {
    this.canvas = canvas;
    this.root = root;
    this.settings = settings;
    this.keys = new Set();
    this.moveX = 0;
    this.moveForward = 0;
    this.jumpQueued = false;
    this.diveQueued = false;
    this.recenterQueued = false;
    this.cameraModeQueued = false;
    // Какие экранные кнопки удерживаются прямо сейчас.
    this.holding = { jump: false, dive: false };
    this.cameraX = 0;
    this.cameraY = 0;
    this.touchCapable = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0;
    this.activeMethod = this.touchCapable ? 'touch' : 'keyboard';
    // Способ ввода проставляется сразу, а не только при первой смене. Стили и разделы интерфейса
    // на него смотрят с первого кадра: без этого раздел переназначения клавиш висел бы на
    // телефоне до тех пор, пока к нему не подключат клавиатуру.
    if (globalThis.document?.body) document.body.dataset.input = this.activeMethod;
    this.enabled = false;

    // Обратный указатель «код клавиши → действие». Пересобирается при смене раскладки: искать
    // действие перебором всех привязок на каждое нажатие незачем.
    this.byCode = new Map();
    this.rebind();
    settings?.subscribe((_values, key) => {
      if (key === null || key === 'keys') this.rebind();
    });

    this.onKeyDown = e => {
      const action = this.byCode.get(e.code);
      if (action && SCROLLING_KEYS.has(e.code) && this.enabled) e.preventDefault();
      this.keys.add(e.code);
      if (!action) return;
      // Повтор от зажатой клавиши — не новое нажатие: иначе удержание прыжка превращалось бы в
      // очередь из тридцати прыжков в секунду.
      if (!e.repeat && (action === 'jump' || action === 'dive' || action === 'cameraMode'))
        this[`${action}Queued`] = true;
      if (action === 'recenter') this.recenterQueued = true;
      this.setMethod('keyboard');
    };
    this.onKeyUp = e => this.keys.delete(e.code);
    addEventListener('keydown', this.onKeyDown, { passive: false });
    addEventListener('keyup', this.onKeyUp);
    this.setupPointers();
  }

  bindings() {
    return this.settings?.get('keys') || DEFAULT_BINDINGS;
  }

  rebind() {
    this.byCode = new Map();
    for (const [action, codes] of Object.entries(this.bindings()))
      for (const code of codes) this.byCode.set(code, action);
  }

  // Нажата ли хоть одна клавиша, назначенная на действие.
  pressed(action) {
    for (const code of this.bindings()[action] || []) if (this.keys.has(code)) return true;
    return false;
  }

  // С какой стороны экрана джойстик. Всё, что зависит от руки, спрашивает это, а не настройку
  // напрямую: правило «джойстик слева» задано в одном месте.
  get leftHanded() {
    return (this.settings?.get('hand') || 'left') === 'left';
  }

  get floatingStick() {
    return this.settings?.get('stickMode') === 'floating';
  }

  // Попадает ли точка в зону джойстика. Обзор работает во всей остальной части экрана.
  inStickZone(clientX) {
    const width = globalThis.innerWidth || 1280;
    return this.leftHanded ? clientX < width * STICK_ZONE_WIDTH : clientX > width * (1 - STICK_ZONE_WIDTH);
  }

  setMethod(method) {
    if (this.activeMethod === method) return;
    this.activeMethod = method;
    document.body.dataset.input = method;
    dispatchEvent(new CustomEvent('inputmethodchange', { detail: method }));
  }

  setupPointers() {
    const stick = this.root.querySelector('#stick'),
      nub = stick.querySelector('i'),
      zone = this.root.querySelector('#stickZone'),
      jump = this.root.querySelector('#jump'),
      dive = this.root.querySelector('#dive'),
      recenter = this.root.querySelector('#recenter'),
      cameraMode = this.root.querySelector('#cameraMode');
    let stickId = null,
      lookId = null,
      lastX = 0,
      lastY = 0;

    // Центр джойстика в координатах окна. У фиксированного он там, где его нарисовал CSS; у
    // плавающего — там, где палец коснулся экрана, и запоминается на всё касание. Считать центр
    // по getBoundingClientRect на каждое движение нельзя: плавающий джойстик сам двигается вслед
    // за пальцем и утаскивал бы отсчёт за собой.
    let centerX = 0,
      centerY = 0,
      radius = 45;

    const placeFloating = (x, y) => {
      stick.style.left = `${x}px`;
      stick.style.top = `${y}px`;
      stick.style.right = 'auto';
      stick.style.bottom = 'auto';
    };
    const clearFloating = () => {
      stick.style.left = stick.style.top = stick.style.right = stick.style.bottom = '';
    };

    const beginStick = (e, floating) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.setMethod('touch');
      stickId = e.pointerId;
      if (floating) placeFloating(e.clientX, e.clientY);
      const r = stick.getBoundingClientRect();
      centerX = floating ? e.clientX : r.left + r.width / 2;
      centerY = floating ? e.clientY : r.top + r.height / 2;
      radius = r.width * 0.34;
      stick.classList.add('active');
      // Палец ловится на элементе, который его получил: у плавающего джойстика это зона, и захват
      // на самом джойстике потерял бы движение, вышедшее за его пределы.
      (floating ? zone : stick).setPointerCapture?.(e.pointerId);
      moveStick(e);
    };

    const moveStick = e => {
      if (e.pointerId !== stickId) return;
      const dx = e.clientX - centerX,
        dy = e.clientY - centerY,
        length = Math.hypot(dx, dy) || 1,
        scale = Math.min(1, radius / length);
      this.moveX = (dx * scale) / radius;
      this.moveForward = (-dy * scale) / radius;
      nub.style.transform = `translate(${dx * scale}px,${dy * scale}px)`;
    };

    const endStick = e => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.moveX = this.moveForward = 0;
      nub.style.transform = '';
      stick.classList.remove('active');
      if (this.floatingStick) clearFloating();
    };

    stick.addEventListener('pointerdown', e => {
      // У плавающего джойстика нажатие обрабатывает зона: иначе касание точно по нарисованному
      // джойстику пошло бы двумя путями сразу.
      if (this.floatingStick) return;
      beginStick(e, false);
    });
    stick.addEventListener('pointermove', moveStick);
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    zone.addEventListener('pointerdown', e => {
      if (!this.floatingStick || !this.inStickZone(e.clientX)) return;
      beginStick(e, true);
    });
    zone.addEventListener('pointermove', moveStick);
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    // hold — имя удерживаемого действия, если у кнопки есть длительный режим. Планирование в
    // падении требует знать не только момент нажатия, но и что кнопку всё ещё держат.
    const action = (element, key, hold = null) => {
      element.addEventListener('pointerdown', e => {
        if (!this.enabled) return;
        e.preventDefault();
        this.setMethod(e.pointerType === 'touch' ? 'touch' : 'keyboard');
        this[key] = true;
        if (hold) this.holding[hold] = true;
        element.classList.add('pressed');
      });
      const release = () => {
        element.classList.remove('pressed');
        if (hold) this.holding[hold] = false;
      };
      element.addEventListener('pointerup', release);
      element.addEventListener('pointercancel', release);
      // Палец, уехавший с кнопки, тоже должен считаться отпусканием: иначе на телефоне действие
      // залипало бы до следующего касания.
      element.addEventListener('pointerleave', release);
    };
    action(jump, 'jumpQueued', 'jump');
    action(dive, 'diveQueued', 'dive');
    action(recenter, 'recenterQueued');
    action(cameraMode, 'cameraModeQueued');

    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('pointerdown', e => {
      if (!this.enabled) return;
      if (e.pointerType === 'touch' && this.inStickZone(e.clientX)) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      lookId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture?.(e.pointerId);
      this.setMethod(e.pointerType === 'touch' ? 'touch' : 'keyboard');
      document.querySelector('#lookHint')?.classList.add('hidden');
    });
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerId !== lookId) return;
      this.cameraX += e.clientX - lastX;
      this.cameraY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endLook = e => {
      if (e.pointerId === lookId) lookId = null;
    };
    this.canvas.addEventListener('pointerup', endLook);
    this.canvas.addEventListener('pointercancel', endLook);
  }

  update() {
    if (this.activeMethod !== 'touch') {
      this.moveX = (this.pressed('right') ? 1 : 0) - (this.pressed('left') ? 1 : 0);
      this.moveForward = (this.pressed('forward') ? 1 : 0) - (this.pressed('back') ? 1 : 0);
    }
    if (this.pressed('cameraLeft')) this.cameraX -= 2.6;
    if (this.pressed('cameraRight')) this.cameraX += 2.6;
  }

  movement() {
    const length = Math.hypot(this.moveX, this.moveForward);
    return {
      x: length > 1 ? this.moveX / length : this.moveX,
      forward: length > 1 ? this.moveForward / length : this.moveForward,
      magnitude: Math.min(1, length)
    };
  }

  // Удерживается ли действие прямо сейчас, в отличие от consume(), который срабатывает один раз.
  // Нужен для длительных действий — сейчас это планирование в падении (удержанный прыжок).
  isHeld(action) {
    if (!HOLD_ACTIONS.has(action)) return false;
    return this.pressed(action) || this.holding[action] === true;
  }

  consume(action) {
    const key = `${action}Queued`,
      value = !!this[key];
    this[key] = false;
    return value;
  }

  // Смещение обзора за кадр, уже с учётом чувствительности и инверсии. Раньше здесь отдавались
  // сырые пиксели, а множитель жил в камере — но обзор двигают и клавиши, и палец, и настройка
  // относится к обоим. Место, где сходятся оба источника, ровно одно: здесь.
  consumeCamera() {
    const scale = this.settings?.lookScale ?? 1;
    const result = {
      x: this.cameraX * scale * (this.settings?.get('invertX') ? -1 : 1),
      y: this.cameraY * scale * (this.settings?.get('invertY') ? -1 : 1)
    };
    this.cameraX = this.cameraY = 0;
    return result;
  }

  reset() {
    this.moveX = this.moveForward = this.cameraX = this.cameraY = 0;
    this.jumpQueued = this.diveQueued = this.recenterQueued = this.cameraModeQueued = false;
    this.holding.jump = false;
    this.holding.dive = false;
    this.keys.clear();
  }
}
