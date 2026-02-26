import rateLimit from 'express-rate-limit';

export const reviewWriteLimiter = rateLimit({
  windowMs: Number(process.env.REVIEW_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.REVIEW_RATE_LIMIT_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many review attempts. Please try again later.' },
});

export const emailOtpSendLimiter = rateLimit({
  windowMs: Number(process.env.EMAIL_OTP_SEND_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.EMAIL_OTP_SEND_MAX || 3),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests. Please wait before retrying.' },
});

export const emailOtpVerifyLimiter = rateLimit({
  windowMs: Number(process.env.EMAIL_OTP_VERIFY_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.EMAIL_OTP_VERIFY_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
});
