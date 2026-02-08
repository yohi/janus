
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
        let timeoutId: NodeJS.Timeout | undefined;
        const controller = new AbortController();

        try {
            timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            const model = this.mapModel(anthropicModel);
            const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
            const url = `${config.google.apiUrl}/v1/models/${model}:${endpoint}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(googleReq),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

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
        } catch (error: any) {
            if (timeoutId) clearTimeout(timeoutId);

            if (error instanceof ProviderError) {
                throw error;
            }

            if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
                throw new ProviderError('Google API request timed out', 'google', 408);
            }

            logger.error('Google API call failed:', error);
            throw new ProviderError('Failed to communicate with Google', 'google');
        }
    }

    /**
     * Convert Google Gemini non-streaming response to Anthropic format
     */
    private mapFinishReason(finishReason: string | undefined): string | null {
        if (!finishReason) return null;
        switch (finishReason) {
            case 'STOP':
            case 'FINISHED':
                return 'end_turn';
            case 'MAX_TOKENS':
                return 'max_tokens';
            case 'STOP_SEQUENCE':
                return 'stop_sequence';
            case 'SAFETY':
            case 'RECITATION':
                return 'refusal';
            case 'INTERRUPTED':
                return 'end_turn';
            default:
                return 'end_turn';
        }
    }

    /**
     * Convert Google Gemini non-streaming response to Anthropic format
     */
    async convertResponse(response: Response, model: string): Promise<any> {
        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const finishReason = data.candidates?.[0]?.finishReason;
        const stopReason = this.mapFinishReason(finishReason);

        return {
            id: `msg_${Math.random().toString(36).substring(2, 15)}`,
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: content
                }
            ],
            model: model,
            stop_reason: stopReason,
            stop_sequence: stopReason === 'stop_sequence' ? null : null, // stop_sequence value not easily available in standard finishReason
            usage: {
                input_tokens: data.usageMetadata?.promptTokenCount || 0,
                output_tokens: data.usageMetadata?.candidatesTokenCount || 0
            }
        };
    }

    /**
     * Convert Google SSE stream to Anthropic format
     */
    async *convertStreamResponse(response: Response, model: string): AsyncGenerator<string> {
        if (!response.body) {
            throw new ProviderError('No response body from Google', 'google');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Generate message ID
        const messageId = `msg_${Math.random().toString(36).substring(2, 15)}`;

        // Emit message_start
        yield `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        })}\n\n`;

        // Emit content_block_start
        yield `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: {
                type: 'text',
                text: ''
            }
        })}\n\n`;

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
                                    // Emit content_block_delta
                                    yield `event: content_block_delta\ndata: ${JSON.stringify({
                                        type: 'content_block_delta',
                                        index: 0,
                                        delta: {
                                            type: 'text_delta',
                                            text: parts[0].text
                                        }
                                    })}\n\n`;
                                }

                                // Check for finish reason
                                if (candidates[0].finishReason) {
                                    const stopReason = this.mapFinishReason(candidates[0].finishReason);

                                    // Emit content_block_stop
                                    yield `event: content_block_stop\ndata: ${JSON.stringify({
                                        type: 'content_block_stop',
                                        index: 0
                                    })}\n\n`;

                                    // Emit message_delta
                                    yield `event: message_delta\ndata: ${JSON.stringify({
                                        type: 'message_delta',
                                        delta: {
                                            stop_reason: stopReason,
                                            stop_sequence: null
                                        },
                                        usage: {
                                            output_tokens: parsed.usageMetadata?.candidatesTokenCount || 0
                                        }
                                    })}\n\n`;

                                    // Emit message_stop
                                    yield `event: message_stop\ndata: ${JSON.stringify({
                                        type: 'message_stop'
                                    })}\n\n`;
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
