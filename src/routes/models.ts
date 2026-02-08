import { type Request, type Response } from 'express';
import { modelRegistry } from '../services/model-registry.js';
import { logger } from '../utils/logger.js';

export const handleModels = async (req: Request, res: Response) => {
    try {
        // Extract Anthropic specific headers if present
        const anthropicApiKey = req.headers['x-api-key'] as string | undefined;
        const anthropicVersion = req.headers['anthropic-version'] as string | undefined;

        const models = await modelRegistry.getModels(anthropicApiKey, anthropicVersion);

        res.json({
            object: 'list',
            data: models
        });
    } catch (error) {
        logger.error('Error fetching models:', error);
        res.status(500).json({
            type: 'error',
            error: {
                type: 'api_error',
                message: 'Failed to fetch models'
            }
        });
    }
};
