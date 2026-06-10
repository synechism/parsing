export type BBox = [number, number, number, number];

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface PageGeometry {
  pageIndex: number;
  width: number;
  height: number;
}

export interface MinerUOptions {
  lang?: string;
  backend?: string;
  parseMethod?: string;
  formulaEnable?: boolean;
  tableEnable?: boolean;
  imageAnalysis?: boolean;
  startPageId?: number;
  endPageId?: number;
}

export interface ExtractedCell {
  rowIndex: number;
  colIndex: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  bbox: BBox;
  ref: string;
}

export interface ExtractedTable {
  index: number;
  pageIndex: number;
  pageSize: [number, number] | null;
  bbox: BBox;
  caption: string[];
  html: string;
  rowCount: number;
  colCount: number;
  cells: ExtractedCell[];
}

export interface ParsedDocumentTables {
  fileName: string;
  mineruTaskId: string;
  rawResult: unknown;
  tables: ExtractedTable[];
  pages: PageGeometry[];
}

export type DifferenceKind =
  | "cell_changed"
  | "cell_added"
  | "cell_removed"
  | "shape_changed";

export interface TableDifference {
  kind: DifferenceKind;
  ref: string;
  rowIndex: number;
  colIndex: number;
  before: string | null;
  after: string | null;
  bboxA?: BBox;
  bboxB?: BBox;
  pageIndexA?: number;
  pageIndexB?: number;
}

export interface TableComparisonResult {
  different: boolean;
  summary: string;
  explanation: string;
  differences: TableDifference[];
  tableA: ExtractedTable;
  tableB: ExtractedTable;
  redlinePdfPath?: string;
}

export interface CompareJobRecord {
  id: string;
  status: JobStatus;
  files: {
    documentA: string;
    documentB: string;
  };
  inputPaths: {
    documentA: string;
    documentB: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: TableComparisonResult;
}
