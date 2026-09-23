const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '../dist/cli.js');
let passed = 0;
let failed = 0;

function check(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}

for (const [type, filename] of [
  ['testdoc', 'cdr-test-doc-schema.json'],
  ['changelog', 'cdr-test-changelog-schema.json']
]) {
  const expected = require(path.join(__dirname, '../src/schemas', filename));

  check(`${type} waits for asynchronous stdout writes`, () => {
    // Model asynchronous pipe writes on every platform, including Windows.
    const script = `
      const { Writable } = require('stream');
      const stdout = process.stdout;
      Object.defineProperty(process, 'stdout', {
        value: new Writable({
          write(chunk, encoding, callback) {
            setTimeout(() => stdout.write(chunk, encoding, callback), 10);
          }
        })
      });
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'schema', ${JSON.stringify(type)}];
      require(${JSON.stringify(cli)});
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
    assert.deepStrictEqual(JSON.parse(result.stdout), expected);
  });

  for (const redirect of [false, true]) {
    check(`${type} produces one complete JSON schema with ${redirect ? 'file' : 'pipe'} output`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'testdocs-schema-'));
      const output = path.join(directory, 'schema.json');
      let fd;
      try {
        if (redirect) fd = fs.openSync(output, 'w');
        const result = spawnSync(process.execPath, [cli, 'schema', type], {
          encoding: 'utf8',
          stdio: ['ignore', redirect ? fd : 'pipe', 'pipe']
        });
        assert.ifError(result.error);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stderr, '');
        if (redirect) {
          fs.closeSync(fd);
          fd = undefined;
        }
        const stdout = redirect ? fs.readFileSync(output, 'utf8') : result.stdout;
        assert.deepStrictEqual(JSON.parse(stdout), expected);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(output)) fs.unlinkSync(output);
        fs.rmdirSync(directory);
      }
    });
  }
}

for (const args of [['schema'], ['schema', 'invalid']]) {
  check(`${args.join(' ')} fails without writing schema data`, () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
    assert.ok(result.stderr.includes(args.length === 1 ? 'Not enough non-option arguments' : 'Invalid values'));
  });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
