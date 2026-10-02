import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

const googleClient = new OAuth2Client(config.google.clientId);

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Xác thực Google ID token (credential) do frontend gửi lên. */
export async function verifyGoogleIdToken(idToken) {
  if (!config.google.clientId) throw new AppError(501, 'Chưa cấu hình đăng nhập Google', 'GOOGLE_DISABLED');
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw new AppError(401, 'Google token không hợp lệ', 'GOOGLE_TOKEN_INVALID');
  }
  return {
    provider: 'google',
    providerUserId: payload.sub,
    email: payload.email ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
    avatarUrl: payload.picture || null,
  };
}

/** Xác thực Facebook access token: phải thuộc đúng app của mình rồi mới lấy hồ sơ. */
export async function verifyFacebookAccessToken(accessToken) {
  const { appId, appSecret } = config.facebook;
  if (!appId || !appSecret) throw new AppError(501, 'Chưa cấu hình đăng nhập Facebook', 'FACEBOOK_DISABLED');
  try {
    const debug = await fetchJson(
      'https://graph.facebook.com/debug_token?' +
        new URLSearchParams({ input_token: accessToken, access_token: `${appId}|${appSecret}` }),
    );
    if (!debug.data?.is_valid || debug.data.app_id !== appId) throw new Error('token không thuộc app này');

    const me = await fetchJson(
      'https://graph.facebook.com/me?' +
        new URLSearchParams({ fields: 'id,name,email,picture.width(256)', access_token: accessToken }),
    );
    const email = me.email ? String(me.email).toLowerCase() : null;
    return {
      provider: 'facebook',
      providerUserId: me.id,
      email,
      emailVerified: Boolean(email), // Facebook chỉ trả email đã xác nhận
      name: me.name || null,
      avatarUrl: me.picture?.data?.url || null,
    };
  } catch {
    throw new AppError(401, 'Facebook token không hợp lệ', 'FACEBOOK_TOKEN_INVALID');
  }
}
