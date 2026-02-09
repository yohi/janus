import { OpenAIAdapter } from './providers/openai.adapter.js';
import { GoogleAdapter } from './providers/google.adapter.js';
import { AnthropicAdapter } from './providers/anthropic.adapter.js';
import { type ProviderAdapter } from './providers/adapter.interface.js';

export class ProviderFactory {
    private static openaiAdapter = new OpenAIAdapter();
    private static googleAdapter = new GoogleAdapter();
    private static anthropicAdapter = new AnthropicAdapter();

    static getAdapter(model: string): ProviderAdapter {
        if (this.openaiAdapter.supports(model)) {
            return this.openaiAdapter;
        }
        if (this.googleAdapter.supports(model)) {
            return this.googleAdapter;
        }
        
        // Aliases Mapping (Default to Google for now)
        // If the model starts with 'claude-', treat it as an alias and route to Google
        // The Google adapter's transpiler handles the mapping from Claude model names to Gemini models
        // Also capture short names like "sonnet-4-5" if they appear
        if (model.startsWith('claude-') || model.includes('sonnet') || model.includes('opus') || model.includes('haiku')) {
            return this.googleAdapter;
        }

        return this.anthropicAdapter;
    }
}
