import express from "express";
import dotenv from "dotenv";
import { pool } from "./client.js";
import { namespace, trelae } from "./trelae.js";
import { z } from "zod";
import { writeFile, readFile, rm } from "fs/promises";
import path, { join } from "path";
import { randomUUID } from "crypto";
import fsPromises from "fs/promises";
import {
    GoogleGenAI,
    type FunctionDeclaration,
    FunctionCallingConfigMode,
} from "@google/genai";

dotenv.config();

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);

app.get("/", (_req, res) => {
    res.json({ message: "Backend is running" });
});

// Trelae namespace check
app.get("/trelae", async (_req, res) => {
    try {
        const meta = await namespace.getMetaData?.();
        res.json({ namespace: meta });
    } catch (e) {
        res.status(500).json({
            error: "Trelae error",
            details: (e as Error).message,
        });
    }
});


// LLM-driven code review
const ReviewBody = z.object({
    userId: z.string().min(1),
    zipFileId: z.string().min(1),
    message: z.string().min(1),
});

type ReviewBody = z.infer<typeof ReviewBody>;

const TEXT_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".yml",
    ".yaml",
    ".toml",
    ".env",
    ".gitignore",
    ".dockerignore",
    ".txt",
    ".svelte",
    ".astro",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".htm",
    ".sql",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
]);

function isProbablyText(name: string) {
    // Handle files with multiple dots or special characters like +page.svelte, +server.ts
    const parts = name.split('.');
    if (parts.length < 2) return false;

    const ext = '.' + parts[parts.length - 1].toLowerCase();
    return TEXT_EXTS.has(ext);
}

//  Trelae tooling wrappers 
async function listFilesTool(args: any) {
    console.log("🔍 listFilesTool called with args:", JSON.stringify(args, null, 2));

    const { location, query, limit, page } = args ?? {};

    try {
        console.log("📋 Fetching files from namespace...");
        const resp = await namespace.getFiles?.({
            location,
            query,
            limit: typeof limit === "number" ? limit : undefined,
            page: typeof page === "number" ? page : undefined,
        });

        const result = resp ?? { files: [], folders: [], page: 1, totalPages: 1, total: 0 };
        console.log(" listFilesTool result:", {
            filesCount: result.files?.length || 0,
            foldersCount: result.folders?.length || 0,
            page: (result as any).page,
            total: (result as any).total
        });

        return result;
    } catch (error) {
        console.error(" listFilesTool error:", error);
        throw error;
    }
}

async function getDownloadUrlTool(args: any) {
    console.log("🔗 getDownloadUrlTool called with args:", JSON.stringify(args, null, 2));

    const { fileId, expiry = "1h" } = args ?? {};

    if (!fileId) {
        console.error(" getDownloadUrlTool error: fileId is required");
        throw new Error("fileId is required");
    }

    try {
        console.log(`📂 Getting download URL for fileId: ${fileId}, expiry: ${expiry}`);
        const file = trelae.file(fileId);
        const url = await file.getDownloadUrl?.({ expiry });

        const result = { downloadUrl: url };
        console.log(" getDownloadUrlTool result:", {
            hasUrl: !!url,
            urlLength: url?.length || 0
        });

        return result;
    } catch (error) {
        console.error(" getDownloadUrlTool error:", error);
        throw error;
    }
}

