import { PwaController } from './core/pwa.js';
import { installCampaignPresentation } from './game/CampaignPresentation.js';
import { installMenuPolish } from './ui/MenuPolish.js';

const pwa = new PwaController({
  isSafeToReload: () => !globalThis.__WOBBLE_GAME__?.running
});
globalThis.__WOBBLE_PWA__ = pwa;
pwa.start();
installCampaignPresentation();
installMenuPolish();
