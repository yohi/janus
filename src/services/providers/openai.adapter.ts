import { type Request, type Response } from 'express';
import { logger } from '../../utils/logger.js';
import { openaiAuth } from '../../auth/openai.js';
import { openaiTranspiler } from '../../transpilers/openai.js';
import { type ProviderAdapter } from './adapter.interface.js';

export class OpenAIAdapter implements ProviderAdapter {
    supports(model: string): boolean {
        return /^(gpt|o[1-9]|chatgpt)-/.test(model) || model.includes('codex');
    }

    async handle(req: Request, res: Response): Promise<void> {
        const { model, stream = true } = req.body;
        logger.info('Routing to OpenAI...');
        
        const token = await openaiAuth.getValidToken();
        const openaiReq = openaiTranspiler.convertRequest(req.body);
        const response = await openaiTranspiler.callAPI(openaiReq, token);

        if (stream) {
            for await (const chunk of openaiTranspiler.convertStreamResponse(response, model)) {
                res.write(chunk);
            }
            res.end();
        } else {
            const data = await openaiTranspiler.convertResponse(response, model);
            res.json(data);
        }
    }
}
