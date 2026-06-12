import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { createRedlinePdf } from "../src/table-compare/redline";
import { buildSemanticComparisonResult } from "../src/table-compare/semantic-compare";
import { compareFirstTables } from "../src/table-compare/table-compare";
import { extractTablesFromMinerUResult } from "../src/table-compare/table-extractor";
import type { BBox } from "../src/table-compare/types";

const artifactDir = "data/table-compare/test-artifacts";
const baseHtml =
  "<table><tr><td>Region</td><td>Q1 Revenue</td><td>Q2 Revenue</td><td>Status</td></tr><tr><td>North</td><td>$120,000</td><td>$135,500</td><td>Approved</td></tr><tr><td>South</td><td>$98,250</td><td>$101,750</td><td>Approved</td></tr><tr><td>East</td><td>$143,100</td><td>$149,900</td><td>Review</td></tr><tr><td>West</td><td>$110,300</td><td>$118,400</td><td>Approved</td></tr></table>";
const changedHtml =
  "<table><tr><td>Region</td><td>Q1 Revenue</td><td>Q2 Revenue</td><td>Status</td></tr><tr><td>North</td><td>$120,000</td><td>$135,500</td><td>Approved</td></tr><tr><td>South</td><td>$98,250</td><td>$104,250</td><td>Approved</td></tr><tr><td>East</td><td>$143,100</td><td>$149,900</td><td>Escalated</td></tr><tr><td>West</td><td>$110,300</td><td>$118,400</td><td>Approved</td></tr></table>";

const contentListBBox: BBox = [94, 138, 903, 325];
const pageSpaceBBox: BBox = [58, 110, 553, 258];

await mkdir(artifactDir, { recursive: true });

const base = extractTablesFromMinerUResult(makeMinerUResult(baseHtml), "base.pdf", "unit-base").tables[0];
const changed = extractTablesFromMinerUResult(makeMinerUResult(changedHtml), "changed.pdf", "unit-changed").tables[0];

assert.deepEqual(changed.bbox, pageSpaceBBox, "extractor must prefer middle_json page-space table bbox");
assert.deepEqual(changed.pageSize, [612, 792], "extractor must keep page size for PDF coordinate mapping");
assert.equal(changed.rowCount, 5);
assert.equal(changed.colCount, 4);
assertCellBBox(changed.cells.find((cell) => cell.ref === "C3")?.bbox, [305.5, 169.2, 429.25, 198.8], "C3 bbox");
assertCellBBox(changed.cells.find((cell) => cell.ref === "D4")?.bbox, [429.25, 198.8, 553, 228.4], "D4 bbox");

const different = compareFirstTables(base, changed);
assert.equal(different.different, true);
assert.equal(different.differences.length, 2);
assert.deepEqual(
  different.differences.map((diff) => [diff.ref, diff.before, diff.after]),
  [
    ["C3", "$101,750", "$104,250"],
    ["D4", "Review", "Escalated"],
  ],
);
assert.equal(
  different.explanation,
  'Cell C3 changed from "$101,750" to "$104,250". Cell D4 changed from "Review" to "Escalated".',
);

const identical = compareFirstTables(base, base);
assert.equal(identical.different, false);
assert.equal(identical.differences.length, 0);
assert.match(identical.explanation, /No differences were found/);

const reorderedHtml =
  "<table><tr><td>Region</td><td>Q1 Revenue</td><td>Q2 Revenue</td><td>Status</td></tr><tr><td>East</td><td>$143,100</td><td>$149,900</td><td>Review</td></tr><tr><td>North</td><td>$120,000</td><td>$135,500</td><td>Approved</td></tr><tr><td>West</td><td>$110,300</td><td>$118,400</td><td>Approved</td></tr><tr><td>South</td><td>$98,250</td><td>$101,750</td><td>Approved</td></tr></table>";
