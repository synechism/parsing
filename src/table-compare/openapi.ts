export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "MinerU Semantic Table Compare API",
    version: "1.0.0",
    description:
      "Asynchronous API for comparing tables in two uploaded documents using MinerU structured output and a Mastra semantic comparison agent.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Health", description: "Service and MinerU health checks" },
    { name: "Table Comparisons", description: "Async semantic table comparison jobs" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Check table-agent and MinerU health",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service health summary",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/table-comparisons": {
      post: {
        tags: ["Table Comparisons"],
        summary: "Submit two documents for semantic table comparison",
        operationId: "submitTableComparison",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["documentA", "documentB"],
                properties: {
                  documentA: {
                    type: "string",
                    format: "binary",
                    description: "First input document. PDF, DOC/DOCX, PNG, JPG/JPEG, or WEBP.",
                  },
                  documentB: {
                    type: "string",
                    format: "binary",
                    description: "Second input document. PDF, DOC/DOCX, PNG, JPG/JPEG, or WEBP.",
                  },
                  baselineDocument: {
                    $ref: "#/components/schemas/BaselineDocument",
                  },
                  baseline: {
                    $ref: "#/components/schemas/BaselineDocument",
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Job accepted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SubmitComparisonResponse" },
              },
            },
          },
          "400": {
            description: "Missing files or invalid baseline",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "500": {
            description: "Unexpected server error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/table-comparisons/{jobId}": {
      get: {
        tags: ["Table Comparisons"],
        summary: "Get table comparison job status",
        operationId: "getTableComparisonStatus",
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Job status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ComparisonJob" },
              },
            },
          },
          "404": {
            description: "Job not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/table-comparisons/{jobId}/result": {
      get: {
        tags: ["Table Comparisons"],
        summary: "Get completed comparison result",
        operationId: "getTableComparisonResult",
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Completed semantic comparison result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TableComparisonResult" },
              },
            },
          },
          "202": {
            description: "Result not ready",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PendingJobResponse" },
              },
            },
          },
          "404": {
            description: "Job not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Job failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PendingJobResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/table-comparisons/{jobId}/redline.pdf": {
      get: {
        tags: ["Table Comparisons"],
        summary: "Download the redlined PDF",
        operationId: "downloadTableComparisonRedline",
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Redlined PDF",
            content: {
              "application/pdf": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
            },
          },
          "202": {
            description: "Redline PDF not ready",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PendingJobResponse" },
              },
            },
          },
          "404": {
            description: "Job not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Job failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PendingJobResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      JobId: {
        name: "jobId",
        in: "path",
        required: true,
        schema: {
          type: "string",
          example: "3679e3e0d77745ab9405a3b9292b7f6a",
        },
      },
    },
    schemas: {
      BaselineDocument: {
        type: "string",
        enum: ["documentA", "documentB"],
        description: "Document to draw redline annotations on. Defaults to documentB.",
        example: "documentB",
      },
      JobStatus: {
        type: "string",
        enum: ["queued", "processing", "completed", "failed"],
      },
      ErrorResponse: {
        type: "object",
        properties: {
          detail: { type: "string" },
        },
        required: ["detail"],
      },
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "healthy" },
          mineru: {
            description: "Raw MinerU health response, or an unhealthy wrapper if MinerU health fails.",
            type: "object",
            additionalProperties: true,
          },
          jobs: {
            type: "object",
            properties: {
              queued: { type: "integer", example: 0 },
              processing: { type: "integer", example: 1 },
              completed: { type: "integer", example: 12 },
              failed: { type: "integer", example: 0 },
            },
            required: ["queued", "processing", "completed", "failed"],
          },
          workerConcurrency: { type: "integer", example: 2 },
        },
        required: ["status", "mineru", "jobs", "workerConcurrency"],
      },
      SubmitComparisonResponse: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          status: { $ref: "#/components/schemas/JobStatus" },
          baselineDocument: { $ref: "#/components/schemas/BaselineDocument" },
          statusUrl: { type: "string" },
          resultUrl: { type: "string" },
          redlinePdfUrl: { type: "string" },
        },
        required: ["jobId", "status", "statusUrl", "resultUrl", "redlinePdfUrl"],
      },
      ComparisonJob: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          status: { $ref: "#/components/schemas/JobStatus" },
          files: {
            type: "object",
            properties: {
              documentA: { type: "string" },
              documentB: { type: "string" },
            },
            required: ["documentA", "documentB"],
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          startedAt: { type: "string", format: "date-time" },
          completedAt: { type: "string", format: "date-time" },
          baselineDocument: { $ref: "#/components/schemas/BaselineDocument" },
          error: { type: "string" },
          resultUrl: { type: "string" },
          redlinePdfUrl: { type: "string" },
        },
        required: ["jobId", "status", "files", "createdAt", "updatedAt", "resultUrl", "redlinePdfUrl"],
      },
      PendingJobResponse: {
        allOf: [
          { $ref: "#/components/schemas/ComparisonJob" },
          {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        ],
      },
      BBox: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: { type: "number" },
        example: [306, 169.5, 429, 199],
      },
      ExtractedCell: {
        type: "object",
        properties: {
          rowIndex: { type: "integer" },
          colIndex: { type: "integer" },
          rowSpan: { type: "integer" },
          colSpan: { type: "integer" },
          text: { type: "string" },
          bbox: { $ref: "#/components/schemas/BBox" },
          ref: { type: "string", example: "D3" },
          geometrySource: { type: "string", enum: ["uniform_grid", "pdf_ruling_lines"] },
        },
        required: ["rowIndex", "colIndex", "rowSpan", "colSpan", "text", "bbox", "ref", "geometrySource"],
      },
      ExtractedTable: {
        type: "object",
        properties: {
          index: { type: "integer" },
          pageIndex: { type: "integer" },
          pageSize: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: { type: "number" },
            nullable: true,
          },
          bbox: { $ref: "#/components/schemas/BBox" },
          caption: {
            type: "array",
            items: { type: "string" },
          },
          html: { type: "string" },
          rowCount: { type: "integer" },
          colCount: { type: "integer" },
          cells: {
            type: "array",
            items: { $ref: "#/components/schemas/ExtractedCell" },
          },
          geometrySource: { type: "string", enum: ["uniform_grid", "pdf_ruling_lines"] },
        },
        required: [
          "index",
          "pageIndex",
          "pageSize",
          "bbox",
          "caption",
          "html",
          "rowCount",
          "colCount",
          "cells",
          "geometrySource",
        ],
      },
      TableDifference: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["cell_changed", "cell_added", "cell_removed", "shape_changed", "row_added", "row_removed"],
          },
          ref: { type: "string", example: "D3" },
          rowIndex: { type: "integer" },
          colIndex: { type: "integer" },
          before: { type: "string", nullable: true },
          after: { type: "string", nullable: true },
          bboxA: { $ref: "#/components/schemas/BBox" },
          bboxB: { $ref: "#/components/schemas/BBox" },
          pageIndexA: { type: "integer" },
          pageIndexB: { type: "integer" },
          field: { type: "string" },
          matchKey: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["kind", "ref", "rowIndex", "colIndex", "before", "after"],
      },
      AgentMetadata: {
        type: "object",
        properties: {
          id: { type: "string", example: "semantic-table-compare-agent" },
          registryName: { type: "string", example: "semanticTableCompareAgent" },
          skill: { type: "string", example: "compare-two-tables" },
          toolCalls: {
            type: "array",
            items: { type: "string" },
            example: ["parse-document-pair-tables-with-mineru", "semantic-table-compare-agent", "create-table-redline-pdf"],
          },
          invokedByApi: { type: "boolean", example: true },
          responseText: { type: "string" },
        },
        required: ["id", "registryName", "skill", "toolCalls"],
      },
      SemanticMetadata: {
        type: "object",
        properties: {
          commonFields: {
            type: "array",
            items: { type: "string" },
          },
          ignoredFieldsA: {
            type: "array",
            items: { type: "string" },
          },
          ignoredFieldsB: {
            type: "array",
            items: { type: "string" },
          },
          matchedRows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                rowIndexA: { type: "integer" },
                rowIndexB: { type: "integer" },
                score: { type: "number" },
              },
              required: ["key", "rowIndexA", "rowIndexB", "score"],
            },
          },
        },
      },
      TableComparisonResult: {
        type: "object",
        properties: {
          different: { type: "boolean" },
          summary: { type: "string" },
          explanation: { type: "string" },
          differences: {
            type: "array",
            items: { $ref: "#/components/schemas/TableDifference" },
          },
          tableA: { $ref: "#/components/schemas/ExtractedTable" },
          tableB: { $ref: "#/components/schemas/ExtractedTable" },
          comparisonMode: { type: "string", enum: ["semantic"] },
          baselineDocument: { $ref: "#/components/schemas/BaselineDocument" },
          semantic: { $ref: "#/components/schemas/SemanticMetadata" },
          redlinePdfPath: { type: "string" },
          agent: { $ref: "#/components/schemas/AgentMetadata" },
        },
        required: ["different", "summary", "explanation", "differences", "tableA", "tableB"],
      },
    },
  },
} as const;
