## Id

F-MOD-007

## Title

Phase 2b Player Data Ingestion Adapters

## Module Ref

MOD-007

## Description

This module adds three ingestion adapters to the player data pipeline established by MOD-001: an ESPN AAV PDF adapter (`server/src/player/adapters/espn-pdf.ts`), a FantasyPros API adapter (`server/src/player/adapters/fantasypros.ts`), and an Excel/XLSX adapter (`server/src/player/adapters/excel.ts`). Each adapter implements the same `PlayerAdapter` interface as the Phase 2a CSV adapter, and each feeds the same normalization pipeline so that players land in the dataset with consistent field shapes (`name`, `position`, `team`, `aav_minor` as integer cents, `projected_points`). Parsing for ESPN PDF (pdfjs-dist) and Excel (SheetJS) always runs in `node:worker_threads` so CPU-bound work never blocks the main event loop or interferes with a concurrently RUNNING draft in another league — see the cross-cutting concern documented in `architecture-overview.md` §5 and the `csv-parsing-worker` decision in `discuss-prd.md`.

The FantasyPros adapter is a server-side HTTP fetch using the `FANTASYPROS_API_KEY` environment variable; the `scoring_format` request body field (STD / HALF_PPR / PPR) selects the correct projection set. The ESPN PDF adapter uses defensive parsing — any page or record it cannot parse is recorded in the `ImportResult.errors` array and does not abort the rest of the import. All three adapters are exposed as new `POST` routes under the existing dataset path defined in the MOD-001 API schema; the full schema for this module is at `schema/MOD-007-api-schema.yaml`.

The UI addition is a single control change in the Commissioner Console Dataset Import screen (established by MOD-001): an adapter-source selector offering CSV, Excel, ESPN PDF, and FantasyPros as options. Selecting a file-based source reveals a file upload input; selecting FantasyPros reveals a scoring-format dropdown and calls the FantasyPros endpoint on submit. Consult `architecture-overview.md` §7 for the folder layout (`web/src/screens/commissioner/`) and `screen-information-architecture.md` §1 for the Commissioner Console's overall IA.

Stack: Node.js 20 + TypeScript + Fastify 4.x backend; React 18 + Vite 5 + TypeScript frontend; Zod 3.x in `shared-types/` for request/response shapes; pdfjs-dist for PDF parsing; SheetJS (`xlsx`) for Excel; `node:worker_threads` for all CPU-bound parsing.

### Behavioral expectations

- Given the server boots and `FANTASYPROS_API_KEY` is absent from the environment, when the startup env checker runs, then the process exits with `ERR_CDR_78_EX_CONFIG` naming `FANTASYPROS_API_KEY`, the variable appears in `.env.example` with a safe placeholder, and it is registered in the env checker's required list — all three changes land in the same commit as this module.
- Given a commissioner POSTs a valid ESPN AAV PDF to `POST /leagues/:leagueId/datasets/:datasetId/import/espn-pdf` with a valid commissioner JWT, when the server processes the request, then pdfjs-dist parses the file inside a `node:worker_thread`, normalized player records are inserted into the dataset, and the response body is `ImportResult` with `source: "ESPN_PDF"` and `rows_imported` equal to the number of successfully parsed players; parsing never blocks the main event loop.
- Given a page or row in an ESPN PDF cannot be parsed, when the worker encounters it, then the error is appended to `ImportResult.errors` with a row index and message; the rest of the import proceeds and the HTTP response is still 200 with partial results — never a 500 or silent abort.
- Given a commissioner POSTs a valid XLSX file to `POST /leagues/:leagueId/datasets/:datasetId/import/excel` with a valid commissioner JWT, when the server processes the request, then SheetJS reads it inside a `node:worker_thread`, column mapping is inferred from headers, rows are passed through the shared normalization pipeline, and the response is `ImportResult` with `source: "EXCEL"` and the correct `rows_imported` count.
- Given a commissioner POSTs `{"scoring_format": "PPR"}` to `POST /leagues/:leagueId/datasets/:datasetId/import/fantasypros` with a valid commissioner JWT and a populated `FANTASYPROS_API_KEY`, when the server fetches from the FantasyPros API, then player projections are normalized to the standard schema, inserted into the dataset, and the response is `ImportResult` with `source: "FANTASYPROS"`.
- Given `FANTASYPROS_API_KEY` is set but the FantasyPros API returns a non-2xx response, when the adapter handles the error, then the endpoint returns a typed `ErrorResponse` (`{code, message}`) with no silent fallback or hardcoded default data, and the dataset row count is unchanged.
- Given any of the three new adapter endpoints receives a request with a missing, expired, or auth_epoch-invalidated JWT, when the Fastify preHandler runs, then the request is rejected with an auth error before any parsing or DB write occurs.
- Given a request's `league_id` in the JWT does not match the `leagueId` in the path, when the route handler validates it, then the request is rejected — routing alone is not the isolation mechanism (architectural constraint #6 in `discuss-prd.md`).
- Given all three adapter source files are compiled, when `tsc --noEmit` runs across the `server/` package, then it passes with zero errors — each adapter implements the same `PlayerAdapter` interface as `server/src/player/adapters/csv.ts` from MOD-001.
- Given a commissioner opens the Dataset Import screen in the Commissioner Console, when they view the adapter selector, then exactly four source options are presented: CSV, Excel, ESPN PDF, FantasyPros; selecting a file-based option renders a file upload input, and selecting FantasyPros renders a scoring-format dropdown (STD / HALF_PPR / PPR); submitting calls the corresponding endpoint with the correct `Content-Type` (multipart for files, JSON for FantasyPros).
- Given the adapter selector is rendered, when keyboard focus reaches it, then all options are reachable and selectable via keyboard alone, and the upload input or dropdown that appears is also keyboard accessible (resolved-standards.yaml rule `RX-A11Y-001`).
- Given a concurrent draft is RUNNING in another league on the same server process, when an ESPN PDF or Excel import is underway, then the import's `worker_thread` does not introduce measurable latency on the auction's command queue — verified by running both operations simultaneously in the Vitest integration test.

