import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronUp, Mic } from "lucide-react";

type Option = { value: string; label: string; missing?: boolean };
type MenuPos = { left: number; top?: number; bottom?: number; mode: "down" | "side" };

const MENU_WIDTH = 260;
const MENU_HEIGHT_ESTIMATE = 170; // header + 3-4 device rows

/**
 * Zoom-style quick device switcher: a small caret beside the AV control pops
 * a menu of attached mics/cameras — no Settings trip.
 *
 * The menu renders through a portal to <body>: panels here use
 * backdrop-filter, which turns them into containing blocks for
 * position:fixed children — a menu rendered in place would be positioned
 * against the PANEL (i.e. drawn off-screen), not the viewport.
 */
export default function DevicePicker({
  kind,
  value,
  onSelect,
  title,
  align = "center",
}: {
  kind: "audioinput" | "videoinput";
  value: string;
  onSelect: (id: string) => void;
  title: string;
  /** Horizontal anchor relative to the trigger: centered, or flush to its right edge. */
  align?: "center" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const fallbackName = kind === "audioinput" ? "Microphone" : "Camera";
        const list = all
          .filter((device) => device.kind === kind && device.deviceId && device.deviceId !== "default")
          .map((device, index) => ({
            value: device.deviceId,
            label: device.label || `${fallbackName} ${index + 1}`,
          }));
        const withDefault: Option[] = [{ value: "", label: "Same as system" }, ...list];
        if (value && !list.some((device) => device.value === value)) {
          withDefault.push({ value, label: "Saved device — not connected", missing: true });
        }
        setOptions(withDefault);
      } catch {
        setOptions([{ value: "", label: "Same as system" }]);
      }
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [open, kind, value]);

  // Close on outside press or Escape. The menu lives in a portal, so check
  // both the trigger and the menu itself before closing (a naive "outside the
  // component" check would swallow menu clicks at pointerdown).
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Open DOWNWARD by default — below the trigger the layout has dead
      // space (camera feed / under the transport buttons), while above it
      // live captions and transcript text must never be covered.
      if (window.innerHeight - rect.bottom >= MENU_HEIGHT_ESTIMATE) {
        const rawLeft = align === "right" ? rect.right - MENU_WIDTH : rect.left + rect.width / 2 - MENU_WIDTH / 2;
        const left = Math.min(Math.max(10, rawLeft), window.innerWidth - MENU_WIDTH - 10);
        setPos({ left, top: rect.bottom + 10, mode: "down" });
      } else {
        // No room below (e.g. the collapsed camera dock hugs the window's
        // bottom edge). Never flip UP over the transcript — fly out to the
        // side instead, rising from the bottom edge over empty deck floor.
        let left = rect.right + 14;
        if (left + MENU_WIDTH > window.innerWidth - 10) left = Math.max(10, rect.left - MENU_WIDTH - 14);
        setPos({ left, bottom: 14, mode: "side" });
      }
    }
    setOpen((current) => !current);
  };

  const KindIcon = kind === "audioinput" ? Mic : Camera;

  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            className={`device-pick-menu ${pos.mode}`}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
          >
            <div className="device-pick-head">
              <KindIcon size={12} />
              {kind === "audioinput" ? "Microphone" : "Camera"}
            </div>
            {options.map((option) => (
              <button
                key={option.value || "default"}
                type="button"
                className={`device-pick-item ${option.value === value ? "active" : ""} ${option.missing ? "missing" : ""}`}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
              >
                <span className="device-pick-check">{option.value === value ? <Check size={13} /> : null}</span>
                <span className="device-pick-label">{option.label}</span>
              </button>
            ))}
            {options.length <= 1 ? <div className="device-pick-empty">No other devices detected</div> : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <span className="device-pick">
      <button
        ref={triggerRef}
        type="button"
        className={`device-pick-trigger ${open ? "open" : ""}`}
        onClick={toggle}
        title={title}
        aria-label={title}
      >
        <ChevronUp size={13} />
      </button>
      {menu}
    </span>
  );
}
