import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { googleAuth } from '../auth/google.js';
import { openaiAuth } from '../auth/openai.js';

interface Model {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
}

interface AnthropicModel {
    id: string;
    type: 'model';
    display_name: string;
    created_at: string;
}

interface OpenAIModel {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
}

interface Cache {
    data: Model[];
    timestamp: number;
}

export class ModelRegistryService {
    private cache: Cache | null = null;
    private readonly CACHE_TTL = 3600 * 1000; // 1 hour

    /**
     * Get aggregated list of models
     */
    async getModels(anthropicApiKey?: string, anthropicVersion?: string): Promise<Model[]> {
        // Check cache
        if (this.cache && (Date.now() - this.cache.timestamp < this.CACHE_TTL)) {
            logger.info('Returning cached model list');
            return this.cache.data;
        }

        logger.info('Fetching fresh model list...');
        const models: Model[] = [];

        // 1. Fetch from Anthropic
        if (anthropicApiKey) {
            try {
                const anthropicModels = await this.fetchAnthropicModels(anthropicApiKey, anthropicVersion);
                models.push(...anthropicModels);
            } catch (error) {
                logger.error('Failed to fetch Anthropic models:', error);
            }
        }

        // 2. Fetch from OpenAI (via Codex subscription or custom key)
        try {
            // Try to get Codex token
            const token = await openaiAuth.getValidToken();
            const openaiModels = await this.fetchOpenAIModels(token);
            models.push(...openaiModels);
        } catch (error) {
            // Not authenticated with Codex, or token refresh failed.
            // If we had a custom apiKey in config, we could try that here.
            // For now, just log and skip.
            logger.debug('Skipping OpenAI models (not authenticated):', error);
        }

        // 3. Fetch from Google (if configured)
        // Note: Google's list models API might need different handling, for now adding static popular ones
        // or if we have a way to fetch them.
        // Google's dynamic fetch is complex due to auth, for now we can add the main ones
        // that we support transcoding for.
        models.push(
            { id: 'gemini-1.5-pro', object: 'model', created: Date.now(), owned_by: 'google' },
            { id: 'gemini-1.5-flash', object: 'model', created: Date.now(), owned_by: 'google' },
            { id: 'gemini-2.0-flash-exp', object: 'model', created: Date.now(), owned_by: 'google' },
            { id: 'gemini-2.0-pro-exp-0205', object: 'model', created: Date.now(), owned_by: 'google' }
        );

        // Deduplicate by ID
        const uniqueModels = Array.from(new Map(models.map(m => [m.id, m])).values());

        // Update cache
        this.cache = {
            data: uniqueModels,
            timestamp: Date.now()
        };

        return uniqueModels;
    }

    private async fetchAnthropicModels(apiKey: string, version: string = '2023-06-01'): Promise<Model[]> {
        const response = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': version
            }
        });

        if (!response.ok) {
            throw new Error(`Anthropic API error: ${response.statusText}`);
        }

        const data = await response.json() as { data: AnthropicModel[] };

        return data.data.map(m => ({
            id: m.id,
            object: 'model',
            created: new Date(m.created_at).getTime(),
            owned_by: 'anthropic'
        }));
    }

    private async fetchOpenAIModels(token: string): Promise<Model[]> {
        const response = await fetch(`${config.openai.apiUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            // If local proxy or specific endpoint fails, warn but don't crash
            logger.warn(`OpenAI models fetch failed: ${response.status}`);
            return [];
        }

        const data = await response.json() as { data: OpenAIModel[] };
        return data.data;
    }
}

export const modelRegistry = new ModelRegistryService();
