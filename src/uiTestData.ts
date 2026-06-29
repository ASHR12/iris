type TaskFixture = {
  id: string;
  task: string;
  status: string;
  output?: string;
  error?: string;
  updatedAt: number;
};

type TranscriptFixture = {
  id: string;
  speaker: string;
  text: string;
};

const longResearchResult = [
  "## Summary",
  "",
  "Hermes completed the requested research and organized the result into practical next steps.",
  "",
  "## Key Findings",
  "",
  "- The most useful options are grouped by reliability, cost, and speed.",
  "- The recommended path is to start with the lowest-risk workflow and only automate more once the first pass is stable.",
  "- Any unclear or missing details were handled with conservative assumptions.",
  "",
  "## Suggested Next Steps",
  "",
  "1. Review the shortlist.",
  "2. Pick the highest-confidence option.",
  "3. Ask Iris to send a follow-up task to Hermes with the selected direction.",
  "",
  "## Notes",
  "",
  "This fixture is intentionally long enough to test markdown rendering and gesture scrolling inside the reader.",
  "",
  ...Array.from({ length: 18 }, (_, index) => `- Detail ${index + 1}: representative supporting context for UI scroll testing.`),
].join("\n");

export function makeUiTestData(now = Date.now()): {
  tasks: TaskFixture[];
  transcript: TranscriptFixture[];
} {
  return {
    transcript: [
      {
        id: "fixture-comms-1",
        speaker: "you",
        text: "Iris, can you check unread emails and tell me if anything needs attention?",
      },
      {
        id: "fixture-comms-2",
        speaker: "gemini",
        text: "On it. I handed that to Hermes and I’ll keep chatting while it checks.",
      },
      {
        id: "fixture-comms-3",
        speaker: "you",
        text: "Also compare the latest AI memory tools and give me a useful summary.",
      },
      {
        id: "fixture-comms-4",
        speaker: "gemini",
        text: "Hermes is handling the comparison now. Quick note: I’ll bring the result back here as soon as it returns.",
      },
      {
        id: "fixture-comms-5",
        speaker: "gemini",
        text: "Hermes is back with the email check: there are no unread emails that need attention.",
      },
      {
        id: "fixture-comms-6",
        speaker: "you",
        text: "Great. Open the memory tools result when it’s ready.",
      },
      {
        id: "fixture-comms-7",
        speaker: "gemini",
        text: "Absolutely. I’ll switch context to that Hermes result when it completes, then we can continue normally.",
      },
    ],
    tasks: [
      {
        id: "fixture-run-001-email-check",
        task: "Check unread emails and summarize anything requiring attention.",
        status: "completed",
        output: "No unread emails require action. Recent messages are informational and can be ignored for now.",
        updatedAt: now - 60_000,
      },
      {
        id: "fixture-run-002-memory-tools",
        task: "Compare current AI memory tools and produce a practical recommendation.",
        status: "completed",
        output: longResearchResult,
        updatedAt: now - 120_000,
      },
      {
        id: "fixture-run-002b-email-digest",
        task: "Summarize email digest and highlight action items.",
        status: "completed",
        output: "Email digest summarized. Two informational newsletters, one product update, and no urgent action items.",
        updatedAt: now - 125_000,
      },
      {
        id: "fixture-run-003-repo-audit",
        task: "Audit the Iris repository for open-source readiness.",
        status: "completed",
        output: [
          "## Open-source readiness audit",
          "",
          "- README has setup instructions.",
          "- `.env` is ignored.",
          "- MIT license is present.",
          "- Cross-platform scripts are present.",
          "- Remaining recommendation: add screenshots and a short demo video.",
        ].join("\n"),
        updatedAt: now - 180_000,
      },
      {
        id: "fixture-run-004-hermes-docs",
        task: "Extract important Hermes API setup instructions for new users.",
        status: "completed",
        output: "Users must enable `API_SERVER_ENABLED=true`, set `API_SERVER_KEY`, restart `hermes gateway`, and verify `/health` returns `{ \"status\": \"ok\" }`.",
        updatedAt: now - 240_000,
      },
      {
        id: "fixture-run-004b-hermes-api-client",
        task: "Review Hermes API client error handling and gateway setup.",
        status: "completed",
        output: "Hermes API client review complete. Recommend clearer gateway health errors, timeout handling, and setup docs for packaged app users.",
        updatedAt: now - 245_000,
      },
      {
        id: "fixture-run-005-weekend-post",
        task: "Draft a short launch post for Iris.",
        status: "completed",
        output: "Drafted a concise post explaining Gemini Live as the conversational layer, Hermes as the worker agent, and MediaPipe gestures for hands-free UI control.",
        updatedAt: now - 300_000,
      },
      {
        id: "fixture-run-006-build-package",
        task: "Package Iris as a macOS app and confirm app identity.",
        status: "completed",
        output: "Built `release/mac-arm64/Iris.app`. The bundle name, display name, executable, and icon are configured as Iris.",
        updatedAt: now - 360_000,
      },
      {
        id: "fixture-run-006b-package-readme",
        task: "Package Iris setup notes for README.",
        status: "completed",
        output: "Packaged README notes for macOS and Windows, including `.env` locations, Hermes gateway setup, and unsigned app caveats.",
        updatedAt: now - 365_000,
      },
      {
        id: "fixture-run-007-two-hand-roadmap",
        task: "Design a two-hand gesture roadmap that uses spatial interactions.",
        status: "completed",
        output: "Roadmap created locally. Recommended MVP: two open palms resize the reader, both palms open command overlay, and later two-card compare mode.",
        updatedAt: now - 420_000,
      },
      {
        id: "fixture-run-007b-two-hand-reader",
        task: "Implement two-hand reader resize design.",
        status: "completed",
        output: "Two-hand reader resize implemented as an MVP: two open palms control reader scale, while one open palm still controls scroll.",
        updatedAt: now - 425_000,
      },
      {
        id: "fixture-run-008-ci-check",
        task: "Run build checks and summarize output.",
        status: "working",
        output: "Build is currently running. Waiting for TypeScript and Vite output.",
        updatedAt: now - 30_000,
      },
      {
        id: "fixture-run-009-market-scan",
        task: "Scan examples of voice-first AI desktop apps for UI inspiration.",
        status: "started",
        output: "Initial scan started. Hermes is collecting interface patterns and interaction ideas.",
        updatedAt: now - 15_000,
      },
      {
        id: "fixture-run-010-error-case",
        task: "Test failed-task styling with a simulated error.",
        status: "failed",
        error: "Simulated fixture error: external service returned a temporary 503. This card exists to test failed-state styling.",
        updatedAt: now - 480_000,
      },
    ],
  };
}
