const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const cli = path.resolve(__dirname, '..');
const scripts = require('../../package.json').scripts;

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(cli, '.exit-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

for (const type of ['testdoc', 'changelog']) {
  test(`${type}: compiled CLI reports validation and read failures`, t => {
    const dir = temporary(t);
    const filename = path.join(dir, 'input with spaces.json');
    const valid = {
      schema: 'https://example.test/schema.json', fileVersion: '1.0.0', title: 'Fixture',
      ...(type === 'testdoc' ? { standardsVersion: '1.0.0' } : { changes: {} }),
    };
    const cases = [
      [JSON.stringify(valid), 0, 'validated successfully'],
      ['{', 1, 'Failed to JSON parse'],
      ['{}', 1, 'validation failed'],
    ];
    for (const [input, status, diagnostic] of cases) {
      fs.writeFileSync(filename, input);
      const result = run([path.join(cli, 'dist/cli.js'), 'validate', type, filename]);
      assert.equal(result.status, status, result.stdout + result.stderr);
      assert.ok((result.stdout + result.stderr).includes(diagnostic));
    }
    const missing = run([path.join(cli, 'dist/cli.js'), 'validate', type, filename + '.missing']);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes('Failed to read'));
  });

  test(`${type}: real Ajv compilation failure exits non-zero`, t => {
    const dir = temporary(t);
    fs.cpSync(path.join(cli, 'dist'), path.join(dir, 'dist'), { recursive: true });
    const schema = type === 'testdoc' ? 'cdr-test-doc-schema.json' : 'cdr-test-changelog-schema.json';
    fs.writeFileSync(path.join(dir, 'dist/schemas', schema), JSON.stringify({ type: 'invalid-type' }));
    const filename = path.join(dir, 'input.json');
    fs.writeFileSync(filename, '{}');
    const result = run([path.join(dir, 'dist/cli.js'), 'validate', type, filename]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('Failed to compile'), result.stderr);
  });
}

for (const command of ['validate', 'generate']) {
  for (const statuses of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    test(`${command}: child exit statuses ${statuses.join(', ')}`, t => {
      const dir = temporary(t);
      fs.mkdirSync(path.join(dir, 'cli/dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
      fs.writeFileSync(path.join(dir, 'cli/package.json'), JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      }));
      // These child processes isolate shell status aggregation from validation.
      fs.writeFileSync(path.join(dir, 'cli/dist/cli.js'), `
        const first = ['testdoc', 'html'].includes(process.argv[3]);
        process.exit(first ? ${statuses[0]} : ${statuses[1]});
      `);
      const result = run([process.env.npm_execpath, 'run', command], { cwd: dir });
      assert.equal(result.status === 0, statuses.every(status => status === 0), result.stdout + result.stderr);
    });
  }
}
