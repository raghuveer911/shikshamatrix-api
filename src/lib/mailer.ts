import nodemailer, { Transporter } from "nodemailer";
import { env, isSmtpConfigured } from "../config/env.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!isSmtpConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

/**
 * Sends a transactional email. If SMTP isn't configured yet, this logs to
 * the console instead of throwing — so renewal reminders / receipts never
 * crash the request that triggers them, they just silently no-op until
 * SMTP_HOST/USER/PASS are set in .env.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] SMTP not configured — would have sent "${input.subject}" to ${input.to}`);
    return false;
  }

  try {
    await t.sendMail({
      from: env.SMTP_FROM ?? env.SMTP_USER,
      to: input.to,
      subject: input.subject,
      html: input.html,
      attachments: input.attachments,
    });
    return true;
  } catch (err) {
    console.error("[mailer] Failed to send email:", err);
    return false;
  }
}
