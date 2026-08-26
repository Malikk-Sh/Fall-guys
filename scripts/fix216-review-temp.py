from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing {label}")
    return text.replace(old, new, 1)


audit = Path("server/movementAudit.js")
text = audit.read_text()
text = replace_once(
    text,
    "    state: state.state,\n    speed: observed,",
    "    state: state.state,\n    fromState: player.last?.state ?? state.state,\n    speed: observed,",
    "movement history state pattern",
)
text = replace_once(
    text,
    "  for (const item of history) {\n    const intervalMs = Math.max(0, item.at - item.fromAt);\n    if (item.state === 'knockdown') {",
    "  for (const item of history) {\n    const intervalMs = Math.max(0, item.at - item.fromAt);\n    // Между разными endpoint-state момент самого перехода неизвестен. Приписывать весь\n    // сетевой промежуток конечному состоянию особенно опасно именно при редких пакетах,\n    // которые этот замер и диагностирует. Переходный интервал поэтому не считается ни\n    // knockdown, ни управляемым движением; знаменатель полного окна при этом не меняется.\n    if ((item.fromState ?? item.state) !== item.state) continue;\n    if (item.state === 'knockdown') {",
    "causality loop pattern",
)
audit.write_text(text)


test = Path("server/sustainedSpeedMeasurement.test.mjs")
text = test.read_text()
marker = "test('окно без knockdown не создаёт новую analytics-размерность', () => {"
inserted = """test('переходный интервал не приписывается конечному состоянию', () => {
  const history = [
    { fromAt: 0, at: 500, dist: 4, fromState: 'ground', state: 'ground' },
    { fromAt: 500, at: 1000, dist: 10, fromState: 'ground', state: 'knockdown' },
    { fromAt: 1000, at: 1500, dist: 10, fromState: 'knockdown', state: 'knockdown' },
    { fromAt: 1500, at: 2000, dist: 4, fromState: 'knockdown', state: 'ground' }
  ];
  const cause = sustainedSpeedCausality(history, 2, 28);

  // Оба интервала смены state исключены: достоверно knockdown только третья четверть окна,
  // а достоверно управляемое движение — только первая.
  assert.ok(Math.abs(cause.knockdownTimeShare - 0.25) < 1e-9);
  assert.ok(Math.abs(cause.knockdownPathShare - 10 / 28) < 1e-9);
  assert.ok(Math.abs(cause.controlledPathSpeed - 8) < 1e-9);
  assert.equal(cause.detailSuffix, 'kd-12u');
});

""" + marker
text = replace_once(text, marker, inserted, "no-knockdown test marker")
test.write_text(text)


docs = Path("docs/ANALYTICS.md")
text = docs.read_text()
old = """`detail` — `когорта:состояние`, где когорта отделяет забеги, в которых признак сработал (`noted`),
израсходовал запас (`over`) и не срабатывал вовсе (`quiet`). Без этого деления среднее считалось бы
по всему населению, где спокойных забегов заведомо больше, и они размыли бы ровно те значения, ради
которых замер сделан: сшить эти строки с `movement_anomaly` нельзя — `GameplayMetrics` хранит только
суммы по ключу измерений. Только гонка: у кооператива своя проверка, уже считающая смещением.
"""
new = old + """
Если peak-окно содержит хотя бы один достоверный интервал `knockdown`, к `detail` добавляется
компактный suffix `kd-TPC`, например `over:knockdown:kd-23u`. Он специально помещается вместе с
префиксом в 32-символьный предел `GameplayMetrics`:

- `T` — доля времени полного peak-окна в стабильном `knockdown`: `1` = (0, 25 %], `2` =
  (25 %, 50 %], `3` = (50 %, 75 %], `4` = (75 %, 100 %];
- `P` — доля длины пути полного peak-окна в стабильном `knockdown`, с теми же четырьмя корзинами;
- `C` — скорость пути на стабильных интервалах вне `knockdown`: `u` = не выше текущего порога,
  `o` = выше, `n` = таких интервалов нет.

Интервал, у которого состояния на двух концах различаются, не приписывается целиком ни старому, ни
новому состоянию: точный момент перехода внутри сетевого промежутка неизвестен. Такой интервал
исключается и из knockdown-числителя, и из расчёта `C`, а знаменатели `T`/`P` остаются полным окном и
полным путём. Поэтому эти доли консервативны и не превращают редкий пакет на границе состояния в
ложное доказательство причинности. Suffix остаётся только диагностикой и не меняет anti-cheat решение.
"""
text = replace_once(text, old, new, "analytics detail paragraph")
docs.write_text(text)