## Layers

- api
- ui

## Dependencies

- F-MOD-001

## API Contracts

```yaml
produces:
  - operation_id: importDatasetExcel
    schema_file: schema/MOD-007-api-schema.yaml
    request_schema: multipart/form-data — file (binary, XLSX)
    response_schema: ImportResult

  - operation_id: importDatasetEspnPdf
    schema_file: schema/MOD-007-api-schema.yaml
    request_schema: multipart/form-data — file (binary, ESPN AAV PDF)
    response_schema: ImportResult

  - operation_id: importDatasetFantasyPros
    schema_file: schema/MOD-007-api-schema.yaml
    request_schema: FantasyProsImportRequest
    response_schema: ImportResult
```

## Required Env Variables

- FANTASYPROS_API_KEY — FantasyPros API auth key for projection data pull

## Lint Config

## Test Config

- command: npx vitest run --reporter=default server/src/__tests__/F-MOD-007_data_adapters.test.ts web/src/__tests__/F-MOD-007_data_adapters.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-007_data_adapters.test.ts
  - web/src/__tests__/F-MOD-007_data_adapters.test.tsx

## Constraints

## Applicable Standards
- Total rules: 68
- Critical:
  - EXTRACTED-022
  - EXTRACTED-046
  - TS-SEC-001
  - TS-SEC-002
  - RX-SEC-001
  - RX-SEC-002
  - PG-SEC-001
- High:
  - EXTRACTED-001
  - EXTRACTED-002
  - EXTRACTED-003
  - EXTRACTED-004
  - EXTRACTED-005
  - EXTRACTED-006
  - EXTRACTED-007
  - EXTRACTED-008
  - EXTRACTED-010
  - EXTRACTED-011
  - EXTRACTED-012
  - EXTRACTED-013
  - EXTRACTED-014
  - EXTRACTED-015
  - EXTRACTED-020
  - EXTRACTED-021
  - EXTRACTED-023
  - EXTRACTED-024
  - EXTRACTED-025
  - EXTRACTED-026
  - EXTRACTED-029
  - EXTRACTED-032
  - EXTRACTED-033
  - EXTRACTED-034
  - EXTRACTED-035
  - EXTRACTED-036
  - EXTRACTED-038
  - EXTRACTED-040
  - EXTRACTED-041
  - EXTRACTED-042
  - EXTRACTED-043
  - EXTRACTED-044
  - EXTRACTED-045
  - TS-TYPE-001
  - TS-TYPE-002
  - TS-TEST-001
  - TS-ERR-001
  - RX-ARCH-001
  - RX-ARCH-002
  - RX-A11Y-001
  - PG-SEC-002
  - PG-PERF-001
  - PG-PERF-002
  - PG-DATA-001
  - PG-DATA-002
- Medium:
  - EXTRACTED-009
  - EXTRACTED-016
  - EXTRACTED-017
  - EXTRACTED-018
  - EXTRACTED-019
  - EXTRACTED-027
  - EXTRACTED-028
  - EXTRACTED-030
  - EXTRACTED-031
  - EXTRACTED-037
  - EXTRACTED-039
  - TS-TYPE-003
  - RX-A11Y-002
  - RX-PERF-001
  - PG-PERF-003
- Low:
  - TS-CONV-001

## Status
done
