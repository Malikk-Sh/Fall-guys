import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const markerPattern = /^(<<<<<<<|=======|>>>>>>>)/;
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: 'utf8'
    })
      .split('\0')
      .filter(Boolean)
  )
];

const findings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file);
  } catch {
    continue;
  }

  // Не пытаемся интерпретировать бинарные файлы как UTF-8.
  if (content.includes(0)) continue;

  const lines = content.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (markerPattern.test(lines[index])) {
      findings.push(`${file}:${index + 1}:${lines[index]}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Merge conflict markers found:');
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
}
