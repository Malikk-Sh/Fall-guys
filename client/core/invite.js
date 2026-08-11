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

// Web Share требует transient user activation не во всех браузерах одинаково. Для обычной кнопки
// share почти всегда проходит; автоматическая попытка после ответа сервера иногда получает
// NotAllowedError. В таком случае безопасно пробуем clipboard и оставляем кнопку «ССЫЛКА» как
// последний fallback. AbortError — это явная отмена системного share sheet пользователем, её не
// превращаем в неожиданное копирование.
export async function shareInvite({ title, url, navigatorRef = globalThis.navigator } = {}) {
  if (!url) return { ok: false, reason: 'missing-url' };
  if (typeof navigatorRef?.share === 'function') {
    try {
      await navigatorRef.share({ title, url });
      return { ok: true, shared: true, copied: false };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, cancelled: true, reason: 'cancelled' };
    }
  }
  try {
    if (typeof navigatorRef?.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
    await navigatorRef.clipboard.writeText(url);
    return { ok: true, shared: false, copied: true };
  } catch {
    return { ok: false, cancelled: false, reason: 'manual', url };
  }
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
