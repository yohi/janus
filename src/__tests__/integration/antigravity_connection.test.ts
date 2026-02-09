import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { googleAuth } from '../../auth/google.js';

// Mock dependencies BEFORE importing app
vi.mock('../../auth/google.js', () => ({
    googleAuth: {
        getValidToken: vi.fn(),
        login: vi.fn(),
    }
}));

// Mock config to ensure stable environment
vi.mock('../../config.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        // @ts-ignore
        ...actual,
        config: {
            // @ts-ignore
            ...actual.config,
            google: {
                // @ts-ignore
                ...actual.config.google,
                apiUrl: 'https://mock-google-api.com',
                tokenPath: '/tmp/mock-token.json',
            },
            port: 0 // Use random port for tests if server starts
        }
    };
});

// Import app after mocks
import app from '../../index.js';

describe('Antigravity Integration', () => {
    const MOCK_TOKEN = 'mock_access_token_123';
    const MOCK_PROJECT_ID = 'mock-project-id';
    
    // Mock global fetch
    const fetchMock = vi.fn();
    let originalFetch: typeof global.fetch;
    
    beforeEach(() => {
        originalFetch = global.fetch;
        vi.stubGlobal('fetch', fetchMock);
        // Setup default auth mock
        vi.mocked(googleAuth.getValidToken).mockResolvedValue(MOCK_TOKEN);
    });

    afterEach(() => {
        vi.stubGlobal('fetch', originalFetch);
        fetchMock.mockReset();
        vi.clearAllMocks();
    });

    it('should successfully proxy Claude request to Antigravity (Gemini)', async () => {
        // 1. Setup Fetch Mocks
        fetchMock.mockImplementation(async (url: string, options: any) => {
            // Mock Project ID resolution
            if (url.includes('loadCodeAssist') || url.includes('onboardUser')) {
                return new Response(JSON.stringify({
                    cloudaicompanionProject: { id: MOCK_PROJECT_ID }
                }));
            }

            // Mock Chat Generation
            if (url.includes('generateContent')) {
                // Verify Auth Header
                let authHeader;
                if (options.headers && typeof options.headers.get === 'function') {
                    authHeader = options.headers.get('Authorization');
                } else {
                    authHeader = options.headers['Authorization'] || options.headers.Authorization;
                }

                if (authHeader !== `Bearer ${MOCK_TOKEN}`) {
                    return new Response('Unauthorized', { status: 401 });
                }

                // Return Gemini response (non-streaming for simplicity in this test case)
                return new Response(JSON.stringify({
                    response: {
                        candidates: [{
                            content: {
                                parts: [{ text: 'Hello from Gemini!' }],
                                role: 'model'
                            },
                            finishReason: 'STOP'
                        }],
                        usageMetadata: {
                            promptTokenCount: 10,
                            candidatesTokenCount: 5
                        }
                    }
                }));
            }

            return new Response('Not Found', { status: 404 });
        });

        // 2. Make Request
        const response = await request(app)
            .post('/v1/messages')
            .send({
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 100,
                stream: false
            });

        // 3. Assertions
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            id: expect.stringMatching(/^msg_/),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Gemini!' }],
            model: 'claude-3-5-sonnet-20241022',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: 10,
                output_tokens: 5
            }
        });

        // Verify Auth Flow
        expect(googleAuth.getValidToken).toHaveBeenCalled();
        
        // Verify API Call
        const generateCall = fetchMock.mock.calls.find(call => call[0].includes('generateContent'));
        expect(generateCall).toBeDefined();
        // @ts-ignore
        const requestBody = JSON.parse(generateCall[1].body);
        expect(requestBody.project).toBe(MOCK_PROJECT_ID);
        expect(requestBody.model).toBe('gemini-3-flash');
    });

    it('should handle authentication failure from Antigravity', async () => {
        // Mock token generation failure
        vi.mocked(googleAuth.getValidToken).mockRejectedValue(new Error('Auth failed'));

        const response = await request(app)
            .post('/v1/messages')
            .send({
                model: 'claude-3-5-sonnet-20241022',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: false
            });

        expect(response.status).toBe(500);
        expect(response.body.error).toBeDefined();
    });
});
