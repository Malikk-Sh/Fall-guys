// Экран настроек управления.
//
// Собирается из схемы, а не пишется руками в разметке: настроек одиннадцать, и у каждой есть тип,
// границы и шаг — те же самые, по которым проверяется сохранённое значение. Разметка, написанная
// отдельно, разошлась бы со схемой на первой же правке: ползунок с чужим максимумом молча
// обрезался бы при сохранении, и виноватым выглядел бы код проверки.
//
// Здесь же лежит единственная причина, по которой панель вообще существует отдельным файлом: она
// нужна и в меню, и (в будущем) из паузы, а UI.js и так на семьсот строк.

import { ACTIONS, SCHEMA, conflictFor } from '../core/settings.js';

// Разделы. Порядок и подписи — то, что видит человек; состав каждого раздела перечислен явно,
// потому что осмысленная группировка из схемы не выводится.
const GROUPS = [
  {
    title: 'ЭКРАННОЕ УПРАВЛЕНИЕ',
    note: 'Как расположены и как выглядят джойстик и кнопки.',
    keys: ['hand', 'stickMode', 'stickSize', 'stickOpacity']
  },
  {
    title: 'КАМЕРА',
    note: 'Чувствительность обзора и направление осей.',
    keys: ['lookSensitivity', 'invertX', 'invertY']
  },
  {
    title: 'ДОСТУПНОСТЬ',
    note: 'Отклик, движение и размер интерфейса.',
    keys: ['haptics', 'shake', 'motion', 'uiScale']
  }
];

const LABELS = {
  hand: 'Джойстик',
  stickMode: 'Тип джойстика',
  stickSize: 'Размер джойстика',
  stickOpacity: 'Прозрачность',
  lookSensitivity: 'Чувствительность',
  invertX: 'Инверсия по горизонтали',
  invertY: 'Инверсия по вертикали',
  haptics: 'Вибрация',
  shake: 'Тряска экрана',
  motion: 'Анимация',
  uiScale: 'Размер интерфейса'
};

const CHOICES = {
  hand: { left: 'СЛЕВА', right: 'СПРАВА' },
  stickMode: { fixed: 'ФИКСИРОВАННЫЙ', floating: 'ПОД ПАЛЬЦЕМ' },
  motion: { auto: 'КАК В СИСТЕМЕ', full: 'ПОЛНАЯ', reduced: 'УМЕНЬШЕННАЯ' }
};

// Подписи к значению справа от регулятора. Ноль у вибрации и тряски называется словом, а не
// «0 %»: выключено — это состояние, а не количество.
function valueLabel(key, value) {
  if (key === 'haptics' || key === 'shake') return value === 0 ? 'ВЫКЛ' : `${value} %`;
  return SCHEMA[key].unit === 'px' ? `${value} px` : `${value} %`;
}

// Читаемое имя клавиши. KeyboardEvent.code — машинное: показывать игроку «KeyW» вместо «W»
// значит заставлять его переводить.
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)] || code;
  return (
    {
      Space: 'ПРОБЕЛ',
      ShiftLeft: 'SHIFT',
      ShiftRight: 'SHIFT ⇥',
      ControlLeft: 'CTRL',
      ControlRight: 'CTRL ⇥',
      AltLeft: 'ALT',
      AltRight: 'ALT ⇥',
      Enter: 'ENTER',
      Tab: 'TAB',
      Backquote: '`',
      Minus: '−',
      Equal: '='
    }[code] || code.toUpperCase()
  );
}

export class SettingsPanel {
  constructor(settings, { root = document } = {}) {
    this.settings = settings;
    this.root = root;
    this.screen = root.querySelector('#settings');
    this.body = root.querySelector('#settingsBody');
    this.status = root.querySelector('#settingsStatus');
    // Действие, которому сейчас назначают клавишу, либо null. Пока оно задано, любое нажатие
    // уходит в раскладку и не доходит до игры.
    this.awaiting = null;
    this.controls = new Map();

    root.querySelector('#settingsClose')?.addEventListener('click', () => this.close());
    root.querySelector('#settingsReset')?.addEventListener('click', () => {
      this.settings.reset();
      this.refresh();
      this.say('Настройки сброшены.');
    });
    root.querySelector('#openSettings')?.addEventListener('click', () => this.open());

    // Перехват нажатия при назначении клавиши идёт в фазе перехвата и с приоритетом над всем
    // остальным: иначе выбранная клавиша успела бы сработать как действие в игре.
    this.onKey = event => {
      if (!this.awaiting) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = this.awaiting;
      if (event.code === 'Escape') {
        this.awaiting = null;
        this.refresh();
        return this.say('Назначение отменено.');
      }
      const taken = conflictFor(this.settings.values, action, event.code);
      this.settings.bind(action, event.code);
      this.awaiting = null;
      this.refresh();
      const name = ACTIONS.find(item => item.id === action)?.label;
      this.say(
        taken
          ? `«${keyLabel(event.code)}» назначена на «${name}» и отобрана у «${labelOf(taken)}».`
          : `«${keyLabel(event.code)}» назначена на «${name}».`
      );
    };
    addEventListener('keydown', this.onKey, { capture: true });

    this.build();
  }

