import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenStore } from '../../auth/token-store.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TokenStore', () => {
    let tokenStore: TokenStore;
    let testDir: string;
    let testTokenPath: string;

    beforeEach(async () => {
        // Create a temporary directory for test tokens
        testDir = join(tmpdir(), `csg-test-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        testTokenPath = join(testDir, 'test-token.json');

        // Use a test encryption key
        tokenStore = new TokenStore('test-encryption-key-for-testing');
    });

    afterEach(async () => {
        // Clean up test directory
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch (e) {
            // Ignore cleanup errors
        }
    });

    describe('save and load', () => {
        it('should save and load token data', async () => {
            const tokenData = {
                access_token: 'test-access-token',
                refresh_token: 'test-refresh-token',
                expires_at: Date.now() + 3600000,
                scope: 'test-scope'
            };

            await tokenStore.save(testTokenPath, tokenData);
            const loaded = await tokenStore.load(testTokenPath);

            expect(loaded).not.toBeNull();
            expect(loaded?.access_token).toBe(tokenData.access_token);
            expect(loaded?.refresh_token).toBe(tokenData.refresh_token);
            expect(loaded?.expires_at).toBe(tokenData.expires_at);
            expect(loaded?.scope).toBe(tokenData.scope);
        });

        it('should return null for non-existent token file', async () => {
            const loaded = await tokenStore.load(join(testDir, 'non-existent.json'));
            expect(loaded).toBeNull();
        });

        it('should encrypt token data', async () => {
            const tokenData = {
                access_token: 'secret-token',
                refresh_token: 'secret-refresh'
            };

            await tokenStore.save(testTokenPath, tokenData);

            // Read raw file content
            const rawContent = await fs.readFile(testTokenPath, 'utf8');

            // Encrypted content should not contain the plain text token
            expect(rawContent).not.toContain('secret-token');
            expect(rawContent).not.toContain('secret-refresh');
        });

        it('should handle optional fields', async () => {
            const tokenData = {
                access_token: 'test-token'
                // No refresh_token, expires_at, or scope
            };

            await tokenStore.save(testTokenPath, tokenData);
            const loaded = await tokenStore.load(testTokenPath);

            expect(loaded).not.toBeNull();
            expect(loaded?.access_token).toBe('test-token');
            expect(loaded?.refresh_token).toBeUndefined();
            expect(loaded?.expires_at).toBeUndefined();
        });
    });

    describe('delete', () => {
        it('should delete token file', async () => {
            const tokenData = {
                access_token: 'test-token'
            };

            await tokenStore.save(testTokenPath, tokenData);

            // Verify file exists
            let exists = true;
            try {
                await fs.access(testTokenPath);
            } catch {
                exists = false;
            }
            expect(exists).toBe(true);

            // Delete
            await tokenStore.delete(testTokenPath);

            // Verify file is deleted
            exists = true;
            try {
                await fs.access(testTokenPath);
            } catch {
                exists = false;
            }
            expect(exists).toBe(false);
        });

        it('should not throw when deleting non-existent file', async () => {
            await expect(
                tokenStore.delete(join(testDir, 'non-existent.json'))
            ).resolves.not.toThrow();
        });
    });

    describe('isTokenValid', () => {
        it('should return true for valid token', () => {
            const tokenData = {
                access_token: 'test',
                expires_at: Date.now() + 3600000 // 1 hour from now
            };

            expect(tokenStore.isTokenValid(tokenData)).toBe(true);
        });

        it('should return false for expired token', () => {
            const tokenData = {
                access_token: 'test',
                expires_at: Date.now() - 3600000 // 1 hour ago
            };

            expect(tokenStore.isTokenValid(tokenData)).toBe(false);
        });

        it('should return false for token expiring within buffer time', () => {
            const tokenData = {
                access_token: 'test',
                expires_at: Date.now() + 60000 // 1 minute from now (less than 5 min buffer)
            };

            expect(tokenStore.isTokenValid(tokenData)).toBe(false);
        });

        it('should return true for token without expiration', () => {
            const tokenData = {
                access_token: 'test'
                // No expires_at
            };

            expect(tokenStore.isTokenValid(tokenData)).toBe(true);
        });
    });
});
