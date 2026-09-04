## Id
- F-MOD-002-rework-02

## Supersedes
- F-MOD-002

## Spec File
- F-MOD-002.md

## Test Config

- command: DATABASE_URL=postgres://draft:draft_local_dev@localhost:5432/draft_test JWT_SECRET=test-secret-for-vitest-at-least-32-chars-long!! NODE_ENV=test npx vitest run --reporter=verbose server/src/__tests__/F-MOD-002_auction.test.ts web/src/__tests__/F-MOD-002-rework-02_draft_room.test.tsx
- test_paths:
  - server/src/__tests__/F-MOD-002_auction.test.ts
  - web/src/__tests__/F-MOD-002-rework-02_draft_room.test.tsx

## Status
implementing
