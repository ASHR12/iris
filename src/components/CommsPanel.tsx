import { Fragment, useRef, type RefObject, type UIEvent } from "react";
import { MessageSquare } from "lucide-react";
import type { TranscriptLine } from "../types";

// Restored turns can be days old, so a bare list of bubbles would read as one
// continuous conversation. A divider is emitted whenever the day changes, and
// the live part of the conversation carries no stamp at all.
function dayLabel(at: number): string {
  const when = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(when, today)) return "Today";
  if (sameDay(when, yesterday)) return "Yesterday";
  return when.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export default function CommsPanel({
  transcript,
  scrollRef,
  testDataEnabled,
  hasOlder = false,
  onLoadOlder,
  onLoadDemo,
}: {
  transcript: TranscriptLine[];
  scrollRef: RefObject<HTMLDivElement | null>;
  testDataEnabled: boolean;
  hasOlder?: boolean;
  onLoadOlder?: () => void;
  onLoadDemo: () => void;
}) {
  // Only an upward scroll asks for more. Nearness to the top alone would fire
  // on the very first render, when the panel is at zero on its way down to the
  // newest line, and pull a page of history nobody asked for.
  const lastTopRef = useRef(0);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const { scrollTop } = event.currentTarget;
    const movingUp = scrollTop < lastTopRef.current;
    lastTopRef.current = scrollTop;
    if (hasOlder && movingUp && scrollTop < 48) onLoadOlder?.();
  }

  let lastDay = "";

  return (
    <section className="deck-panel comms">
      <div className="col-head">
        <MessageSquare size={13} />
        <span>Comms</span>
      </div>
      <div className="comms-scroll" ref={scrollRef} onScroll={onScroll}>
        {transcript.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">
              <MessageSquare size={19} />
            </span>
            <p>No conversation yet</p>
            <small>Wake Iris and start talking — everything you say lands here.</small>
            {testDataEnabled ? (
              <button className="demo-load" onClick={onLoadDemo}>
                Load demo comms
              </button>
            ) : null}
          </div>
        ) : (
          transcript.map((line) => {
            const self = /you|user/i.test(line.speaker);
            const day = line.at ? dayLabel(line.at) : "";
            const divider = day && day !== lastDay ? day : "";
            if (day) lastDay = day;
            // A fragment, not a wrapper: the bubbles are direct children of a
            // flex column and rely on align-self to pick their side.
            return (
              <Fragment key={line.id}>
                {divider ? <div className="comms-day">{divider}</div> : null}
                <div className={`bubble ${self ? "self" : "iris"}`}>
                  <span className="who">{self ? "You" : "Iris"}</span>
                  {line.text}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </section>
  );
}
