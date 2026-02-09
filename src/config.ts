import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';

const googleClientId = process.env.JANUS_GOOGLE_CLIENT_ID || process.env.ANTIGRAVITY_CLIENT_ID;
const googleClientSecret = process.env.JANUS_GOOGLE_CLIENT_SECRET || process.env.ANTIGRAVITY_CLIENT_SECRET;
const openaiClientId = process.env.JANUS_OPENAI_CLIENT_ID;

export const config = {
  // Server configuration
  port: parseInt(process.env.JANUS_PORT || '4000', 10),
  host: process.env.JANUS_HOST || '127.0.0.1', // Default to localhost for security, allow override

  // OpenAI (Codex) configuration
  openai: {
    clientId: openaiClientId,
    authUrl: 'https://auth0.openai.com/authorize',
    tokenUrl: 'https://auth0.openai.com/oauth/token',
    apiUrl: 'https://api.openai.com/v1',
    tokenPath: join(homedir(), '.csg', 'openai-token.json'),
    scopes: ['openid', 'profile', 'email', 'offline_access', 'model.request'],
    redirectUri: 'http://localhost:1455/auth/callback'
  },

  // Google (Antigravity) configuration
  google: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiUrl: 'https://cloudcode-pa.googleapis.com',
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
  logLevel: process.env.JANUS_LOG_LEVEL || 'info'
};

export function validateProviderConfig(provider: 'openai' | 'google') {
  if (provider === 'openai') {
    if (!config.openai.clientId) {
      throw new Error('必須の環境変数 JANUS_OPENAI_CLIENT_ID が設定されていません。');
    }
  } else if (provider === 'google') {
    if (!config.google.clientId || !config.google.clientSecret) {
      throw new Error('必須の環境変数 JANUS_GOOGLE_CLIENT_ID または JANUS_GOOGLE_CLIENT_SECRET (もしくは互換性のある ANTIGRAVITY_*) が設定されていません。');
    }
  }
}

