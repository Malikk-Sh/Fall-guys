// Кто голосует на экране итогов и как считается счёт.
//
// Вынесено из UI отдельной функцией, потому что ошибка здесь не видна ни в одном автоматическом
// сценарии и обнаруживается только глазами — а обнаружившись, выглядит как поломка игры.
//
// Так и случилось: бот входил в знаменатель, и единственный живой игрок в гонке с тремя ботами
// видел «ЕЩЁ РАЗ · 0/4». Он ждал трёх голосов, которых не будет — бот кнопку не нажимает, — хотя
// решение принималось его собственным нажатием.
//
// Правило то же, что на сервере (resolveResultsDecision): голосуют люди, оставшиеся на связи.

/**
 * @param {Array<{id: string, online?: boolean, bot?: boolean, choice?: string|null}>} players
 * @param {string|null} selfId
 */
export function voteTally(players = [], selfId = null) {
  const voters = players.filter(player => player.online && !player.bot);
  const count = choice => voters.filter(player => player.choice === choice).length;
  return {
    total: voters.length,
    self: voters.find(player => player.id === selfId) || null,
    next: count('next'),
    rematch: count('rematch'),
    lobby: count('lobby')
  };
}
