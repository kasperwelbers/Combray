/**
 * Sending sign-in emails to researchers. Over SMTP in production; for development, mails can be
 * written to an outbox directory instead. Addresses and contents are never logged.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import nodemailer, { type Transporter } from 'nodemailer';

import type { MailConfig } from './config.ts';
import { log } from './log.ts';
import { b64, nowSecs, random } from './util.ts';

export class Mailer {
  private readonly kind: 'smtp' | 'outbox' | 'disabled';
  private readonly transport?: Transporter;
  private readonly from?: string;
  private readonly dir?: string;

  constructor(config: MailConfig) {
    if (config.kind === 'outbox') {
      this.kind = 'outbox';
      this.dir = config.dir;
      return;
    }
    if (config.kind === 'smtp') {
      try {
        const url = new URL(config.url);
        // smtps:// is TLS on connect; smtp://…?tls=required is STARTTLS, which must then succeed.
        const secure = url.protocol === 'smtps:';
        if (!secure && url.protocol !== 'smtp:') throw new Error('scheme');
        this.transport = nodemailer.createTransport({
          host: url.hostname,
          port: url.port ? Number(url.port) : secure ? 465 : 587,
          secure,
          requireTLS: !secure && url.searchParams.get('tls') === 'required',
          auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
        });
        this.from = config.from;
        this.kind = 'smtp';
        return;
      } catch {
        log.error({ error_class: 'mail_config' }, 'COMBRAY_SMTP_URL or COMBRAY_MAIL_FROM is invalid; email sign-in is off');
      }
    }
    this.kind = 'disabled';
  }

  get enabled(): boolean {
    return this.kind !== 'disabled';
  }

  /** Whether mails go to a folder instead of being sent (development). */
  get isOutbox(): boolean {
    return this.kind === 'outbox';
  }

  /** Send a mail; failures are logged by class only and otherwise ignored by callers. */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    try {
      if (this.kind === 'smtp') {
        await this.transport!.sendMail({ from: this.from, to, subject, text });
        return true;
      }
      if (this.kind === 'outbox') {
        await mkdir(this.dir!, { recursive: true });
        await writeFile(join(this.dir!, `${nowSecs()}-${b64(random(6))}.txt`), `To: ${to}\nSubject: ${subject}\n\n${text}`);
        return true;
      }
    } catch {
      log.error({ error_class: this.kind === 'smtp' ? 'smtp' : 'outbox' }, 'could not send a sign-in email');
    }
    return false;
  }
}
