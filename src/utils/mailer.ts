import nodemailer from 'nodemailer';

type SendResult = {
  delivered: boolean;
  codeExposed?: boolean;
};

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
}

export async function sendEmailVerificationCode(email: string, code: string): Promise<SendResult> {
  const transport = getTransport();

  if (!transport) {
    return { delivered: false, codeExposed: process.env.NODE_ENV !== 'production' };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await transport.sendMail({
    from,
    to: email,
    subject: 'Your verification code',
    text: `Your verification code is ${code}. This code expires in 10 minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>`,
  });

  return { delivered: true };
}
