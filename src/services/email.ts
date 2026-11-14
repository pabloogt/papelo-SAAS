import type { Config } from '../config.ts';
import type { DB } from '../db.ts';
import { run } from '../db.ts';
import { newId } from '../lib/security.ts';

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
  kind: string;
  orgId?: string | null;
  requestId?: string | null;
};

export type Mailer = { send(email: OutgoingEmail): Promise<void> };

// Todo correo queda registrado en la tabla `emails` (trazabilidad y bandeja de desarrollo).
// Con RESEND_API_KEY se envía de verdad; sin ella sólo se registra (modo desarrollo).
export function createMailer(config: Config, db: DB, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async send(email) {
      let status = 'logged';
      let error: string | null = null;
      if (config.email.resendApiKey) {
        try {
          const res = await fetchFn('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: config.email.from,
              to: [email.to],
              subject: email.subject,
              text: email.text,
              reply_to: email.replyTo || undefined,
            }),
          });
          status = res.ok ? 'sent' : 'failed';
          if (!res.ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        } catch (err) {
          status = 'failed';
          error = String(err).slice(0, 300);
        }
      } else if (config.env === 'development') {
        console.log(`[email] → ${email.to} | ${email.subject}`);
      }
      run(
        db,
        `INSERT INTO emails (id, org_id, request_id, kind, to_email, subject, body_text, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), email.orgId ?? null, email.requestId ?? null, email.kind, email.to, email.subject, email.text, status, error,
      );
      if (status === 'failed') console.error(`[email] fallo enviando a ${email.to}: ${error}`);
    },
  };
}
