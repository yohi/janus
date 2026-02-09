import { type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';

export const handleUserMe = async (req: Request, res: Response) => {
    logger.info('Handling /v1/users/me request');
    res.json({
        id: 'user_janus_dummy_id',
        type: 'user',
        email: 'janus-user@example.com',
        name: 'Janus Gateway User',
        role: 'user',
        added_at: new Date().toISOString()
    });
};

export const handleOrganizations = async (req: Request, res: Response) => {
    logger.info('Handling /v1/organizations request');
    res.json([
        {
            id: 'org_janus_dummy_id',
            type: 'organization',
            name: 'Janus Gateway Org',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            capabilities: [
                'claude_pro',
                'scale_tier_usage_api',
                'raw_output'
            ],
            active_flags: [],
            api_key_role: null
        }
    ]);
};

export const handlePlans = async (req: Request, res: Response) => {
    logger.info('Handling /v1/plans request');
    // Returning a dummy plan structure often seen in API responses
    res.json({
        type: 'plan',
        id: 'plan_janus_dummy_id',
        name: 'Scale',
        created_at: new Date().toISOString()
    });
};
