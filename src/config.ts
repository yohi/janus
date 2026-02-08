import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';

export const config = {
  // Server configuration
  port: parseInt(process.env.CSG_PORT || '4000', 10),
  host: 'localhost', // Security: bind to localhost only
  
  // OpenAI (Codex) configuration
  openai: {
    clientId: process.env.CSG_OPENAI_CLIENT_ID || '',
    authUrl: 'https://auth0.openai.com/oauth/device/code',
    tokenUrl: 'https://auth0.openai.com/oauth/token',
    apiUrl: 'https://api.openai.com/v1',
    tokenPath: join(homedir(), '.csg', 'openai-token.json'),
    scopes: ['openid', 'profile', 'email', 'offline_access', 'model.request']
  },
  
  // Google (Antigravity) configuration
  google: {
    clientId: process.env.CSG_GOOGLE_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: process.env.CSG_GOOGLE_CLIENT_SECRET || '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',
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
