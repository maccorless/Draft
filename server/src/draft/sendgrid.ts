/**
 * SendGrid v3 Mail Send adapter (F-MOD-006-rework-01, PRD §36.4).
 *
 * Environment variables used:
 *   SENDGRID_API_KEY   — required, validated at startup by env-check.cjs
 *   SENDGRID_FROM_EMAIL — required, verified sender identity (SendGrid requirement)
 *   SENDGRID_API_URL   — optional override for the base URL (used in tests, mirrors
 *                         the FANTASYPROS_API_URL pattern in adapters/fantasypros.ts)
 *
 * A send failure for one recipient must never throw past this module — the
 * caller records it as a FAILED ReportDeliveryAttempt and continues to the
 * next recipient (EXTRACTED-038).
 */

const SENDGRID_BASE_URL = 'https://api.sendgrid.com/v3/mail/send';

export interface SendMailResult {
  ok: boolean;
  errorDetail?: string;
}

export async function sendMail(params: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendMailResult> {
  const apiKey = process.env['SENDGRID_API_KEY'] ?? '';
  const fromEmail = process.env['SENDGRID_FROM_EMAIL'] ?? '';
  const url = process.env['SENDGRID_API_URL'] ?? SENDGRID_BASE_URL;

  const body = {
    personalizations: [{ to: [{ email: params.to }] }],
    from: { email: fromEmail },
    subject: params.subject,
    content: [{ type: 'text/plain', value: params.text }],
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, errorDetail: `SendGrid returned ${response.status}: ${detail}`.slice(0, 500) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, errorDetail: String(err).slice(0, 500) };
  }
}
