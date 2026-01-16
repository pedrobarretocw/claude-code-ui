import { Box, Flex, Heading, Link, Text, Separator } from "@radix-ui/themes";
import { KanbanColumn } from "./KanbanColumn";
import type { Session, SessionStatus } from "../data/schema";

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour - match daemon setting

/**
 * Get effective status based on elapsed time since last activity.
 * Sessions inactive for 1 hour are considered idle regardless of stored status.
 */
export function getEffectiveStatus(session: Session): SessionStatus {
  const elapsed = Date.now() - new Date(session.lastActivityAt).getTime();
  if (elapsed > IDLE_TIMEOUT_MS) {
    return "idle";
  }
  return session.status;
}

interface RepoSectionProps {
  repoId: string;
  repoUrl: string | null;
  sessions: Session[];
  activityScore: number;
}

export function RepoSection({ repoId, repoUrl, sessions, activityScore }: RepoSectionProps) {
  // Use effective status to categorize sessions (accounts for time-based idle)
  const working = sessions.filter((s) => getEffectiveStatus(s) === "working");
  const needsApproval = sessions.filter(
    (s) => getEffectiveStatus(s) === "waiting" && s.hasPendingToolUse
  );
  const waiting = sessions.filter(
    (s) => getEffectiveStatus(s) === "waiting" && !s.hasPendingToolUse
  );

  // Don't render if only idle sessions exist
  const hasActiveSessions = working.length > 0 || needsApproval.length > 0 || waiting.length > 0;
  if (!hasActiveSessions) {
    return null;
  }

  return (
    <Box mb="12">
      <Flex align="center" gap="3" mb="4">
        <Heading size="6" weight="bold">
          {repoId === "Other" ? (
            <Text color="gray">Other</Text>
          ) : repoUrl ? (
            <Link href={repoUrl} target="_blank" color="violet" highContrast>
              {repoId}
            </Link>
          ) : (
            repoId
          )}
        </Heading>
      </Flex>

      <Flex gap="3" style={{ minHeight: 240 }}>
        <KanbanColumn
          title="Working"
          status="working"
          sessions={working}
          color="green"
        />
        <KanbanColumn
          title="Needs Approval"
          status="needs-approval"
          sessions={needsApproval}
          color="orange"
        />
        <KanbanColumn
          title="Waiting"
          status="waiting"
          sessions={waiting}
          color="yellow"
        />
      </Flex>

      <Separator size="4" mt="6" />
    </Box>
  );
}
