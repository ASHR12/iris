import { useEffect, useMemo, useState } from "react";
import { KeyRound, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import type { TaskCard } from "../types";

const approvalLabel = (choice: string) =>
  choice === "once"
    ? "Allow once"
    : choice === "session"
      ? "Allow this session"
      : choice === "always"
        ? "Always allow"
        : "Deny";

export default function HermesInteractionPrompt({
  task,
  onResolve,
}: {
  task: TaskCard;
  onResolve: (
    value: string,
    choice?: "once" | "session" | "always" | "deny",
  ) => void;
}) {
  const interaction = task.interaction;
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const secure = interaction?.secret === true;
  const approval = interaction?.type === "approval";
  const choices = interaction?.choices ?? [];
  const answer = selected ?? draft.trim();
  const canSubmit = secure ? draft.length > 0 : answer.length > 0;
  const Icon = secure ? KeyRound : approval ? ShieldAlert : MessageCircleQuestion;
  const title = secure
    ? interaction?.type === "sudo"
      ? "Sudo password required"
      : "Secret required"
    : approval
      ? "Hermes needs approval"
      : "Hermes needs your input";
  const inputLabel = useMemo(() => {
    if (interaction?.type === "sudo") return "Password";
    if (interaction?.type === "secret") {
      return interaction.envVar ? `Value for ${interaction.envVar}` : "Secret value";
    }
    return choices.length ? "Other answer" : "Your answer";
  }, [choices.length, interaction?.envVar, interaction?.type]);

  useEffect(() => {
    setSelected(null);
    setDraft("");
  }, [interaction?.id]);

  useEffect(() => {
    const voiceValue = interaction?.voiceValue;
    if (voiceValue === undefined) return;
    const matchingChoice = choices.find(
      (choice) => choice.trim().toLowerCase() === voiceValue.trim().toLowerCase(),
    );
    if (matchingChoice) {
      setSelected(matchingChoice);
      setDraft("");
    } else {
      setSelected(null);
      setDraft(voiceValue);
    }
  }, [choices, interaction?.voiceValue]);

  if (!interaction) return null;

  const submit = () => {
    if (!canSubmit || interaction.resolving) return;
    const choice =
      approval && selected && ["once", "session", "always", "deny"].includes(selected)
        ? (selected as "once" | "session" | "always" | "deny")
        : undefined;
    onResolve(answer, choice);
  };
  const cancel = () => {
    if (interaction.resolving) return;
    onResolve("", approval ? "deny" : undefined);
  };

  return (
    <section
      className={`hermes-interaction-prompt hud-hit ${secure ? "secure" : ""}`}
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="hermes-interaction-title"
    >
      <header>
        <Icon size={18} />
        <div>
          <strong id="hermes-interaction-title">{title}</strong>
          <span>{task.task}</span>
        </div>
      </header>

      <p className="interaction-question">{interaction.question}</p>
      {interaction.command ? <code>{interaction.command}</code> : null}

      {choices.length ? (
        <div className="interaction-choices">
          {choices.map((choice, index) => (
            <button
              key={`${choice}-${index}`}
              type="button"
              className={`${selected === choice ? "selected" : ""} ${choice === "deny" ? "deny" : ""}`}
              disabled={interaction.resolving}
              onClick={() => {
                setSelected(choice);
                setDraft("");
              }}
            >
              <kbd>{String.fromCharCode(65 + index)}</kbd>
              <span>{approval ? approvalLabel(choice) : choice}</span>
            </button>
          ))}
        </div>
      ) : null}

      {interaction.allowCustom ? (
        <label>
          <span>{inputLabel}</span>
          {secure ? (
            <input
              autoFocus
              type="password"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setSelected(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
          ) : (
            <textarea
              autoFocus={!choices.length}
              value={draft}
              rows={2}
              onChange={(event) => {
                setDraft(event.target.value);
                setSelected(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </label>
      ) : null}

      <footer>
        <button type="button" className="skip" onClick={cancel} disabled={interaction.resolving}>
          {approval ? "Deny" : "Skip"}
        </button>
        <button
          type="button"
          className="continue"
          disabled={!canSubmit || interaction.resolving}
          onClick={submit}
        >
          {interaction.voiceSubmitting
            ? "Submitting voice answer…"
            : interaction.resolving
              ? "Sending…"
              : "Continue"}
        </button>
      </footer>
      {secure ? (
        <small>Secure UI only — this value is never sent to Gemini or stored by Iris.</small>
      ) : null}
      {interaction.error ? <small className="error">{interaction.error}</small> : null}
    </section>
  );
}
