from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


admin_auth = Path("server/adminAuth.js")
replace_once(
    admin_auth,
    "constructor({ db, sessionTtlMs = ADMIN_SESSION_TTL_MS } = {}) {",
    "constructor({ db, sessionTtlMs = ADMIN_SESSION_TTL_MS, migrate = true } = {}) {",
)
replace_once(admin_auth, "    migrateDatabase(db);\n", "    if (migrate) migrateDatabase(db);\n")

control = Path("server/controlPlane.js")
replace_once(
    control,
    "const adminAuth = new AdminAuthService({ db });",
    "const adminAuth = new AdminAuthService({ db, migrate: false });",
)

routes = Path("server/controlPlaneRoutes.js")
replace_once(
    routes,
    """        cookie: req.headers.cookie || '',
        csrf: req.headers['x-wobble-admin-csrf'] || ''
""",
    """        cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(resolved.token)}`,
        csrf: req.headers['x-wobble-admin-csrf'] || ''
""",
)

routes_test = Path("server/controlPlaneRoutes.test.mjs")
replace_once(
    routes_test,
    """test('unknown admin route is never forwarded', async () => {
""",
    """test('game proxy synthesizes only the admin session cookie', async () => {
  let forwarded = null;
  const ctx = await start({
    gameClient: {
      health: async () => ({ ok: true }),
      adminRequest: async (_path, options) => {
        forwarded = options;
        return { statusCode: 200, payload: { ok: true, overview: {} } };
      }
    }
  });
  try {
    const session = await login(ctx);
    const response = await fetch(`${ctx.origin}/api/admin/dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${session.cookie}; account_session=must-not-forward`,
        'X-Wobble-Admin-CSRF': session.csrf
      },
      body: '{}'
    });
    assert.equal(response.status, 200);
    assert.match(forwarded.cookie, /^wobble_admin_session=/);
    assert.equal(forwarded.cookie.includes('account_session'), false);
  } finally {
    await ctx.close();
  }
});

test('unknown admin route is never forwarded', async () => {
""",
)
