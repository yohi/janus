import { type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import { openaiAuth } from '../auth/openai.js';
import { googleAuth } from '../auth/google.js';
import { openaiTranspiler } from '../transpilers/openai.js';
import { googleTranspiler } from '../transpilers/google.js';

export const handleMessages = async (req: Request, res: Response) => {
    try {
        const { model, messages, stream = true } = req.body;

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

        // Determine which provider to use based on model name
        const isOpenAI = model.startsWith('gpt') || model.includes('codex');
        const isGoogle = model.startsWith('gemini') || model.includes('antigravity');

        if (!isOpenAI && !isGoogle) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: `Unsupported model: ${model}`
                }
            });
        }

        // Set SSE headers for streaming
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
        }

        if (isOpenAI) {
            // Route to OpenAI
            logger.info('Routing to OpenAI...');
            const token = await openaiAuth.getValidToken();
            const openaiReq = openaiTranspiler.convertRequest(req.body);
            const response = await openaiTranspiler.callAPI(openaiReq, token);

            if (stream) {
                // Stream response
                for await (const chunk of openaiTranspiler.convertStreamResponse(response, model)) {
                    res.write(chunk);
                }
                res.end();
            } else {
                // Non-streaming response
                const data = await openaiTranspiler.convertResponse(response, model);
                res.json(data);
            }
        } else if (isGoogle) {
            // Route to Google
            logger.info('Routing to Google...');
            const token = await googleAuth.getValidToken();
            const googleReq = googleTranspiler.convertRequest(req.body);
            const response = await googleTranspiler.callAPI(googleReq, model, token, stream);

            if (stream) {
                // Stream response
                for await (const chunk of googleTranspiler.convertStreamResponse(response, model)) {
                    res.write(chunk);
                }
                res.end();
            } else {
                // Non-streaming response
                const data = await googleTranspiler.convertResponse(response, model);
                res.json(data);
            }
        }

        logger.info('Request completed successfully');
    } catch (error) {
        logger.error('Error in handleMessages:', error);

        const streamVal = req.body?.stream === undefined ? true : req.body?.stream;
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
                    type: 'internal_server_error',
                    message: 'Internal server error occurred during streaming'
                }
            })}\n\n`);
            res.end();
        } else {
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'internal_server_error',
                    message: 'Internal server error'
                }
            });
        }
    }
};
