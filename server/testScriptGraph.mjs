export function expandNpmScript(scripts, name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);

  const command = scripts[name] || '';
  const nestedScripts = [...command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map(([, child]) => child);

  return [command, ...nestedScripts.map(child => expandNpmScript(scripts, child, seen))]
    .filter(Boolean)
    .join('\n');
}
