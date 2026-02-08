import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ProviderError, TranspilerError } from '../utils/errors.js';

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string;[key: string]: any }>;
}

interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    system?: string;
}

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
}

export class OpenAITranspiler {
    /**
     * Convert Anthropic request to OpenAI format
     */
    convertRequest(anthropicReq: AnthropicRequest): OpenAIRequest {
        try {
            const messages: OpenAIMessage[] = [];

            // Add system message if present
            if (anthropicReq.system) {
                messages.push({
                    role: 'system',
                    content: anthropicReq.system
                });
            }

            // Convert messages
            for (const msg of anthropicReq.messages) {
                let content: string;

                if (typeof msg.content === 'string') {
                    content = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // Extract text from content blocks
                    content = msg.content
                        .filter(block => block.type === 'text' && block.text)
                        .map(block => block.text)
                        .join('\n');
                } else {
                    throw new TranspilerError('Unsupported message content format');
                }

                messages.push({
                    role: msg.role,
                    content
                });
            }

            // Map model name
            const modelMap: Record<string, string> = {
                'claude-3-5-sonnet-20241022': 'gpt-4o',
                'claude-3-opus-20240229': 'gpt-4o',
                'claude-3-sonnet-20240229': 'gpt-4o',
                'claude-3-haiku-20240307': 'gpt-4o-mini'
            };

            const openaiModel = modelMap[anthropicReq.model] || 'gpt-4o';

            const openaiReq: OpenAIRequest = {
                model: openaiModel,
                messages,
                stream: anthropicReq.stream ?? true
            };

            // Add optional parameters only if defined
            if (anthropicReq.max_tokens) {
                openaiReq.max_tokens = anthropicReq.max_tokens;
            }
            if (anthropicReq.temperature !== undefined) {
                openaiReq.temperature = anthropicReq.temperature;
            }
            if (anthropicReq.top_p !== undefined) {
                openaiReq.top_p = anthropicReq.top_p;
            }

            return openaiReq;
        } catch (error) {
            logger.error('Failed to convert Anthropic request to OpenAI:', error);
            throw new TranspilerError('Request conversion failed');
        }
    }

    /**
     * Call OpenAI API
     */
    async callAPI(openaiReq: OpenAIRequest, token: string): Promise<Response> {
        try {
            const response = await fetch(`${config.openai.apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(openaiReq)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`OpenAI API error: ${response.status} - ${errorText}`);
                throw new ProviderError(
                    `OpenAI API request failed: ${response.statusText}`,
                    'openai',
                    response.status
                );
            }

            return response;
        } catch (error) {
            if (error instanceof ProviderError) {
                throw error;
            }
            logger.error('OpenAI API call failed:', error);
            throw new ProviderError('Failed to communicate with OpenAI', 'openai');
        }
    }

    /**
     * Convert OpenAI SSE stream to Anthropic format
     */
    async *convertStreamResponse(response: Response): AsyncGenerator<string> {
        if (!response.body) {
            throw new ProviderError('No response body from OpenAI', 'openai');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim() || line.startsWith(':')) continue;
                    if (line === 'data: [DONE]') continue;

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                // Convert to Anthropic format
                                const anthropicChunk = {
                                    type: 'content_block_delta',
                                    index: 0,
                                    delta: {
                                        type: 'text_delta',
                                        text: delta.content
                                    }
                                };

                                yield `event: content_block_delta\ndata: ${JSON.stringify(anthropicChunk)}\n\n`;
                            }

                            // Send message_stop event when done
                            if (parsed.choices?.[0]?.finish_reason) {
                                yield `event: message_stop\ndata: {}\n\n`;
                            }
                        } catch (parseError) {
                            logger.warn('Failed to parse OpenAI SSE chunk:', parseError);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}

export const openaiTranspiler = new OpenAITranspiler();
