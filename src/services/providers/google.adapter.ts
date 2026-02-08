import { type Request, type Response } from 'express';
import { logger } from '../../utils/logger.js';
import { googleAuth } from '../../auth/google.js';
import { googleTranspiler } from '../../transpilers/google.js';
import { type ProviderAdapter } from './adapter.interface.js';

export class GoogleAdapter implements ProviderAdapter {
    supports(model: string): boolean {
        return model.startsWith('gemini') || model.includes('antigravity');
    }

    async handle(req: Request, res: Response): Promise<void> {
        const { model, stream = true } = req.body;
        logger.info('Routing to Google...');
        
        const token = await googleAuth.getValidToken();
        const googleReq = googleTranspiler.convertRequest(req.body);
        const response = await googleTranspiler.callAPI(googleReq, model, token, stream);

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            for await (const chunk of googleTranspiler.convertStreamResponse(response, model)) {
                res.write(chunk);
            }
            res.end();
        } else {
            const data = await googleTranspiler.convertResponse(response, model);
            res.json(data);
        }
    }
}
