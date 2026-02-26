type CaptchaResult = {
  success: boolean;
  reason?: string;
};

function normalizeRemoteIp(remoteIp?: string) {
  if (!remoteIp) return undefined;
  const value = String(remoteIp).trim();
  if (!value) return undefined;
  if (value.includes(',')) return value.split(',')[0].trim();
  return value;
}

export async function verifyCaptchaToken(token: string | undefined, remoteIp?: string): Promise<CaptchaResult> {
  const secret = process.env.CAPTCHA_SECRET_KEY;
  const provider = (process.env.CAPTCHA_PROVIDER || 'recaptcha').toLowerCase();

  if (!secret) {
    if (process.env.NODE_ENV !== 'production') {
      return { success: true };
    }
    return { success: false, reason: 'captcha-not-configured' };
  }

  if (!token) {
    return { success: false, reason: 'missing-token' };
  }

  const verifyUrl =
    provider === 'recaptcha'
      ? 'https://www.google.com/recaptcha/api/siteverify'
      : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);

  const ip = normalizeRemoteIp(remoteIp);
  if (ip) {
    body.set('remoteip', ip);
  }

  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const json = (await response.json()) as { success?: boolean };
    return { success: Boolean(json.success), reason: json.success ? undefined : 'provider-rejected' };
  } catch {
    return { success: false, reason: 'captcha-verify-failed' };
  }
}
