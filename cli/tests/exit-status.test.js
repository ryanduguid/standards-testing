const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
  const schemaName = type === 'testdoc' ? 'cdr-test-doc-schema.json' : 'cdr-test-changelog-schema.json';
  const schema = JSON.parse(fs.readFileSync(path.join(cli, 'src/schemas', schemaName), 'utf8'));

  test(`${type}: schema stdout contains exactly the selected JSON document`, () => {
    const result = run([path.join(cli, 'dist/cli.js'), 'schema', type], { timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(schema, null, 4)}\n`);
  });

  test(`${type}: large schema output drains to a slow pipe`, { timeout: 15000 }, async t => {
    const dir = fs.mkdtempSync(path.join(cli, '.exit-status-'));
    let child, closed, sink;
    t.after(async () => {
      try {
        if (sink) sink.destroy();
        if (child && child.pid) {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          const force = setTimeout(() => child.kill('SIGKILL'), 1000);
          let deadline;
          try {
            await Promise.race([
              closed,
              new Promise((resolve, reject) => {
                deadline = setTimeout(() => reject(new Error('schema child did not close')), 3000);
              }),
            ]);
          } finally {
            clearTimeout(force);
            clearTimeout(deadline);
          }
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    fs.cpSync(path.join(cli, 'dist'), path.join(dir, 'dist'), { recursive: true });
    // Enlarge only the copied schema so the output exceeds a pipe's buffer.
    const largeSchema = { ...schema, description: 'x'.repeat(256 * 1024) };
    fs.writeFileSync(path.join(dir, 'dist/schemas', schemaName), JSON.stringify(largeSchema));
    const expected = Buffer.from(`${JSON.stringify(largeSchema, null, 4)}\n`);
    const childErrors = [];
    child = spawn(process.execPath, [path.join(dir, 'dist/cli.js'), 'schema', type]);
    child.on('error', error => childErrors.push(error));
    closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const chunks = [];
    let throttle;
    sink = new Writable({
      highWaterMark: 1024,
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        throttle = setTimeout(callback, 5);
      },
      destroy(error, callback) {
        clearTimeout(throttle);
        callback(error);
      },
    });
    const [[status, signal]] = await Promise.all([
      closed,
      pipeline(child.stdout, sink, { signal: t.signal }),
    ]);
    assert.deepEqual(childErrors, []);
    assert.equal(signal, null, stderr);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, '');
    const actual = Buffer.concat(chunks);
    assert.equal(actual.length, expected.length);
    assert.ok(actual.equals(expected), 'piped schema bytes differ');
  });

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

for (const args of [['schema'], ['schema', 'invalid']]) {
  test(`${args.join(' ')}: rejects missing or invalid schema type`, () => {
    const result = run([path.join(cli, 'dist/cli.js'), ...args], { timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
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
