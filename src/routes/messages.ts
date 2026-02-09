import { type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import { ProviderFactory } from '../services/provider-factory.js';

export const handleMessages = async (req: Request, res: Response) => {
    try {
        const { model } = req.body;

        // Validation for model
        if (typeof model !== 'string' || model.trim().length === 0) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: typeof model !== 'string' ? "Invalid type for 'model': expected string" : "Invalid value for 'model': must not be empty"
                }
            });
        }

        logger.info(`Incoming request for model: ${model}`);

        // Get appropriate adapter and handle the request
        const adapter = ProviderFactory.getAdapter(model);
        await adapter.handle(req, res);

        logger.info('Request completed successfully');
    } catch (error) {
        logger.error('Error in handleMessages:', error);

        const streamVal = req.body?.stream === undefined ? true : req.body?.stream;
        if (res.writableEnded || res.destroyed) {
            return;
        }

        const statusCode = (error as any).status || (error as any).statusCode || 500;
        const message = error instanceof Error ? error.message : 'Internal server error';

        if (streamVal || res.headersSent) {
            // Error during streaming or streaming intended
            if (!res.headersSent) {
                // If headers not yet sent but we intended to stream, send headers now to support events
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
            }
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: {
                    type: statusCode === 401 ? 'authentication_error' : 'internal_server_error',
                    message: message
                }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: {
                    type: statusCode === 401 ? 'authentication_error' : 'internal_server_error',
                    message: message
                }
            });
        }
    }
};
