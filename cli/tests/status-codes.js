const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '..');
const repo = path.dirname(cli);
const working = path.join(repo, 'working');
fs.mkdirSync(working, { recursive: true });
const fixture = fs.mkdtempSync(path.join(working, 'status-codes-'));
let passed = 0;
let failed = 0;

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(destination, name);
    if (fs.statSync(from).isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function check(name, action) {
  try { action(); passed++; }
  catch (error) { failed++; console.error(`${name}: ${error.message}`); }
}

function run(command, args, cwd = fixture) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null);
  return result;
}

const valid = {
  testdoc: { schema: 'https://example.invalid/schema', fileVersion: '1.0.0',
    standardsVersion: '1.0.0', title: 'Fabricated tests', description: 'Fabricated data' },
  changelog: { schema: 'https://example.invalid/schema', fileVersion: '1.0.0',
    title: 'Fabricated changes', changes: {} }
};

copyTree(path.join(cli, 'dist'), path.join(fixture, 'dist'));
fs.symlinkSync(path.join(cli, 'node_modules'), path.join(fixture, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir');
for (const type of ['testdoc', 'changelog']) {
  for (const [name, contents, expected] of [
    ['valid', JSON.stringify(valid[type]), 0], ['malformed', '{', 1], ['invalid', '{}', 1],
    ['missing', null, 1]
  ]) {
    const input = path.join(fixture, `${type}-${name}.json`);
    if (contents !== null) fs.writeFileSync(input, contents);
    check(`${type} ${name}`, () => {
      const result = run(process.execPath, ['dist/cli.js', 'validate', type, input]);
      assert.strictEqual(result.status, expected, result.stdout + result.stderr);
      if (contents !== null) assert.strictEqual(fs.readFileSync(input, 'utf8'), contents);
    });
  }
  const schemaName = type === 'testdoc' ? 'cdr-test-doc-schema.json' : 'cdr-test-changelog-schema.json';
  const schemaPath = path.join(fixture, 'dist/schemas', schemaName);
  const schema = fs.readFileSync(schemaPath);
  fs.writeFileSync(schemaPath, JSON.stringify({ type: 'not-a-json-schema-type' }));
  check(`${type} schema compilation failure`, () => {
    const result = run(process.execPath, ['dist/cli.js', 'validate', type, `${type}-valid.json`]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert(result.stderr.includes('Failed to compile'));
  });
  fs.writeFileSync(schemaPath, schema);
}

// Run the actual aggregate scripts with compiled workers and a real build.
const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).scripts;
const shell = process.env.npm_config_script_shell || 'bash';
for (const script of ['validate', 'generate']) {
  for (const failure of ['none', 'first', 'second']) {
    const root = path.join(fixture, `${script}-${failure}`);
    const targetCli = path.join(root, 'cli');
    copyTree(path.join(cli, 'src'), path.join(targetCli, 'src'));
    copyTree(path.join(cli, 'dist'), path.join(targetCli, 'dist'));
    for (const name of ['package.json', 'tsconfig.json']) {
      fs.copyFileSync(path.join(cli, name), path.join(targetCli, name));
    }
    fs.symlinkSync(path.join(cli, 'node_modules'), path.join(targetCli, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(root, 'json-docs'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'json-docs/full-test-suite.json'),
      script === 'validate' && failure === 'first' ? '{' : JSON.stringify(valid.testdoc));
    fs.writeFileSync(path.join(root, 'json-docs/CDR Test Documentation CHANGE LOG.json'),
      script === 'validate' && failure === 'second' ? '{' : JSON.stringify(valid.changelog));
    if (script === 'generate' && failure !== 'none') {
      // A directory at the output filename produces a real worker write failure.
      fs.mkdirSync(path.join(root, 'docs', failure === 'first' ? 'index.html' : 'ReadMe.md'));
    }
    check(`${script} ${failure}`, () => {
      const result = run(shell, ['-c', scripts[script]], root);
      assert.strictEqual(result.status, failure === 'none' ? 0 : 1, result.stdout + result.stderr);
      if (script === 'generate' && failure === 'none') {
        for (const name of ['index.html', 'ReadMe.md']) {
          assert(fs.readFileSync(path.join(root, 'docs', name), 'utf8').includes('Fabricated tests'));
        }
      }
    });
  }
}

console.log(`${passed} passed; ${failed} failed. Fabricated fixtures: ${fixture}`);
process.exitCode = failed ? 1 : 0;
