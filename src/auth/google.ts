import axios from 'axios';
import open from 'open';
import { createServer, type Server } from 'http';
import { config } from '../config.js';
import { tokenStore } from './token-store.js';
import { logger } from '../utils/logger.js';
import { AuthenticationError } from '../utils/errors.js';

interface TokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

export class GoogleAuth {
    private escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    private async startLocalServer(): Promise<{ server: Server; code: Promise<string> }> {
        return new Promise((resolve, reject) => {
            let codeResolver: (code: string) => void;
            const codePromise = new Promise<string>((res) => {
                codeResolver = res;
            });

            const server = createServer((req, res) => {
                const url = new URL(req.url || '', `http://${req.headers.host}`);

                if (url.pathname === '/oauth-callback') {
                    const code = url.searchParams.get('code');
                    const error = url.searchParams.get('error');

                    if (error) {
                        const safeError = this.escapeHtml(error);
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end(`<h1>Authentication Failed</h1><p>Error: ${safeError}</p>`);
                        codeResolver('');
                    } else if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication Successful!</h1><p>You can close this window now.</p>');
                        codeResolver(code);
                    } else {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication Failed</h1><p>No authorization code received.</p>');
                        codeResolver('');
                    }
                }
            });

            server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error('Port 51121 is already in use. Please kill the hanging process or wait a moment.'));
                } else {
                    reject(err);
                }
            });

            server.listen(51121, 'localhost', () => {
                logger.debug('Local OAuth server started on http://localhost:51121');
                resolve({ server, code: codePromise });
            });
        });
    }

    private buildAuthUrl(): string {
        const params = new URLSearchParams({
            client_id: config.google.clientId!,
            redirect_uri: config.google.redirectUri,
            response_type: 'code',
            scope: config.google.scopes.join(' '),
            access_type: 'offline',
            prompt: 'consent'
        });

        return `${config.google.authUrl}?${params.toString()}`;
    }

    private async exchangeCodeForToken(code: string): Promise<TokenResponse> {
        try {
            const response = await axios.post<TokenResponse>(
                config.google.tokenUrl,
                {
                    client_id: config.google.clientId!,
                    client_secret: config.google.clientSecret!,
                    code,
                    redirect_uri: config.google.redirectUri,
                    grant_type: 'authorization_code'
                },
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            return response.data;
        } catch (error) {
            logger.error('Failed to exchange code for token:', error);
            throw new AuthenticationError('Failed to complete Google authentication');
        }
    }

    async login(): Promise<void> {
        logger.info('Starting Google (Antigravity) authentication...');

        const { server, code: codePromise } = await this.startLocalServer();
        const authUrl = this.buildAuthUrl();

        logger.info(`\n🔐 Google Authentication Required`);
        logger.info(`🌐 Opening browser: ${authUrl}\n`);

        await open(authUrl);

        logger.info('⏳ Waiting for authorization...');

        const code = await codePromise;
        server.close();

        if (!code) {
            throw new AuthenticationError('Authorization failed or was cancelled');
        }

        const token = await this.exchangeCodeForToken(code);

        // Save token
        await tokenStore.save(config.google.tokenPath, {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: Date.now() + (token.expires_in * 1000),
            scope: token.scope
        });

        logger.info('✅ Google authentication successful!');
    }

    async getValidToken(): Promise<string> {
        const tokenData = await tokenStore.load(config.google.tokenPath);

        if (!tokenData) {
            throw new AuthenticationError('No Google token found. Please run: claude-gateway auth antigravity');
        }

        // Check if token is still valid
        if (tokenStore.isTokenValid(tokenData)) {
            return tokenData.access_token;
        }

        // Refresh token
        logger.info('Refreshing Google token...');

        try {
            const response = await axios.post<TokenResponse>(
                config.google.tokenUrl,
                {
                    client_id: config.google.clientId!,
                    client_secret: config.google.clientSecret!,
                    refresh_token: tokenData.refresh_token,
                    grant_type: 'refresh_token'
                },
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            const newTokenData = {
                access_token: response.data.access_token,
                refresh_token: response.data.refresh_token ?? tokenData.refresh_token,
                expires_at: Date.now() + (response.data.expires_in * 1000),
                scope: response.data.scope
            };

            await tokenStore.save(config.google.tokenPath, newTokenData);

            logger.info('✅ Token refreshed successfully');
            return newTokenData.access_token;
        } catch (error) {
            logger.error('Failed to refresh token:', error);
            await tokenStore.delete(config.google.tokenPath);
            throw new AuthenticationError('Token refresh failed. Please re-authenticate: claude-gateway auth antigravity');
        }
    }
}

export const googleAuth = new GoogleAuth();
