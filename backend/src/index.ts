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
import { chatConversations, chatMessages, reviewZip } from "./db/schema.js";
import { asc, eq, and } from "drizzle-orm";

dotenv.config();

import cors from "cors";
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
const PORT = Number(process.env.PORT || 3000);

app.get("/", (_req, res) => {
    res.json({ message: "Backend is running" });
});

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

const ReviewBody = z.object({
    userId: z.string().min(1),
    zipFileId: z.string().min(1),
    message: z.string().min(1),
    conversationId: z.string().optional(),
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
    const parts = name.split(".");
    if (parts.length < 2) return false;
    const ext = "." + parts[parts.length - 1].toLowerCase();
    return TEXT_EXTS.has(ext);
}


// clamp helper
function toPosInt(v: unknown, fallback: number) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Store the original rootLocation globally to prevent it from being overwritten
let ORIGINAL_ROOT_LOCATION: string | null = null;

function validateLocation(location: string, rootLocation: string): string {
    // Ensure the location always starts with or is the rootLocation
    if (!location || typeof location !== "string") {
        return rootLocation;
    }

    // If location is exactly the rootLocation, use it
    if (location === rootLocation) {
        return location;
    }

    // If location starts with rootLocation, use it as is
    if (location.startsWith(rootLocation)) {
        return location;
    }

    // If location doesn't start with rootLocation, prepend it
    const cleanLocation = location.startsWith('/') ? location.slice(1) : location;
    const cleanRoot = rootLocation.endsWith('/') ? rootLocation.slice(0, -1) : rootLocation;
    return `${cleanRoot}/${cleanLocation}`;
}

async function listFilesTool(args: any) {
    const { location } = args ?? {};
    if (!location || typeof location !== "string") {
        throw new Error("listFiles: 'location' is required");
    }

    // Validate location against the original root location
    const validatedLocation = ORIGINAL_ROOT_LOCATION
        ? validateLocation(location, ORIGINAL_ROOT_LOCATION)
        : location;

    const limit = Math.min(100, toPosInt(args?.limit, 100));
    const page = toPosInt(args?.page, 1);

    console.log("listFilesTool", { originalLocation: location, validatedLocation, limit, page, rootLocation: ORIGINAL_ROOT_LOCATION });

    const resp = await namespace.getFiles?.({
        location: validatedLocation,
        limit,
        page,
    });

    return resp ?? { files: [], folders: [], page, totalPages: 1, total: 0 };
}

async function getDownloadUrlTool(args: any) {
    const { fileId, expiry = "1h" } = args ?? {};
    if (!fileId) throw new Error("fileId is required");
    const file = trelae.file(fileId);
    const url = await file.getDownloadUrl?.({ expiry });
    return { downloadUrl: url };
}

async function readFileTextTool(args: any, tempRoot: string) {
    const { fileId, name = "unknown", maxBytes = 512 * 1024 } = args ?? {};
    if (!fileId) throw new Error("fileId is required");
    if (!isProbablyText(name)) {
        return { name, fileId, skipped: true, reason: "Non-text or unrecognized extension" };
    }
    const file = trelae.file(fileId);
    const url = await file.getDownloadUrl?.({ expiry: "30m" });
    if (!url) throw new Error("Could not get download URL");

    // temp download (first maxBytes) then read
    const safeFileName = name.replace(/[<>:"/\\|?*]/g, "_");
    const tmpPath = join(tempRoot, `${randomUUID()}-${safeFileName}`);
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Download failed: ${r.status} ${r.statusText}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
        await writeFile(tmpPath, slice);
        const text = await readFile(tmpPath, "utf8");
        return {
            fileId,
            name,
            bytes: slice.length,
            truncated: buf.length > slice.length,
            text,
        };
    } finally {
        await rm(tmpPath, { force: true }).catch(() => { });
    }
}

// ======== Function Declarations for Gemini ========
const fnListFiles: FunctionDeclaration = {
    name: "listFiles",
    description: "List files/folders in a Trelae namespace with explicit pagination (no search).",
    parametersJsonSchema: {
        type: "object",
        properties: {
            location: { type: "string", description: "Folder path to list" },
            limit: { type: "number", description: "Max results per page" },
            page: { type: "number", description: "Page number (1-based)" },
        },
        required: ["location"]
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


// SSE review endpoint
app.post("/ai/review/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    req.socket.setTimeout(0);
    res.flushHeaders?.();

    const send = (event: string, data: any) => {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        res.write(`event: ${event}\n`);
        res.write(`data: ${payload}\n\n`);
    };
    const sendProgress = (message: string, details?: any) =>
        send("progress", { timestamp: Date.now(), message, status: "processing", ...(details ?? {}) });
    const sendError = (message: string, details?: any) =>
        send("error", { timestamp: Date.now(), message, status: "error", ...(details ?? {}) });

    const hb = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);

    try {
        send("start", { message: "Initializing AI code review session", timestamp: Date.now(), status: "started" });

        const parsed = ReviewBody.safeParse(req.body);
        if (!parsed.success) {
            sendError("Request validation failed - Invalid request body format", { validationErrors: parsed.error.flatten() });
            send("done", { status: "failed", timestamp: Date.now() });
            return res.end();
        }
        const { userId, zipFileId, message, conversationId } = parsed.data;
        sendProgress("Request validated successfully", { userId, zipFileId, messageLength: message.length, hasConversation: !!conversationId });

        if (!process.env.GEMINI_API_KEY) {
            sendError("Configuration error - Missing Gemini API key");
            send("done", { status: "failed", timestamp: Date.now() });
            return res.end();
        }

        // Load saved structure
        let folderStructure: any = null;
        try {
            sendProgress("Retrieving project structure from database");
            const r = await pool.query(
                `SELECT folder_structure FROM review_zip WHERE zip_file_id = $1 AND user_id = $2 LIMIT 1`,
                [zipFileId, userId]
            );
            if (r.rowCount) {
                folderStructure = r.rows[0].folder_structure;
                send("folder_structure", { status: "found", timestamp: Date.now(), message: "Project structure loaded successfully" });
            } else {
                send("folder_structure", { status: "not_found", timestamp: Date.now(), message: "No saved project structure found - will analyze files directly" });
            }
        } catch (e: any) {
            sendError("Database query failed while fetching project structure", { error: e?.message || String(e) });
        }

        // Set the original root location globally
        const rootLocation = folderStructure?.rootLocation ? String(folderStructure.rootLocation) : "(unknown)";
        ORIGINAL_ROOT_LOCATION = rootLocation !== "(unknown)" ? rootLocation : null;

        console.log("Setting ORIGINAL_ROOT_LOCATION to:", ORIGINAL_ROOT_LOCATION);

        // Conversation history (load + save user turn)
        let priorTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
        if (conversationId) {
            try {
                const rows = await db
                    .select({ role: chatMessages.role, content: chatMessages.content })
                    .from(chatMessages)
                    .where(eq(chatMessages.conversationId, conversationId))
                    .orderBy(asc(chatMessages.createdAt));
                priorTurns = rows.map(r => ({ role: r.role === "assistant" ? "assistant" as const : "user" as const, content: r.content })).slice(-5);
                if (rows.length) send("history_loaded", { timestamp: Date.now(), message: `Loaded ${rows.length} prior messages` });
            } catch (e: any) {
                sendError("Failed to load prior messages", { error: e?.message || String(e) });
            }
            try {
                await db.insert(chatMessages).values({
                    id: randomUUID(),
                    conversationId,
                    userId,
                    role: "user",
                    content: message,
                    metadata: { source: "chat", zipFileId },
                });
                send("message_saved", { role: "user", timestamp: Date.now() });
            } catch (e: any) {
                sendError("Failed to save user message", { error: e?.message || String(e) });
            }
        }

        const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-001";
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const tempRoot = path.resolve("src/lib/review-tmp");
        await fsPromises.mkdir(tempRoot, { recursive: true });

        const toolLogs: any[] = [];
        const gatheredTexts: Array<{ fileId: string; name: string; bytes: number; truncated: boolean; text: string }> = [];

        // ===== Strong system prompt =====
        const sysPrompt = [
            "ROLE: You are a meticulous code analysis assistant with TOOL ACCESS.",
            "CONTEXT:",
            "- All project files live under a single Trelae namespace.",
            `- The root folder for this upload is: ${rootLocation}`,
            "- CRITICAL: Always navigate from this root location. Never change or override it.",
            "",
            "TOOLS YOU CAN CALL:",
            "1) listFiles({ location, limit?, page? })",
            "   • Enumerate files and folders **for a specific location only**.",
            "   • IMPORTANT: Always use full paths starting from the root location.",
            `   • To explore subdirectories, use: ${rootLocation}/subdirectory`,
            "   • Example: If you want to check 'src' folder, use location: '${rootLocation}/src'",
            "2) readFileText({ fileId, name, maxBytes? })",
            "   • Read text content for a specific file. Only call this after you've located the file via listFiles.",
            "3) getDownloadUrl({ fileId, expiry? })",
            "   • Generate a temporary download link (only if the user asks).",
            "",
            "TRAVERSAL STRATEGY:",
            "- NEVER use patterns, globs, or relative paths. Always use absolute paths from root.",
            `- Start with listFiles({ location: "${rootLocation}" }).`,
            "- From the returned folders, navigate to subdirectories by appending to the root path.",
            `- Example navigation: ${rootLocation} → ${rootLocation}/src → ${rootLocation}/src/components`,
            "- Continue this pattern until you find key files and folders.",
            "",
            "PRIORITIZE READING THESE ANCHORS:",
            "- package.json, tsconfig.json, vite/svelte/next configs, entrypoints (src/main.*, +layout.svelte), routes, key components (*.svelte, *.tsx), utilities, env/config files.",
            "- Read only what you need; keep reads small and targeted.",
            "",
            "DOWNLOADS:",
            "- When the user requests a download link for a file, call getDownloadUrl with the located fileId.",
            "",
            "OUTPUT STYLE:",
            "- Answer in clear Markdown with short sections.",
            "- Include concrete findings, file paths, and recommended fixes with small code snippets.",
            "- If something is missing, explain what you did, what was found, and next steps.",
            "",
            "VERY IMPORTANT:",
            "- Do not request external web access.",
            "- Do not ask for file IDs; resolve them via listFiles.",
            "- Prefer decisive, useful answers over generic disclaimers.",
            "- Keep in mind that no need of answering all questions asked by user only as for the latest one if he asks about any older thing try to use that from history as well",
            `- NEVER change the root location ${rootLocation} - this is where all navigation starts from`,
            "- Always validate that your location parameters start with the root location",
        ].join('\\n');


        const fsSummary = folderStructure
            ? `Folder structure (JSON, truncated):\n${JSON.stringify(folderStructure).slice(0, 5000)}`
            : `No saved folder structure found for this zipFileId.`;

        const history: any[] = [
            { role: "user", parts: [{ text: sysPrompt }] },
            { role: "user", parts: [{ text: fsSummary }] },
            ...priorTurns.map(t =>
                t.role === "user"
                    ? ({ role: "user", parts: [{ text: t.content }] })
                    : ({ role: "model", parts: [{ text: t.content }] })
            ),
            { role: "user", parts: [{ text: `ZipFileId: ${zipFileId}\n\nMessage:\n${message}` }] },
        ];

        sendProgress("Starting AI analysis of your codebase", { rootLocation });

        let response = await ai.models.generateContent({
            model: MODEL,
            contents: history,
            config: {
                tools: [{ functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText] }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                temperature: 0.2,
                maxOutputTokens: 2048
            },
        });

        // 🔧 seed the model if it didn't call any tools initially
        if (!(response.functionCalls?.length) && ORIGINAL_ROOT_LOCATION) {
            sendProgress("No tool calls in first turn — seeding with a root folder listing");
            const args = { location: ORIGINAL_ROOT_LOCATION, limit: 100, page: 1 };
            console.log("Seeding with rootLocation:", ORIGINAL_ROOT_LOCATION);
            const listing = await listFilesTool(args);
            history.push({ role: "model", parts: [{ functionCall: { name: "listFiles", args } }] });
            history.push({ role: "tool", parts: [{ functionResponse: { name: "listFiles", response: listing } }] });
            response = await ai.models.generateContent({
                model: MODEL,
                contents: history,
                config: {
                    tools: [{ functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText] }],
                    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                    temperature: 0.2,
                    maxOutputTokens: 2048
                },
            });
        }


        // tool loop — process ALL calls per round
        for (let round = 0; round < 20; round++) {
            const calls = response.functionCalls ?? [];
            sendProgress(`Analysis round ${round + 1} - Processing ${calls.length} operations`, { round: round + 1, operationsCount: calls.length });

            if (!calls.length) {
                sendProgress("Analysis complete - No additional operations required");
                break;
            }

            for (const fnCall of calls) {
                const { name, args } = fnCall;
                const t0 = Date.now();
                let result: any;

                try {
                    if (name === "listFiles") {
                        send("directory_scan_started", { timestamp: Date.now(), message: "Scanning project directory structure", parameters: args });
                        console.log("Processing listFiles with args:", args, "rootLocation:", ORIGINAL_ROOT_LOCATION);
                        result = await listFilesTool(args);
                        const ms = Date.now() - t0;
                        toolLogs.push({ name, args, result, duration: ms });
                        send("directory_scan_complete", { durationMs: ms, timestamp: Date.now(), message: `Directory scan completed in ${ms}ms`, summary: summarizeToolResult(result) });
                    } else if (name === "getDownloadUrl") {
                        send("file_access_started", { timestamp: Date.now(), message: "Retrieving file access permissions", parameters: args });
                        result = await getDownloadUrlTool(args);
                        const ms = Date.now() - t0;
                        toolLogs.push({ name, args, result, duration: ms });
                        send("file_access_complete", { durationMs: ms, timestamp: Date.now(), message: `File access granted in ${ms}ms`, summary: summarizeToolResult(result) });
                    } else if (name === "readFileText") {
                        send("file_analysis_started", { timestamp: Date.now(), message: "Reading and analyzing file content", parameters: args });
                        const out = await readFileTextTool(args, tempRoot);
                        result = out;
                        if (out && typeof out === "object" && "text" in out) {
                            gatheredTexts.push({
                                fileId: out.fileId,
                                name: out.name,
                                bytes: out.bytes ?? 0,
                                truncated: !!out.truncated,
                                text: out.text ?? "",
                            });
                        }
                        const ms = Date.now() - t0;
                        toolLogs.push({ name, args, result, duration: ms });
                        send("file_analysis_complete", {
                            fileName: out?.name || "unknown",
                            fileSizeBytes: typeof (out as any)?.bytes === "number" ? (out as any).bytes : 0,
                            contentTruncated: "truncated" in out ? !!(out as any).truncated : false,
                            durationMs: ms,
                            timestamp: Date.now(),
                            message: `File analysis completed for ${out?.name || "file"} in ${ms}ms`,
                        });
                    } else if (name === "findInTree") {
                        send("progress", { timestamp: Date.now(), message: "Searching folders recursively", parameters: args });
                        // result = await findInTreeTool(args);
                        const ms = Date.now() - t0;
                        toolLogs.push({ name, args, result, duration: ms });
                        send("review_summary", { timestamp: Date.now(), message: `Recursive search scanned ${result.scannedFolders} folders, found ${result.matches.length} matches`, summary: summarizeToolResult(result) });
                    } else {
                        result = { error: `unknown_tool: ${name}` };
                        send("operation_error", { timestamp: Date.now(), message: `Unknown operation requested: ${name}`, operation: name });
                    }
                } catch (err: any) {
                    const ms = Date.now() - t0;
                    toolLogs.push({ name, args, error: err?.message || String(err), duration: ms });
                    const operationType =
                        name === "listFiles" ? "directory_scan" :
                            name === "getDownloadUrl" ? "file_access" :
                                name === "readFileText" ? "file_analysis" :
                                    name === "findInTree" ? "search" :
                                        "operation";
                    sendError(`${operationType} failed after ${ms}ms`, { operation: name, operationType, durationMs: ms, error: err?.message || String(err) });
                    result = { error: err?.message || String(err) };
                }

                // feed result back
                history.push({ role: "model", parts: [{ functionCall: { name, args } }] });
                history.push({ role: "tool", parts: [{ functionResponse: { name, response: result } }] });
            }

            // continue the dialog
            sendProgress("Continuing analysis with gathered information");
            response = await ai.models.generateContent({
                model: MODEL,
                contents: history,
                config: {
                    tools: [{ functionDeclarations: [fnListFiles, fnGetDownloadUrl, fnReadFileText] }],
                    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                    temperature: 0.2,
                    maxOutputTokens: 2048
                },
            });
        }

        // Final text (fallback if model returns an unhelpful generic)
        let finalText = (response.text ?? "").trim();
        const unhelpful = /cannot\s+answer|cannot\s+fulfill|not\s+available\s+to\s+me/i.test(finalText) || finalText.length < 20;

        if (unhelpful) {
            const filesList = gatheredTexts.map(g => `- \`${g.name}\` (${g.bytes} bytes${g.truncated ? ", truncated" : ""})`).join("\n");
            finalText = [
                "### What I analyzed",
                filesList || "_No files were read. If you expected files, ensure the structure was saved and I will search again using the tools._",
                "",
                "### Next steps",
                `- Tell me what to focus on (e.g., a specific path or feature), or just say "explain the project structure".`,
                "- I can also search recursively for files by name or pattern (e.g., `**/*.svelte`) and then read them.",
            ].join("\n");
        }

        const markdownResponse = `# Code Review Analysis
        ${finalText}

        ---

        *Analysis completed at ${new Date().toISOString()}*`;

        send("analysis_result", { timestamp: Date.now(), message: markdownResponse });

        send("review_summary", {
            totalOperations: toolLogs.length,
            filesAnalyzed: gatheredTexts.length,
            responseLength: markdownResponse.length,
            timestamp: Date.now(),
            message: `Review completed — analyzed ${gatheredTexts.length} files with ${toolLogs.length} tool ops`,
            analyzedFiles: gatheredTexts.map(g => ({
                fileId: g.fileId,
                fileName: g.name,
                fileSizeBytes: g.bytes,
                contentTruncated: g.truncated
            })),
        });

        if (conversationId) {
            try {
                await db.insert(chatMessages).values({
                    id: randomUUID(),
                    conversationId,
                    userId,
                    role: "assistant",
                    content: markdownResponse,
                    metadata: {
                        toolOps: toolLogs.length,
                        filesAnalyzed: gatheredTexts.length,
                        finishedAt: new Date().toISOString(),
                    },
                });
                send("message_saved", { role: "assistant", timestamp: Date.now() });
            } catch (e: any) {
                sendError("Failed to save assistant message", { error: e?.message || String(e) });
            }
        }

        send("finished", { status: "success", timestamp: Date.now(), message: "Code review session completed successfully" });
        res.end();
    } catch (e: any) {
        sendError("Critical error occurred during code review", { error: e?.message || String(e) });
        send("finished", { status: "failed", timestamp: Date.now(), message: "Code review session failed due to critical error" });
        res.end();
    } finally {
        clearInterval(hb);
        // Reset the global rootLocation after processing
        ORIGINAL_ROOT_LOCATION = null;
    }
});

// helper for SSE summaries
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
    if (result.matches && typeof result.scannedFolders === "number") {
        return {
            matches: result.matches.length,
            scannedFolders: result.scannedFolders,
            scannedFiles: result.scannedFiles,
            limitReached: !!result.limitReached
        };
    }
    if (result.downloadUrl) return { downloadUrlLength: result.downloadUrl.length };
    if (result.text && result.name) return { name: result.name, bytes: result.bytes, truncated: !!result.truncated };
    return Object.keys(result).slice(0, 5);
}

