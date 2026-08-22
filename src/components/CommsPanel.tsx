import { type FormEvent, type RefObject } from "react";
import { MessageSquare, Send } from "lucide-react";
import type { TranscriptLine } from "../types";
import JarvisActionApproval from "./JarvisActionApproval";

export default function CommsPanel({
  transcript,
  scrollRef,
  testDataEnabled,
  onLoadDemo,
  textDraft,
  onTextDraftChange,
  onSendText,
  textSending,
  actionPreviews = [],
  actionBusyId = null,
  onApproveAction = () => {},
  onSecondaryApproveAction = () => {},
  onCancelAction = () => {},
}: {
  transcript: TranscriptLine[];
  scrollRef: RefObject<HTMLDivElement | null>;
  testDataEnabled: boolean;
  onLoadDemo: () => void;
  textDraft: string;
  onTextDraftChange: (value: string) => void;
  onSendText: (text: string) => void;
  textSending: boolean;
  // Jarvis Actions & Approvals (P2.5) — rendered inside the existing Ask
  // Jarvis surface, directly above the composer, so the approval sits next
  // to the sentence that produced it. All optional with safe defaults, so
  // nothing about the existing transcript/composer behaviour changes.
  actionPreviews?: JarvisActionPreview[];
  actionBusyId?: string | null;
  onApproveAction?: (preview: JarvisActionPreview) => void;
  onSecondaryApproveAction?: (preview: JarvisActionPreview) => void;
  onCancelAction?: (preview: JarvisActionPreview) => void;
}) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSendText(textDraft);
  }

  return (
    <section className="deck-panel comms">
      <div className="col-head">
        <MessageSquare size={13} />
        <span>Kommunikation</span>
      </div>
      <div className="comms-scroll" ref={scrollRef}>
        {transcript.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">
              <MessageSquare size={19} />
            </span>
            <p>Noch kein Gespräch</p>
            <small>Schreib unten, oder weck Iris und sprich – alles landet hier.</small>
            {testDataEnabled ? (
              <button className="demo-load" onClick={onLoadDemo}>
                Load demo comms
              </button>
            ) : null}
          </div>
        ) : (
          transcript.map((line) => {
            const self = /you|user/i.test(line.speaker);
            const jarvisError = line.speaker === "jarvis-error";
            const fromJarvis = !jarvisError && /jarvis/i.test(line.speaker);
            const who = self ? "You" : jarvisError ? "Jarvis ⚠" : fromJarvis ? "Jarvis" : "Iris";
            const kind = self ? "self" : jarvisError ? "jarvis-error" : fromJarvis ? "jarvis" : "iris";
            return (
              <div className={`bubble ${kind}`} key={line.id}>
                <span className="who">{who}</span>
                {line.text}
              </div>
            );
          })
        )}
      </div>
      <JarvisActionApproval
        previews={actionPreviews}
        busyPreviewId={actionBusyId}
        onApprove={onApproveAction}
        onSecondaryApprove={onSecondaryApproveAction}
        onCancel={onCancelAction}
      />
      {/* Always enabled — independent of voice/sidecar/wake state, so Jarvis
          stays usable by text with no Gemini key and no active voice session. */}
      <form className="comms-composer" onSubmit={handleSubmit}>
        <input
          type="text"
          value={textDraft}
          onChange={(event) => onTextDraftChange(event.target.value)}
          placeholder="Nachricht an Jarvis…"
          disabled={textSending}
          aria-label="Nachricht an Jarvis"
        />
        <button type="submit" disabled={textSending || !textDraft.trim()} title="Send to Jarvis">
          <Send size={15} />
        </button>
      </form>
    </section>
  );
}
