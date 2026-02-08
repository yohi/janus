
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
            // Use AbortSignal.timeout for OpenAI as requested
            const signal = AbortSignal.timeout(30000); // 30s timeout

            const response = await fetch(`${config.openai.apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(openaiReq),
                signal
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
        } catch (error: any) {
            if (error instanceof ProviderError) {
                throw error;
            }
            if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                throw new ProviderError('OpenAI API request timed out', 'openai', 408);
            }

            logger.error('OpenAI API call failed:', error);
            throw new ProviderError('Failed to communicate with OpenAI', 'openai');
        }
    }

    /**
     * Convert OpenAI non-streaming response to Anthropic format
     */
    private mapFinishReason(finishReason: string | undefined): string | null {
        if (!finishReason) return null;
        switch (finishReason) {
            case 'stop':
                return 'end_turn';
            case 'length':
                return 'max_tokens';
            case 'tool_calls':
            case 'function_call':
                return 'tool_use';
            case 'content_filter':
                return 'refusal';
            default:
                return finishReason;
        }
    }

    /**
     * Convert OpenAI non-streaming response to Anthropic format
     */
    async convertResponse(response: Response, model: string): Promise<any> {
        const data = await response.json();
        const finishReason = data.choices?.[0]?.finish_reason;

        return {
            id: data.id,
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: data.choices?.[0]?.message?.content || ''
                }
            ],
            model: data.model || model,
            stop_reason: this.mapFinishReason(finishReason),
            stop_sequence: null,
            usage: {
                input_tokens: data.usage?.prompt_tokens || 0,
                output_tokens: data.usage?.completion_tokens || 0
            }
        };
    }

    /**
     * Convert OpenAI SSE stream to Anthropic format
     */
    async *convertStreamResponse(response: Response, model: string): AsyncGenerator<string> {
        if (!response.body) {
            throw new ProviderError('No response body from OpenAI', 'openai');
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
                    if (line === 'data: [DONE]') continue;

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                // Emit content_block_delta
                                yield `event: content_block_delta\ndata: ${JSON.stringify({
                                    type: 'content_block_delta',
                                    index: 0,
                                    delta: {
                                        type: 'text_delta',
                                        text: delta.content
                                    }
                                })}\n\n`;
                            }

                            // Handle finish reason
                            if (parsed.choices?.[0]?.finish_reason) {
                                // Emit content_block_stop
                                yield `event: content_block_stop\ndata: ${JSON.stringify({
                                    type: 'content_block_stop',
                                    index: 0
                                })}\n\n`;

                                // Emit message_delta
                                yield `event: message_delta\ndata: ${JSON.stringify({
                                    type: 'message_delta',
                                    delta: {
                                        stop_reason: this.mapFinishReason(parsed.choices[0].finish_reason),
                                        stop_sequence: null
                                    },
                                    usage: {
                                        output_tokens: 0 // Usage not available in stream end usually
                                    }
                                })}\n\n`;

                                // Emit message_stop
                                yield `event: message_stop\ndata: ${JSON.stringify({
                                    type: 'message_stop'
                                })}\n\n`;
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
