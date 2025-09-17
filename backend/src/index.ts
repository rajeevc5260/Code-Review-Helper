import express from "express";
import dotenv from "dotenv";
import { db, pool } from "./client.js";
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
import { eq, and } from 'drizzle-orm';
import { reviewZip } from "./db/schema.js";

dotenv.config();
import cors from "cors";
const app = express();
app.use(express.json());
app.use(cors({
    origin: "*",
}))
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
app.post("/ai/review/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Keep the socket open
    req.socket.setTimeout(0);
    res.flushHeaders?.();

    // utility helpers
    const send = (event: string, data: any) => {
        // SSE format: event:<name>\n data:<json>\n\n
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        res.write(`event: ${event}\n`);
        res.write(`data: ${payload}\n\n`);
    };
    const sendProgress = (message: string, details?: any) =>
        send("progress", {
            timestamp: Date.now(),
            message,
            status: "processing",
            ...(details ?? {})
        });
    const sendError = (message: string, details?: any) =>
        send("error", {
            timestamp: Date.now(),
            message,
            status: "error",
            ...(details ?? {})
        });

    // heartbeat to keep connections alive (esp. behind proxies)
    const hb = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);

    try {
        send("start", {
            message: "Initializing AI code review session",
            timestamp: Date.now(),
            status: "started"
        });

        const parsed = ReviewBody.safeParse(req.body);
        if (!parsed.success) {
            sendError("Request validation failed - Invalid request body format", {
                validationErrors: parsed.error.flatten()
            });
            send("done", { status: "failed", timestamp: Date.now() });
            return res.end();
        }
        const { userId, zipFileId, message } = parsed.data;
        sendProgress("Request validated successfully", {
            userId,
            zipFileId,
            messageLength: message.length
        });

        if (!process.env.GEMINI_API_KEY) {
            sendError("Configuration error - Missing Gemini API key");
            send("done", { status: "failed", timestamp: Date.now() });
            return res.end();
        }

        // fetch saved folder_structure for extra context (best-effort)
        console.log("🗄️ Fetching folder structure from database...");
        let folderStructure: any = null;
        try {
            sendProgress("Retrieving project structure from database");
            const r = await pool.query(
                `SELECT folder_structure FROM review_zip WHERE zip_file_id = $1 AND user_id = $2 LIMIT 1`,
                [zipFileId, userId]
            );
            if (r.rowCount) {
                folderStructure = r.rows[0].folder_structure;
                send("folder_structure", {
                    status: "found",
                    timestamp: Date.now(),
                    message: "Project structure loaded successfully"
                });
            } else {
                send("folder_structure", {
                    status: "not_found",
                    timestamp: Date.now(),
                    message: "No saved project structure found - will analyze files directly"
                });
            }
        } catch (e: any) {
            sendError("Database query failed while fetching project structure", {
                error: e?.message || String(e)
            });
        }

        // init Gen AI
        console.log("🤖 Initializing Google GenAI...");
        sendProgress("Initializing AI analysis engine");
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const tempRoot = path.resolve("src/lib/review-tmp");
        await fsPromises.mkdir(tempRoot, { recursive: true });
        sendProgress("Workspace prepared successfully", { workspaceLocation: tempRoot });

        const toolLogs: any[] = [];
        const gatheredTexts: Array<{
            fileId: string; name: string; bytes: number; truncated: boolean; text: string;
        }> = [];

        const sysPrompt =
            `You are a code analysis assistant. Your job is to directly answer the user's specific question or request about the code.\n` +
            `Use the available tools to explore files and gather information needed to provide a precise, direct answer.\n` +
            `Focus on reading the most relevant files based on the user's query. Provide specific, actionable responses rather than general summaries.\n` +
            `If the user asks about specific functionality, bugs, improvements, or code patterns, give exact answers with code examples where appropriate.`;

        const fsSummary = folderStructure
            ? `Folder structure (JSON):\n${JSON.stringify(folderStructure).slice(0, 5000)}`
            : `No saved folder structure found for this zipFileId.`;

        console.log("📝 Preparing conversation history...");
        const history: any[] = [
            { role: "user", parts: [{ text: sysPrompt }] },
            { role: "user", parts: [{ text: `ZipFileId: ${zipFileId}\nMessage: ${message}` }] },
            { role: "user", parts: [{ text: fsSummary }] },
        ];

        sendProgress("Starting AI analysis of your codebase");

        let response = await ai.models.generateContent({
            model: "gemini-2.0-flash-001",
            contents: history,
            config: {
                tools: [{ functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText] }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            },
        });

        // tool-calling loop (max 10 rounds)
        for (let i = 0; i < 10; i++) {
            const calls = response.functionCalls ?? [];
            sendProgress(`Analysis round ${i + 1} - Processing ${calls.length} operations`, {
                round: i + 1,
                operationsCount: calls.length
            });

            if (!calls.length) {
                sendProgress("Analysis complete - No additional operations required");
                break;
            }

            const fnCall = calls[0];
            const { name, args } = fnCall;

            const t0 = Date.now();
            let result: any;
            try {
                if (name === "listFiles") {
                    send("directory_scan_started", {
                        timestamp: Date.now(),
                        message: "Scanning project directory structure",
                        parameters: args
                    });
                    result = await listFilesTool(args);
                    const ms = Date.now() - t0;
                    toolLogs.push({ name, args, result, duration: ms });
                    send("directory_scan_complete", {
                        durationMs: ms,
                        timestamp: Date.now(),
                        message: `Directory scan completed in ${ms}ms`,
                        summary: summarizeToolResult(result)
                    });
                } else if (name === "getDownloadUrl") {
                    send("file_access_started", {
                        timestamp: Date.now(),
                        message: "Retrieving file access permissions",
                        parameters: args
                    });
                    result = await getDownloadUrlTool(args);
                    const ms = Date.now() - t0;
                    toolLogs.push({ name, args, result, duration: ms });
                    send("file_access_complete", {
                        durationMs: ms,
                        timestamp: Date.now(),
                        message: `File access granted in ${ms}ms`,
                        summary: summarizeToolResult(result)
                    });
                } else if (name === "readFileText") {
                    send("file_analysis_started", {
                        timestamp: Date.now(),
                        message: "Reading and analyzing file content",
                        parameters: args
                    });
                    const out = await readFileTextTool(args, tempRoot);
                    result = out;
                    if (out && typeof out === "object" && "text" in out) {
                        gatheredTexts.push({
                            fileId: out.fileId, name: out.name, bytes: out.bytes,
                            truncated: !!out.truncated, text: out.text,
                        });
                    }
                    const ms = Date.now() - t0;
                    toolLogs.push({ name, args, result, duration: ms });
                    send("file_analysis_complete", {
                        fileName: out?.name || "unknown",
                        fileSizeBytes: out?.bytes || 0,
                        contentTruncated: !!out?.truncated,
                        durationMs: ms,
                        timestamp: Date.now(),
                        message: `File analysis completed for ${out?.name || "file"} (${out?.bytes || 0} bytes) in ${ms}ms`
                    });
                } else {
                    result = { error: `unknown_tool: ${name}` };
                    send("operation_error", {
                        timestamp: Date.now(),
                        message: `Unknown operation requested: ${name}`,
                        operation: name
                    });
                }
            } catch (err: any) {
                const ms = Date.now() - t0;
                toolLogs.push({ name, args, error: err?.message || String(err), duration: ms });
                const operationType = name === "listFiles" ? "directory_scan" :
                    name === "getDownloadUrl" ? "file_access" :
                        name === "readFileText" ? "file_analysis" : "operation";
                sendError(`${operationType.replace('_', ' ')} failed after ${ms}ms`, {
                    operation: name,
                    operationType,
                    durationMs: ms,
                    error: err?.message || String(err)
                });
            }

            // Feed result back
            history.push({ role: "model", parts: [{ functionCall: { name, args } }] });
            history.push({ role: "tool", parts: [{ functionResponse: { name, response: result } }] });

            sendProgress("Continuing analysis with gathered information");
            response = await ai.models.generateContent({
                model: "gemini-2.0-flash-001",
                contents: history,
                config: {
                    tools: [{ functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText] }],
                    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                },
            });
        }

        const finalText = response.text ?? "Analysis completed.";

        // Format the final response as markdown
        const markdownResponse = `# Code Review Analysis
        
        ${finalText}

        ---
        *Analysis completed at ${new Date().toISOString()}*`;

        send("analysis_result", {
            timestamp: Date.now(),
            message: markdownResponse
        });

        send("review_summary", {
            totalOperations: toolLogs.length,
            filesAnalyzed: gatheredTexts.length,
            responseLength: finalText.length,
            timestamp: Date.now(),
            message: `Review completed - Analyzed ${gatheredTexts.length} files with ${toolLogs.length} operations`,
            analyzedFiles: gatheredTexts.map(g => ({
                fileId: g.fileId,
                fileName: g.name,
                fileSizeBytes: g.bytes,
                contentTruncated: g.truncated
            })),
        });

        // // cleanup
        // try {
        //     await rm(tempRoot, { recursive: true, force: true });
        //     sendProgress("Workspace cleanup completed successfully");
        // } catch (e: any) {
        //     sendError("Workspace cleanup failed", {
        //         error: e?.message || String(e)
        //     });
        // }

        send("finished", {
            status: "success",
            timestamp: Date.now(),
            message: "Code review session completed successfully"
        });
        res.end();
    } catch (e: any) {
        sendError("Critical error occurred during code review", {
            error: e?.message || String(e)
        });
        send("finished", {
            status: "failed",
            timestamp: Date.now(),
            message: "Code review session failed due to critical error"
        });
        res.end();
    } finally {
        clearInterval(hb);
    }
});

