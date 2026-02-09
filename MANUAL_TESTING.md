# ClaudeCode Subscription Gateway (CSG) - Manual Testing Guide

このドキュメントは、CSGの手動テスト手順を記載しています。

## 前提条件

- Node.js 18以上がインストールされていること
- OpenAI Codex または Google Gemini Advanced のサブスクリプションがあること
- 各プロバイダーのOAuth認証情報が設定されていること

## 環境変数の設定

`.env` ファイルを作成し、以下の環境変数を設定します:

```bash
# Server Configuration
JANUS_PORT=4000
JANUS_LOG_LEVEL=info

# Encryption Key (必須: 設定しない場合はエラーで起動しません)
JANUS_ENCRYPTION_KEY=your-secure-encryption-key-here

# OpenAI OAuth Configuration
JANUS_OPENAI_CLIENT_ID=your-openai-client-id

# Google OAuth Configuration
# 注: ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET が設定されている場合はそれがデフォルトで使用されます
JANUS_GOOGLE_CLIENT_ID=your-google-client-id
JANUS_GOOGLE_CLIENT_SECRET=your-google-client-secret
```

## テストシナリオ

### 1. ビルドとインストール

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# ビルドが成功することを確認
ls -la dist/
```

**期待結果**: `dist/` ディレクトリに `.js` ファイルが生成される。

---

### 2. CLI - Status Command (認証前)

```bash
npm run status
```

**期待結果**:
```
Checking authentication status...

❌ OpenAI (Codex):       Not authenticated
❌ Google (Antigravity): Not authenticated

Run "claude-gateway auth <provider>" to authenticate.
```

---

### 3. CLI - OpenAI 認証

```bash
npm run auth:codex
```

**期待結果**:
1. ブラウザが自動的に開き、OpenAI の認証ページが表示される
2. ユーザーコードが表示される
3. ブラウザで認証を完了すると、CLIに成功メッセージが表示される:
   ```
   ✅ OpenAI authentication successful!
   ```
4. `.csg/openai-token.json` ファイルが作成される（暗号化済み）

---

### 4. CLI - Google 認証

```bash
npm run auth:antigravity
```

**期待結果**:
1. ブラウザが自動的に開き、Google の認証ページが表示される
2. ローカルサーバー (http://localhost:8080) でコールバックを受信
3. 認証完了後、CLIに成功メッセージが表示される:
   ```
   ✅ Google authentication successful!
   ```
4. `.csg/google-token.json` ファイルが作成される（暗号化済み）

---

### 5. CLI - Status Command (認証後)

```bash
npm run status
```

**期待結果**:
```
Checking authentication status...

✅ OpenAI (Codex):       Authenticated (Expires: 2026-02-15 10:30:00)
✅ Google (Antigravity): Authenticated (Expires: 2026-02-15 10:35:00)

Run "claude-gateway auth <provider>" to authenticate.
```

---

### 6. サーバー起動

```bash
npm run start
```

**期待結果**:
```
[2026-02-08T05:00:00.000Z] [INFO] 🚀 CSG Gateway running on http://localhost:4000
[2026-02-08T05:00:00.001Z] [INFO] 📝 Anthropic-compatible endpoints:
[2026-02-08T05:00:00.002Z] [INFO]    POST /v1/messages
[2026-02-08T05:00:00.003Z] [INFO]    GET  /v1/models
```

サーバーが起動し、ポート 4000 でリッスンしていることを確認。

---

### 7. Health Check

別のターミナルで:

```bash
curl http://localhost:4000/health
```

**期待結果**:
```json
{"status":"ok","version":"1.0.0"}
```

---

### 8. Models Endpoint

```bash
curl http://localhost:4000/v1/models
```

**期待結果**:
```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-3-5-sonnet-20241022",
      "object": "model",
      "created": 1234567890,
      "owned_by": "anthropic"
    },
    ...
  ]
}
```

---

### 9. Messages Endpoint - OpenAI (非ストリーミング)

```bash
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100,
    "stream": false
  }'
```

**期待結果**:
- Anthropic形式のレスポンスが返される
- `role: "assistant"` のメッセージが含まれる
- `stop_reason` が設定されている
- `usage` にトークン数が含まれる

---

### 10. Messages Endpoint - OpenAI (ストリーミング)

```bash
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "max_tokens": 100,
    "stream": true
  }'
```

**期待結果**:
- SSE形式でイベントがストリーミングされる
- 以下のイベントシーケンスが含まれる:
  1. `event: message_start`
  2. `event: content_block_start`
  3. `event: content_block_delta` (複数回)
  4. `event: content_block_stop`
  5. `event: message_delta`
  6. `event: message_stop`

---

### 11. Messages Endpoint - Google (非ストリーミング)

```bash
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 50,
    "stream": false
  }'
```

**期待結果**:
- Anthropic形式のレスポンスが返される
- Google Gemini APIが内部で使用される（ログで確認）
- 正しい回答が返される

---

### 12. Messages Endpoint - Google (ストリーミング)

```bash
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "messages": [{"role": "user", "content": "List 3 colors"}],
    "max_tokens": 100,
    "stream": true
  }'
```

**期待結果**:
- SSE形式でイベントがストリーミングされる
- Anthropic互換のイベントシーケンスが返される

---

### 13. エラーハンドリング - 無効なモデル

```bash
curl -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 10
  }'
```

**期待結果**:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid value for 'model': must not be empty"
  }
}
```

---

### 14. トークンリフレッシュ

1. トークンの有効期限を手動で過去に設定（`.csg/openai-token.json` を編集）
2. `/v1/messages` エンドポイントにリクエストを送信

**期待結果**:
- ログに "Refreshing OpenAI token..." が表示される
- リクエストが成功する
- 新しいトークンが保存される

---

### 15. ClaudeCode CLI との統合テスト

CSGサーバーを起動した状態で、ClaudeCode CLIを設定:

```bash
# ClaudeCode の設定ファイルを編集
# API endpoint を http://localhost:4000 に設定
```

ClaudeCode CLIでコマンドを実行し、CSGを経由してOpenAI/Googleのモデルが使用されることを確認。

---

## トラブルシューティング

### 認証エラー

- `.csg/` ディレクトリのトークンファイルを削除して再認証
- 環境変数が正しく設定されているか確認

### ポート競合

- `JANUS_PORT` 環境変数で別のポートを指定

### ログレベルの変更

```bash
JANUS_LOG_LEVEL=debug npm run start
```

---

## テスト完了チェックリスト

- [ ] ビルドが成功する
- [ ] OpenAI認証が成功する
- [ ] Google認証が成功する
- [ ] `status` コマンドが正しく動作する
- [ ] サーバーが起動する
- [ ] Health checkが成功する
- [ ] Models エンドポイントが動作する
- [ ] OpenAI (非ストリーミング) が動作する
- [ ] OpenAI (ストリーミング) が動作する
- [ ] Google (非ストリーミング) が動作する
- [ ] Google (ストリーミング) が動作する
- [ ] エラーハンドリングが正しく動作する
- [ ] トークンリフレッシュが動作する
- [ ] ClaudeCode CLI との統合が動作する
