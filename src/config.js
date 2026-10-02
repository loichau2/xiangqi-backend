import 'dotenv/config';

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Thiếu biến môi trường: ${key}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_ACCESS_SECRET'),
  accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  google: { clientId: process.env.GOOGLE_CLIENT_ID || '' },
  facebook: {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
  },
};
