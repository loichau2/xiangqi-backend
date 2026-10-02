import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as auth from '../services/authService.js';
import { verifyGoogleIdToken, verifyFacebookAccessToken } from '../services/oauthProviders.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Thử lại sau ít phút' } },
});

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// ---- Schemas
const registerSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9_]{3,30}$/, '3-30 ký tự: chữ, số, dấu gạch dưới'),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Tối thiểu 8 ký tự').max(72, 'Tối đa 72 ký tự'),
  displayName: z.string().trim().min(1).max(50).optional(),
});
const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254), // email hoặc username
  password: z.string().min(1).max(72),
});
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
const googleSchema = z.object({ idToken: z.string().min(20) });
const facebookSchema = z.object({ accessToken: z.string().min(20) });

// ---- Routes
router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  res.status(201).json(await auth.register(req.body, meta(req)));
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  res.json(await auth.login(req.body, meta(req)));
});

router.post('/google', authLimiter, validate(googleSchema), async (req, res) => {
  const profile = await verifyGoogleIdToken(req.body.idToken);
  res.json(await auth.loginWithOAuth(profile, meta(req)));
});

router.post('/facebook', authLimiter, validate(facebookSchema), async (req, res) => {
  const profile = await verifyFacebookAccessToken(req.body.accessToken);
  res.json(await auth.loginWithOAuth(profile, meta(req)));
});

router.post('/refresh', authLimiter, validate(refreshSchema), async (req, res) => {
  res.json(await auth.refresh(req.body.refreshToken, meta(req)));
});

router.post('/logout', validate(refreshSchema), async (req, res) => {
  await auth.logout(req.body.refreshToken);
  res.status(204).end();
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: await auth.getProfile(req.user.id) });
});

export default router;
