const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;

export function parseReleaseTag(tag) {
  const value = String(tag || '').trim();
  const match = RELEASE_TAG.exec(value);
  if (!match) return null;
  return {
    tag: value,
    version: match[1],
    prerelease: Boolean(match[2]),
    prereleaseLabel: match[2] || null
  };
}

// Следующий свободный номер предрелиза.
//
// Номер выбирается по УЖЕ СУЩЕСТВУЮЩИМ тегам, а не человеком по памяти. Человек ошибался трижды:
// дважды ставил тег на устаревшую локальную main (v2.6.0-beta.2 уронила прод), один раз назвал
// занятый номер. Первое лечится тем, что тег ставит CI с origin/main; второе — вот этим.
//
// Теги неизменяемы, поэтому занятый номер нельзя переставить — только взять следующий.
export function nextPrereleaseTag({ tags, version, channel = 'beta' }) {
  const base = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error(`invalid package version: ${version}`);
  }
  if (!/^[0-9A-Za-z]+$/.test(String(channel || ''))) {
    throw new Error(`invalid prerelease channel: ${channel}`);
  }

  let highest = 0;
  let stable = false;
  for (const candidate of tags || []) {
    const release = parseReleaseTag(candidate);
    if (!release || release.version !== base) continue;
    if (!release.prerelease) {
      stable = true;
      continue;
    }
    const match = new RegExp(`^${channel}\\.(\\d+)$`).exec(release.prereleaseLabel);
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }

  // Предрелиз версии, которая уже вышла стабильной, — это шаг назад: по semver `-beta.N` МЕНЬШЕ,
  // чем сама версия. Молча выпустить такое хуже, чем остановиться и потребовать поднять версию.
  if (stable) {
    throw new Error(`v${base} is already released; bump the package version before tagging ${channel}`);
  }

  return `v${base}-${channel}.${highest + 1}`;
}

// Какой релиз считать «последним опубликованным».
//
// Черновики пропускаются всегда: это ещё не выпущенное. Предрелизы — только по явному согласию,
// иначе боевой сервер уезжал бы на бету от одного того, что её опубликовали.
//
// Порядок берётся тот, что вернул GitHub (самый свежий первым), а не «наибольший номер»: выкатить
// надо то, что выпущено последним. Это различается, когда чинят старую ветку версий.
export function pickLatestRelease(releases, { allowPrerelease = false } = {}) {
  if (!Array.isArray(releases)) return null;
  for (const release of releases) {
    if (!release || typeof release !== 'object') continue;
    if (release.draft) continue;
    if (release.prerelease && !allowPrerelease) continue;
    if (!parseReleaseTag(release.tag_name)) continue;
    return release.tag_name;
  }
  return null;
}

export function validateReleaseVersions({ tag, packageVersion, lockVersion }) {
  const release = parseReleaseTag(tag);
  if (!release) {
    throw new Error(`invalid release tag: ${tag}`);
  }
  if (String(packageVersion || '') !== release.version) {
    throw new Error(`tag ${tag} targets ${release.version}, package.json is ${packageVersion}`);
  }
  if (String(lockVersion || '') !== release.version) {
    throw new Error(`package-lock.json is ${lockVersion}, expected ${release.version}`);
  }
  return release;
}
