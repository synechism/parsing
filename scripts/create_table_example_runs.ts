import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

const gotenbergUrl = (process.env.GOTENBERG_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const apiUrl = (process.env.TABLE_COMPARE_API_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const outputRoot = process.env.TABLE_EXAMPLE_OUTPUT_DIR ?? "data/table-example-runs";

type InputKind = "pdf" | "png" | "scanned-pdf";

interface ExampleDefinition {
  id: string;
  title: string;
  inputKind: InputKind;
  description: string;
  baseRows: string[][];
  changedRows: string[][];
  colWidths?: string[];
  rowHeights?: string[];
  fontSize?: number;
  pageMargin?: string;
  expectDifferent?: boolean;
}

const examples: ExampleDefinition[] = [
  {
    id: "01-pdf-regular-revenue",
    title: "Regional Revenue Review",
    inputKind: "pdf",
    description: "Regular vector PDF table with two changed cells.",
    baseRows: [
      ["Region", "Q1", "Q2", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$101,750", "Approved"],
      ["East", "$143,100", "$149,900", "Review"],
      ["West", "$110,300", "$118,400", "Approved"],
    ],
    changedRows: [
      ["Region", "Q1", "Q2", "Status"],
      ["North", "$120,000", "$135,500", "Approved"],
      ["South", "$98,250", "$104,250", "Approved"],
      ["East", "$143,100", "$149,900", "Escalated"],
      ["West", "$110,300", "$118,400", "Approved"],
    ],
  },
  {
    id: "02-png-notes-scorecard",
    title: "Service Desk Scorecard",
    inputKind: "png",
    description: "PNG table with a short header row, uneven note lengths, and a wide notes column.",
    colWidths: ["13%", "15%", "13%", "15%", "44%"],
    rowHeights: ["30px", "46px", "68px", "48px", "74px", "54px"],
    baseRows: [
      ["Queue", "SLA", "Open", "Owner", "Notes"],
      ["Billing", "98%", "12", "Ava", "Stable queue with weekly review cadence"],
      ["Claims", "94%", "27", "Noah", "Longer notes wrap onto a second visual line for this row"],
      ["Portal", "99%", "5", "Mia", "Monitor but no escalation"],
      ["Mobile", "91%", "31", "Liam", "Extra-long note creates a taller row and tests non-uniform geometry"],
      ["Data", "96%", "16", "Ivy", "Normal follow-up"],
    ],
    changedRows: [
      ["Queue", "SLA", "Open", "Owner", "Notes"],
      ["Billing", "98%", "12", "Ava", "Stable queue with weekly review cadence"],
      ["Claims", "92%", "27", "Noah", "Longer notes wrap onto a second visual line for this row"],
      ["Portal", "99%", "8", "Mia", "Monitor but no escalation"],
      ["Mobile", "91%", "31", "Liam", "Escalate mobile backlog because response time breached target"],
      ["Data", "96%", "16", "Ivy", "Normal follow-up"],
    ],
  },
  {
    id: "03-scanned-pdf-inventory",
    title: "Lab Inventory Count",
    inputKind: "scanned-pdf",
    description: "Image-only scanned PDF made from a rendered table image.",
    colWidths: ["18%", "15%", "15%", "18%", "17%", "17%"],
    rowHeights: ["36px", "44px", "44px", "58px", "44px", "52px"],
    baseRows: [
      ["Item", "Shelf", "Count", "Unit", "Lot", "Flag"],
      ["Reagent A", "A1", "42", "box", "L-104", "OK"],
      ["Buffer B", "A2", "18", "kit", "L-209", "OK"],
      ["Slides", "B1", "240", "pack", "L-318", "Low"],
      ["Pipettes", "B2", "75", "each", "L-417", "OK"],
      ["Tubes", "C1", "500", "bag", "L-502", "OK"],
    ],
    changedRows: [
      ["Item", "Shelf", "Count", "Unit", "Lot", "Flag"],
      ["Reagent A", "A1", "42", "box", "L-104", "OK"],
      ["Buffer B", "A2", "21", "kit", "L-209", "OK"],
      ["Slides", "B1", "240", "pack", "L-318", "Reorder"],
      ["Pipettes", "B2", "75", "each", "L-417", "OK"],
      ["Tubes", "C1", "500", "bag", "L-502", "OK"],
    ],
  },
  {
    id: "04-pdf-8x8-capacity",
    title: "Eight By Eight Capacity Grid",
    inputKind: "pdf",
    description: "8x8 vector PDF with varied column widths and row heights.",
    colWidths: ["10%", "12%", "12%", "12%", "12%", "12%", "12%", "18%"],
    rowHeights: ["28px", "42px", "52px", "42px", "60px", "42px", "50px", "46px"],
    fontSize: 11,
    pageMargin: "0.55in",
    baseRows: [
      ["Unit", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Notes"],
      ["A", "81", "83", "85", "86", "88", "89", "steady"],
      ["B", "72", "74", "73", "76", "78", "80", "watch"],
      ["C", "91", "90", "92", "93", "94", "95", "stable"],
      ["D", "64", "66", "68", "70", "73", "75", "longer note wraps here"],
      ["E", "88", "87", "89", "90", "91", "92", "stable"],
      ["F", "77", "78", "79", "81", "82", "83", "needs staff"],
      ["G", "69", "70", "72", "74", "75", "77", "monitor"],
    ],
    changedRows: [
      ["Unit", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Notes"],
      ["A", "81", "83", "85", "86", "88", "90", "steady"],
      ["B", "72", "74", "73", "76", "78", "80", "watch"],
      ["C", "91", "90", "92", "93", "94", "95", "stable"],
      ["D", "64", "66", "68", "71", "73", "75", "longer note wraps here"],
      ["E", "88", "87", "89", "90", "91", "92", "stable"],
      ["F", "77", "78", "79", "81", "82", "83", "staff added"],
      ["G", "69", "70", "72", "74", "75", "77", "monitor"],
    ],
  },
  {
    id: "05-png-quality-audit",
    title: "Quality Audit Exceptions",
    inputKind: "png",
    description: "PNG audit table with narrow metric columns, a short header row, and a wide notes column.",
    colWidths: ["13%", "12%", "12%", "12%", "13%", "13%", "25%"],
    rowHeights: ["28px", "46px", "62px", "46px", "70px", "50px"],
    baseRows: [
      ["Batch", "Line", "Defects", "Severity", "Owner", "Action", "Notes"],
      ["B-104", "A", "3", "Low", "Rae", "Ship", "Routine inspection"],
      ["B-205", "B", "18", "High", "Omar", "Hold", "Longer exception note wraps to test row height"],
      ["B-309", "C", "7", "Med", "Nia", "Review", "Calibrate station"],
      ["B-412", "A", "11", "Med", "Tao", "Review", "Supplier check pending with additional details"],
      ["B-518", "D", "2", "Low", "Zed", "Ship", "No issue"],
    ],
    changedRows: [
      ["Batch", "Line", "Defects", "Severity", "Owner", "Action", "Notes"],
      ["B-104", "A", "3", "Low", "Rae", "Ship", "Routine inspection"],
      ["B-205", "B", "27", "High", "Omar", "Hold", "Longer exception note wraps to test row height"],
      ["B-309", "C", "7", "Med", "Nia", "Review", "Calibrate station"],
      ["B-412", "A", "11", "Med", "Tao", "Release", "Supplier cleared after second inspection"],
      ["B-518", "D", "2", "Low", "Zed", "Ship", "No issue"],
    ],
  },
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const manifest = [];
for (const example of examples) {
  const runDir = path.join(outputRoot, example.id);
  const inputDir = path.join(runDir, "input");
  const outputDir = path.join(runDir, "output");
  const workDir = path.join(runDir, "_work");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const basePdf = path.join(workDir, "base-source.pdf");
  const changedPdf = path.join(workDir, "changed-source.pdf");
  await writeFile(basePdf, await renderPdf(renderHtml(example, example.baseRows)));
  await writeFile(changedPdf, await renderPdf(renderHtml(example, example.changedRows)));

  const { baseInput, changedInput } = await createInputs(example, basePdf, changedPdf, inputDir);
  const apiResult = await submitAndWait(baseInput, changedInput);
  const expectDifferent = example.expectDifferent ?? true;
  if (apiResult.result.different !== expectDifferent) {
    throw new Error(`${example.id} expected different=${expectDifferent}, got ${apiResult.result.different}`);
  }
  const redlineBytes = await fetchBytes(`${apiUrl}/v1/table-comparisons/${apiResult.jobId}/redline.pdf`);
  await writeFile(path.join(outputDir, "redline.pdf"), redlineBytes);

  const resultJson = {
    example: {
      id: example.id,
      title: example.title,
      inputKind: example.inputKind,
      description: example.description,
      baseFile: path.basename(baseInput),
      changedFile: path.basename(changedInput),
      jobId: apiResult.jobId,
    },
    changed: apiResult.result.different,
    agentReasoningText: apiResult.result.agent?.responseText ?? apiResult.result.explanation,
    ...apiResult.result,
  };
  await writeFile(path.join(outputDir, "result.json"), JSON.stringify(resultJson, null, 2));
  manifest.push({
    id: example.id,
    inputKind: example.inputKind,
    changed: apiResult.result.different,
    differences: apiResult.result.differences.map((diff) => ({
      kind: diff.kind,
      ref: diff.ref,
      before: diff.before,
      after: diff.after,
    })),
  });
  await rm(workDir, { recursive: true, force: true });
  console.log(`completed ${example.id}`);
}

await writeFile(path.join(outputRoot, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), runs: manifest }, null, 2));

async function createInputs(
  example: ExampleDefinition,
  basePdf: string,
  changedPdf: string,
  inputDir: string,
): Promise<{ baseInput: string; changedInput: string }> {
  if (example.inputKind === "pdf") {
    const baseInput = path.join(inputDir, "base.pdf");
    const changedInput = path.join(inputDir, "changed.pdf");
    await writeFile(baseInput, await readFile(basePdf));
    await writeFile(changedInput, await readFile(changedPdf));
    return { baseInput, changedInput };
  }

  const basePng = path.join(inputDir, "base.png");
  const changedPng = path.join(inputDir, "changed.png");
  await renderPdfToPng(basePdf, basePng);
  await renderPdfToPng(changedPdf, changedPng);

  if (example.inputKind === "png") {
    return { baseInput: basePng, changedInput: changedPng };
  }

  const baseInput = path.join(inputDir, "base.pdf");
  const changedInput = path.join(inputDir, "changed.pdf");
  await embedPngInPdf(basePng, baseInput);
  await embedPngInPdf(changedPng, changedInput);
  await rm(basePng, { force: true });
  await rm(changedPng, { force: true });
  return { baseInput, changedInput };
}

async function renderPdf(html: string): Promise<Buffer> {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");

  const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Gotenberg render failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function renderHtml(example: ExampleDefinition, rows: string[][]): string {
  const colgroup = example.colWidths
    ? `<colgroup>${example.colWidths.map((width) => `<col style="width: ${width}" />`).join("")}</colgroup>`
    : "";
  const body = rows
    .map((row, rowIndex) => {
      const tag = rowIndex === 0 ? "th" : "td";
      const rowStyle = example.rowHeights?.[rowIndex] ? ` style="height: ${example.rowHeights[rowIndex]}"` : "";
      return `<tr${rowStyle}>${row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("")}</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: Letter; margin: ${example.pageMargin ?? "0.7in"}; }
      body { font-family: Arial, sans-serif; color: #111827; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      table { border-collapse: collapse; width: 100%; table-layout: fixed; }
      th, td {
        border: 1.25px solid #111827;
        padding: 7px 8px;
        font-size: ${example.fontSize ?? 12}px;
        line-height: 1.25;
        vertical-align: middle;
        overflow-wrap: anywhere;
      }
      th { background: #eef2f7; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(example.title)}</h1>
    <table>
      ${colgroup}
      <tbody>${body}</tbody>
    </table>
  </body>
</html>`;
}

async function renderPdfToPng(pdfPath: string, pngPath: string): Promise<void> {
  const prefix = pngPath.replace(/\.png$/i, "");
  const relPdf = path.relative(process.cwd(), pdfPath);
  const relPrefix = path.relative(process.cwd(), prefix);
  await runCommand("docker", [
    "run",
    "--rm",
    "-v",
    `${process.cwd()}:/work`,
    "minidocks/poppler",
    "pdftoppm",
    "-png",
    "-singlefile",
    "-r",
    "180",
    `/work/${relPdf}`,
    `/work/${relPrefix}`,
  ]);
}

async function embedPngInPdf(pngPath: string, pdfPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(await readFile(pngPath));
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  await writeFile(pdfPath, await pdf.save());
}

async function submitAndWait(baseInput: string, changedInput: string): Promise<{ jobId: string; result: TableCompareResult }> {
  const form = new FormData();
  form.append("documentA", new Blob([await readFile(baseInput)], { type: mimeType(baseInput) }), path.basename(baseInput));
  form.append("documentB", new Blob([await readFile(changedInput)], { type: mimeType(changedInput) }), path.basename(changedInput));

  const submit = await fetch(`${apiUrl}/v1/table-comparisons`, { method: "POST", body: form });
  if (submit.status !== 202) {
    throw new Error(`submit failed: ${submit.status} ${await submit.text()}`);
  }
  const submitted = (await submit.json()) as { jobId: string };

  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}`);
    if (!status.ok) {
      throw new Error(`status failed: ${status.status} ${await status.text()}`);
    }
    const statusBody = (await status.json()) as { status: string; error?: string };
    if (statusBody.status === "completed") {
      const result = await fetch(`${apiUrl}/v1/table-comparisons/${submitted.jobId}/result`);
      if (!result.ok) {
        throw new Error(`result failed: ${result.status} ${await result.text()}`);
      }
      return { jobId: submitted.jobId, result: (await result.json()) as TableCompareResult };
    }
    if (statusBody.status === "failed") {
      throw new Error(`job ${submitted.jobId} failed: ${statusBody.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`timed out waiting for job ${submitted.jobId}`);
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
}

function mimeType(filePath: string): string {
  return filePath.toLowerCase().endsWith(".png") ? "image/png" : "application/pdf";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

interface TableCompareResult {
  different: boolean;
  explanation: string;
  differences: Array<{ kind: string; ref: string; before: string | null; after: string | null }>;
  agent?: { responseText?: string };
}