// persist structure once per upload
const Body = z.object({
    userId: z.string().min(1),
    zipFileId: z.string().min(1),
    folderStructure: z.any(),
});

app.post("/review-zip", async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const { userId, zipFileId, folderStructure } = parsed.data;

    const existing = await db
        .select({ id: reviewZip.id })
        .from(reviewZip)
        .where(and(eq(reviewZip.userId, userId), eq(reviewZip.zipFileId, zipFileId)))
        .limit(1);

    if (existing.length) {
        return res.status(409).json({ error: "Already exists for this userId + zipFileId" });
    }

    const id = randomUUID();
    await db.insert(reviewZip).values({ id, userId, zipFileId, folderStructure });

    return res.status(201).json({ id, userId, zipFileId });
});

// META endpoint used by the frontend hydrate()
app.get("/review-zip/meta", async (req, res) => {
    const { userId, zipFileId } = req.query as { userId?: string; zipFileId?: string };
    if (!userId || !zipFileId) return res.status(400).json({ error: "userId and zipFileId required" });
    try {
        const r = await pool.query(
            `SELECT folder_structure, created_at FROM review_zip WHERE user_id=$1 AND zip_file_id=$2 LIMIT 1`,
            [userId, zipFileId]
        );
        if (!r.rowCount) return res.json({ exists: false });
        const fs = r.rows[0].folder_structure || null;
        res.json({ exists: true, rootLocation: fs?.rootLocation || null, folderStructure: fs, createdAt: r.rows[0].created_at });
    } catch (e: any) {
        res.status(500).json({ error: e?.message || "failed" });
    }
});

