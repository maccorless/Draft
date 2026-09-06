/**
 * F-MOD-000-rework-01: the fixed identity/logout pill (top-right, ~40px
 * tall) must never overlap interactive/informational content on
 * Commissioner Console or Draft Room at viewports 1200-1440px.
 *
 * jsdom has no real layout engine (no box measurements), so this can't
 * assert actual pixel geometry without a browser (Playwright isn't wired
 * into this project — see testing-standards fallback for UI). Instead
 * this locks in the two CSS reservations that fix the reported overlap:
 * .app-content reserves top space, and each top-right header reserves
 * right-side space clear of the pill's horizontal band. If either
 * reservation regresses (removed or shrunk to ~0), this fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(path.join(root, relPath), 'utf8');
}

describe('logout pill does not overlap page content', () => {
  it('test_F-MOD-000-rework-01_app_content_reserves_top_space_below_pill', () => {
    const css = read('app-chrome.css');
    const match = css.match(/\.app-content\s*\{[^}]*padding-top:\s*(\d+)px/);
    expect(match).toBeTruthy();
    // Pill: top offset 12px + ~40px height — reserve at least that much.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(52);
  });

  it('test_F-MOD-000-rework-01_commissioner_header_reserves_right_space_for_pill', () => {
    const css = read('screens/commissioner/commissioner-console.css');
    const rule = css.match(/\.commissioner-console__header-inner\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/padding:.*calc\(var\(--space-6\)\s*\+\s*\d+px\)/);
  });

  it('test_F-MOD-000-rework-01_draft_room_topbar_reserves_right_space_for_pill', () => {
    const css = read('screens/draft-room/draft-room.css');
    const rule = css.match(/\.draft-room__topbar\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/padding:.*calc\(var\(--space-6\)\s*\+\s*\d+px\)/);
  });
});
