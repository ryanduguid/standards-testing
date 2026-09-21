const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

// Run against a consumer directory with the packed package installed.
const consumer = path.resolve(process.argv[2] || '.');
const resolve = name => require.resolve(name, { paths: [consumer] });
const fixtureDir = fs.mkdtempSync(path.join(consumer, 'testdocs-imports-'));
const fixture = path.join(fixtureDir, 'imports.ts');

try {
  fs.writeFileSync(fixture, `
import {
  ConsumerDataRightTestCaseJSONSchema, CDRTestDocumentationChangelogSchema,
  AssertionPredicate, TestCaseStep, TestCasePredicate, ScenarioAction,
  Assertion, Reference, TestCase, Scenario, Suite, Change,
  testDocSchema, changeLogSchema, validateSchema,
  markdownDocGenerator, htmlDocGenerator
} from '@cds-au/testdocs';
import { ConsumerDataRightTestCaseJSONSchema as DeepTestDoc }
  from '@cds-au/testdocs/dist/schemas/cdr-test-doc-schema';
import { CDRTestDocumentationChangelogSchema as DeepChangelog }
  from '@cds-au/testdocs/dist/schemas/cdr-test-changelog-schema';

const document = (value: ConsumerDataRightTestCaseJSONSchema): DeepTestDoc => value;
const changelog = (value: CDRTestDocumentationChangelogSchema): DeepChangelog => value;
const wait: TestCaseStep = { type: 'WAIT', period: 1 };
// @ts-expect-error The public type must still reject an invalid wait period.
const invalidWait: TestCaseStep = { type: 'WAIT', period: 'one' };
testDocSchema();
changeLogSchema();
`);
  const program = ts.createProgram([fixture], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    target: ts.ScriptTarget.ES2016,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.strictEqual(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => consumer,
    getNewLine: () => '\n'
  }));
  console.log('PASS: package-root types, existing deep imports and type checking');

  const api = require(resolve('@cds-au/testdocs'));
  const deep = require(resolve('@cds-au/testdocs/dist/logic/schemas'));
  assert.strictEqual(api.testDocSchema, deep.testDocSchema);
  assert.strictEqual(api.changeLogSchema, deep.changeLogSchema);
  assert.deepStrictEqual(api.testDocSchema(), require(resolve('@cds-au/testdocs/dist/schemas/cdr-test-doc-schema.json')));
  assert.deepStrictEqual(api.changeLogSchema(), require(resolve('@cds-au/testdocs/dist/schemas/cdr-test-changelog-schema.json')));
  for (const name of ['validateSchema', 'markdownDocGenerator', 'htmlDocGenerator']) {
    assert.strictEqual(typeof api[name], 'function');
  }
  console.log('PASS: runtime schemas and existing API exports');

  const help = execFileSync(process.execPath, [resolve('@cds-au/testdocs/dist/cli.js'), '--help'], { encoding: 'utf8' });
  assert.ok(help.includes('schema <type>'));
  assert.ok(help.includes('validate'));
  assert.ok(help.includes('generate'));
  console.log('PASS: installed CLI help');
} finally {
  if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
  fs.rmdirSync(fixtureDir);
}
