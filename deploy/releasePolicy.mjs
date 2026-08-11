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
