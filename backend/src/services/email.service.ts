/**
 * Email sending via nodemailer. Support ticket notifications are sent to SUPPORT_EMAIL
 * (default hypearena@outlook.com). All support requests must go to that address.
 *
 * Required for sending: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.
 * Optional: SUPPORT_EMAIL (default hypearena@outlook.com), SMTP_FROM, SMTP_SECURE.
 * Outlook/Office365: SMTP_HOST=smtp.office365.com, PORT=587, SMTP_SECURE=false, use App Password.
 */

import nodemailer from 'nodemailer';

/** All support ticket notifications are sent here. Default: hypearena@outlook.com */
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'hypearena@outlook.com';

let smtpConfigLogged = false;
export function logSmtpConfigOnce(): void {
  if (smtpConfigLogged) return;
  smtpConfigLogged = true;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ?? '587';
  const user = process.env.SMTP_USER;
  const passSet = process.env.SMTP_PASS ? 'set' : 'not set';
  const userMask = user && user.length > 4 ? user.slice(0, 2) + '***' + user.slice(-2) : '***';
  console.log(
    '[smtp] config: SMTP_HOST=' + (host || 'NOT SET') +
    ', SMTP_PORT=' + port +
    ', SMTP_USER=' + (user ? userMask : 'NOT SET') +
    ', SUPPORT_EMAIL=' + SUPPORT_EMAIL +
    ', SMTP_PASS=' + passSet
  );
}

function getTransporter(): nodemailer.Transporter | null {
  logSmtpConfigOnce();
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const secure = process.env.SMTP_SECURE === 'true';
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: { user, pass },
  });
}

export async function sendSupportTicketNotification(params: {
  ticketId: string;
  userId: string;
  username: string;
  userEmail: string;
  subject: string;
  description: string;
  attachmentLinks: string[];
  timestamp: string;
}): Promise<void> {
  const subject = `[HypeArena Support] New ticket – ${params.subject}`;
  const body = [
    `Ticket ID: ${params.ticketId}`,
    `User ID: ${params.userId}`,
    `Username: ${params.username}`,
    `User Email: ${params.userEmail}`,
    `Subject: ${params.subject}`,
    '',
    'Description:',
    params.description,
    '',
    params.attachmentLinks.length ? `Attachments: ${params.attachmentLinks.join(', ')}` : '',
    '',
    `Timestamp (UTC): ${params.timestamp}`,
  ].filter(Boolean).join('\n');

  const transporter = getTransporter();
  if (!transporter) {
    console.log('[support] Email not configured. Would send to', SUPPORT_EMAIL, ':', subject);
    return;
  }
  try {
    console.log('[support] sending email to', SUPPORT_EMAIL, 'subject:', subject);
    const result = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: SUPPORT_EMAIL,
      subject,
      text: body,
    });
    console.log(
      '[support] sendMail result: messageId=' + (result.messageId ?? 'null') +
      ', accepted=' + JSON.stringify(result.accepted ?? []) +
      ', rejected=' + JSON.stringify(result.rejected ?? [])
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[support] sendMail error:', msg);
    if (stack) console.error('[support] sendMail stack:', stack);
    throw err;
  }
}

export async function sendSupportReplyToUser(params: {
  userEmail: string;
  ticketId: string;
  subject: string;
  adminReply: string;
}): Promise<void> {
  const subject = `[HypeArena Support] Reply to your ticket – ${params.subject}`;
  const body = [
    'Your support ticket has received a reply.',
    '',
    `Ticket: ${params.subject}`,
    '',
    'Reply:',
    params.adminReply,
    '',
    'You can view your tickets in the Support section when logged in.',
  ].join('\n');

  const transporter = getTransporter();
  if (transporter) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: params.userEmail,
      subject,
      text: body,
    });
  } else {
    console.log('[support] Email not configured. Would send reply to', params.userEmail, ':', subject);
  }
}

/** Send a test email to SUPPORT_EMAIL. Returns { messageId, accepted, rejected } or throws. */
export async function sendTestEmailToSupport(): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS required)');
  }
  const to = SUPPORT_EMAIL;
  const result = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: '[HypeArena] SMTP test',
    text: 'This is a test email from the support backend. If you see this, SMTP is working.',
  });
  console.log(
    '[smtp] test email: messageId=' + (result.messageId ?? 'null') +
    ', accepted=' + JSON.stringify(result.accepted ?? []) +
    ', rejected=' + JSON.stringify(result.rejected ?? [])
  );
  return {
    messageId: result.messageId ?? '',
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
  };
}
