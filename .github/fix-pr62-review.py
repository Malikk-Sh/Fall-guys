from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


install = "deploy/install.sh"
replace(
    install,
    'RELEASE_TAG="${RELEASE_TAG-${SAVED_RELEASE_TAG:-}}"\nDOMAIN="${DOMAIN:-$SAVED_DOMAIN}"\n',
    'RELEASE_TAG="${RELEASE_TAG-${SAVED_RELEASE_TAG:-}}"\nRELEASE_REPOSITORY="${RELEASE_REPOSITORY:-Malikk-Sh/Fall-guys}"\nDOMAIN="${DOMAIN:-$SAVED_DOMAIN}"\n',
)
replace(
    install,
    'if [ -n "$RELEASE_TAG" ] &&\n  ! [[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then\n  fail "RELEASE_TAG должен выглядеть как v2.6.0 или v2.6.0-beta.1"\nfi\n\n',
    'if [ -n "$RELEASE_TAG" ] &&\n  ! [[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then\n  fail "RELEASE_TAG должен выглядеть как v2.6.0 или v2.6.0-beta.1"\nfi\nif [ -n "$RELEASE_TAG" ] &&\n  ! [[ "$RELEASE_REPOSITORY" =~ ^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$ ]]; then\n  fail "RELEASE_REPOSITORY должен выглядеть как owner/repo"\nfi\n\n',
)
old_block = '''  say "Фиксированный release ${RELEASE_TAG}"
  git -C "$APP_DIR" fetch --force --depth 1 origin     "+refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"
  release_commit="$(git -C "$APP_DIR" rev-parse "${RELEASE_TAG}^{commit}")"
  git -C "$APP_DIR" checkout --detach --force "$release_commit"
'''
new_block = '''  say "Проверяю опубликованный release ${RELEASE_TAG}"
  release_json="$(
    curl -fsS --max-time 10 \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${RELEASE_TAG}"
  )" || fail "release ${RELEASE_TAG} ещё не опубликован в GitHub Releases"
  node - "$release_json" "$RELEASE_TAG" <<'NODE'
const release = JSON.parse(process.argv[2]);
const expectedTag = process.argv[3];
if (release.tag_name !== expectedTag || release.draft === true || !release.published_at) {
  throw new Error(`release ${expectedTag} is not published`);
}
NODE

  say "Фиксированный release ${RELEASE_TAG}"
  candidate_ref="refs/wobble-release-candidates/${RELEASE_TAG}"
  git -C "$APP_DIR" fetch --force --depth 1 origin \
    "+refs/tags/${RELEASE_TAG}:${candidate_ref}"
  remote_release_object="$(git -C "$APP_DIR" rev-parse "$candidate_ref")"
  if local_release_object="$(git -C "$APP_DIR" rev-parse -q --verify "refs/tags/${RELEASE_TAG}" 2>/dev/null)"; then
    [ "$local_release_object" = "$remote_release_object" ] ||
      fail "release tag ${RELEASE_TAG} изменился после первого получения — отказываюсь перезаписывать pin"
  else
    git -C "$APP_DIR" update-ref "refs/tags/${RELEASE_TAG}" "$remote_release_object"
  fi
  git -C "$APP_DIR" update-ref -d "$candidate_ref" >/dev/null 2>&1 || true
  release_commit="$(git -C "$APP_DIR" rev-parse "${RELEASE_TAG}^{commit}")"
  git -C "$APP_DIR" checkout --detach --force "$release_commit"
'''
replace(install, old_block, new_block)

release_test = Path("server/releaseDeploy.test.mjs")
text = release_test.read_text()
text = text.replace(
    "  assert.match(install, /refs\\/tags\\/\\$\\{RELEASE_TAG\\}:refs\\/tags\\/\\$\\{RELEASE_TAG\\}/);\n",
    "  assert.match(install, /refs\\/wobble-release-candidates\\/\\$\\{RELEASE_TAG\\}/);\n  assert.match(install, /remote_release_object/);\n  assert.match(install, /local_release_object/);\n  assert.match(install, /release tag \\$\\{RELEASE_TAG\\} изменился/);\n",
)
text = text.replace(
    "  assert.match(install, /check-release\\.mjs\" \"\\$RELEASE_TAG\"/);\n",
    "  assert.match(install, /releases\\/tags\\/\\$\\{RELEASE_TAG\\}/);\n  assert.match(install, /release \\$\\{RELEASE_TAG\\} ещё не опубликован/);\n  assert.match(install, /check-release\\.mjs\" \"\\$RELEASE_TAG\"/);\n",
)
release_test.write_text(text)

deploy_doc = Path("docs/DEPLOY.md")
text = deploy_doc.read_text()
text = text.replace(
    "код в `/opt/wobble`, поднимает службу `wobble` и проверяет, что сервер отвечает. Повторный запуск\nобновляет игру до свежего `main` и перезапускает службу — ничего не ломая.\n",
    "код в `/opt/wobble`, поднимает службу `wobble` и проверяет, что сервер отвечает. В обычном\nbranch-режиме повторный запуск обновляет игру до свежего `main`. После production deploy по\n`RELEASE_TAG` повторный запуск остаётся на том же release, пока новый тег не передан явно.\n",
)
text = text.replace(
    "bash /opt/wobble/deploy/install.sh   # обновить до свежего main\n",
    "bash /opt/wobble/deploy/install.sh   # повторить текущий режим; release-pin останется закреплён\n",
)
text = text.replace(
    "Скрипт подтянет свежий `main`, переустановит зависимости и перезапустит службу. Простой — секунды.\n\nДомен и порт повторять не нужно: значения последнего удачного развёртывания лежат в\n",
    "Если сервер работает в branch-режиме, скрипт подтянет свежий `main`. Если ранее был успешно\nразвёрнут `RELEASE_TAG`, команда без переменных повторно ставит именно этот закреплённый release.\nЧтобы перейти на новый публичный beta/release, укажите новый тег явно:\n\n```bash\nRELEASE_TAG=v2.6.0-beta.2 bash /opt/wobble/deploy/install.sh\n```\n\nТег должен уже существовать как опубликованный GitHub Release; один только pushed tag недостаточен.\nДомен и порт повторять не нужно: значения последнего удачного развёртывания лежат в\n",
)
deploy_doc.write_text(text)

release_doc = Path("docs/RELEASE-PROCESS.md")
text = release_doc.read_text()
text = text.replace(
    "Exact tag-pinned VPS deployment is intentionally a separate hardening step: the existing installer still follows its configured branch. Until that follow-up lands, a release is considered published only after the production `/health` build SHA is manually verified against the release commit.\n\n",
    "Production deploys can now pin an exact published release tag. The installer still verifies `/health` build identity after restart, so the release tag, package version and exact build SHA remain tied together.\n\n",
)
text = text.replace(
    "The installer verifies that the tag matches `package.json` and `package-lock.json`, checks out the tag commit detached, writes both release tag and build SHA into the service environment, and requires the deploy smoke to observe the expected version, commit and release identity from `/health`.\n",
    "The installer first requires the tag to have a non-draft published GitHub Release, then refuses to overwrite a previously seen local tag if the remote tag object ever changes. It verifies that the tag matches `package.json` and `package-lock.json`, checks out the tag commit detached, writes both release tag and build SHA into the service environment, and requires the deploy smoke to observe the expected version, commit and release identity from `/health`.\n",
)
release_doc.write_text(text)