  say(text) {
    if (this.status) this.status.textContent = text || '';
  }

  open() {
    this.refresh();
    this.say('');
    this.screen?.classList.remove('hidden');
  }

  close() {
    this.awaiting = null;
    this.screen?.classList.add('hidden');
  }

  get isOpen() {
    return !this.screen?.classList.contains('hidden');
  }

  build() {
    if (!this.body) return;
    this.body.textContent = '';
    this.controls.clear();
    for (const group of GROUPS) this.body.append(this.buildGroup(group));
    this.body.append(this.buildKeys());
    this.refresh();
  }

  buildGroup({ title, note, keys }) {
    const section = document.createElement('section');
    section.className = 'settings-group';
    section.innerHTML = `<h3>${title}</h3><p class="settings-note">${note}</p>`;
    for (const key of keys) section.append(this.buildRow(key));
    return section;
  }

  buildRow(key) {
    const rule = SCHEMA[key];
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = LABELS[key];
    row.append(label);

    if (rule.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(rule.min);
      input.max = String(rule.max);
      input.step = String(rule.step);
      input.setAttribute('aria-label', LABELS[key]);
      const value = document.createElement('b');
      value.className = 'settings-value';
      input.addEventListener('input', () => {
        this.settings.set(key, Number(input.value));
        value.textContent = valueLabel(key, this.settings.get(key));
      });
      row.append(input, value);
      this.controls.set(key, { input, value });
    } else if (rule.type === 'enum') {
      // Короткий выбор («слева/справа») помещается справа от подписи; длинный переносится и
      // разрывает выравнивание всей строки, поэтому уезжает под подпись целиком.
      const wide =
        rule.values.length > 2 || rule.values.some(option => (CHOICES[key]?.[option] || option).length > 8);
      if (wide) row.classList.add('settings-row-stack');
      const group = document.createElement('div');
      group.className = 'settings-choice';
      const buttons = new Map();
      for (const option of rule.values) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = CHOICES[key]?.[option] || option.toUpperCase();
        button.addEventListener('click', () => {
          this.settings.set(key, option);
          this.refresh();
        });
        buttons.set(option, button);
        group.append(button);
      }
      row.append(group);
      this.controls.set(key, { buttons });
    } else if (rule.type === 'boolean') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-toggle';
      button.addEventListener('click', () => {
        this.settings.set(key, !this.settings.get(key));
        this.refresh();
      });
      row.append(button);
      this.controls.set(key, { toggle: button });
    }
    return row;
  }

  buildKeys() {
    const section = document.createElement('section');
    section.className = 'settings-group settings-keys';
    section.innerHTML =
      '<h3>КЛАВИАТУРА</h3><p class="settings-note">Нажмите клавишу рядом с действием, затем — новую. Escape отменяет.</p>';
    for (const action of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const label = document.createElement('span');
      label.className = 'settings-label';
      label.textContent = action.label;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-key';
      button.addEventListener('click', () => {
        this.awaiting = action.id;
        this.refresh();
        this.say(`Нажмите клавишу для «${action.label}». Escape — отмена.`);
      });
      row.append(label, button);
      section.append(row);
      this.controls.set(`key:${action.id}`, { button });
    }
    return section;
  }

  // Переносит значения из настроек в элементы. Отдельным проходом, а не при каждом изменении по
  // месту: настройки меняются и мимо панели — сбросом, а раскладка ещё и чужим действием, у
  // которого клавишу отобрали.
  refresh() {
    for (const [key, rule] of Object.entries(SCHEMA)) {
      const control = this.controls.get(key);
      if (!control) continue;
      const value = this.settings.get(key);
      if (rule.type === 'range') {
        control.input.value = String(value);
        control.value.textContent = valueLabel(key, value);
      } else if (rule.type === 'enum') {
        for (const [option, button] of control.buttons) button.classList.toggle('active', option === value);
      } else if (rule.type === 'boolean') {
        control.toggle.textContent = value ? 'ВКЛ' : 'ВЫКЛ';
        control.toggle.classList.toggle('active', value);
        control.toggle.setAttribute('aria-pressed', String(value));
      }
    }
    const keys = this.settings.get('keys');
    for (const action of ACTIONS) {
      const control = this.controls.get(`key:${action.id}`);
      if (!control) continue;
      const waiting = this.awaiting === action.id;
      control.button.textContent = waiting ? 'ЖДУ…' : keys[action.id].map(keyLabel).join(' · ');
      control.button.classList.toggle('awaiting', waiting);
    }
  }
}

function labelOf(action) {
  return ACTIONS.find(item => item.id === action)?.label || action;
}
