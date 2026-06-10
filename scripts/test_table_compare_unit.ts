import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { createRedlinePdf } from "../src/table-compare/redline";
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
