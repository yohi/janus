import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';

// 環境変数の必須チェック
const requiredEnvVars = {
  CSG_GOOGLE_CLIENT_ID: process.env.CSG_GOOGLE_CLIENT_ID,
  CSG_GOOGLE_CLIENT_SECRET: process.env.CSG_GOOGLE_CLIENT_SECRET
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value || value.trim() === '') {
    throw new Error(
      `必須の環境変数 ${key} が設定されていません。` +
      `環境変数を設定してから再度起動してください。`
    );
  }
}

export const config = {
  // Server configuration
  port: parseInt(process.env.CSG_PORT || '4000', 10),
  host: 'localhost', // Security: bind to localhost only
  
  // OpenAI (Codex) configuration
  openai: {
    clientId: process.env.CSG_OPENAI_CLIENT_ID || '',
    authUrl: 'https://auth0.openai.com/authorize',
    tokenUrl: 'https://auth0.openai.com/oauth/token',
    apiUrl: 'https://api.openai.com/v1',
    tokenPath: join(homedir(), '.csg', 'openai-token.json'),
    scopes: ['openid', 'profile', 'email', 'offline_access', 'model.request']
  },
  
  // Google (Antigravity) configuration
  google: {
    clientId: requiredEnvVars.CSG_GOOGLE_CLIENT_ID!,
    clientSecret: requiredEnvVars.CSG_GOOGLE_CLIENT_SECRET!,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
    tokenPath: join(homedir(), '.csg', 'google-token.json'),
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs'
    ],
    redirectUri: 'http://localhost:51121/oauth-callback'
  },
  
  // Logging
  logLevel: process.env.CSG_LOG_LEVEL || 'info'
};
