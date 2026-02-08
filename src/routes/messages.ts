import { type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import { openaiAuth } from '../auth/openai.js';
import { googleAuth } from '../auth/google.js';
import { openaiTranspiler } from '../transpilers/openai.js';
import { googleTranspiler } from '../transpilers/google.js';

export const handleMessages = async (req: Request, res: Response) => {
    try {
        const { model, messages, stream = true } = req.body;

        logger.info(`Incoming request for model: ${model}`);

        // Determine which provider to use based on model name
        const isOpenAI = model.startsWith('gpt') || model.includes('codex') || model.startsWith('claude');
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
                for await (const chunk of openaiTranspiler.convertStreamResponse(response)) {
                    res.write(chunk);
                }
                res.end();
            } else {
                // Non-streaming response
                const data = await response.json();
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
                for await (const chunk of googleTranspiler.convertStreamResponse(response)) {
                    res.write(chunk);
                }
                res.end();
            } else {
                // Non-streaming response
                const data = await response.json();
                res.json(data);
            }
        }

        logger.info('Request completed successfully');
    } catch (error) {
        logger.error('Error in handleMessages:', error);
        throw error;
    }
};
