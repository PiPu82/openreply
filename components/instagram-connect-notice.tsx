"use client";

import { useSearchParams } from "next/navigation";

type Tone = "error" | "warning" | "success";

const TONE_CLASSES: Record<Tone, string> = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

const MESSAGES: Record<string, { tone: Tone; title: string; detail: string }> = {
  denied: {
    tone: "warning",
    title: "Instagram-Verbindung abgebrochen",
    detail:
      "Du hast die Berechtigungsabfrage bei Instagram abgelehnt. Starte erneut und bestätige alle angefragten Berechtigungen.",
  },
  invalid: {
    tone: "error",
    title: "Instagram-Verbindung abgelaufen",
    detail:
      "Der Anmeldelink fehlte oder war älter als 10 Minuten. Klicke auf „Instagram verbinden“ für einen neuen Versuch.",
  },
  forbidden: {
    tone: "error",
    title: "Nicht berechtigt",
    detail:
      "Nur Eigentümer und Administratoren des Arbeitsbereichs können ein Instagram-Konto verbinden.",
  },
  already_connected: {
    tone: "warning",
    title: "Konto bereits verbunden",
    detail:
      "Dieses Instagram-Konto ist mit einem anderen Arbeitsbereich verbunden. Trenne es dort zuerst oder verbinde ein anderes Konto.",
  },
};

export function InstagramConnectNotice() {
  const searchParams = useSearchParams();
  const status = searchParams.get("instagram");

  if (!status) return null;

  if (status === "misconfigured") {
    const missing = (searchParams.get("missing") ?? "")
      .split(",")
      .filter(Boolean);

    return (
      <Notice tone="error" title="Instagram-App nicht konfiguriert">
        <p>
          Set{" "}
          {missing.length > 0
            ? "these environment variables"
            : "the required environment variables"}{" "}
          and restart the server:
        </p>
        {missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {missing.map((name) => (
              <li key={name} className="font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          See <span className="font-mono text-xs">docs/setup.md</span> for how to
          obtain each value. Note that{" "}
          <span className="font-mono text-xs">ENCRYPTION_KEY</span> must be a
          64-character hex string.
        </p>
      </Notice>
    );
  }

  if (status === "failed") {
    const reason = searchParams.get("reason");

    return (
      <Notice tone="error" title="Instagram-Verbindung fehlgeschlagen">
        <p>
          Instagram hat die Anmeldung angenommen, die Verbindung ließ sich
          aber nicht abschließen. Meist liegt es an einer abweichenden
          Redirect-URI oder an fehlenden Berechtigungen der App.
        </p>
        {reason && (
          <p className="mt-2 font-mono text-xs break-words opacity-80">
            {reason}
          </p>
        )}
      </Notice>
    );
  }

  const known = MESSAGES[status];
  if (!known) return null;

  return (
    <Notice tone={known.tone} title={known.title}>
      <p>{known.detail}</p>
    </Notice>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded border p-4 text-sm ${TONE_CLASSES[tone]}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}
