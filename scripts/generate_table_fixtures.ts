import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const gotenbergUrl = (process.env.GOTENBERG_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const outputDir = process.env.TABLE_FIXTURE_OUTPUT_DIR ?? "data/table-fixtures";

interface Fixture {
  name: string;
  title: string;
  rows: string[][];
  colWidths?: string[];
  rowHeights?: string[];
}

interface ExpectedDifference {
  kind?: string;
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

const baseRows = [
  ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
  ["North", "$120,000", "$135,500", "Approved"],
  ["South", "$98,250", "$101,750", "Approved"],
  ["East", "$143,100", "$149,900", "Review"],
  ["West", "$110,300", "$118,400", "Approved"],
];

const fixtures: Fixture[] = [
  { name: "base", title: "Quarterly Revenue Table", rows: baseRows },
  { name: "identical", title: "Quarterly Revenue Table", rows: baseRows },
  {
    name: "changed",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$104,250", "Approved"],
      ["East", "$143,100", "$149,900", "Escalated"],
      ["West", "$110,300", "$118,400", "Approved"],
    ],
  },
  {
    name: "changed-single-cell",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$101,750", "Approved"],
      ["East", "$140,000", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Approved"],
    ],
  },
  {
    name: "changed-edge-cells",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["Northeast", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$101,750", "Approved"],
      ["East", "$143,100", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Pending"],
    ],
  },
  {
    name: "changed-header-and-body",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Sales", "Q2 Revenue", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$101,750", "Approved"],
      ["East", "$143,100", "$149,900", "Review"],
      ["West", "$110,300", "$119,900", "Approved"],
    ],
  },
  {
    name: "changed-many-cells",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["North", "$121,000", "$136,000", "Review"],
      ["South", "$98,250", "$104,250", "Approved"],
      ["East", "$140,000", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Pending"],
    ],
  },
  {
    name: "added-row",
    title: "Quarterly Revenue Table",
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$101,750", "Approved"],
      ["East", "$143,100", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Approved"],
      ["Central", "$87,000", "$91,200", "Review"],
    ],
  },
  {
    name: "irregular-base",
    title: "Irregular Revenue Table",
    colWidths: ["18%", "34%", "20%", "28%"],
    rowHeights: ["42px", "34px", "74px", "46px", "62px"],
    rows: baseRows,
  },
  {
    name: "irregular-changed",
    title: "Irregular Revenue Table",
    colWidths: ["18%", "34%", "20%", "28%"],
    rowHeights: ["42px", "34px", "74px", "46px", "62px"],
    rows: [
      ["Region", "Q1 Revenue", "Q2 Revenue", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$99,999", "$101,750", "Approved"],
      ["East", "$143,100", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Pending"],
    ],
  },
];

const cases: FixtureCase[] = [
  { name: "base-vs-identical", documentA: "base.pdf", documentB: "identical.pdf", different: false, differences: [] },
  {
    name: "base-vs-changed",
    documentA: "base.pdf",
    documentB: "changed.pdf",
    different: true,
    differences: [
      { kind: "cell_changed", ref: "C3", before: "$101,750", after: "$104,250" },
      { kind: "cell_changed", ref: "D4", before: "Review", after: "Escalated" },
    ],
  },
  {
    name: "base-vs-changed-single-cell",
    documentA: "base.pdf",
    documentB: "changed-single-cell.pdf",
    different: true,
    differences: [{ kind: "cell_changed", ref: "B4", before: "$143,100", after: "$140,000" }],
  },
  {
    name: "base-vs-changed-edge-cells",
    documentA: "base.pdf",
    documentB: "changed-edge-cells.pdf",
    different: true,
    differences: [
      { kind: "cell_changed", ref: "A2", before: "North", after: "Northeast" },
      { kind: "cell_changed", ref: "D5", before: "Approved", after: "Pending" },
    ],
  },
  {
    name: "base-vs-changed-header-and-body",
    documentA: "base.pdf",
    documentB: "changed-header-and-body.pdf",
    different: true,
    differences: [
      { kind: "cell_changed", ref: "B1", before: "Q1 Revenue", after: "Q1 Sales" },
      { kind: "cell_changed", ref: "C5", before: "$118,400", after: "$119,900" },
    ],
  },
  {
    name: "base-vs-changed-many-cells",
    documentA: "base.pdf",
    documentB: "changed-many-cells.pdf",
    different: true,
    differences: [
      { kind: "cell_changed", ref: "B2", before: "$120,000", after: "$121,000" },
      { kind: "cell_changed", ref: "C2", before: "$135,500", after: "$136,000" },
      { kind: "cell_changed", ref: "D2", before: "Approved", after: "Review" },
      { kind: "cell_changed", ref: "C3", before: "$101,750", after: "$104,250" },
      { kind: "cell_changed", ref: "B4", before: "$143,100", after: "$140,000" },
      { kind: "cell_changed", ref: "D5", before: "Approved", after: "Pending" },
    ],
  },
  {
    name: "base-vs-added-row",
    documentA: "base.pdf",
    documentB: "added-row.pdf",
    different: true,
    differences: [
      { kind: "shape_changed", ref: "table", before: "5 rows x 4 columns", after: "6 rows x 4 columns" },
      { kind: "cell_added", ref: "A6", before: null, after: "Central" },
      { kind: "cell_added", ref: "B6", before: null, after: "$87,000" },
      { kind: "cell_added", ref: "C6", before: null, after: "$91,200" },
      { kind: "cell_added", ref: "D6", before: null, after: "Review" },
    ],
  },
  {
    name: "irregular-base-vs-irregular-changed",
    documentA: "irregular-base.pdf",
    documentB: "irregular-changed.pdf",
    different: true,
    differences: [
      { kind: "cell_changed", ref: "B3", before: "$98,250", after: "$99,999" },
      { kind: "cell_changed", ref: "D5", before: "Approved", after: "Pending" },
    ],
  },
];

await mkdir(outputDir, { recursive: true });

for (const fixture of fixtures) {
  const html = renderHtml(fixture);
  const htmlPath = path.join(outputDir, `${fixture.name}.html`);
  const pdfPath = path.join(outputDir, `${fixture.name}.pdf`);
  await writeFile(htmlPath, html);
  await writeFile(pdfPath, await renderPdf(html), "binary");
  console.log(`wrote ${pdfPath}`);
}

await writeFile(
  path.join(outputDir, "manifest.json"),
  JSON.stringify(
    {
      fixtures: fixtures.map((fixture) => `${fixture.name}.pdf`),
      cases,
    },
    null,
    2,
  ),
);

async function renderPdf(html: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");

  const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Gotenberg render failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function renderHtml(fixture: Fixture): string {
  const rows = fixture.rows
    .map((row, rowIndex) => {
      const cellTag = rowIndex === 0 ? "th" : "td";
      const rowStyle = fixture.rowHeights?.[rowIndex] ? ` style="height: ${fixture.rowHeights[rowIndex]}"` : "";
      return `<tr${rowStyle}>${row.map((cell) => `<${cellTag}>${escapeHtml(cell)}</${cellTag}>`).join("")}</tr>`;
    })
    .join("\n");
  const colgroup = fixture.colWidths
    ? `<colgroup>${fixture.colWidths.map((width) => `<col style="width: ${width}" />`).join("")}</colgroup>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: Letter; margin: 0.75in; }
      body { font-family: Arial, sans-serif; color: #111827; }
      h1 { font-size: 22px; margin: 0 0 18px; }
      table { border-collapse: collapse; width: 100%; table-layout: fixed; }
      caption { caption-side: top; text-align: left; font-weight: 700; margin-bottom: 8px; }
      th, td { border: 1px solid #374151; padding: 10px 12px; font-size: 13px; line-height: 1.35; }
      th { background: #e5e7eb; }
      .note { margin-top: 28px; font-size: 11px; color: #4b5563; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(fixture.title)}</h1>
    <table>
      <caption>Revenue approval matrix</caption>
      ${colgroup}
      <tbody>
        ${rows}
      </tbody>
    </table>
    <p class="note">Deterministic fixture generated for MinerU table comparison tests.</p>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
