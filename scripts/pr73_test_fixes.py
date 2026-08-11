from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing test-fix anchor in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# AdminControl intentionally reads the existing competitive leaderboard. The isolated sanctions
# fixture must provide the same legacy table shape as other admin-control tests.
replace_once(
    'server/adminSanctions.test.mjs',
    "  migrateDatabase(db);\n  db.prepare(\n",
    "  migrateDatabase(db);\n  db.exec(`\n    CREATE TABLE IF NOT EXISTS leaderboard_entries (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      mode TEXT NOT NULL,\n      course_key TEXT NOT NULL,\n      player_id TEXT NOT NULL,\n      display_name TEXT NOT NULL,\n      color INTEGER NOT NULL,\n      time_ms INTEGER NOT NULL,\n      achieved_at INTEGER NOT NULL,\n      verification_version INTEGER NOT NULL,\n      match_id TEXT NOT NULL\n    );\n  `);\n  db.prepare(\n",
)

# The pre-ban session must be alive at current wall-clock time so /api/auth/session reaches the
# sanction check instead of correctly expiring a session created near Unix epoch.
replace_once(
    'server/authSanctions.test.mjs',
    "  const session = ctx.auth.createSession(ctx.created.id, 200);",
    "  const session = ctx.auth.createSession(ctx.created.id, Date.now());",
)

# Migration regression expectations advance with migration 013.
replacements = {
    "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]": "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]",
    "    { version: 12, applied_at: 123 }\n  ]": "    { version: 12, applied_at: 123 },\n    { version: 13, applied_at: 123 }\n  ]",
    "    'account_support_search'\n  ])": "    'account_support_search',\n    'player_sanctions'\n  ])",
    "[8, 9, 10, 11, 12]": "[8, 9, 10, 11, 12, 13]",
    "[9, 10, 11, 12]": "[9, 10, 11, 12, 13]",
    "[10, 11, 12]": "[10, 11, 12, 13]",
    "[11, 12]": "[11, 12, 13]",
    "assert.deepEqual(migrateDatabase(db, { now: 200 }), [12]);": "assert.deepEqual(migrateDatabase(db, { now: 200 }), [12, 13]);",
}
p = Path('server/migrations.test.mjs')
text = p.read_text()
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f'missing migrations test anchor: {old!r}')
    text = text.replace(old, new, 1)
p.write_text(text)
