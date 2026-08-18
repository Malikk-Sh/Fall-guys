const FULLSCREEN_PROMPT_DISMISSED_KEY = 'wobble-fullscreen-prompt-v1';

export async function continueInWindowedMode(context) {
  await context.addInitScript(key => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      // Init scripts can also run for opaque documents such as about:blank.
      // The preference is applied once the app origin is available.
    }
  }, FULLSCREEN_PROMPT_DISMISSED_KEY);
}
