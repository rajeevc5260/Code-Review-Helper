import { Trelae } from 'trelae-files'
import { env } from "$env/dynamic/private";

const trelaeAPIKey = env.TRELAE_API_KEY;
const isDevelopment = env.ENVIRONMENT !== 'production';

if (!trelaeAPIKey) {
    throw new Error('TRELAE_API_KEY is not set');
}

if (!env.ENVIRONMENT){
     throw new Error('ENVIRONMENT is not set');
}

export const trelae = new Trelae({
    apiKey: trelaeAPIKey,
    devMode: isDevelopment
});