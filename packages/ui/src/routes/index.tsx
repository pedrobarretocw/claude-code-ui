import { createFileRoute } from "@tanstack/react-router";
import { Flex, Text } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { RepoSection, getEffectiveStatus } from "../components/RepoSection";
import { useSessions, groupSessionsByRepo } from "../hooks/useSessions";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const { sessions } = useSessions();

  // Force re-render every minute to update relative times and activity scores
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Check if there are any active (non-idle) sessions
  const hasActiveSessions = sessions.some((s) => {
    const status = getEffectiveStatus(s);
    return status === "working" || status === "waiting";
  });

  if (sessions.length === 0 || !hasActiveSessions) {
    return (
      <Flex direction="column" align="center" gap="3" py="9">
        <Text color="gray" size="3">
          No active sessions
        </Text>
        <Text color="gray" size="2">
          {sessions.length === 0
            ? "Start a Claude Code session to see it here"
            : "All sessions are currently idle"}
        </Text>
      </Flex>
    );
  }

  const repoGroups = groupSessionsByRepo(sessions);

  return (
    <Flex direction="column">
      {repoGroups.map((group) => (
        <RepoSection
          key={group.repoId}
          repoId={group.repoId}
          repoUrl={group.repoUrl}
          sessions={group.sessions}
          activityScore={group.activityScore}
        />
      ))}
    </Flex>
  );
}
