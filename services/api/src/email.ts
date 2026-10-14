import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { AppError, type Env } from '@alfred/core';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}
export interface EmailSender {
  readonly kind: 'disabled' | 'file' | 'smtp' | 'memory';
  send(mail: OutgoingEmail): Promise<void>;
}

/** Test double: records mails in memory. Never constructed by createEmailSender. */
export class MemoryEmailSender implements EmailSender {
  readonly kind = 'memory' as const;
  readonly sent: OutgoingEmail[] = [];
  async send(mail: OutgoingEmail) {
    this.sent.push(mail);
  }
}

/**
 * file: dev/e2e only (env validation forbids it in staging/production). Writes one 0600 JSON file per mail.
 * smtp: real transport — NOT VERIFIED against a real server in this repo (gate REAL-EMAIL).
 * disabled: fails closed with an honest error.
 */
export function createEmailSender(env: Pick<Env, 'EMAIL_TRANSPORT' | 'EMAIL_FROM' | 'EMAIL_OUTBOX_DIR' | 'SMTP_URL'>): EmailSender {
  switch (env.EMAIL_TRANSPORT) {
    case 'file': {
      const dir = env.EMAIL_OUTBOX_DIR as string;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return {
        kind: 'file',
        async send(mail) {
          writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(mail, null, 2), { mode: 0o600 });
        },
      };
    }
    case 'smtp': {
      const transport = nodemailer.createTransport(env.SMTP_URL as string);
      return {
        kind: 'smtp',
        async send(mail) {
          await transport.sendMail({ from: env.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
        },
      };
    }
    default:
      return {
        kind: 'disabled',
        async send() {
          throw new AppError('not_ready', "L'envoi d'e-mails n'est pas configuré");
        },
      };
  }
}

export function magicLinkMail(to: string, url: string, ttlMinutes: number): OutgoingEmail {
  return {
    to,
    subject: 'Ton lien de connexion — Assistant IA',
    text:
      `Bonjour,\n\nClique sur ce lien pour te connecter (valable ${ttlMinutes} minutes, utilisable une seule fois) :\n${url}\n\n` +
      `Si tu n'as pas demandé ce lien, ignore ce message : personne ne peut se connecter sans lui.\n` +
      `Ne transfère pas cet e-mail.\n`,
  };
}
