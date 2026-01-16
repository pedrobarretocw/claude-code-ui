import { z } from "zod";
import { createStateSchema } from "@durable-streams/state";

// Session status enum
const SessionStatusSchema = z.enum(["working", "waiting", "idle"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// Pending tool info
const PendingToolSchema = z.object({
  tool: z.string(),
  target: z.string(),
});

// Recent output entry for live view
const RecentOutputSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
});

// CI check status
const CIStatusSchema = z.enum(["pending", "running", "success", "failure", "cancelled", "unknown"]);
export type CIStatus = z.infer<typeof CIStatusSchema>;

// PR info
const PRInfoSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  ciStatus: CIStatusSchema,
  ciChecks: z.array(z.object({
    name: z.string(),
    status: CIStatusSchema,
    url: z.string().nullable(),
  })),
  lastChecked: z.string(),
});

// Main session state schema
const SessionSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  gitBranch: z.string().nullable(),
  gitRepoUrl: z.string().nullable(),
  gitRepoId: z.string().nullable(),
  originalPrompt: z.string(),
  status: SessionStatusSchema,
  lastActivityAt: z.string(), // ISO timestamp
  messageCount: z.number(),
  hasPendingToolUse: z.boolean(),
  pendingTool: PendingToolSchema.nullable(),
  goal: z.string(), // High-level goal of the session
  summary: z.string(), // Current activity summary
  recentOutput: z.array(RecentOutputSchema),
  pr: PRInfoSchema.nullable(), // Associated PR if branch has one
});
export type Session = z.infer<typeof SessionSchema>;

// Create the state schema for durable streams
export const sessionsStateSchema = createStateSchema({
  sessions: {
    schema: SessionSchema,
    type: "session",
    primaryKey: "sessionId",
  },
});
