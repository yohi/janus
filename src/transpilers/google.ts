import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { randomUUID } from 'crypto';
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
    system?: string | string[];
    tools?: AnthropicTool[];
}

interface AnthropicTool {
    name: string;
    description?: string;
    input_schema?: any;
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
    tools?: any[];
    thinkingConfig?: {
        thinkingBudget?: number;
        thinkingLevel?: number;
        includeThoughts?: boolean;
    };
}

export class GoogleTranspiler {
    private projectIdCache = new Map<string, string>();

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
                let systemText = '';
                if (typeof anthropicReq.system === 'string') {
                    systemText = anthropicReq.system;
                } else if (Array.isArray(anthropicReq.system)) {
                    systemText = (anthropicReq.system as any[])
                        .map((p: any) => {
                            if (typeof p === 'string') return p;
                            if (p && p.type === 'text' && p.text) return p.text;
                            return '';
                        })
                        .filter(Boolean)
                        .join('\n');
                }

                if (systemText) {
                    googleReq.systemInstruction = {
                        parts: [{ text: systemText }]
                    };
                }
            }

            // Add tools if present
            const transformedTools = this.transformTools(anthropicReq.tools);
            if (transformedTools && transformedTools.length > 0) {
                googleReq.tools = transformedTools;
            }

            // Add thinking config for opus/thinking models
            const googleModel = this.mapModel(anthropicReq.model);
            const thinkingConfig = this.getThinkingConfig(googleModel);
            if (thinkingConfig) {
                googleReq.thinkingConfig = thinkingConfig;
            }

            return googleReq;
        } catch (error) {
            logger.error('Failed to convert Anthropic request to Google:', error);
            throw new TranspilerError('Request conversion failed');
        }
    }

    /**
     * Transform Anthropic tools to Gemini format
     */
    private transformTools(tools?: AnthropicTool[]): any[] | undefined {
        if (!tools || tools.length === 0) return undefined;

        const transformedTools: any[] = [];
        const functionDeclarations: any[] = [];

        for (const tool of tools) {
            // Special handling for web_search -> googleSearch grounding
            if (tool.name === 'web_search' || tool.name === 'brave_search') {
                transformedTools.push({
                    googleSearch: {}
                });
                continue;
            }

            // Standard function calling conversion
            const parameters = this.cleanSchema(tool.input_schema || { type: 'object', properties: {} });

            functionDeclarations.push({
                name: tool.name,
                description: tool.description || '',
                parameters
            });
        }

        if (functionDeclarations.length > 0) {
            transformedTools.push({
                functionDeclarations: functionDeclarations
            });
        }

        return transformedTools;
    }

    /**
     * Get thinking config for models that support extended thinking
     */
    private getThinkingConfig(model: string): { thinkingLevel?: number, thinkingBudget?: number, includeThoughts?: boolean } | null {
        // Models that support thinking/reasoning
        // Check for Google Gemini model identifiers (gemini, flash, 3)
        if (model.includes('gemini') && (model.includes('flash') || model.includes('3'))) {
            return {
                thinkingLevel: 2, // Default thinking level
                includeThoughts: true
            };
        }
        return null;
    }

    /**
     * Recursively clean JSON schema to be compatible with Gemini API
     */
    private cleanSchema(schema: any): any {
        if (!schema || typeof schema !== 'object') return schema;

        if (Array.isArray(schema)) {
            return schema.map(item => this.cleanSchema(item));
        }

        const clean: any = {};

        for (const [key, value] of Object.entries(schema)) {
            // Remove explicitly unsupported fields by Gemini API
            if (key === '$schema' ||
                key === 'exclusiveMinimum' ||
                key === 'exclusiveMaximum' ||
                key === 'propertyNames' ||
                key === 'additionalProperties') { // additionalProperties can also cause issues
                continue;
            }

            // Convert const to enum
            if (key === 'const') {
                clean['enum'] = [value];
                continue;
            }

            // Recursively clean children
            clean[key] = this.cleanSchema(value);
        }

        return clean;
    }

    /**
     * Map Anthropic model to Google model
     */
    private mapModel(anthropicModel: string): string {
        // Using gemini-3-flash for all models currently as it is the only confirmed working model
        logger.info(`Mapping model: ${anthropicModel} -> gemini-3-flash`);
        return 'gemini-3-flash';
    }



    /**
     * Get Project ID by calling loadCodeAssist or onboardUser
     */
    private async getProjectId(token: string): Promise<string> {
        if (process.env.JANUS_ANTIGRAVITY_PROJECT_ID) {
            return process.env.JANUS_ANTIGRAVITY_PROJECT_ID;
        }
        if (this.projectIdCache.has(token)) {
            return this.projectIdCache.get(token)!;
        }

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            // Headers based on magi-core/antigravity-adapter
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
        };

        const fetchWithTimeout = async (url: string) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                return response;
            } catch (error: any) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') {
                    throw new Error(`Request to ${url} timed out`);
                }
                throw error;
            }
        };

        try {
            // Try loadCodeAssist first
            const loadUrl = `${config.google.apiUrl}/v1internal:loadCodeAssist`;
            logger.info(`Fetching Project ID from ${loadUrl}`);

            const loadResp = await fetchWithTimeout(loadUrl);

            if (loadResp.ok) {
                const data = await loadResp.json();
                const pid = typeof data.cloudaicompanionProject === 'string'
                    ? data.cloudaicompanionProject
                    : data.cloudaicompanionProject?.id;

                if (pid) {
                    this.projectIdCache.set(token, pid);
                    logger.info(`Resolved Project ID: ${pid}`);
                    return pid;
                }
            }

            // Fallback to onboardUser if loadCodeAssist fails or returns no ID
            logger.info('loadCodeAssist failed or returned no ID, trying onboardUser...');
            const onboardUrl = `${config.google.apiUrl}/v1internal:onboardUser`;
            const onboardResp = await fetchWithTimeout(onboardUrl);

            if (onboardResp.ok) {
                const data = await onboardResp.json();
                const pid = typeof data.cloudaicompanionProject === 'string'
                    ? data.cloudaicompanionProject
                    : data.cloudaicompanionProject?.id;

                if (pid) {
                    this.projectIdCache.set(token, pid);
                    logger.info(`Onboarded Project ID: ${pid}`);
                    return pid;
                }
            }

            throw new Error('Failed to retrieve Project ID from Antigravity API');
        } catch (error) {
            logger.error('Error resolving Project ID:', error);
            throw error;
        }
    }

    /**
     * Call Google Gemini API (via Antigravity internal endpoint)
     */
    async callAPI(googleReq: GoogleRequest, anthropicModel: string, token: string, stream: boolean = true): Promise<Response> {
        let timeoutId: NodeJS.Timeout | undefined;
        const controller = new AbortController();

        try {
            timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            const model = this.mapModel(anthropicModel);

            // Get Project ID (handled internally now)
            const projectId = await this.getProjectId(token);

            // Use Antigravity internal endpoint
            // streamGenerateContent causes 404, using generateContent with alt=sse for streaming
            const endpoint = 'generateContent';
            const url = `${config.google.apiUrl}/v1internal:${endpoint}${stream ? '?alt=sse' : ''}`;

            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.15.8 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
                'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
                'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
            };

            // Wrap request body for Antigravity
            const requestBody: any = {
                // model: model, // Removed as per magi-core impl
                contents: googleReq.contents,
                generationConfig: googleReq.generationConfig,
            };

            // Temporarily disable system_instruction if causing issues, but usually fine
            // Note: Antigravity expects snake_case for system_instruction in wrapped body?
            // Let's assume standard object is fine inside 'request' payload, but double check casing.
            // magi-core uses "systemInstruction" (camelCase) in request_payload.
            if (googleReq.systemInstruction) {
                requestBody.systemInstruction = googleReq.systemInstruction;
            }
            if (googleReq.tools) {
                requestBody.tools = googleReq.tools;
            }
            if (googleReq.thinkingConfig) {
                // Check if the original Anthropic model supports thinking
                // We use the already computed googleReq.thinkingConfig which comes from anthropicReq.model
                if (this.getThinkingConfig(model)) {
                    requestBody.thinkingConfig = googleReq.thinkingConfig;
                } else {
                    logger.warn(`Dropping thinkingConfig for model ${anthropicModel}`);
                }
            }

            const wrappedBody = {
                project: projectId,
                model: model,
                request: requestBody,
                requestType: 'chat', // Try 'chat' instead of 'agent'
                userAgent: 'antigravity',
                requestId: `agent-${randomUUID()}`,
            };

            logger.info(`Calling Antigravity API: ${url} (Project: ${projectId}, Model: ${model})`);

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(wrappedBody),
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
    async convertResponse(response: Response, model: string): Promise<any> {
        const data = await response.json();

        // Unwrap response from Antigravity envelope
        // Standard shape: { response: { candidates: [...] } }
        const innerResponse = data.response || data; // Fallback if not wrapped

        const content = innerResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const finishReason = innerResponse.candidates?.[0]?.finishReason;
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
            stop_sequence: stopReason === 'stop_sequence' ? null : null,
            usage: {
                input_tokens: innerResponse.usageMetadata?.promptTokenCount || 0,
                output_tokens: innerResponse.usageMetadata?.candidatesTokenCount || 0
            }
        };
    }

    /**
     * Map Gemini finish reason to Anthropic stop reason
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
     * Convert Google SSE stream to Anthropic format
     */
    async * convertStreamResponse(response: Response, model: string): AsyncGenerator<string> {
        if (!response.body) {
            throw new ProviderError('No response body from Google', 'google');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

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

        const events: string[] = [];
        const parser = createParser({
            onEvent: (event: EventSourceMessage) => {
                try {
                    // SSE data is typically a JSON string
                    // For Antigravity, it might be { response: ... } or just ...
                    const parsed = JSON.parse(event.data);

                    // Unwrap response
                    const innerResponse = parsed.response || parsed;
                    const candidates = innerResponse.candidates;

                    if (candidates && candidates.length > 0) {
                        const content = candidates[0].content;
                        const parts = content?.parts;

                        if (parts && parts.length > 0 && parts[0].text) {
                            // Emit content_block_delta
                            events.push(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: 'content_block_delta',
                                index: 0,
                                delta: {
                                    type: 'text_delta',
                                    text: parts[0].text
                                }
                            })}\n\n`);
                        }

                        // Check for finish reason
                        if (candidates[0].finishReason) {
                            const stopReason = this.mapFinishReason(candidates[0].finishReason);

                            // Emit content_block_stop
                            events.push(`event: content_block_stop\ndata: ${JSON.stringify({
                                type: 'content_block_stop',
                                index: 0
                            })}\n\n`);

                            // Emit message_delta
                            events.push(`event: message_delta\ndata: ${JSON.stringify({
                                type: 'message_delta',
                                delta: {
                                    stop_reason: stopReason,
                                    stop_sequence: null
                                },
                                usage: {
                                    output_tokens: innerResponse.usageMetadata?.candidatesTokenCount || 0
                                }
                            })}\n\n`);

                            // Emit message_stop
                            events.push(`event: message_stop\ndata: ${JSON.stringify({
                                type: 'message_stop'
                            })}\n\n`);
                        }
                    }
                } catch (parseError) {
                    logger.warn('Failed to parse Google SSE chunk:', parseError);
                }
            }
        });

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (value) {
                    parser.feed(decoder.decode(value, { stream: !done }));
                }

                if (done) {
                    parser.feed('\n\n');
                    parser.reset();
                }

                while (events.length > 0) {
                    yield events.shift()!;
                }

                if (done) break;
            }
        } finally {
            reader.releaseLock();
        }
    }
}

export const googleTranspiler = new GoogleTranspiler();
