import { PwaController } from './core/pwa.js';
import { installCampaignPresentation } from './game/CampaignPresentation.js';
import { installMenuPolish } from './ui/MenuPolish.js';
import { installMenuStageExperience } from './ui/MenuStageExperience.js';
import { MobileExperience } from './ui/MobileExperience.js';

const pwa = new PwaController({
  isSafeToReload: () => !globalThis.__WOBBLE_GAME__?.running
});
globalThis.__WOBBLE_PWA__ = pwa;
pwa.start();

const mobileExperience = new MobileExperience();
globalThis.__WOBBLE_MOBILE_EXPERIENCE__ = mobileExperience;
mobileExperience.init();

installCampaignPresentation();
installMenuPolish();
installMenuStageExperience();
