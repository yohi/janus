#!/usr/bin/env node
import { Command } from 'commander';
import { startServer } from './index.js';
import { openaiAuth } from './auth/openai.js';
import { googleAuth } from './auth/google.js';
import { logger } from './utils/logger.js';
import { tokenStore } from './auth/token-store.js';
import { config, validateProviderConfig } from './config.js';

const program = new Command();

program
    .name('claude-gateway')
    .description('Local proxy gateway for ClaudeCode CLI')
    .version('1.0.0');

program
    .command('start')
    .description('Start the gateway server')
    .action(() => {
        startServer();
    });

const authCommand = program.command('auth')
    .description('Authenticate with providers');

authCommand
    .command('codex')
    .description('Authenticate with OpenAI (Codex)')
    .action(async () => {
        try {
            validateProviderConfig('openai');
            await openaiAuth.login();
            process.exit(0);
        } catch (error) {
            logger.error('Authentication failed:', error instanceof Error ? error.message : error);
            process.exit(1);
        }
    });

authCommand
    .command('antigravity')
    .description('Authenticate with Google (Antigravity)')
    .action(async () => {
        try {
            validateProviderConfig('google');
            await googleAuth.login();
            process.exit(0);
        } catch (error) {
            logger.error('Authentication failed:', error instanceof Error ? error.message : error);
            process.exit(1);
        }
    });

program
    .command('status')
    .description('Check authentication status')
    .action(async () => {
        console.log('Checking authentication status...\n');

        try {
            const openaiToken = await tokenStore.load(config.openai.tokenPath);
            if (openaiToken && tokenStore.isTokenValid(openaiToken)) {
                const expiry = openaiToken.expires_at ? new Date(openaiToken.expires_at).toLocaleString() : 'Never';
                console.log(`✅ OpenAI (Codex):       Authenticated (Expires: ${expiry})`);
            } else {
                console.log('❌ OpenAI (Codex):       Not authenticated');
            }
        } catch (e) {
            console.log('❌ OpenAI (Codex):       Error checking status');
        }

        try {
            const googleToken = await tokenStore.load(config.google.tokenPath);
            if (googleToken && tokenStore.isTokenValid(googleToken)) {
                const expiry = googleToken.expires_at ? new Date(googleToken.expires_at).toLocaleString() : 'Never';
                console.log(`✅ Google (Antigravity): Authenticated (Expires: ${expiry})`);
            } else {
                console.log('❌ Google (Antigravity): Not authenticated');
            }
        } catch (e) {
            console.log('❌ Google (Antigravity): Error checking status');
        }

        console.log('\nRun "claude-gateway auth <provider>" to authenticate.');
        process.exit(0);
    });

program.parse();
