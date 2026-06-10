# Compare Two Tables Skill

Use this skill when a user asks whether two document tables differ.

Inputs:
- `documentA`: PDF, DOC/DOCX, or image path.
- `documentB`: PDF, DOC/DOCX, or image path.
- `redlineOutputPath`: destination PDF path.

Procedure:
1. Parse both documents with `parse-document-tables-with-mineru`.
2. Inspect `tables`; if there is more than one table, choose the requested one or default to index `0`.
3. Compare the selected tables with `compare-mineru-parsed-tables`.
4. Create the visual redline with `create-table-redline-pdf`.
5. Report:
   - `different`: boolean
   - `explanation`: written explanation with changed cell refs and before/after text
   - `redlinePdfPath`

Grounding rule:
The judgement must be based on MinerU structured output. The visual redline should use MinerU page geometry and bounding boxes. If MinerU does not provide cell-level boxes, use the table bbox plus parsed row/column geometry to derive cell boxes.
