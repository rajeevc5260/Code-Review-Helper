import { Trelae } from "trelae-files";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.TRELAE_API_KEY) {
    throw new Error("TRELAE_API_KEY is missing in .env");
}
if (!process.env.EXT_NAMESPACE_ID) {
    throw new Error("EXT_NAMESPACE_ID is missing in .env");
}

export const trelae = new Trelae({
    apiKey: process.env.TRELAE_API_KEY,
    devMode: true
});

export const namespace = trelae.namespace(process.env.EXT_NAMESPACE_ID);
