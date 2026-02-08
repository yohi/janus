import { type Request, type Response } from 'express';
import { logger } from '../../utils/logger.js';
import { type ProviderAdapter } from './adapter.interface.js';

export class AnthropicAdapter implements ProviderAdapter {
    supports(_model: string): boolean {
        return true;
    }

    async handle(req: Request, res: Response): Promise<void> {
        const { stream = true } = req.body;
        logger.info('Routing to Anthropic (Pass-through)...');

        const apiKey = req.headers['x-api-key'];
        const anthropicVersion = req.headers['anthropic-version'];

        if (!apiKey) {
            res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Missing x-api-key header'
                }
            });
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

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
                    res.status(response.status).json(errorJson);
                } catch {
                    res.status(response.status).send(errorText);
                }
                return;
            }

            if (stream) {
                if (!response.body) {
                    throw new Error('No response body from Anthropic');
                }

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                res.on('close', async () => {
                    logger.info('Client disconnected, aborting upstream Anthropic request');
                    controller.abort();
                    try {
                        await reader.cancel();
                    } catch (e) {
                    }
                });

                try {
                    while (true) {
                        if (res.destroyed || res.writableEnded) {
                            break;
                        }

                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        
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
                    }
                }
            } else {
                const data = await response.json();
                res.json(data);
            }

            logger.info('Request completed successfully');
        } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                logger.error('Anthropic API request timed out');
                res.status(504).json({
                    type: 'error',
                    error: {
                        type: 'timeout_error',
                        message: 'Upstream request timed out'
                    }
                });
                return;
            }
            logger.error('Error forwarding to Anthropic:', error);
            throw error;
        }
    }
}
