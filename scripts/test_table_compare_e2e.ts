import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const apiUrl = (process.env.TABLE_COMPARE_API_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const artifactDir = "data/table-compare/test-artifacts";
const fixtureDir = "data/table-fixtures";
const manifestPath = path.join(fixtureDir, "manifest.json");

await mkdir(artifactDir, { recursive: true });
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
await Promise.all(manifest.fixtures.map((fixture) => stat(path.join(fixtureDir, fixture))));

const results: Array<{ caseName: string; jobId: string; refs: string[] }> = [];

for (const testCase of manifest.cases) {
  const result = await submitAndWait(path.join(fixtureDir, testCase.documentA), path.join(fixtureDir, testCase.documentB));
  assert.equal(result.different, testCase.different, `${testCase.name} different mismatch`);
  assert.equal(result.differences.length, testCase.differences.length, `${testCase.name} diff count mismatch`);
  assertExpectedDifferences(testCase.name, result.differences, testCase.differences);
  assertExplanation(testCase, result);

  if (testCase.name === "base-vs-changed") {
    assert.deepEqual(result.tableB.bbox, [58, 110, 553, 258], "redline source bbox must be middle_json page-space bbox");
    assert.deepEqual(result.tableB.pageSize, [612, 792]);
    assertBBox(result.differences[0].bboxB, [305.5, 169.2, 429.25, 198.8], "C3 API bbox");
    assertBBox(result.differences[1].bboxB, [429.25, 198.8, 553, 228.4], "D4 API bbox");
  }

  await downloadRedline(result.jobId, path.join(artifactDir, `${testCase.name}-redline.pdf`));
  results.push({ caseName: testCase.name, jobId: result.jobId, refs: result.differences.map((diff) => diff.ref) });
}

console.log(
  JSON.stringify(
    {
      passed: true,
      cases: results,
    },
    null,
    2,
  ),
);

async function submitAndWait(documentA: string, documentB: string): Promise<TableCompareResult & { jobId: string }> {
  const form = new FormData();
  form.append("documentA", new Blob([await readFile(documentA)], { type: "application/pdf" }), path.basename(documentA));
  form.append("documentB", new Blob([await readFile(documentB)], { type: "application/pdf" }), path.basename(documentB));

  const submit = await fetch(`${apiUrl}/v1/table-comparisons`, { method: "POST", body: form });
  await assertHttpStatus(submit, 202, "submit");
  const submitted = (await submit.json()) as { jobId: string };
  assert.ok(submitted.jobId);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}`);
    await assertHttpStatus(status, 200, "status");
    const statusBody = (await status.json()) as { status: string; error?: string };
    if (statusBody.status === "completed") {
      const result = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}/result`);
      await assertHttpStatus(result, 200, "result");
      return { ...((await result.json()) as TableCompareResult), jobId: submitted.jobId };
    }
    if (statusBody.status === "failed") {
      throw new Error(`job ${submitted.jobId} failed: ${statusBody.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`timed out waiting for job ${submitted.jobId}`);
}

async function downloadRedline(jobId: string, outputPath: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/table-comparisons/${jobId}/redline.pdf`);
  await assertHttpStatus(response, 200, "redline download");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  await writeFile(outputPath, bytes);
  assert.ok((await stat(outputPath)).size > 1000, "downloaded redline should not be empty");
}

async function assertHttpStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
}

function assertBBox(actual: number[] | undefined, expected: number[], label: string): void {
  assert.ok(actual, `${label} should exist`);
  for (const [index, value] of actual.entries()) {
    assert.ok(Math.abs(value - expected[index]) < 0.001, `${label}[${index}] expected ${expected[index]}, got ${value}`);
  }
}

function assertExpectedDifferences(
  caseName: string,
  actual: TableCompareResult["differences"],
  expected: ExpectedDifference[],
): void {
  assert.deepEqual(
    actual.map((diff) => ({ kind: diff.kind, ref: diff.ref, before: diff.before, after: diff.after })),
    expected.map((diff) => ({ kind: diff.kind, ref: diff.ref, before: diff.before, after: diff.after })),
    `${caseName} differences mismatch`,
  );
}

function assertExplanation(testCase: FixtureCase, result: TableCompareResult): void {
  if (!testCase.different) {
    assert.match(result.explanation, /No differences were found/, `${testCase.name} should explain no differences`);
    return;
  }

  for (const diff of testCase.differences) {
    if (diff.ref === "table") {
      assert.match(result.explanation, /table shape changed/i, `${testCase.name} should explain shape change`);
      continue;
    }
    assert.ok(result.explanation.includes(diff.ref), `${testCase.name} explanation should include ${diff.ref}`);
    if (diff.before !== null) {
      assert.ok(result.explanation.includes(diff.before), `${testCase.name} explanation should include ${diff.before}`);
    }
    if (diff.after !== null) {
      assert.ok(result.explanation.includes(diff.after), `${testCase.name} explanation should include ${diff.after}`);
    }
  }
}

interface TableCompareResult {
  different: boolean;
  summary: string;
  explanation: string;
  differences: Array<{
    kind: string;
    ref: string;
    before: string | null;
    after: string | null;
    bboxB?: number[];
  }>;
  tableB: {
    bbox: number[];
    pageSize: number[];
  };
}

interface ExpectedDifference {
  kind: string;
  ref: string;
  before: string | null;
  after: string | null;
}

interface FixtureCase {
  name: string;
  documentA: string;
  documentB: string;
  different: boolean;
  differences: ExpectedDifference[];
}

interface FixtureManifest {
  fixtures: string[];
  cases: FixtureCase[];
}
