import open from 'open';
import { createServer, type Server } from 'http';
import { parse as parseUrl } from 'url';
import crypto from 'crypto';
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

export class OpenAIAuth {
    private generatePKCE(): { codeVerifier: string; codeChallenge: string } {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto
            .createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        return { codeVerifier, codeChallenge };
    }

    private async startLocalServer(): Promise<{ server: Server; code: Promise<string> }> {
        return new Promise((resolve) => {
            let codeResolver: (code: string) => void;
            const codePromise = new Promise<string>((res) => {
                codeResolver = res;
            });

            const server = createServer((req, res) => {
                const url = parseUrl(req.url || '', true);

                if (url.pathname === '/auth/callback') {
                    const code = url.query.code as string;
                    const error = url.query.error as string;

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end(`<h1>Authentication Failed</h1><p>Error: ${error}</p>`);
                        codeResolver('');
                    } else if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication Successful!</h1><p>You can close this window now.</p>');
                        codeResolver(code);
                    }
                }
            });

            server.listen(1455, 'localhost', () => {
                logger.debug('Local OAuth server started on http://localhost:1455');
                resolve({ server, code: codePromise });
            });
        });
    }


    async login(): Promise<void> {
        logger.info('Starting OpenAI (Codex) authentication...');

        const { codeVerifier, codeChallenge } = this.generatePKCE();
        const { server, code: codePromise } = await this.startLocalServer();

        const clientId = config.openai.clientId;
        const redirectUri = 'http://localhost:1455/auth/callback';

        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            scope: config.openai.scopes.join(' '),
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: redirectUri,
            state: crypto.randomBytes(16).toString('hex'),
            id_token_add_organizations: 'true',
            codex_cli_simplified_flow: 'true',
            originator: 'codex_cli_rs'
        });

        const authUrl = `${config.openai.authUrl}?${params.toString()}`;

        logger.info(`\n🔐 OpenAI Authentication Required`);
        logger.info(`🌐 Opening browser: ${authUrl}\n`);

        await open(authUrl);

        logger.info('⏳ Waiting for authorization...');

        const code = await codePromise;
        server.close();

        if (!code) {
            throw new AuthenticationError('Authorization failed or was cancelled');
        }

        logger.info('Exchanging code for token...');

        const tokenBody = new URLSearchParams({
            client_id: config.openai.clientId,
            grant_type: 'authorization_code',
            code: code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
        });

        const response = await fetch(config.openai.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            body: tokenBody
        });

        if (!response.ok) {
            const text = await response.text();
            logger.error(`Token exchange error (${response.status}): ${text}`);
            throw new AuthenticationError('Failed to exchange code for token');
        }

        const token = await response.json() as TokenResponse;

        // Save token
        await tokenStore.save(config.openai.tokenPath, {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: Date.now() + (token.expires_in * 1000),
            scope: token.scope
        });

        logger.info('✅ OpenAI authentication successful!');
    }

    async getValidToken(): Promise<string> {
        const tokenData = await tokenStore.load(config.openai.tokenPath);

        if (!tokenData) {
            throw new AuthenticationError('No OpenAI token found. Please run: claude-gateway auth codex');
        }

        // Check if token is still valid
        if (tokenStore.isTokenValid(tokenData)) {
            return tokenData.access_token;
        }

        // Refresh token
        logger.info('Refreshing OpenAI token...');

        try {
            const body = new URLSearchParams({
                client_id: config.openai.clientId,
                refresh_token: tokenData.refresh_token || '',
                grant_type: 'refresh_token'
            });

            const response = await fetch(config.openai.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                },
                body: body
            });

            if (!response.ok) {
                const text = await response.text();
                logger.error(`Token refresh error (${response.status}): ${text}`);
                throw new Error(`Request failed with status ${response.status}`);
            }

            const data = await response.json() as TokenResponse;

            const newTokenData = {
                access_token: data.access_token,
                refresh_token: data.refresh_token ?? tokenData.refresh_token,
                expires_at: Date.now() + (data.expires_in * 1000),
                scope: data.scope
            };

            await tokenStore.save(config.openai.tokenPath, newTokenData);

            logger.info('✅ Token refreshed successfully');
            return newTokenData.access_token;
        } catch (error) {
            logger.error('Failed to refresh token:', error);
            await tokenStore.delete(config.openai.tokenPath);
            throw new AuthenticationError('Token refresh failed. Please re-authenticate: claude-gateway auth codex');
        }
    }
}

export const openaiAuth = new OpenAIAuth();
