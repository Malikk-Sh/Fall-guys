import { PwaController } from './core/pwa.js';
import { installCampaignPresentation } from './game/CampaignPresentation.js';

const pwa = new PwaController({
  isSafeToReload: () => !globalThis.__WOBBLE_GAME__?.running
});
globalThis.__WOBBLE_PWA__ = pwa;
pwa.start();
installCampaignPresentation();
