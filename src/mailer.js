// Sends email over SMTP: to Mailpit on your computer, or to your email
// service (Resend, Postmark, Amazon SES...) in production.
import nodemailer from 'nodemailer';
import { emailFrom, emailTransport, smtpUrl } from './config.js';

// With EMAIL_TRANSPORT=test, emails land here instead (used by the automated tests).
export const sentEmails = [];

const transport = emailTransport === 'test' ? null : nodemailer.createTransport(smtpUrl);

export async function sendEmail({ to, subject, text, html }) {
  const message = { from: emailFrom, to, subject, text, html };
  if (!transport) {
    sentEmails.push(message);
    return;
  }
  await transport.sendMail(message);
}

// Send without making the visitor wait, and without letting a mail problem
// break their request. Failures are logged so you can see them.
export function sendInBackground(message) {
  sendEmail(message).catch((err) => {
    console.error(`Couldn't send "${message.subject}" to ${message.to}: ${err.message}`);
  });
}
