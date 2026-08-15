import { COSMETIC_BY_ID, EMOTE_LOADOUT_SIZE } from '/shared/cosmetics.js';
import { readEmoteLoadout } from '../core/cosmetics.js';

// Кнопка эмоций.
//
// Расположение выбрано так, чтобы не спорить с управлением: джойстик занимает нижний левый угол,
// прыжок и рывок — нижний правый, поэтому эмоции живут вверху справа, рядом с кнопками камеры.
// Это не эстетика: промах по прыжку в забеге стоит дороже любой позы.
//
// Короткое касание проигрывает первую выбранную эмоцию, удержание раскрывает колесо из четырёх.
// Одно и то же поведение и на телефоне, и на компьютере — плюс цифры 1–4 и клавиша E.

const LONG_PRESS_MS = 260;

export class EmoteControl {
  constructor({ onPlay = () => {}, getProgress = () => null, getProfile = () => null } = {}) {
    this.onPlay = onPlay;
    this.getProgress = getProgress;
    this.getProfile = getProfile;
    this.open = false;
    this.timer = 0;
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    const button = document.querySelector('#emoteButton');
    const wheel = document.querySelector('#emoteWheel');
    if (!button || !wheel) return;
    this.bound = true;
    this.button = button;
    this.wheel = wheel;

    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.toggle(true);
      }, LONG_PRESS_MS);
    });
    const release = () => {
      if (!this.timer) return;
      clearTimeout(this.timer);
      this.timer = 0;
      if (this.open) this.toggle(false);
      else this.play(0);
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', () => {
      clearTimeout(this.timer);
      this.timer = 0;
    });

    addEventListener('keydown', event => {
      if (event.repeat || event.target?.matches?.('input, select, textarea')) return;
      if (event.code === 'KeyE') this.toggle(!this.open);
      const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
      if (digit >= 0) this.play(digit);
    });
  }

  loadout() {
    return readEmoteLoadout(this.getProgress(), this.getProfile());
  }

  setVisible(visible) {
    this.bind();
    this.button?.classList.toggle('hidden', !visible);
    if (!visible) this.toggle(false);
  }

  toggle(open) {
    this.bind();
    if (!this.wheel) return;
    this.open = Boolean(open) && this.loadout().some(Boolean);
    this.wheel.classList.toggle('hidden', !this.open);
    if (this.open) this.render();
  }

  render() {
    const loadout = this.loadout();
    this.wheel.replaceChildren();
    for (let index = 0; index < EMOTE_LOADOUT_SIZE; index++) {
      const item = loadout[index] ? COSMETIC_BY_ID[loadout[index]] : null;
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'emote-wheel-slot';
      slot.disabled = !item;
      slot.textContent = item ? item.render.glyph || '💃' : '—';
      slot.setAttribute('aria-label', item ? item.name : `Ячейка ${index + 1} пуста`);
      slot.addEventListener('click', () => this.play(index));
      this.wheel.append(slot);
    }
  }

  play(index) {
    const id = this.loadout()[index];
    if (!id) return false;
    this.toggle(false);
    return this.onPlay(id);
  }
}
