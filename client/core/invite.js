import { GAME_MODE } from '/shared/protocol.js';

const INVITE_MODES = new Set([GAME_MODE.RACE, GAME_MODE.COOP]);

export function normalizeInviteMode(mode) {
  return INVITE_MODES.has(mode) ? mode : GAME_MODE.RACE;
}

export function buildInviteLink(baseUrl, code, mode) {
  const url = new URL(baseUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set(
    'room',
    String(code || '')
      .trim()
      .toUpperCase()
      .slice(0, 5)
  );
  url.searchParams.set('mode', normalizeInviteMode(mode));
  return url.toString();
}

export function readInvite(urlValue) {
  try {
    const url = new URL(urlValue);
    const code = url.searchParams.get('room')?.trim().toUpperCase().slice(0, 5);
    if (!code) return null;
    const mode = url.searchParams.get('mode');
    // До появления параметра mode все ссылки открывали кооператив. Сохраняем это поведение для
    // уже отправленных приглашений; новые ссылки всегда несут режим явно.
    return { code, mode: mode === null ? GAME_MODE.COOP : normalizeInviteMode(mode) };
  } catch {
    return null;
  }
}
