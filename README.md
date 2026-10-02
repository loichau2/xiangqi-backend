# Xiangqi Backend (Node.js + Express + PostgreSQL)

API xác thực cho web cờ tướng: đăng ký / đăng nhập, Google, Facebook, refresh token xoay vòng.

## Cài đặt

```bash
npm install
createdb xiangqi
psql xiangqi -f sql/000_schema.sql        # schema ở bước trước
psql xiangqi -f sql/001_auth_oauth.sql    # bổ sung bảng oauth_accounts
cp .env.example .env                      # rồi điền giá trị thật
npm run dev
```

Cần Node.js >= 20.

## API

| Method | Đường dẫn | Body | Ghi chú |
|---|---|---|---|
| POST | `/api/auth/register` | `username, email, password, displayName?` | 201 + token |
| POST | `/api/auth/login` | `identifier` (email hoặc username), `password` | |
| POST | `/api/auth/google` | `idToken` | Google ID token (credential) |
| POST | `/api/auth/facebook` | `accessToken` | Facebook user access token |
| POST | `/api/auth/refresh` | `refreshToken` | Cấp cặp token mới, token cũ bị thu hồi |
| POST | `/api/auth/logout` | `refreshToken` | 204 |
| GET | `/api/auth/me` | header `Authorization: Bearer <accessToken>` | Hồ sơ + Elo |

Mọi API đăng nhập trả về:

```json
{ "user": { "id": "1", "username": "...", "email": "...", "displayName": "...", "avatarUrl": null, "role": "player" },
  "accessToken": "<JWT 15 phút>", "refreshToken": "<chuỗi ngẫu nhiên, sống 30 ngày>" }
```

Lỗi có dạng `{ "error": { "code": "EMAIL_TAKEN", "message": "...", "details": {...} } }`.

```bash
curl -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"kiet_co_tuong","email":"a@example.com","password":"matkhau123"}'

curl -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"kiet_co_tuong","password":"matkhau123"}'

curl localhost:3000/api/auth/me -H "Authorization: Bearer <accessToken>"
```

## Cấu hình Google

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** → *Web application*.
2. Thêm domain frontend vào **Authorized JavaScript origins** (vd `http://localhost:5173`).
3. Chép Client ID vào `GOOGLE_CLIENT_ID`.

Frontend (Google Identity Services):

```html
<script src="https://accounts.google.com/gsi/client" async></script>
<div id="g_id_onload" data-client_id="YOUR_CLIENT_ID" data-callback="onGoogle"></div>
<div class="g_id_signin"></div>
<script>
  async function onGoogle(resp) {
    const r = await fetch('http://localhost:3000/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: resp.credential }),
    });
    const data = await r.json(); // { user, accessToken, refreshToken }
  }
</script>
```

## Cấu hình Facebook

1. developers.facebook.com → Create App → thêm sản phẩm **Facebook Login**.
2. Settings → Basic: chép **App ID** và **App Secret** vào `.env`.
3. Facebook Login → Settings: thêm domain vào *Valid OAuth Redirect URIs / Allowed Domains*. Bản chạy thật cần HTTPS và app ở chế độ *Live*.

Frontend (Facebook JS SDK):

```js
FB.login(async (res) => {
  if (!res.authResponse) return;
  const r = await fetch('http://localhost:3000/api/auth/facebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: res.authResponse.accessToken }),
  });
  const data = await r.json();
}, { scope: 'public_profile,email' });
```

## Cách hoạt động của đăng nhập mạng xã hội

Frontend lấy token từ Google/Facebook, gửi lên backend; backend **tự xác minh token với nhà cung cấp** rồi mới tạo phiên. Cách này không cần redirect/session phía server, nên dùng chung được cho web lẫn app Unity/mobile.

Với mỗi lần đăng nhập, backend:
1. Nếu `(provider, provider_user_id)` đã có trong `oauth_accounts` → đăng nhập.
2. Nếu email đã xác minh trùng một tài khoản có sẵn → liên kết vào tài khoản đó.
3. Ngược lại → tạo user mới (`password_hash = NULL`, username tự sinh dạng `ten_a1b2c3`, kèm dòng `player_stats` nhờ trigger).

## Bảo mật đã có sẵn

- Mật khẩu băm bcrypt (cost 12), giới hạn 72 ký tự (giới hạn của bcrypt).
- Refresh token chỉ lưu dạng băm SHA-256 trong `auth_sessions`, mỗi lần refresh sẽ xoay vòng; dùng lại token cũ sẽ thu hồi mọi phiên của user đó.
- Đăng nhập sai không tiết lộ tài khoản có tồn tại hay không.
- `helmet`, CORS theo danh sách origin, giới hạn tần suất 30 request / 15 phút / IP trên các API đăng nhập, body tối đa 10KB.
- Nếu tài khoản email/mật khẩu chưa xác minh email mà sau đó có người đăng nhập Google cùng email, mật khẩu cũ bị xóa (chống chiếm trước tài khoản).

## Việc nên làm tiếp

- Xác minh email và quên mật khẩu (hiện `email_verified` chỉ bật khi đăng nhập qua Google/Facebook).
- Dọn phiên hết hạn định kỳ: `DELETE FROM auth_sessions WHERE expires_at < now() - interval '7 days';`
- Dùng lại `verifyAccessToken` để xác thực kết nối WebSocket khi làm phần chơi cờ thời gian thực.
- Production: đặt `TRUST_PROXY` đúng, chạy sau HTTPS, đổi `JWT_ACCESS_SECRET`.
