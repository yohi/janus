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
        const isOpenAI = /^(gpt|o[1-9]|chatgpt)-/.test(model) || model.includes('codex');
        const isGoogle = model.startsWith('gemini') || model.includes('antigravity');

        // If not OpenAI or Google, we assume it's a native Anthropic request and pass it through
        if (!isOpenAI && !isGoogle) {
            logger.info('Routing to Anthropic (Pass-through)...');

            const apiKey = req.headers['x-api-key'];
            const anthropicVersion = req.headers['anthropic-version'];

            if (!apiKey) {
                return res.status(401).json({
                    type: 'error',
                    error: {
                        type: 'authentication_error',
                        message: 'Missing x-api-key header'
                    }
                });
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            try {
                const forwardBody = { ...req.body, stream };
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey as string,
                        'anthropic-version': (anthropicVersion as string) || '2023-06-01'
                    },
                    body: JSON.stringify(forwardBody),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`Anthropic API error: ${response.status} - ${errorText}`);
                    try {
                        const errorJson = JSON.parse(errorText);
                        return res.status(response.status).json(errorJson);
                    } catch {
                        return res.status(response.status).send(errorText);
                    }
                }

                if (stream) {
                    if (!response.body) {
                        throw new Error('No response body from Anthropic');
                    }

                    // Set headers before starting stream
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.flushHeaders();

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();

                    // Handle client disconnect
                    res.on('close', async () => {
                        logger.info('Client disconnected, aborting upstream Anthropic request');
                        controller.abort();
                        try {
                            await reader.cancel();
                        } catch (e) {
                            // Ignore cancel errors
                        }
                    });

                    try {
                        while (true) {
                            // Check if client is still connected
                            if (res.destroyed || res.writableEnded) {
                                break;
                            }

                            const { done, value } = await reader.read();
                            if (done) {
                                break;
                            }
                            
                            // Check again before writing
                            if (res.destroyed || res.writableEnded) {
                                break;
                            }

                            const chunk = decoder.decode(value, { stream: true });
                            res.write(chunk);
                        }
                    } catch (error) {
                        if (error instanceof Error && error.name === 'AbortError') {
                            logger.info('Stream aborted by client');
                        } else {
                            logger.error('Error during Anthropic streaming:', error);
                            // If we haven't ended the response yet, try to end it with an error event
                            if (!res.writableEnded && !res.destroyed) {
                                res.write(`event: error\ndata: ${JSON.stringify({
                                    type: 'error',
                                    error: {
                                        type: 'api_error',
                                        message: 'Stream interrupted'
                                    }
                                })}\n\n`);
                            }
                        }
                    } finally {
                        if (!res.writableEnded && !res.destroyed) {
                            res.end();
                        }
                        try {
                            reader.releaseLock();
                        } catch (e) {
                            // Ignore lock release errors
                        }
                        // Ensure controller is aborted to cleanup
                        controller.abort();
                    }
                } else {
                    const data = await response.json();
                    res.json(data);
                }

                logger.info('Request completed successfully');
                return;
            } catch (error) {
                clearTimeout(timeoutId);
                if (error instanceof Error && error.name === 'AbortError') {
                    logger.error('Anthropic API request timed out');
                    return res.status(504).json({
                        type: 'error',
                        error: {
                            type: 'timeout_error',
                            message: 'Upstream request timed out'
                        }
                    });
                }
                logger.error('Error forwarding to Anthropic:', error);
                throw error; // Let the main error handler catch it
            }
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
