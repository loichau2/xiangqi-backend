-- =====================================================
-- CỜ TƯỚNG ONLINE - PostgreSQL schema
-- =====================================================

CREATE EXTENSION IF NOT EXISTS citext;   -- email/username không phân biệt hoa thường

-- ---------- ENUM ----------
CREATE TYPE user_role        AS ENUM ('player', 'moderator', 'admin');
CREATE TYPE piece_side       AS ENUM ('red', 'black');
CREATE TYPE game_status      AS ENUM ('waiting', 'in_progress', 'finished', 'aborted');
CREATE TYPE game_result      AS ENUM ('red_win', 'black_win', 'draw');
CREATE TYPE end_reason       AS ENUM ('checkmate', 'stalemate', 'resign', 'timeout',
                                      'draw_agreed', 'repetition', 'no_progress',
                                      'disconnect', 'aborted');
CREATE TYPE friendship_status AS ENUM ('pending', 'accepted', 'blocked');
CREATE TYPE challenge_status AS ENUM ('pending', 'accepted', 'declined', 'expired', 'cancelled');
CREATE TYPE game_event_type  AS ENUM ('draw_offer', 'draw_accept', 'draw_decline',
                                      'undo_request', 'undo_accept', 'undo_decline',
                                      'resign', 'disconnect', 'reconnect');

-- ---------- 1. USERS ----------
CREATE TABLE users (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       CITEXT      NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 30),
    email          CITEXT      NOT NULL UNIQUE,
    password_hash  TEXT        NOT NULL,                -- argon2/bcrypt, KHÔNG lưu mật khẩu thô
    display_name   VARCHAR(50) NOT NULL,
    avatar_url     TEXT,
    country_code   CHAR(2),
    role           user_role   NOT NULL DEFAULT 'player',
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at  TIMESTAMPTZ
);

-- Thống kê + Elo tách riêng để update thường xuyên mà không khoá bảng users
CREATE TABLE player_stats (
    user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rating       INT NOT NULL DEFAULT 1200,
    games_played INT NOT NULL DEFAULT 0,
    wins         INT NOT NULL DEFAULT 0,
    losses       INT NOT NULL DEFAULT 0,
    draws        INT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_player_stats_rating ON player_stats (rating DESC);  -- bảng xếp hạng

CREATE TABLE auth_sessions (          -- refresh token / phiên đăng nhập
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT   NOT NULL UNIQUE,
    user_agent   TEXT,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);

-- ---------- 2. BẠN BÈ ----------
CREATE TABLE friendships (
    requester_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       friendship_status NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
);
CREATE INDEX idx_friendships_addressee ON friendships (addressee_id);

-- ---------- 3. CẤU HÌNH THỜI GIAN ----------
CREATE TABLE time_controls (
    id                SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name              VARCHAR(30) NOT NULL UNIQUE,      -- 'Blitz 3+2', 'Rapid 10+0'...
    base_seconds      INT NOT NULL CHECK (base_seconds > 0),
    increment_seconds INT NOT NULL DEFAULT 0 CHECK (increment_seconds >= 0)
);

INSERT INTO time_controls (name, base_seconds, increment_seconds) VALUES
    ('Bullet 1+0', 60, 0),
    ('Blitz 3+2', 180, 2),
    ('Blitz 5+0', 300, 0),
    ('Rapid 10+0', 600, 0),
    ('Rapid 15+10', 900, 10);

-- ---------- 4. LỜI THÁCH ĐẤU ----------
CREATE TABLE challenges (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    challenger_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = link mời mở
    time_control_id SMALLINT NOT NULL REFERENCES time_controls(id),
    is_rated        BOOLEAN NOT NULL DEFAULT TRUE,
    preferred_side  piece_side,                                     -- NULL = ngẫu nhiên
    invite_code     VARCHAR(16) UNIQUE,
    status          challenge_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_challenges_opponent ON challenges (opponent_id) WHERE status = 'pending';

-- ---------- 5. VÁN CỜ ----------
CREATE TABLE games (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    red_player_id    BIGINT REFERENCES users(id),     -- NULL nếu chơi với máy/khách
    black_player_id  BIGINT REFERENCES users(id),
    time_control_id  SMALLINT NOT NULL REFERENCES time_controls(id),
    challenge_id     BIGINT REFERENCES challenges(id),
    status           game_status NOT NULL DEFAULT 'waiting',
    result           game_result,
    end_reason       end_reason,
    is_rated         BOOLEAN NOT NULL DEFAULT TRUE,
    initial_fen      TEXT NOT NULL DEFAULT
        'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    current_fen      TEXT NOT NULL DEFAULT
        'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    red_time_left_ms   INT,
    black_time_left_ms INT,
    red_rating_before  INT,
    black_rating_before INT,
    red_rating_after   INT,
    black_rating_after INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    CHECK (red_player_id IS DISTINCT FROM black_player_id),
    CHECK ((status = 'finished') = (result IS NOT NULL))
);
CREATE INDEX idx_games_red    ON games (red_player_id,   created_at DESC);
CREATE INDEX idx_games_black  ON games (black_player_id, created_at DESC);
CREATE INDEX idx_games_active ON games (status) WHERE status IN ('waiting', 'in_progress');

-- ---------- 6. NƯỚC ĐI ----------
CREATE TABLE game_moves (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    game_id       BIGINT   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply           SMALLINT NOT NULL CHECK (ply >= 1),         -- nửa nước thứ n
    side          piece_side NOT NULL,
    from_square   CHAR(2) NOT NULL CHECK (from_square ~ '^[a-i][0-9]$'),  -- ICCS: a0..i9
    to_square     CHAR(2) NOT NULL CHECK (to_square   ~ '^[a-i][0-9]$'),
    piece         CHAR(1) NOT NULL,                           -- K,A,B,N,R,C,P (đỏ hoa, đen thường)
    captured      CHAR(1),
    notation      VARCHAR(12),                                -- vd: 'Pháo 2 bình 5'
    is_check      BOOLEAN NOT NULL DEFAULT FALSE,
    fen_after     TEXT NOT NULL,
    time_spent_ms INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (game_id, ply)
);

-- ---------- 7. SỰ KIỆN TRONG VÁN (cầu hòa, xin đi lại, ngắt kết nối) ----------
CREATE TABLE game_events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    game_id    BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id    BIGINT REFERENCES users(id),
    event_type game_event_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_events_game ON game_events (game_id, created_at);

-- ---------- 8. LỊCH SỬ ELO ----------
CREATE TABLE rating_history (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id    BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    old_rating INT NOT NULL,
    new_rating INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, game_id)
);
CREATE INDEX idx_rating_history_user ON rating_history (user_id, created_at DESC);

-- ---------- 9. CHAT ----------
CREATE TABLE chat_messages (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    game_id    BIGINT REFERENCES games(id) ON DELETE CASCADE,   -- NULL = chat sảnh chung
    sender_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_game ON chat_messages (game_id, created_at);

-- ---------- 10. BÁO CÁO VI PHẠM ----------
CREATE TABLE reports (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     BIGINT REFERENCES games(id) ON DELETE SET NULL,
    reason      VARCHAR(30) NOT NULL,           -- 'cheating', 'abuse', 'stalling'...
    details     TEXT,
    resolved    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- TRIGGER: tự tạo player_stats khi có user mới ----------
CREATE OR REPLACE FUNCTION create_player_stats() RETURNS trigger AS $$
BEGIN
    INSERT INTO player_stats (user_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_create_stats
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION create_player_stats();
