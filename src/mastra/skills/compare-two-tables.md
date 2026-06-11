# Compare Two Tables Skill

Use this skill when a user asks whether two document tables differ.

Inputs:
- `documentA`: PDF, DOC/DOCX, or image path.
- `documentB`: PDF, DOC/DOCX, or image path.
- `redlineOutputPath`: destination PDF path.

Procedure:
1. Parse both documents with `parse-document-pair-tables-with-mineru`.
2. Inspect `tables`; if there is more than one table, choose the requested one or default to index `0`.
3. Compare the selected tables semantically from MinerU cell refs, row indexes, column indexes, and text. Infer matching rows and columns by meaning rather than order.
4. Return a JSON plan with `different`, `summary`, `explanation`, `rowMatches`, `differences`, and `ignored`.
5. Let deterministic code validate the plan, map refs back to bounding boxes, and create the visual redline.
6. Report:
   - `different`: boolean
   - `explanation`: written explanation with changed cell refs and before/after text
   - `redlinePdfPath`

Grounding rule:
The judgement must be based on MinerU structured output plus semantic reasoning over the parsed cell text. The semantic comparison must handle same-format tables, reordered rows, different templates, extra columns, and equivalent descriptions. The visual redline should use MinerU page geometry and bounding boxes. If MinerU does not provide cell-level boxes, use the table bbox plus parsed row/column geometry to derive cell boxes.
