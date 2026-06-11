import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const apiUrl = (process.env.TABLE_COMPARE_API_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const gotenbergUrl = (process.env.GOTENBERG_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const fixtureDir = "data/table-semantic-fixtures";
const semanticTestsDir = "data/table-compare/semantic-tests";

interface SemanticCase {
  name: string;
  documentA: TableFixture;
  documentB: TableFixture;
  different: boolean;
  expectedText?: string[];
}

interface TableFixture {
  title: string;
  rows: string[][];
  style?: "buyer" | "supplier";
}

const payableRows = [
  ["Part Code", "Part Name", "Specification", "Quantity", "Unit Price"],
  ["P-100", "Valve", "SS 1 inch", "10", "$12.50"],
  ["P-200", "Gasket", "NBR", "25", "$1.10"],
  ["P-300", "Clamp", "Zinc M6", "8", "$3.75"],
];

const cases: SemanticCase[] = [
  {
    name: "same-format-reordered",
    different: false,
    documentA: { title: "Buyer Payables", rows: payableRows, style: "buyer" },
    documentB: {
      title: "Buyer Payables",
      style: "buyer",
      rows: [payableRows[0], payableRows[2], payableRows[3], payableRows[1]],
    },
  },
  {
    name: "different-format-same-content",
    different: false,
    documentA: { title: "Buyer Payables", rows: payableRows, style: "buyer" },
    documentB: {
      title: "Supplier Invoice",
      style: "supplier",
      rows: [
        ["Item", "Description", "Manufacturer Part", "Qty", "Price Each", "Line Total"],
        ["P-200", "NBR gasket", "MFG-GSK-200", "25", "$1.10", "$27.50"],
        ["P-100", "SS 1 inch valve", "MFG-VLV-100", "10", "$12.50", "$125.00"],
        ["P-300", "Zinc M6 clamp", "MFG-CLP-300", "8", "$3.75", "$30.00"],
      ],
    },
  },
  {
    name: "different-format-quantity-change",
    different: true,
    expectedText: ["P-100", "12", "quantity"],
    documentA: { title: "Buyer Payables", rows: payableRows, style: "buyer" },
    documentB: {
      title: "Supplier Invoice",
      style: "supplier",
      rows: [
        ["Item", "Description", "Manufacturer Part", "Qty", "Price Each", "Line Total"],
        ["P-200", "NBR gasket", "MFG-GSK-200", "25", "$1.10", "$27.50"],
        ["P-100", "SS 1 inch valve", "MFG-VLV-100", "12", "$12.50", "$150.00"],
        ["P-300", "Zinc M6 clamp", "MFG-CLP-300", "8", "$3.75", "$30.00"],
      ],
    },
  },
];

await rm(fixtureDir, { recursive: true, force: true });
await rm(semanticTestsDir, { recursive: true, force: true });
await mkdir(fixtureDir, { recursive: true });
await mkdir(semanticTestsDir, { recursive: true });

const results = [];
for (const testCase of cases) {
  const documentA = path.join(fixtureDir, `${testCase.name}-a.pdf`);
  const documentB = path.join(fixtureDir, `${testCase.name}-b.pdf`);
  const caseDir = path.join(semanticTestsDir, testCase.name);
  const inputDir = path.join(caseDir, "input");
  const outputDir = path.join(caseDir, "output");

  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(documentA, await renderPdf(renderHtml(testCase.documentA)));
  await writeFile(documentB, await renderPdf(renderHtml(testCase.documentB)));
  await copyFile(documentA, path.join(inputDir, "base.pdf"));
  await copyFile(documentB, path.join(inputDir, "changed.pdf"));

  const result = await submitAndWait(documentA, documentB);
  assert.equal(result.different, testCase.different, `${testCase.name} different mismatch`);
  assert.equal(result.comparisonMode, "semantic", `${testCase.name} should use semantic mode`);
  assert.equal(result.agent?.invokedByApi, true, `${testCase.name} should be API-agent invoked`);
  assert.equal(result.agent?.id, "semantic-table-compare-agent", `${testCase.name} should be produced by semanticTableCompareAgent`);
  assert.equal(result.agent?.registryName, "semanticTableCompareAgent", `${testCase.name} should use semantic Mastra registry agent`);
  assert.ok(
    result.agent?.toolCalls.includes("parse-document-pair-tables-with-mineru"),
    `${testCase.name} should invoke MinerU pair parsing through the semantic agent`,
  );
  assert.ok(result.agent?.toolCalls.includes("semantic-table-compare-agent"), `${testCase.name} should invoke semantic agent`);
  if (testCase.expectedText) {
    const haystack = JSON.stringify(result).toLowerCase();
    for (const expected of testCase.expectedText) {
      assert.ok(haystack.includes(expected.toLowerCase()), `${testCase.name} should mention ${expected}`);
    }
  }

  await downloadRedline(result.jobId, path.join(outputDir, "redline.pdf"));
  await writeFile(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        caseName: testCase.name,
        expectedDifferent: testCase.different,
        passed: true,
        result,
      },
      null,
      2,
    ),
  );
  results.push({
    name: testCase.name,
    jobId: result.jobId,
    different: result.different,
    differences: result.differences.length,
    outputDirectory: caseDir,
  });
}

