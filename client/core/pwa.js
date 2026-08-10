export function updateButtonLabel({ safe, requested }) {
  if (requested && !safe) return 'ОБНОВИМ ПОСЛЕ ЗАБЕГА';
  return safe ? 'ОБНОВИТЬ СЕЙЧАС' : 'ОБНОВИТЬ ПОСЛЕ ЗАБЕГА';
}

export class PwaController {
  constructor({
    navigatorRef = globalThis.navigator,
    windowRef = globalThis,
    documentRef = globalThis.document,
    isSafeToReload = () => true,
    setIntervalImpl = globalThis.setInterval?.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval?.bind(globalThis)
  } = {}) {
    this.navigator = navigatorRef;
    this.window = windowRef;
    this.document = documentRef;
    this.isSafeToReload = isSafeToReload;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.waitingWorker = null;
    this.installPrompt = null;
    this.updateRequested = false;
    this.reloadStarted = false;
    this.pollTimer = null;
  }

  async start() {
    this.bindConnectivity();
    this.bindInstallPrompt();
    const serviceWorker = this.navigator?.serviceWorker;
    if (!serviceWorker?.register) return null;
    serviceWorker.addEventListener?.('controllerchange', () => this.handleControllerChange());
    try {
      const registration = await serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none'
      });
      this.watchRegistration(registration);
      return registration;
    } catch (error) {
      console.warn('PWA registration failed', error);
      return null;
    }
  }

  bindConnectivity() {
    const render = () => {
      const banner = this.document?.getElementById?.('offlineBanner');
      if (!banner) return;
      banner.classList.toggle('hidden', this.navigator?.onLine !== false);
    };
    this.window?.addEventListener?.('online', render);
    this.window?.addEventListener?.('offline', render);
    render();
  }

  bindInstallPrompt() {
    const button = this.document?.getElementById?.('installApp');
    if (!button) return;
    button.addEventListener('click', () => this.promptInstall());
    this.window?.addEventListener?.('beforeinstallprompt', event => {
      event.preventDefault();
      this.installPrompt = event;
      if (!this.isStandalone()) button.classList.remove('hidden');
    });
    this.window?.addEventListener?.('appinstalled', () => {
      this.installPrompt = null;
      button.classList.add('hidden');
    });
    if (this.isStandalone()) button.classList.add('hidden');
  }

  isStandalone() {
    return Boolean(
      this.navigator?.standalone || this.window?.matchMedia?.('(display-mode: standalone)')?.matches
    );
  }

  async promptInstall() {
    const prompt = this.installPrompt;
    if (!prompt) return false;
    this.installPrompt = null;
    const button = this.document?.getElementById?.('installApp');
    button?.classList.add('hidden');
    await prompt.prompt?.();
    const choice = await prompt.userChoice?.catch?.(() => null);
    return choice?.outcome === 'accepted';
  }

  watchRegistration(registration) {
    if (!registration) return;
    if (registration.waiting && this.navigator?.serviceWorker?.controller)
      this.offerUpdate(registration.waiting);
    registration.addEventListener?.('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener?.('statechange', () => {
        if (worker.state === 'installed' && this.navigator?.serviceWorker?.controller)
          this.offerUpdate(worker);
      });
    });
  }

  offerUpdate(worker) {
    this.waitingWorker = worker;
    const banner = this.document?.getElementById?.('updateBanner');
    const button = this.document?.getElementById?.('applyUpdate');
    banner?.classList.remove('hidden');
    if (!button) return;
    button.disabled = false;
    button.textContent = updateButtonLabel({ safe: this.isSafeToReload(), requested: false });
    if (!button.dataset.pwaBound) {
      button.dataset.pwaBound = '1';
      button.addEventListener('click', () => this.requestUpdate());
    }
  }

  requestUpdate() {
    if (!this.waitingWorker) return false;
    this.updateRequested = true;
    if (this.isSafeToReload()) return this.activateWaiting();
    const button = this.document?.getElementById?.('applyUpdate');
    if (button) {
      button.textContent = updateButtonLabel({ safe: false, requested: true });
      button.disabled = true;
    }
    if (!this.pollTimer && this.setInterval) {
      this.pollTimer = this.setInterval(() => {
        if (this.updateRequested && this.waitingWorker && this.isSafeToReload()) this.activateWaiting();
      }, 500);
    }
    return true;
  }

  activateWaiting() {
    if (!this.waitingWorker || !this.updateRequested) return false;
    if (this.pollTimer && this.clearInterval) this.clearInterval(this.pollTimer);
    this.pollTimer = null;
    const button = this.document?.getElementById?.('applyUpdate');
    if (button) {
      button.textContent = 'ОБНОВЛЯЕМ…';
      button.disabled = true;
    }
    this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  handleControllerChange() {
    if (!this.updateRequested || this.reloadStarted || !this.isSafeToReload()) return;
    this.reloadStarted = true;
    this.window?.location?.reload?.();
  }
}
