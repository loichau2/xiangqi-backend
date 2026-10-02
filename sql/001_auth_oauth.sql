-- Bổ sung cho schema gốc để hỗ trợ đăng nhập Google / Facebook

-- Tài khoản OAuth không có mật khẩu; Facebook có thể không trả về email
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;   -- UNIQUE vẫn cho phép nhiều NULL

CREATE TYPE oauth_provider AS ENUM ('google', 'facebook');

CREATE TABLE oauth_accounts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         oauth_provider NOT NULL,
    provider_user_id TEXT   NOT NULL,          -- "sub" của Google / "id" của Facebook
    email            CITEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id),
    UNIQUE (user_id, provider)
);
CREATE INDEX idx_oauth_accounts_user ON oauth_accounts (user_id);