// Small helper to avoid dumping giant payloads in SSE
function summarizeToolResult(result: any) {
    if (!result) return null;
    if (result.error) return { error: String(result.error) };
    if (result.files || result.folders || result.total) {
        return {
            filesCount: result.files?.length || 0,
            foldersCount: result.folders?.length || 0,
            total: result.total ?? undefined,
            page: result.page ?? undefined,
        };
    }
    if (result.downloadUrl) {
        return { downloadUrlLength: result.downloadUrl.length };
    }
    if (result.text && result.name) {
        return { name: result.name, bytes: result.bytes, truncated: !!result.truncated };
    }
    return Object.keys(result).slice(0, 5);
}


const Body = z.object({
    userId: z.string().min(1),
    zipFileId: z.string().min(1),
    folderStructure: z.any(),
});

app.post("/review-zip", async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
        return res
            .status(400)
            .json({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const { userId, zipFileId, folderStructure } = parsed.data;

    const existing = await db
        .select({ id: reviewZip.id })
        .from(reviewZip)
        .where(and(eq(reviewZip.userId, userId), eq(reviewZip.zipFileId, zipFileId)))
        .limit(1);

    if (existing.length) {
        return res
            .status(409)
            .json({ error: "Already exists for this userId + zipFileId" });
    }

    const id = randomUUID();
    await db.insert(reviewZip).values({ id, userId, zipFileId, folderStructure });

    return res.status(201).json({ id, userId, zipFileId });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});