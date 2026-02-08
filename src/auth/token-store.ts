import { promises as fs } from 'fs';
import { dirname } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { logger } from '../utils/logger.js';

interface TokenData {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
}

export class TokenStore {
    private encryptionKey: Buffer;

    constructor(password: string | undefined = process.env.CSG_ENCRYPTION_KEY) {
        if (!password || password === 'default-key-change-me') {
            throw new Error('Fatal: Secure encryption key not configured.');
        }
        // Derive a 32-byte key from password
        const salt = process.env.CSG_SALT;
        if (!salt || salt === 'default-salt') {
            throw new Error('Fatal: Secure salt not configured. Set CSG_SALT environment variable.');
        }
        this.encryptionKey = scryptSync(password, salt, 32);
    }

    private encrypt(data: string): string {
        const iv = randomBytes(16);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);

        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag();

        // Format: iv:authTag:encrypted
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    }

    private decrypt(encryptedData: string): string {
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }

        const [ivHex, authTagHex, encrypted] = parts as [string, string, string];

        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);

        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }

    async save(path: string, tokenData: TokenData): Promise<void> {
        try {
            // Ensure directory exists
            await fs.mkdir(dirname(path), { recursive: true });

            const jsonData = JSON.stringify(tokenData);
            const encrypted = this.encrypt(jsonData);

            await fs.writeFile(path, encrypted, 'utf8');
            logger.info(`Token saved to ${path}`);
        } catch (error) {
            logger.error(`Failed to save token to ${path}:`, error);
            throw error;
        }
    }

    async load(path: string): Promise<TokenData | null> {
        try {
            const encrypted = await fs.readFile(path, 'utf8');
            const decrypted = this.decrypt(encrypted);
            const tokenData = JSON.parse(decrypted) as TokenData;

            logger.debug(`Token loaded from ${path}`);
            return tokenData;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                logger.debug(`No token file found at ${path}`);
                return null;
            }
            logger.error(`Failed to load token from ${path}:`, error);
            throw error;
        }
    }

    async delete(path: string): Promise<void> {
        try {
            await fs.unlink(path);
            logger.info(`Token deleted from ${path}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.error(`Failed to delete token from ${path}:`, error);
            }
        }
    }

    isTokenValid(tokenData: TokenData): boolean {
        if (!tokenData.expires_at) {
            return true; // No expiration info, assume valid
        }

        // Add 5 minute buffer
        const bufferMs = 5 * 60 * 1000;
        return Date.now() < (tokenData.expires_at - bufferMs);
    }
}

let singleton: TokenStore | null = null;

export const getTokenStore = (): TokenStore => {
    if (!singleton) {
        singleton = new TokenStore();
    }
    return singleton;
};

export const tokenStore = new Proxy({} as TokenStore, {
    get: (_, prop) => {
        const store = getTokenStore();
        const value = (store as any)[prop];
        if (typeof value === 'function') {
            return value.bind(store);
        }
        return value;
    }
});
