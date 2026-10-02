import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';
import { signAccessToken, generateRefreshToken, hashToken } from '../utils/tokens.js';

const BCRYPT_ROUNDS = 12;
// Dùng khi không tìm thấy user để thời gian phản hồi không lộ tài khoản có tồn tại hay không
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

const USER_COLUMNS =
  'id, username, email, display_name, avatar_url, role, is_active, email_verified, created_at';

export const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  role: row.role,
  createdAt: row.created_at,
});

async function createSession(db, user, meta) {
  const refreshToken = generateRefreshToken();
  await db.query(
    `INSERT INTO auth_sessions (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [user.id, hashToken(refreshToken), meta.userAgent?.slice(0, 255) ?? null, meta.ip ?? null, config.refreshTtlDays],
  );
  return { accessToken: signAccessToken(user), refreshToken };
}

const assertActive = (user) => {
  if (!user.is_active) throw new AppError(403, 'Tài khoản đã bị khóa', 'ACCOUNT_DISABLED');
};

// ---------------------------------------------------------------- Đăng ký
export async function register({ username, email, password, displayName }, meta) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let user;
  try {
    const { rows } = await query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
      [username, email, passwordHash, displayName ?? username],
    );
    user = rows[0]; // trigger trong DB tự tạo player_stats
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint === 'users_email_key') throw new AppError(409, 'Email đã được sử dụng', 'EMAIL_TAKEN');
      if (err.constraint === 'users_username_key') throw new AppError(409, 'Tên đăng nhập đã tồn tại', 'USERNAME_TAKEN');
    }
    throw err;
  }
  const tokens = await createSession({ query }, user, meta);
  return { user: publicUser(user), ...tokens };
}

// ---------------------------------------------------------------- Đăng nhập
export async function login({ identifier, password }, meta) {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1 OR username = $1`,
    [identifier],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    throw new AppError(401, 'Sai tài khoản hoặc mật khẩu', 'INVALID_CREDENTIALS');
  }
  assertActive(user);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const tokens = await createSession({ query }, user, meta);
  return { user: publicUser(user), ...tokens };
}

// ---------------------------------------------------------------- Refresh token (xoay vòng)
export async function refresh(refreshToken, meta) {
  const result = await withTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = $1 FOR UPDATE',
      [hashToken(refreshToken)],
    );
    const session = rows[0];
    if (!session) return { error: 'INVALID' };

    if (session.revoked_at) {
      // Token cũ bị dùng lại => nghi bị đánh cắp, thu hồi toàn bộ phiên của user
      await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
        session.user_id,
      ]);
      return { error: 'REUSED' };
    }
    if (new Date(session.expires_at) < new Date()) return { error: 'INVALID' };

    const userRes = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [session.user_id]);
    const user = userRes.rows[0];
    if (!user || !user.is_active) return { error: 'INVALID' };

    await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
    const tokens = await createSession(db, user, meta);
    return { user, tokens };
  });

  if (result.error) throw new AppError(401, 'Refresh token không hợp lệ', 'REFRESH_INVALID');
  return { user: publicUser(result.user), ...result.tokens };
}

export async function logout(refreshToken) {
  await query('UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    hashToken(refreshToken),
  ]);
}

// ---------------------------------------------------------------- Google / Facebook
function makeUsername(profile) {
  const raw = profile.email?.split('@')[0] || profile.name || '';
  const base = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 20);
  return `${base.length >= 3 ? base : 'player'}_${crypto.randomBytes(3).toString('hex')}`;
}

async function findOrCreateOAuthUser(db, p) {
  // 1. Đã liên kết trước đó -> đăng nhập luôn
  let res = await db.query(
    `SELECT u.* FROM oauth_accounts o JOIN users u ON u.id = o.user_id
     WHERE o.provider = $1 AND o.provider_user_id = $2`,
    [p.provider, p.providerUserId],
  );
  if (res.rows[0]) return res.rows[0];

  const link = (userId) =>
    db.query(
      'INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES ($1, $2, $3, $4)',
      [userId, p.provider, p.providerUserId, p.email],
    );

  // 2. Trùng email đã xác minh với tài khoản có sẵn -> liên kết
  if (p.email && p.emailVerified) {
    res = await db.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [p.email]);
    const existing = res.rows[0];
    if (existing) {
      if (!existing.email_verified) {
        // Chống "pre-hijacking": mật khẩu cũ được đặt bởi người chưa chứng minh sở hữu email -> xóa đi
        await db.query('UPDATE users SET password_hash = NULL, email_verified = TRUE WHERE id = $1', [existing.id]);
        existing.password_hash = null;
        existing.email_verified = true;
      }
      await link(existing.id);
      return existing;
    }
  }

  // 3. Tạo tài khoản mới
  const username = makeUsername(p);
  const created = await db.query(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_url, email_verified)
     VALUES ($1, $2, NULL, $3, $4, $5) RETURNING *`,
    [username, p.emailVerified ? p.email : null, (p.name || username).slice(0, 50), p.avatarUrl, p.emailVerified],
  );
  await link(created.rows[0].id);
  return created.rows[0];
}

export async function loginWithOAuth(profile, meta) {
  let user;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      user = await withTransaction((db) => findOrCreateOAuthUser(db, profile));
      break;
    } catch (err) {
      if (err.code === '23505' && attempt < 2) continue; // trùng username ngẫu nhiên / race -> thử lại
      throw err;
    }
  }
  assertActive(user);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const tokens = await createSession({ query }, user, meta);
  return { user: publicUser(user), ...tokens };
}

// ---------------------------------------------------------------- Hồ sơ
export async function getProfile(userId) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.role, u.created_at,
            s.rating, s.games_played, s.wins, s.losses, s.draws
     FROM users u LEFT JOIN player_stats s ON s.user_id = u.id
     WHERE u.id = $1 AND u.is_active`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');
  return {
    ...publicUser(row),
    stats: {
      rating: row.rating,
      gamesPlayed: row.games_played,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
    },
  };
}
