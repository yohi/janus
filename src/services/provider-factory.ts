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
        return this.anthropicAdapter;
    }
}
