import { describe, it, expect } from 'vitest';
import { openaiTranspiler } from '../../transpilers/openai.js';

describe('OpenAI Transpiler', () => {
    describe('convertRequest', () => {
        it('should convert basic Anthropic request to OpenAI format', () => {
            const anthropicReq = {
                model: 'claude-3-5-sonnet-20241022',
                messages: [
                    { role: 'user' as const, content: 'Hello, world!' }
                ],
                max_tokens: 1024
            };

            const openaiReq = openaiTranspiler.convertRequest(anthropicReq);

            expect(openaiReq.model).toBe('gpt-4o');
            expect(openaiReq.messages).toHaveLength(1);
            expect(openaiReq.messages[0]?.role).toBe('user');
            expect(openaiReq.messages[0]?.content).toBe('Hello, world!');
            expect(openaiReq.max_tokens).toBe(1024);
        });

        it('should handle system messages', () => {
            const anthropicReq = {
                model: 'claude-3-5-sonnet-20241022',
                system: 'You are a helpful assistant.',
                messages: [
                    { role: 'user' as const, content: 'Hello!' }
                ],
                max_tokens: 100
            };

            const openaiReq = openaiTranspiler.convertRequest(anthropicReq);

            expect(openaiReq.messages).toHaveLength(2);
            expect(openaiReq.messages[0]?.role).toBe('system');
            expect(openaiReq.messages[0]?.content).toBe('You are a helpful assistant.');
            expect(openaiReq.messages[1]?.role).toBe('user');
        });

        it('should handle content blocks', () => {
            const anthropicReq = {
                model: 'claude-3-5-sonnet-20241022',
                messages: [
                    {
                        role: 'user' as const,
                        content: [
                            { type: 'text' as const, text: 'First part' },
                            { type: 'text' as const, text: 'Second part' }
                        ]
                    }
                ],
                max_tokens: 100
            };

            const openaiReq = openaiTranspiler.convertRequest(anthropicReq);

            expect(openaiReq.messages[0]?.content).toBe('First part\nSecond part');
        });

        it('should map model names correctly', () => {
            const models = [
                { anthropic: 'claude-3-5-sonnet-20241022', openai: 'gpt-4o' },
                { anthropic: 'claude-3-opus-20240229', openai: 'gpt-4o' },
                { anthropic: 'claude-3-sonnet-20240229', openai: 'gpt-4o' },
                { anthropic: 'claude-3-haiku-20240307', openai: 'gpt-4o-mini' }
            ];

            models.forEach(({ anthropic, openai }) => {
                const req = openaiTranspiler.convertRequest({
                    model: anthropic,
                    messages: [{ role: 'user' as const, content: 'test' }],
                    max_tokens: 100
                });
                expect(req.model).toBe(openai);
            });
        });

        it('should handle temperature and top_p', () => {
            const anthropicReq = {
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'user' as const, content: 'test' }],
                max_tokens: 100,
                temperature: 0.7,
                top_p: 0.9
            };

            const openaiReq = openaiTranspiler.convertRequest(anthropicReq);

            expect(openaiReq.temperature).toBe(0.7);
            expect(openaiReq.top_p).toBe(0.9);
        });
    });

    describe('convertResponse', () => {
        it('should convert OpenAI response to Anthropic format', async () => {
            const mockResponse = new Response(JSON.stringify({
                id: 'chatcmpl-123',
                model: 'gpt-4o',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'Hello! How can I help you?'
                    },
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 20
                }
            }));

            const result = await openaiTranspiler.convertResponse(mockResponse, 'claude-3-5-sonnet-20241022');

            expect(result.type).toBe('message');
            expect(result.role).toBe('assistant');
            expect(result.content).toHaveLength(1);
            expect(result.content[0].type).toBe('text');
            expect(result.content[0].text).toBe('Hello! How can I help you?');
            expect(result.stop_reason).toBe('end_turn');
            expect(result.usage.input_tokens).toBe(10);
            expect(result.usage.output_tokens).toBe(20);
        });

        it('should map finish reasons correctly', async () => {
            const finishReasons = [
                { openai: 'stop', anthropic: 'end_turn' },
                { openai: 'length', anthropic: 'max_tokens' },
                { openai: 'content_filter', anthropic: 'refusal' }
            ];

            for (const { openai, anthropic } of finishReasons) {
                const mockResponse = new Response(JSON.stringify({
                    id: 'test',
                    model: 'gpt-4o',
                    choices: [{
                        message: { role: 'assistant', content: 'test' },
                        finish_reason: openai
                    }],
                    usage: { prompt_tokens: 1, completion_tokens: 1 }
                }));

                const result = await openaiTranspiler.convertResponse(mockResponse, 'claude-3-5-sonnet-20241022');
                expect(result.stop_reason).toBe(anthropic);
            }
        });
    });

    describe('convertStreamResponse', () => {
        it('should emit proper SSE event sequence', async () => {
            const sseData = [
                'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}',
                'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":" world"}}]}',
                'data: {"id":"chatcmpl-123","choices":[{"delta":{},"finish_reason":"stop"}]}',
                'data: [DONE]'
            ].join('\n\n');

            const mockResponse = new Response(sseData);

            const events: string[] = [];
            for await (const chunk of openaiTranspiler.convertStreamResponse(mockResponse, 'claude-3-5-sonnet-20241022')) {
                events.push(chunk);
            }

            // Check event sequence
            expect(events.some(e => e.includes('event: message_start'))).toBe(true);
            expect(events.some(e => e.includes('event: content_block_start'))).toBe(true);
            expect(events.some(e => e.includes('event: content_block_delta'))).toBe(true);
            expect(events.some(e => e.includes('event: content_block_stop'))).toBe(true);
            expect(events.some(e => e.includes('event: message_delta'))).toBe(true);
            expect(events.some(e => e.includes('event: message_stop'))).toBe(true);
        });

        it('should include text content in delta events', async () => {
            const sseData = 'data: {"choices":[{"delta":{"content":"test content"}}]}\n\n';
            const mockResponse = new Response(sseData);

            const events: string[] = [];
            for await (const chunk of openaiTranspiler.convertStreamResponse(mockResponse, 'claude-3-5-sonnet-20241022')) {
                events.push(chunk);
            }

            const deltaEvent = events.find(e => e.includes('content_block_delta'));
            expect(deltaEvent).toBeDefined();
            expect(deltaEvent).toContain('test content');
        });
    });
});