console.log(JSON.stringify({ passed: true, cases: results }, null, 2));

async function renderPdf(html: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Gotenberg render failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function renderHtml(fixture: TableFixture): string {
  const rows = fixture.rows
    .map((row, rowIndex) => {
      const tag = rowIndex === 0 ? "th" : "td";
      return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("\n");
  const supplier = fixture.style === "supplier";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: Letter; margin: ${supplier ? "0.55in" : "0.75in"}; }
      body { font-family: ${supplier ? "Verdana" : "Arial"}, sans-serif; color: #111827; }
      h1 { font-size: ${supplier ? "18px" : "22px"}; margin: 0 0 16px; }
      table { border-collapse: collapse; width: 100%; table-layout: fixed; }
      th, td { border: ${supplier ? "1px solid #1f2937" : "1.25px solid #374151"}; padding: ${supplier ? "7px 8px" : "10px 12px"}; font-size: ${supplier ? "11px" : "13px"}; line-height: 1.3; }
      th { background: ${supplier ? "#dbeafe" : "#e5e7eb"}; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(fixture.title)}</h1>
    <table><tbody>${rows}</tbody></table>
  </body>
</html>`;
}

async function submitAndWait(documentA: string, documentB: string): Promise<TableCompareResult & { jobId: string }> {
  const form = new FormData();
  form.append("documentA", new Blob([await readFile(documentA)], { type: "application/pdf" }), path.basename(documentA));
  form.append("documentB", new Blob([await readFile(documentB)], { type: "application/pdf" }), path.basename(documentB));
  form.append("baselineDocument", "documentB");
  const submit = await fetch(`${apiUrl}/v1/table-comparisons`, { method: "POST", body: form });
  await assertHttpStatus(submit, 202, "submit");
  const submitted = (await submit.json()) as { jobId: string };

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}`);
    await assertHttpStatus(status, 200, "status");
    const body = (await status.json()) as { status: string; error?: string };
    if (body.status === "completed") {
      const result = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}/result`);
      await assertHttpStatus(result, 200, "result");
      return { ...((await result.json()) as TableCompareResult), jobId: submitted.jobId };
    }
    if (body.status === "failed") {
      throw new Error(`job ${submitted.jobId} failed: ${body.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for job ${submitted.jobId}`);
}

async function downloadRedline(jobId: string, outputPath: string): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/table-comparisons/${jobId}/redline.pdf`);
  await assertHttpStatus(response, 200, "redline");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  await writeFile(outputPath, bytes);
  assert.ok((await stat(outputPath)).size > 1000);
}

async function assertHttpStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

interface TableCompareResult {
  different: boolean;
  comparisonMode?: string;
  differences: unknown[];
  agent?: {
    id?: string;
    registryName?: string;
    invokedByApi?: boolean;
    toolCalls: string[];
  };
}
