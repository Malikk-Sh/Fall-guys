import { PwaController } from './core/pwa.js';
import { installCampaignPresentation } from './game/CampaignPresentation.js';
import { installCoopCelebrationPresentation } from './game/CoopCelebrationPresentation.js';
import { installCoopPingPresentation } from './game/CoopPingPresentation.js';
import { installFeedbackController } from './game/FeedbackController.js';
import { installResultsPresentation } from './game/ResultsPresentation.js';
import { installContextActionControl } from './ui/ContextActionControl.js';
import { installMenuPolish } from './ui/MenuPolish.js';
import { installMenuStageExperience } from './ui/MenuStageExperience.js';
import { MobileExperience } from './ui/MobileExperience.js';
import { installRewardRevealQueue } from './ui/RewardRevealQueue.js';
import { installWardrobeMilestonePresentation } from './ui/WardrobeMilestonePresentation.js';
import { installWardrobePresetPresentation } from './ui/WardrobePresetPresentation.js';

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