async function readFileTextTool(args: any, tempRoot: string) {
    console.log("📖 readFileTextTool called with args:", JSON.stringify(args, null, 2));

    const { fileId, name = "unknown", maxBytes = 512 * 1024 } = args ?? {};

    if (!fileId) {
        console.error(" readFileTextTool error: fileId is required");
        throw new Error("fileId is required");
    }

    if (!isProbablyText(name)) {
        console.log(`⏭️ Skipping non-text file: ${name}`);
        return {
            name,
            fileId,
            skipped: true,
            reason: "Non-text or unrecognized extension",
        };
    }

    // 1) get a signed URL
    console.log(`🔗 Getting download URL for file: ${name} (${fileId})`);
    const file = trelae.file(fileId);
    const url = await file.getDownloadUrl?.({ expiry: "30m" });

    if (!url) {
        console.error(" Could not get download URL");
        throw new Error("Could not get download URL");
    }

    console.log(" Download URL obtained successfully");

    // 2) download → temp → read → cleanup
    // Create a safe filename by replacing problematic characters while preserving the original name structure
    const safeFileName = name.replace(/[<>:"/\\|?*]/g, "_");
    const tmpPath = join(
        tempRoot,
        `${randomUUID()}-${safeFileName}`
    );

    console.log(`📥 Downloading file to temp path: ${tmpPath}`);

    try {
        const r = await fetch(url);
        if (!r.ok) {
            console.error(` Download failed: ${r.status} ${r.statusText}`);
            throw new Error(`Download failed: ${r.status} ${r.statusText}`);
        }

        console.log(" File downloaded successfully");

        const buf = Buffer.from(await r.arrayBuffer());
        const slice = buf.subarray(0, Math.min(buf.length, maxBytes));

        console.log(`💾 Writing ${slice.length} bytes to temp file (original: ${buf.length} bytes)`);
        await writeFile(tmpPath, slice);

        console.log("📄 Reading file content as UTF-8");
        const text = await readFile(tmpPath, "utf8");

        const result = {
            fileId,
            name,
            bytes: slice.length,
            truncated: buf.length > slice.length,
            text,
        };

        console.log(" readFileTextTool result:", {
            fileId,
            name,
            bytes: result.bytes,
            truncated: result.truncated,
            textLength: text.length
        });

        return result;
    } catch (error) {
        console.error(" readFileTextTool error:", error);
        throw error;
    } finally {
        console.log(`🗑️ Cleaning up temp file: ${tmpPath}`);
        await rm(tmpPath, { force: true }).catch((cleanupError) => {
            console.warn(" Failed to cleanup temp file:", cleanupError);
        });
    }
}

// Function Declarations 
const fnListFiles: FunctionDeclaration = {
    name: "listFiles",
    description: "List or search files/folders in Trelae namespace",
    parametersJsonSchema: {
        type: "object",
        properties: {
            location: { type: "string", description: "Folder path to list" },
            query: { type: "string", description: "Keyword to search files" },
            limit: { type: "number", description: "Max results per page" },
            page: { type: "number", description: "Page number (1-based)" },
        },
    },
};

const fnGetDownloadUrl: FunctionDeclaration = {
    name: "getDownloadUrl",
    description: "Get a signed download URL for a file by ID",
    parametersJsonSchema: {
        type: "object",
        properties: {
            fileId: { type: "string" },
            expiry: { type: "string", description: "e.g., 1h, 10m" },
        },
        required: ["fileId"],
    },
};

const fnReadFileText: FunctionDeclaration = {
    name: "readFileText",
    description: "Download and return the content of a file. If not text, returns Base64.",
    parametersJsonSchema: {
        type: "object",
        properties: {
            fileId: { type: "string" },
            name: { type: "string", description: "File name with extension" },
            maxBytes: { type: "number", description: "Max bytes to read (default ~512KB)" },
        },
        required: ["fileId", "name"],
    },
};

// POST review 
app.post("/ai/review", async (req, res) => {
    console.log("🚀 Starting AI review request");
    console.log("📥 Request body:", JSON.stringify(req.body, null, 2));

    const parsed = ReviewBody.safeParse(req.body);
    if (!parsed.success) {
        console.error(" Invalid request body:", parsed.error.flatten());
        return res.status(400).json({
            error: "invalid_body",
            issues: parsed.error.flatten(),
        });
    }

    const { userId, zipFileId, message } = parsed.data;
    console.log(" Request validated:", { userId, zipFileId, messageLength: message.length });

    if (!process.env.GEMINI_API_KEY) {
        console.error(" Missing GEMINI_API_KEY");
        return res.status(500).json({ error: "missing_gemini_api_key" });
    }

    // 1) fetch saved folder_structure for extra context (best-effort)
    console.log("🗄️ Fetching folder structure from database...");
    let folderStructure: any = null;
    try {
        const r = await pool.query(
            `SELECT folder_structure FROM review_zip WHERE zip_file_id = $1 AND user_id = $2 LIMIT 1`,
            [zipFileId, userId]
        );
        if (r.rowCount) {
            folderStructure = r.rows[0].folder_structure;
            console.log(" Folder structure found:", {
                hasStructure: !!folderStructure,
                structureSize: JSON.stringify(folderStructure).length
            });
        } else {
            console.log("📂 No folder structure found in database");
        }
    } catch (dbError) {
        console.warn(" Database query failed (continuing anyway):", dbError);
    }

    // 2) init Gen AI
    console.log("🤖 Initializing Google GenAI...");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

    // 3) temp workspace for downloads
    const tempRoot = path.resolve("src/lib/review-tmp");
    console.log(`📁 Setting up temp workspace: ${tempRoot}`);
    await fsPromises.mkdir(tempRoot, { recursive: true });

    const toolLogs: any[] = [];
    const gatheredTexts: Array<{
        fileId: string;
        name: string;
        bytes: number;
        truncated: boolean;
        text: string;
    }> = [];

    try {
        const sysPrompt =
            `You are a code analysis assistant. Your job is to directly answer the user's specific question or request about the code.\n` +
            `Use the available tools to explore files and gather information needed to provide a precise, direct answer.\n` +
            `Focus on reading the most relevant files based on the user's query. Provide specific, actionable responses rather than general summaries.\n` +
            `If the user asks about specific functionality, bugs, improvements, or code patterns, give exact answers with code examples where appropriate.`;
            
        const fsSummary = folderStructure
            ? `Folder structure (JSON):\n${JSON.stringify(folderStructure).slice(0, 5000)}`
            : `No saved folder structure found for this zipFileId.`

        console.log("📝 Preparing conversation history...");
        const history: any[] = [
            { role: "user", parts: [{ text: sysPrompt }] },
            { role: "user", parts: [{ text: `ZipFileId: ${zipFileId}\nMessage: ${message}` }] },
            { role: "user", parts: [{ text: fsSummary }] },
        ];

        console.log("Making initial request to GenAI with tools enabled...");
        // First ask with tools enabled
        let response = await ai.models.generateContent({
            model: "gemini-2.0-flash-001",
            contents: history,
            config: {
                tools: [
                    {
                        functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText],
                    },
                ],
                toolConfig: {
                    functionCallingConfig: {
                        mode: FunctionCallingConfigMode.AUTO,
                    },
                },
            },
        });

        console.log(" Initial GenAI response received");

        // Tool-calling loop (max 10 rounds)
        console.log("🔄 Starting tool-calling loop (max 10 rounds)...");
        for (let i = 0; i < 10; i++) {
            const calls = response.functionCalls ?? [];
            console.log(`🔄 Round ${i + 1}: Found ${calls.length} function calls`);

            if (!calls.length) {
                console.log(" No more function calls - loop complete");
                break;
            }

            const fnCall = calls[0];
            const { name, args } = fnCall;
            console.log(`🛠️ Executing tool: ${name}`, JSON.stringify(args, null, 2));

            let result: any;
            const toolStartTime = Date.now();

            try {
                if (name === "listFiles") {
                    result = await listFilesTool(args);
                } else if (name === "getDownloadUrl") {
                    result = await getDownloadUrlTool(args);
                } else if (name === "readFileText") {
                    const out = await readFileTextTool(args, tempRoot);
                    result = out;
                    // Only push to gatheredTexts if out is a successful result (has text, name, fileId, bytes)
                    if (
                        out &&
                        typeof out === "object" &&
                        "text" in out &&
                        "name" in out &&
                        "fileId" in out &&
                        "bytes" in out
                    ) {
                        gatheredTexts.push({
                            fileId: out.fileId,
                            name: out.name,
                            bytes: out.bytes,
                            truncated: !!out.truncated,
                            text: out.text,
                        });
                        console.log(`📚 Added text file to gathered texts: ${out.name} (${out.bytes} bytes)`);
                    }
                } else {
                    console.error(` Unknown tool: ${name}`);
                    result = { error: `unknown_tool: ${name}` };
                }
            } catch (err: any) {
                console.error(` Tool execution error for ${name}:`, err);
                result = { error: err?.message || String(err) };
            }

            const toolDuration = Date.now() - toolStartTime;
            console.log(`⏱️ Tool ${name} completed in ${toolDuration}ms`);

            const logEntry = { name, args, result, duration: toolDuration };
            toolLogs.push(logEntry);
            console.log("📝 Tool call logged:", { name, duration: toolDuration, hasResult: !!result });

            // Feed function response back into the conversation
            console.log("🔄 Updating conversation history with tool results...");
            history.push({
                role: "model",
                parts: [{ functionCall: { name, args } }],
            });
            history.push({
                role: "tool",
                parts: [{ functionResponse: { name, response: result } }],
            });

            console.log("🤖 Making follow-up request to GenAI...");
            // Ask the model again with the updated history
            response = await ai.models.generateContent({
                model: "gemini-2.0-flash-001",
                contents: history,
                config: {
                    tools: [
                        {
                            functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText],
                        },
                    ],
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.AUTO,
                        },
                    },
                },
            });

            console.log(` Follow-up GenAI response received for round ${i + 1}`);
        }

        const finalText = response.text ?? "Done.";
        console.log("🎉 AI review completed successfully");
        console.log("📊 Final stats:", {
            toolCallsCount: toolLogs.length,
            gatheredFilesCount: gatheredTexts.length,
            responseLength: finalText.length
        });

        return res.json({
            ok: true,
            response: finalText,
            selectedFiles: gatheredTexts.map((g) => ({
                fileId: g.fileId,
                name: g.name,
                bytes: g.bytes,
                truncated: g.truncated,
            })),
            snippets: gatheredTexts.map((g) => ({
                name: g.name,
                excerpt: g.text.slice(0, 2000),
            })),
            toolLogs,
        });
    } catch (e: any) {
        console.error("AI review failed:", e);
        return res.status(500).json({
            ok: false,
            error: e?.message || String(e),
        });
    } finally {
        console.log("Cleaning up temp workspace...");
        await rm(tempRoot, { recursive: true, force: true }).catch((cleanupError) => {
            console.warn(" Failed to cleanup temp workspace:", cleanupError);
        });
        console.log("Cleanup completed");
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});