// Conversations list for a user (optional zip filter)
app.get("/chat/conversations", async (req, res) => {
    const { userId, zipFileId } = req.query as { userId?: string; zipFileId?: string };
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
        const params: any[] = [userId];
        let filterZip = "";
        if (zipFileId) { params.push(zipFileId); filterZip = "AND c.zip_file_id = $2"; }
        const q = `
      SELECT c.id, c.user_id, c.zip_file_id, c.title, c.created_at, c.updated_at,
             MAX(m.created_at) AS last_message_at, COUNT(m.id) AS message_count
      FROM chat_conversations c
      LEFT JOIN chat_messages m ON m.conversation_id = c.id
      WHERE c.user_id = $1 ${filterZip}
      GROUP BY c.id
      ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC
      LIMIT 100
    `;
        const r = await pool.query(q, params);
        res.json({ conversations: r.rows });
    } catch (e: any) {
        res.status(500).json({ error: e?.message || "failed" });
    }
});

// conversation helpers (unchanged)
app.post("/chat/start", async (req, res) => {
    const { userId, zipFileId, title } = req.body || {};
    if (!userId || !zipFileId) {
        return res.status(400).json({ error: "userId and zipFileId are required" });
    }
    try {
        const id = randomUUID();
        await db.insert(chatConversations).values({
            id,
            userId,
            zipFileId,
            title: (typeof title === "string" && title.trim()) ? title.trim() : "New chat",
        });
        return res.status(201).json({ conversationId: id });
    } catch (e: any) {
        return res.status(500).json({ error: e?.message || "Failed to start chat" });
    }
});

app.get("/chat/:conversationId/messages", async (req, res) => {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: "conversationId required" });
    try {
        const rows = await db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.conversationId, conversationId))
            .orderBy(asc(chatMessages.createdAt));
        return res.json({ messages: rows });
    } catch (e: any) {
        return res.status(500).json({ error: e?.message || "Failed to load messages" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});