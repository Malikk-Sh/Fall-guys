const {
  DEFAULT_COSMETIC_LOADOUT,
  publicCosmeticLoadout
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
  }

  configure(resolve) {
    this.resolve = typeof resolve === 'function' ? resolve : null;
  }

  sanitize(loadout) {
    return publicCosmeticLoadout(loadout || DEFAULT_COSMETIC_LOADOUT);
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
}

const socialCosmetics = new SocialCosmetics();

module.exports = { SocialCosmetics, socialCosmetics };
