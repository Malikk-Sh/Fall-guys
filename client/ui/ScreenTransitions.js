const DEFAULT_MOTION = Object.freeze({
  fast: 120,
  normal: 180,
  slow: 320,
  easeOut: 'cubic-bezier(.16,.9,.28,1)',
  easePop: 'cubic-bezier(.18,.9,.3,1.18)'
});

function directionSign(direction) {
  if (direction === 'back' || direction === 'backward' || direction === -1) return -1;
  return 1;
}

export class ScreenTransitions {
  constructor({ windowRef = globalThis, getReducedMotion = () => false, motion = {} } = {}) {
    this.window = windowRef;
    this.getReducedMotion = getReducedMotion;
    this.motion = { ...DEFAULT_MOTION, ...motion };
    this.active = new WeakMap();
  }

  reduced() {
    return Boolean(this.getReducedMotion?.());
  }

  cancel(node) {
    const animation = node ? this.active.get(node) : null;
    if (!animation) return;
    try {
      animation.cancel();
    } catch {}
    this.active.delete(node);
  }

  play(node, keyframes, options = {}) {
    if (!node || this.reduced() || typeof node.animate !== 'function') return null;
    this.cancel(node);
    try {
      const animation = node.animate(keyframes, { fill: 'both', ...options });
      this.active.set(node, animation);
      const clear = () => {
        if (this.active.get(node) === animation) this.active.delete(node);
      };
      animation.finished?.then(clear, clear);
      return animation;
    } catch {
      return null;
    }
  }

  transition(from, to, { direction = 'forward', instant = false } = {}) {
    if (!to) return Promise.resolve();
    const sign = directionSign(direction);
    if (instant || this.reduced() || !from || from === to) {
      if (from && from !== to) from.classList.add('hidden');
      to.classList.remove('hidden');
      return Promise.resolve();
    }

    const exit = this.play(
      from,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: `translateX(${-14 * sign}px) scale(.986)` }
      ],
      { duration: this.motion.fast, easing: 'cubic-bezier(.4,0,1,1)' }
    );

    return Promise.resolve(exit?.finished)
      .catch(() => {})
      .then(() => {
        this.cancel(from);
        from.classList.add('hidden');
        to.classList.remove('hidden');
        const enter = this.play(
          to,
          [
            { opacity: 0, transform: `translateX(${16 * sign}px) scale(.986)` },
            { opacity: 1, transform: 'none' }
          ],
          { duration: this.motion.normal, easing: this.motion.easeOut }
        );
        return Promise.resolve(enter?.finished).catch(() => {});
      })
      .finally(() => this.cancel(to));
  }

  panelSwap(oldPanel, newPanel, direction = 'forward') {
    return this.transition(oldPanel, newPanel, { direction });
  }

  celebrate(element, kind = 'confirm') {
    if (!element || this.reduced()) return null;
    const presets = {
      confirm: [
        { transform: 'scale(1)' },
        { transform: 'scale(.97)', offset: 0.35 },
        { transform: 'scale(1.018)', offset: 0.72 },
        { transform: 'scale(1)' }
      ],
      card: [
        { opacity: 0.72, transform: 'translateY(7px) scale(.975)' },
        { opacity: 1, transform: 'translateY(-1px) scale(1.01)', offset: 0.72 },
        { opacity: 1, transform: 'none' }
      ],
      reward: [
        { opacity: 0, transform: 'translateY(10px) scale(.9)' },
        { opacity: 1, transform: 'translateY(-2px) scale(1.04)', offset: 0.7 },
        { opacity: 1, transform: 'none' }
      ]
    };
    const frames = presets[kind] || presets.confirm;
    return this.play(element, frames, {
      duration: kind === 'reward' ? this.motion.slow : this.motion.normal,
      easing: kind === 'card' ? this.motion.easeOut : this.motion.easePop
    });
  }
}
