import { type RefObject } from "react";
import { MessageSquare } from "lucide-react";
import type { TranscriptLine } from "../types";

export default function CommsPanel({
  transcript,
  scrollRef,
  testDataEnabled,
  onLoadDemo,
}: {
  transcript: TranscriptLine[];
  scrollRef: RefObject<HTMLDivElement | null>;
  testDataEnabled: boolean;
  onLoadDemo: () => void;
}) {
  return (
    <section className="deck-panel comms">
      <div className="col-head">
        <MessageSquare size={13} />
        <span>Comms</span>
      </div>
      <div className="comms-scroll" ref={scrollRef}>
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
            return (
              <div className={`bubble ${self ? "self" : "iris"}`} key={line.id}>
                <span className="who">{self ? "You" : "Iris"}</span>
                {line.text}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
