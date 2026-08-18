import { appendFileSync } from 'node:fs';

const clean = value => String(value || '').replace(/```/g, '``\u200b`');

class GitHubStepSummaryReporter {
  constructor() {
    this.results = new Map();
    this.globalErrors = [];
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    this.results.set(test.id, {
      test,
      result,
      project: test.parent.project()?.name || 'unknown'
    });
  }

  onError(error) {
    this.globalErrors.push(error);
  }

  onEnd(run) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;

    const latest = [...this.results.values()];
    const failures = latest.filter(
      ({ test, result }) => result.status !== test.expectedStatus && result.status !== 'skipped'
    );
    const flaky = latest.filter(
      ({ test, result }) =>
        result.status === test.expectedStatus && result.status === 'passed' && result.retry > 0
    );

    const lines = [
      `### Playwright ${run.status === 'passed' ? '✅' : '❌'}`,
      '',
      `Final status: **${run.status}**`,
      ''
    ];

    if (failures.length === 0 && this.globalErrors.length === 0) {
      lines.push('No final test failures.', '');
    }

    for (const { test, result, project } of failures) {
      const location = `${test.location.file}:${test.location.line}:${test.location.column}`;
      const error = clean(result.error?.message || result.error?.value || 'No error message');
      lines.push(
        `#### ❌ ${clean(test.titlePath().join(' › '))}`,
        '',
        `- Project: \`${clean(project)}\``,
        `- Location: \`${clean(location)}\``,
        `- Status: \`${clean(result.status)}\``,
        `- Retry: \`${result.retry}\``,
        '',
        '```text',
        error.slice(0, 4000),
        '```',
        ''
      );
    }

    for (const error of this.globalErrors) {
      lines.push(
        '#### ❌ Runner error',
        '',
        '```text',
        clean(error.message).slice(0, 4000),
        '```',
        ''
      );
    }

    if (flaky.length > 0) {
      lines.push('#### ⚠️ Passed only after retry', '');
      for (const { test, result, project } of flaky) {
        lines.push(
          `- \`${clean(project)}\` — ${clean(test.titlePath().join(' › '))} (retry ${result.retry})`
        );
      }
      lines.push('');
    }

    appendFileSync(summaryPath, `${lines.join('\n')}\n`);
  }
}

export default GitHubStepSummaryReporter;
