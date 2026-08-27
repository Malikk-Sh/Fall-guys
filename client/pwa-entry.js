import { PLATFORM, resolvePlatform } from './core/PlatformResolver.js';
import { PwaController } from './core/pwa.js';
import { installCampaignPresentation } from './game/CampaignPresentation.js';
import { installCoopCelebrationPresentation } from './game/CoopCelebrationPresentation.js';
import { installCoopPingPresentation } from './game/CoopPingPresentation.js';
import { installFeedbackController } from './game/FeedbackController.js';
import { installResultsPresentation } from './game/ResultsPresentation.js';
import { installCampaignUiTheme } from './ui/CampaignUiTheme.js';
import { installContextActionControl } from './ui/ContextActionControl.js';
import { installMenuPolish } from './ui/MenuPolish.js';
import { installMenuStageExperience } from './ui/MenuStageExperience.js';
import { MobileExperience } from './ui/MobileExperience.js';
import { installRewardRevealQueue } from './ui/RewardRevealQueue.js';
import { installTouchTutorialPresentation } from './ui/TouchTutorialPresentation.js';
import { installWardrobeMilestonePresentation } from './ui/WardrobeMilestonePresentation.js';
import { installWardrobePresetPresentation } from './ui/WardrobePresetPresentation.js';

// Файл назван по первому своему жильцу, но давно им не исчерпывается: ниже поднимается ВЕСЬ
// интерфейс — мобильный опыт, оформление меню, обучение, обратная связь, кооп-презентации, экран
// результатов, гардероб и награды. Поэтому целиком его отключать нельзя нигде и никогда.
//
// Платформенная часть здесь только одна: сама PWA-обвязка. На площадке она бессмысленна и вредна —
// service worker живёт в чужом iframe, а установка приложения площадкой не предусмотрена, — поэтому
// в портальный билд `service-worker.js` не попадает вовсе. Запусти мы контроллер без него, он
// попытался бы зарегистрировать отсутствующий файл.
if (resolvePlatform() === PLATFORM.WEB) {
  const pwa = new PwaController({
    isSafeToReload: () => !globalThis.__WOBBLE_GAME__?.running
  });
  globalThis.__WOBBLE_PWA__ = pwa;
  pwa.start();
}

const mobileExperience = new MobileExperience();
globalThis.__WOBBLE_MOBILE_EXPERIENCE__ = mobileExperience;
mobileExperience.init();

installCampaignPresentation();
installMenuPolish();
installMenuStageExperience();
const campaignUiTheme = installCampaignUiTheme();
globalThis.__WOBBLE_CAMPAIGN_UI_THEME__ = campaignUiTheme;
const touchTutorial = installTouchTutorialPresentation();
globalThis.__WOBBLE_TOUCH_TUTORIAL__ = touchTutorial;
const feedbackController = installFeedbackController();
globalThis.__WOBBLE_FEEDBACK__ = feedbackController;
const contextActionControl = installContextActionControl();
globalThis.__WOBBLE_CONTEXT_ACTION__ = contextActionControl;
const coopPingPresentation = installCoopPingPresentation();
globalThis.__WOBBLE_COOP_PING_PRESENTATION__ = coopPingPresentation;
const coopCelebrationPresentation = installCoopCelebrationPresentation();
globalThis.__WOBBLE_COOP_CELEBRATION_PRESENTATION__ = coopCelebrationPresentation;
const resultsPresentation = installResultsPresentation();
globalThis.__WOBBLE_RESULTS_PRESENTATION__ = resultsPresentation;
const wardrobePresetPresentation = installWardrobePresetPresentation();
globalThis.__WOBBLE_WARDROBE_PRESET_PRESENTATION__ = wardrobePresetPresentation;
const rewardReveal = installRewardRevealQueue();
globalThis.__WOBBLE_REWARD_REVEAL__ = rewardReveal;
const wardrobeMilestones = installWardrobeMilestonePresentation();
globalThis.__WOBBLE_WARDROBE_MILESTONES__ = wardrobeMilestones;
