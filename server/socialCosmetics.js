const {
  DEFAULT_COSMETIC_LOADOUT,
  publicCosmeticLoadout,
  publicEmoteLoadout
} = require('../shared/cosmetics.js');

// Публичная косметика — это представление server inventory, а не данные клиента.
//
// index.js загружается и отдельно в старых integration-тестах, поэтому сам InventoryService сюда
// не импортируется. Production bootstrap подключает resolver после создания inventory. До этого
// граница безопасно возвращает базовый loadout — никакой присланный клиентом cosmetic id сюда не
// попадает.
class SocialCosmetics {
  constructor() {
    this.resolve = null;
    this.resolveEmotes = null;
  }

  configure(resolve) {
    this.resolve = typeof resolve === 'function' ? resolve : null;
  }

  // Отдельный хук для эмоций: index.js спрашивает «этому аккаунту сейчас можно проиграть этот
  // ID?», а отвечает inventory. Без подключённого inventory ответ всегда «нет» — сервер без
  // источника правды не должен раздавать разрешения на всякий случай.
  configureEmotes(canPlay) {
    this.resolveEmotes = typeof canPlay === 'function' ? canPlay : null;
  }

  sanitize(loadout) {
    return publicCosmeticLoadout(loadout || DEFAULT_COSMETIC_LOADOUT);
  }

  sanitizeEmotes(loadout) {
    return publicEmoteLoadout(loadout);
  }

  forAccount(accountId) {
    if (!accountId || !this.resolve) return this.sanitize(DEFAULT_COSMETIC_LOADOUT);
    try {
      return this.sanitize(this.resolve(String(accountId)));
    } catch {
      // Ошибка inventory не должна мешать войти в комнату. В худшем случае остальные увидят
      // стандартный образ; приватные данные аккаунта наружу всё равно не попадут.
      return this.sanitize(DEFAULT_COSMETIC_LOADOUT);
    }
  }

  /**
   * Разрешено ли аккаунту проиграть эмоцию: предмет существует, принадлежит ему и выбран в его
   * emote loadout. Гость эмоций не имеет — у него нет ни владения, ни выбора.
   */
  canPlayEmote(accountId, emoteId) {
    if (!accountId || !emoteId || !this.resolveEmotes) return false;
    try {
      return Boolean(this.resolveEmotes(String(accountId), String(emoteId)));
    } catch {
      // Та же логика, что и с loadout: сбой inventory не роняет комнату. Но и разрешения при
      // сбое не выдаём — молчаливый отказ безопаснее молчаливого допуска.
      return false;
    }
  }
}

const socialCosmetics = new SocialCosmetics();

module.exports = { SocialCosmetics, socialCosmetics };
