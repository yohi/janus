import { type Request, type Response } from 'express';

export interface ProviderAdapter {
    supports(model: string): boolean;
    handle(req: Request, res: Response): Promise<void>;
}
