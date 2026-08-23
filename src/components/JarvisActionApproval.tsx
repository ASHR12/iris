import { ShieldAlert, Check, X } from "lucide-react";

/*
 * Jarvis Action approval (P2.5) — the human gate in front of every Jarvis
 * write action.
 *
 * Deliberately minimal and deliberately inside the existing Ask Jarvis
 * surface (CommsPanel), not a new panel: the approval belongs next to the
 * sentence that caused it.
 *
 * This component decides NOTHING. It renders the preview Jarvis proposed and
 * calls back; the risk level, the "does this need a second approval" flag and
 * the whole state machine live in Jarvis's Action Service, one process over.
 *
 * The one rule encoded here: a destructive action (which Jarvis reports back
 * as status "secondary_approval_required") shows a SEPARATE, differently
 * labeled second button. Approving it is never the same click as the first
 * approval, and that button is never rendered until Jarvis itself asked for
 * it.
 */
export default function JarvisActionApproval({
  previews,
  busyPreviewId,
  onApprove,
  onSecondaryApprove,
  onCancel,
}: {
  previews: JarvisActionPreview[];
  busyPreviewId: string | null;
  onApprove: (preview: JarvisActionPreview) => void;
  onSecondaryApprove: (preview: JarvisActionPreview) => void;
  onCancel: (preview: JarvisActionPreview) => void;
}) {
  if (previews.length === 0) return null;

  return (
    <div className="jarvis-actions">
      {previews.map((preview) => {
        const awaitingSecond = preview.status === "secondary_approval_required";
        const busy = busyPreviewId === preview.previewId;
        const warnings = preview.validation?.warnings ?? [];
        return (
          <div
            className={`jarvis-action${awaitingSecond ? " danger" : ""}`}
            key={preview.previewId}
            data-preview-id={preview.previewId}
            data-risk={preview.riskLevel}
            data-status={preview.status}
          >
            <div className="jarvis-action-head">
              <span className="jarvis-action-label">{preview.label || preview.type}</span>
              <span className={`jarvis-action-risk risk-${preview.riskLevel}`}>{preview.riskLevel}</span>
            </div>
            <p className="jarvis-action-summary">{preview.summary || preview.title}</p>
            {warnings.map((warning) => (
              <p className="jarvis-action-warning" key={warning}>
                <ShieldAlert size={12} /> {warning}
              </p>
            ))}
            {awaitingSecond ? (
              <p className="jarvis-action-warning">
                <ShieldAlert size={12} /> Diese Aktion ist nicht umkehrbar und braucht eine zweite, ausdrückliche Freigabe.
              </p>
            ) : null}
            <div className="jarvis-action-buttons">
              {awaitingSecond ? (
                <button
                  className="jarvis-action-confirm danger"
                  disabled={busy}
                  onClick={() => onSecondaryApprove(preview)}
                >
                  <Check size={13} /> Endgültig ausführen
                </button>
              ) : (
                <button className="jarvis-action-confirm" disabled={busy} onClick={() => onApprove(preview)}>
                  <Check size={13} /> Freigeben
                </button>
              )}
              <button className="jarvis-action-reject" disabled={busy} onClick={() => onCancel(preview)}>
                <X size={13} /> Verwerfen
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
