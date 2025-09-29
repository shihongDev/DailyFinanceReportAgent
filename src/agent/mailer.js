import nodemailer from 'nodemailer';
import Logger from '../twitter/Logger.js';

function resolveTransportConfig() {
  const service = process.env.SMTP_SERVICE;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE !== 'false';
  const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));

  if (!user || !pass) {
    throw new Error('Missing SMTP_USER or SMTP_PASS environment variables');
  }

  if (service) {
    return {
      service,
      auth: { user, pass },
    };
  }

  const effectiveHost = host || 'smtp.gmail.com';
  return {
    host: effectiveHost,
    port: host ? port : 465,
    secure: secure || !host,
    auth: { user, pass },
  };
}

export async function sendEmail({ subject, text, html, to, from }) {
  if (!to) {
    throw new Error('No report recipient configured (REPORT_RECIPIENT)');
  }

  const transporter = nodemailer.createTransport(resolveTransportConfig());

  const message = {
    to,
    from,
    subject,
    text,
    html,
  };

  Logger.startSpinner('Sending email report');
  try {
    await transporter.sendMail(message);
    Logger.stopSpinner();
    Logger.success('?? Report email sent');
  } catch (error) {
    Logger.stopSpinner(false);
    throw error;
  }
}
