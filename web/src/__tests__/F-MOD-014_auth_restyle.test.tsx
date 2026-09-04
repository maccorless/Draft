/**
 * F-MOD-014: SiteLogin / LeagueLogin restyled onto the design-token system.
 *
 * jsdom component test — mocks global.fetch (see [[feedback-ui-test-mocking]]
 * memory: real Fastify+Postgres isn't worth spinning up for client rendering
 * assertions; backend behavior stays covered by real-DB tests elsewhere).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { SiteLogin, LeagueLogin } from '../App.js';

describe('F-MOD-014 auth restyle', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('test_F_MOD_014_site_login_uses_no_inline_style_object', () => {
    const { container } = render(<SiteLogin onLeagues={vi.fn()} />);
    const styledEls = container.querySelectorAll('[style]');
    // No element should carry the old inline styles object's properties
    // (font-family / background from styles.center|form|input|btn).
    styledEls.forEach((el) => {
      expect((el as HTMLElement).style.fontFamily).not.toBe('sans-serif');
      expect((el as HTMLElement).style.background).not.toBe('rgb(26, 115, 232)');
    });
    expect(container.querySelector('.auth-screen')).toBeTruthy();
    expect(container.querySelector('.auth-screen__form')).toBeTruthy();
  });

  it('test_F_MOD_014_league_login_uses_no_inline_style_object', () => {
    const { container } = render(
      <LeagueLogin leagues={[{ id: 'l1', name: 'League One' }]} sitePass="sp" onAuth={vi.fn()} />,
    );
    const styledEls = container.querySelectorAll('[style]');
    styledEls.forEach((el) => {
      expect((el as HTMLElement).style.fontFamily).not.toBe('sans-serif');
      expect((el as HTMLElement).style.background).not.toBe('rgb(26, 115, 232)');
    });
    expect(container.querySelector('.auth-screen')).toBeTruthy();
  });

  it('test_F_MOD_014_site_login_429_shows_rate_limit_message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 429, ok: false });
    render(<SiteLogin onLeagues={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Site password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /enter/i }));

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeTruthy();
    });
  });

  it('test_F_MOD_014_site_login_wrong_password_shows_error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 401, ok: false });
    render(<SiteLogin onLeagues={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Site password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /enter/i }));

    await waitFor(() => {
      expect(screen.getByText('Wrong site password')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_site_login_success_calls_onLeagues', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ leagues: [{ id: 'l1', name: 'League One' }] }),
    });
    const onLeagues = vi.fn();
    render(<SiteLogin onLeagues={onLeagues} />);

    fireEvent.change(screen.getByLabelText('Site password'), { target: { value: 'correct-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /enter/i }));

    await waitFor(() => {
      expect(onLeagues).toHaveBeenCalledWith([{ id: 'l1', name: 'League One' }], 'correct-pass');
    });
  });

  it('test_F_MOD_014_league_login_wrong_password_shows_error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    render(
      <LeagueLogin leagues={[{ id: 'l1', name: 'League One' }]} sitePass="sp" onAuth={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Wrong password')).toBeTruthy();
    });
  });

  it('test_F_MOD_014_league_login_success_calls_onAuth', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'jwt-token' }),
    });
    const onAuth = vi.fn();
    render(
      <LeagueLogin leagues={[{ id: 'l1', name: 'League One' }]} sitePass="sp" onAuth={onAuth} />,
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'commish-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(onAuth).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'jwt-token', role: 'COMMISSIONER', leagueId: 'l1' }),
      );
    });
  });
});
