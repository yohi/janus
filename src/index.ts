import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { CSGError } from './utils/errors.js';
import { handleMessages } from './routes/messages.js';
import { handleModels } from './routes/models.js';

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' })); // Large file context support

// CORS for localhost only
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Routes - Anthropic API compatible endpoints
app.post('/v1/messages', handleMessages);
app.get('/v1/models', handleModels);

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

// Run server only if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startServer();
}

export default app;
