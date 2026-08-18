import { appendFileSync } from 'node:fs';

const clean = value => String(value || '').replace(/```/g, '``\u200b`');
const seconds = milliseconds => `${(milliseconds / 1000).toFixed(1)}s`;

class GitHubStepSummaryReporter {
  constructor() {
    this.results = new Map();
    this.globalErrors = [];
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    const current = this.results.get(test.id) || {
      test,
      project: test.parent.project()?.name || 'unknown',
      attempts: []
    };
    current.test = test;
    current.attempts.push(result);
    this.results.set(test.id, current);
  }

  onError(error) {
    this.globalErrors.push(error);
  }

  onEnd(run) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;

    const latest = [...this.results.values()].map(entry => ({
      ...entry,
      result: entry.attempts.at(-1)
    }));
    const failures = latest.filter(
      ({ test, result }) => result.status !== test.expectedStatus && result.status !== 'skipped'
    );
    const flaky = latest.filter(
      ({ test, result, attempts }) =>
        result.status === test.expectedStatus && result.status === 'passed' && attempts.length > 1
    );
    const passed = latest.filter(({ result }) => result.status === 'passed').length;
    const skipped = latest.filter(({ result }) => result.status === 'skipped').length;
    const retryAttempts = latest.reduce(
      (sum, { attempts }) => sum + Math.max(0, attempts.length - 1),
      0
    );
    const executionMs = latest.reduce(
      (sum, { attempts }) => sum + attempts.reduce((attemptSum, result) => attemptSum + result.duration, 0),
      0
    );
    const slowest = latest
      .filter(({ result }) => result.status !== 'skipped')
      .sort((a, b) => b.result.duration - a.result.duration)
      .slice(0, 5);

    const lines = [
      `### Playwright ${run.status === 'passed' ? '✅' : '❌'}`,
      '',
      `Final status: **${run.status}**`,
      '',
      `- Tests: **${latest.length}** (${passed} passed, ${failures.length} failed, ${skipped} skipped)`,
      `- Test execution time: **${seconds(executionMs)}** including retries`,
      `- Retry attempts: **${retryAttempts}**`,
      `- Flaky tests: **${flaky.length}**`,
      ''
    ];

    if (slowest.length > 0) {
      lines.push('#### Slowest final attempts', '', '| Test | Project | Duration |', '| --- | --- | ---: |');
      for (const { test, result, project } of slowest) {
        lines.push(
          `| ${clean(test.titlePath().join(' › '))} | \`${clean(project)}\` | ${seconds(result.duration)} |`
        );
      }
      lines.push('');
    }

    if (failures.length === 0 && this.globalErrors.length === 0) {
      lines.push('No final test failures.', '');
    }

    for (const { test, result, project, attempts } of failures) {
      const location = `${test.location.file}:${test.location.line}:${test.location.column}`;
      const error = clean(result.error?.message || result.error?.value || 'No error message');
      lines.push(
        `#### ❌ ${clean(test.titlePath().join(' › '))}`,
        '',
        `- Project: \`${clean(project)}\``,
        `- Location: \`${clean(location)}\``,
        `- Status: \`${clean(result.status)}\``,
        `- Attempts: \`${attempts.length}\``,
        `- Final attempt duration: \`${seconds(result.duration)}\``,
        '',
        '```text',
        error.slice(0, 4000),
        '```',
        ''
      );
    }

    for (const error of this.globalErrors) {
      lines.push('#### ❌ Runner error', '', '```text', clean(error.message).slice(0, 4000), '```', '');
    }

    if (flaky.length > 0) {
      lines.push('#### ⚠️ Passed only after retry', '');
      for (const { test, result, project, attempts } of flaky) {
        const attemptSummary = attempts
          .map(attempt => `${attempt.status} ${seconds(attempt.duration)}`)
          .join(' → ');
        lines.push(
          `- \`${clean(project)}\` — ${clean(test.titlePath().join(' › '))} (retry ${result.retry}; ${attemptSummary})`
        );
      }
      lines.push('');
    }

    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  }
}

export default GitHubStepSummaryReporter;