const reordered = extractTablesFromMinerUResult(makeMinerUResult(reorderedHtml), "reordered.pdf", "unit-reordered").tables[0];
const semanticReordered = buildSemanticComparisonResult(
  base,
  reordered,
  {
    different: false,
    summary: "The tables match semantically despite row reordering.",
    explanation: "Rows were matched by region and all shared values match.",
    rowMatches: [
      { rowIndexA: 1, rowIndexB: 2, rationale: "North row", confidence: 1 },
      { rowIndexA: 2, rowIndexB: 4, rationale: "South row", confidence: 1 },
      { rowIndexA: 3, rowIndexB: 1, rationale: "East row", confidence: 1 },
      { rowIndexA: 4, rowIndexB: 3, rationale: "West row", confidence: 1 },
    ],
    differences: [],
  },
  { baselineDocument: "documentB" },
);
assert.equal(semanticReordered.different, false);
assert.equal(semanticReordered.comparisonMode, "semantic");
assert.equal(semanticReordered.semantic?.matchedRows.length, 4);

const payableHtml =
  "<table><tr><td>Part Code</td><td>Part Name</td><td>Specification</td><td>Quantity</td><td>Unit Price</td></tr><tr><td>P-100</td><td>Valve</td><td>SS 1 inch</td><td>10</td><td>$12.50</td></tr><tr><td>P-200</td><td>Gasket</td><td>NBR</td><td>25</td><td>$1.10</td></tr></table>";
const invoiceHtml =
  "<table><tr><td>Item</td><td>Description</td><td>Mfr Part</td><td>Qty</td><td>Price Each</td><td>Line Total</td></tr><tr><td>P-200</td><td>NBR gasket</td><td>MFG-GSK</td><td>25</td><td>$1.10</td><td>$27.50</td></tr><tr><td>P-100</td><td>Stainless valve</td><td>MFG-VLV</td><td>12</td><td>$12.50</td><td>$150.00</td></tr></table>";
const payable = extractTablesFromMinerUResult(makeMinerUResult(payableHtml), "payable.pdf", "unit-payable").tables[0];
const invoice = extractTablesFromMinerUResult(makeMinerUResult(invoiceHtml), "invoice.pdf", "unit-invoice").tables[0];
const semanticInvoice = buildSemanticComparisonResult(
  payable,
  invoice,
  {
    different: true,
    summary: "The invoice differs from the payable on one quantity.",
    explanation: "Rows were matched by part code. Quantity for P-100 differs.",
    rowMatches: [
      { rowIndexA: 1, rowIndexB: 2, rationale: "same part code P-100", confidence: 1 },
      { rowIndexA: 2, rowIndexB: 1, rationale: "same part code P-200", confidence: 1 },
    ],
    differences: [
      {
        kind: "cell_changed",
        cellRefA: "D2",
        cellRefB: "D3",
        rowIndexA: 1,
        rowIndexB: 2,
        field: "quantity",
        before: "10",
        after: "12",
        explanation: "Quantity differs for P-100: payable has 10 and invoice has 12.",
      },
    ],
    ignored: [{ refsA: ["C1"], refsB: ["C1", "F1"], reason: "non-shared template columns were not material to the quantity/price match" }],
  },
  { baselineDocument: "documentB" },
);
assert.equal(semanticInvoice.different, true);
assert.equal(semanticInvoice.differences.length, 1);
assert.equal(semanticInvoice.differences[0].ref, "D3");
assert.equal(semanticInvoice.differences[0].field, "quantity");
assert.ok(semanticInvoice.differences[0].bboxB, "semantic invoice difference should anchor to document B");
assert.match(semanticInvoice.explanation, /Quantity for P-100 differs/);

const statementAHtml =
  "<table><tr><td>Part Code</td><td>Description</td><td>Quantity</td><td>Unit Price</td><td>Amount</td><td>Remarks</td></tr><tr><td>P-100</td><td>Valve</td><td>10</td><td>$12.50</td><td>$125.00</td><td>line note</td></tr><tr><td>P-200</td><td>Gasket</td><td>25</td><td>$1.10</td><td>$27.50</td><td>line note</td></tr><tr><td>TOTAL</td><td></td><td>35</td><td></td><td>$152.50</td><td></td></tr></table>";
