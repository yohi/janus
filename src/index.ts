import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { CSGError } from './utils/errors.js';
import { handleMessages } from './routes/messages.js';
import { handleModels } from './routes/models.js';
import { handleUserMe, handleOrganizations, handlePlans } from './routes/mock-auth.js';

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' })); // Large file context support

// CORS for localhost only
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Routes - Anthropic API compatible endpoints
app.post('/v1/messages', handleMessages);
app.get('/v1/models', handleModels);

// Mock Auth & Organization Endpoints for ClaudeCode CLI
app.get('/v1/users/me', handleUserMe);
app.get('/v1/organizations', handleOrganizations);
app.get('/v1/plans', handlePlans);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof CSGError) {
        logger.error(`${err.code}: ${err.message}`);
        res.status(err.statusCode).json({
            type: 'error',
            error: {
                type: err.code,
                message: err.message
            }
        });
    } else {
        logger.error('Unhandled error:', err);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'internal_error',
                message: 'An unexpected error occurred'
            }
        });
    }
});

// Start server
export const startServer = () => {
    return app.listen(config.port, config.host, () => {
        logger.info(`🚀 CSG Gateway running on http://${config.host}:${config.port}`);
        logger.info(`📝 Anthropic-compatible endpoints:`);
        logger.info(`   POST /v1/messages`);
        logger.info(`   GET  /v1/models`);
    });
};

// Always start server when running this file directly or via tsx
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1]?.endsWith('index.ts') ||
    process.argv.some(arg => arg.includes('tsx') || arg.includes('ts-node'));

if (true) { // Validating if this works by forcing start
    // Keep process alive for debugging
    setInterval(() => { }, 10000);

    const server = startServer();

    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM signal received: closing HTTP server');
        server.close(() => {
            logger.info('HTTP server closed');
        });
    });

    process.on('uncaughtException', (err) => {
        logger.error('Uncaught Exception:', err);
    });

    process.on('exit', (code) => {
        logger.info(`Process exiting with code: ${code}`);
    });
}

export default app;
