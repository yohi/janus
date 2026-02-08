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

interface GoogleContent {
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
}

interface GoogleRequest {
    contents: GoogleContent[];
    generationConfig?: {
        maxOutputTokens?: number;
        temperature?: number;
        topP?: number;
    };
    systemInstruction?: {
        parts: Array<{ text: string }>;
    };
}

export class GoogleTranspiler {
    /**
     * Convert Anthropic request to Google Gemini format
     */
    convertRequest(anthropicReq: AnthropicRequest): GoogleRequest {
        try {
            const contents: GoogleContent[] = [];

            // Convert messages
            for (const msg of anthropicReq.messages) {
                let text: string;

                if (typeof msg.content === 'string') {
                    text = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // Extract text from content blocks
                    text = msg.content
                        .filter(block => block.type === 'text' && block.text)
                        .map(block => block.text)
                        .join('\n');
                } else {
                    throw new TranspilerError('Unsupported message content format');
                }

                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text }]
                });
            }

            const googleReq: GoogleRequest = {
                contents
            };

            // Add generation config if any parameters are defined
            if (anthropicReq.max_tokens || anthropicReq.temperature !== undefined || anthropicReq.top_p !== undefined) {
                googleReq.generationConfig = {};

                if (anthropicReq.max_tokens) {
                    googleReq.generationConfig.maxOutputTokens = anthropicReq.max_tokens;
                }
                if (anthropicReq.temperature !== undefined) {
                    googleReq.generationConfig.temperature = anthropicReq.temperature;
                }
                if (anthropicReq.top_p !== undefined) {
                    googleReq.generationConfig.topP = anthropicReq.top_p;
                }
            }

            // Add system instruction if present
            if (anthropicReq.system) {
                googleReq.systemInstruction = {
                    parts: [{ text: anthropicReq.system }]
                };
            }

            return googleReq;
        } catch (error) {
            logger.error('Failed to convert Anthropic request to Google:', error);
            throw new TranspilerError('Request conversion failed');
        }
    }

    /**
     * Map Anthropic model to Google model
     */
    private mapModel(anthropicModel: string): string {
        const modelMap: Record<string, string> = {
            'claude-3-5-sonnet-20241022': 'gemini-1.5-pro',
            'claude-3-opus-20240229': 'gemini-1.5-pro',
            'claude-3-sonnet-20240229': 'gemini-1.5-pro',
            'claude-3-haiku-20240307': 'gemini-2.0-flash-exp'
        };

        return modelMap[anthropicModel] || 'gemini-1.5-pro';
    }

    /**
     * Call Google Gemini API
     */
    async callAPI(googleReq: GoogleRequest, anthropicModel: string, token: string, stream: boolean = true): Promise<Response> {
        try {
            const model = this.mapModel(anthropicModel);
            const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
            const url = `${config.google.apiUrl}/v1/models/${model}:${endpoint}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(googleReq)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`Google API error: ${response.status} - ${errorText}`);
                throw new ProviderError(
                    `Google API request failed: ${response.statusText}`,
                    'google',
                    response.status
                );
            }

            return response;
        } catch (error) {
            if (error instanceof ProviderError) {
                throw error;
            }
            logger.error('Google API call failed:', error);
            throw new ProviderError('Failed to communicate with Google', 'google');
        }
    }

    /**
     * Convert Google SSE stream to Anthropic format
     */
    async *convertStreamResponse(response: Response): AsyncGenerator<string> {
        if (!response.body) {
            throw new ProviderError('No response body from Google', 'google');
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

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            const candidates = parsed.candidates;

                            if (candidates && candidates.length > 0) {
                                const content = candidates[0].content;
                                const parts = content?.parts;

                                if (parts && parts.length > 0 && parts[0].text) {
                                    // Convert to Anthropic format
                                    const anthropicChunk = {
                                        type: 'content_block_delta',
                                        index: 0,
                                        delta: {
                                            type: 'text_delta',
                                            text: parts[0].text
                                        }
                                    };

                                    yield `event: content_block_delta\ndata: ${JSON.stringify(anthropicChunk)}\n\n`;
                                }

                                // Check for finish reason
                                if (candidates[0].finishReason) {
                                    yield `event: message_stop\ndata: {}\n\n`;
                                }
                            }
                        } catch (parseError) {
                            logger.warn('Failed to parse Google SSE chunk:', parseError);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}

export const googleTranspiler = new GoogleTranspiler();
