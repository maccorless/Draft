-- Migration: Commissioner budget adjustments (F-MOD-011)
-- Adds COMMISSIONER_ADJUSTMENT as a distinct BudgetLedgerEntry type — separate
-- from CORRECTION, which is reserved for in-place price corrections on an
-- existing acquisition (server/src/draft/corrections.ts).

--> statement-breakpoint
ALTER TYPE "budget_entry_type" ADD VALUE IF NOT EXISTS 'COMMISSIONER_ADJUSTMENT';
