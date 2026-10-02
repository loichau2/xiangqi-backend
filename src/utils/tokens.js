import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';

export const signAccessToken = (user) =>
  jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.accessTtl,
  });

export const verifyAccessToken = (token) => jwt.verify(token, config.jwtSecret);

// Refresh token là chuỗi ngẫu nhiên; DB chỉ lưu bản băm SHA-256
export const generateRefreshToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
