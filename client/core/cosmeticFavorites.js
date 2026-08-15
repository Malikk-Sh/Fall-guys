// Избранное шкафа.
//
// Это НЕ entitlement. Избранное ничего не выдаёт, ничего не открывает и не проверяется сервером —
// это отметка «показывай это ближе», и место ей в браузере, а не в аккаунте. Отсюда же и
// требование к отказам: закрытый или переполненный localStorage не должен ломать шкаф. Приватный
// режим, переполненная квота и отключённое хранилище — обычные состояния браузера, а не сбой.

import { COSMETIC_BY_ID } from '/shared/cosmetics.js';

const STORAGE_KEY = 'wobble-cosmetic-favorites-v1';
const MAX_FAVORITES = 60;

// Пока storage недоступен, избранное живёт в памяти вкладки. Игрок отметит предмет, увидит
// отметку и потеряет её после перезагрузки — это заметно лучше, чем кнопка, которая молча не
// работает.
let memory = null;

export function readFavorites(storage = globalThis.localStorage) {
  if (memory) return new Set(memory);
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    // Неизвестные ID отсеиваются здесь: каталог мог измениться между версиями, и хранить ссылки
    // на несуществующие предметы бессмысленно.
    return new Set(parsed.filter(id => typeof id === 'string' && COSMETIC_BY_ID[id]).slice(0, MAX_FAVORITES));
  } catch {
    return new Set();
  }
}

export function writeFavorites(ids, storage = globalThis.localStorage) {
  const list = [...ids].filter(id => COSMETIC_BY_ID[id]).slice(0, MAX_FAVORITES);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(list));
    memory = null;
  } catch {
    memory = list;
  }
  return new Set(list);
}

export function toggleFavorite(id, storage = globalThis.localStorage) {
  if (!COSMETIC_BY_ID[id]) return readFavorites(storage);
  const favorites = readFavorites(storage);
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  return writeFavorites(favorites, storage);
}

// Что игрок уже видел в окне «новый предмет». Ownership всё равно остаётся серверным: этот список
// отвечает только на вопрос «показывали ли мы уже эту карточку», и подделка его ничего не даёт.
const SEEN_KEY = 'wobble-cosmetic-seen-v1';
let seenMemory = null;

export function readSeenCosmetics(storage = globalThis.localStorage) {
  if (seenMemory) return new Set(seenMemory);
  try {
    const parsed = JSON.parse(storage?.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markCosmeticsSeen(ids, storage = globalThis.localStorage) {
  const seen = readSeenCosmetics(storage);
  for (const id of ids) seen.add(id);
  const list = [...seen].slice(-400);
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify(list));
    seenMemory = null;
  } catch {
    seenMemory = list;
  }
  return new Set(list);
}

/** Только для тестов: сбрасывает память-фолбэк между сценариями. */
export function resetFavoritesFallback() {
  memory = null;
  seenMemory = null;
}