const statementBHtml =
  "<table><tr><td>Part Code</td><td>Description</td><td>Quantity</td><td>Unit Price</td><td>Amount</td><td>Remarks</td></tr><tr><td>P-100</td><td>Valve</td><td>10</td><td>$12.50</td><td>$125.00</td><td></td></tr><tr><td>P-200</td><td>Gasket</td><td>25</td><td>$1.10</td><td>$27.50</td><td></td></tr></table>";
const statementA = extractTablesFromMinerUResult(makeMinerUResult(statementAHtml), "statement-a.pdf", "unit-statement-a").tables[0];
const statementB = extractTablesFromMinerUResult(makeMinerUResult(statementBHtml), "statement-b.pdf", "unit-statement-b").tables[0];
const templateOnly = buildSemanticComparisonResult(
  statementA,
  statementB,
  {
    different: true,
    summary: "Only template remarks and a one-sided total row differ.",
    explanation: "All detail rows match. Document A has generic line note remarks and a TOTAL row absent from Document B.",
    differences: [
      {
        kind: "cell_changed",
        cellRefA: "F2",
        cellRefB: "F2",
        rowIndexA: 1,
        rowIndexB: 1,
        field: "Remarks",
        before: "line note",
        after: "",
        explanation: "Generic placeholder remark is absent from the other template.",
      },
      {
        kind: "row_added",
        rowIndexA: 3,
        rowIndexB: null,
        field: "TOTAL row",
        before: "TOTAL",
        after: null,
        explanation: "Document A has a computed TOTAL row that is absent from Document B.",
      },
    ],
  },
  { baselineDocument: "documentB" },
);
assert.equal(templateOnly.different, false, "generic remarks and one-sided computed totals should be ignored");
assert.equal(templateOnly.differences.length, 0);
assert.match(templateOnly.explanation, /No material table differences/);

const materialNote = buildSemanticComparisonResult(
  statementA,
  statementB,
  {
    different: true,
    summary: "A real shipping note is missing.",
    explanation: "The note 'ship cold chain' is missing from Document B.",
    differences: [
      {
        kind: "cell_changed",
        cellRefA: "F2",
        cellRefB: "F2",
        rowIndexA: 1,
        rowIndexB: 1,
        field: "Remarks",
        before: "ship cold chain",
        after: "",
        explanation: "Document A has a material handling note that is blank in Document B.",
      },
    ],
  },
  { baselineDocument: "documentB" },
);
assert.equal(materialNote.different, true, "non-generic notes should remain material");
assert.equal(materialNote.differences.length, 1);

const blankPdfPath = path.join(artifactDir, "blank.pdf");
const redlinePdfPath = path.join(artifactDir, "unit-redline.pdf");
const blank = await PDFDocument.create();
blank.addPage([612, 792]);
await writeFile(blankPdfPath, await blank.save());
await createRedlinePdf(different, blankPdfPath, redlinePdfPath);
const redlineBytes = await readFile(redlinePdfPath);
assert.equal(redlineBytes.subarray(0, 4).toString(), "%PDF");
assert.ok((await stat(redlinePdfPath)).size > 1000, "redline PDF should not be empty");

console.log("table unit tests passed");

function makeMinerUResult(html: string): unknown {
  return {
    results: {
      fixture: {
        content_list: JSON.stringify([
          {
            type: "table",
            table_caption: ["Revenue approval matrix "],
            table_body: html,
            bbox: contentListBBox,
            page_idx: 0,
          },
        ]),
        middle_json: JSON.stringify({
          pdf_info: [
            {
              page_idx: 0,
              page_size: [612, 792],
              para_blocks: [
                {
                  type: "table",
                  bbox: pageSpaceBBox,
                  blocks: [
                    {
                      type: "table_body",
                      bbox: pageSpaceBBox,
                      lines: [
                        {
                          spans: [
                            {
                              type: "table",
                              bbox: pageSpaceBBox,
                              html,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    },
  };
}

function assertCellBBox(actual: BBox | undefined, expected: BBox, label: string): void {
  assert.ok(actual, `${label} should exist`);
  for (const [index, value] of actual.entries()) {
    assert.ok(Math.abs(value - expected[index]) < 0.001, `${label}[${index}] expected ${expected[index]}, got ${value}`);
  }
}
