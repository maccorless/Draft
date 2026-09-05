-- Migration: Auto-Agent per-player willingness ceiling (F-MOD-004-rework-02, UF-17-05)
-- Replaces the flat willingness_pct-of-total-budget ceiling with the per-player
-- algorithm from state-machine-flows.md §11 / data-model.md §10.5. Adds the six
-- AutoAgentConfiguration fields the algorithm needs; willingness_pct/enabled/
-- last_transition_at are left in place (no longer read by the ceiling calc, but
-- not dropped — no destructive change to existing data).

--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "use_owner_target_when_customized" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "fallback_to_primary_aav" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "max_over_base_pct" numeric(4, 3) DEFAULT '0.250' NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "random_variance_pct" numeric(4, 3) DEFAULT '0.250' NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "bench_value_pct" numeric(4, 3) DEFAULT '0.500' NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_agent_configs" ADD COLUMN IF NOT EXISTS "prioritize_starters" boolean DEFAULT true NOT NULL;
