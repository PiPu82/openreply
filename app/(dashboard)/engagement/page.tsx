"use client";

/**
 * Top-Kontakte
 *
 * Ranks the people who interact most: one point per comment, inbound DM or
 * button tap. Fed entirely from webhook deliveries, so it costs no API calls.
 *
 * Deliberately not called "Top-Follower". Meta never discloses who follows an
 * account — only who does something. Someone who reads every post and never
 * comments cannot appear here, and no product built on this API can show them.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import type { EngagementResponse } from "@/app/api/engagement/route";
import type { RankedContact, RankingPeriod } from "@/lib/engagement/ranking";

const PERIODS: Array<{ value: RankingPeriod; label: string }> = [
  { value: "7d", label: "7 Tage" },
  { value: "14d", label: "14 Tage" },
  { value: "30d", label: "30 Tage" },
  { value: "all", label: "Seit Beginn" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/** The breakdown behind the number, so a score is never just a number. */
function breakdown(contact: RankedContact): string {
  return [
    contact.comments ? `${contact.comments} Kommentare` : null,
    contact.dms ? `${contact.dms} DMs` : null,
    contact.buttonTaps ? `${contact.buttonTaps} Taps` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function EngagementPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [period, setPeriod] = useState<RankingPeriod>("7d");
  const [contacts, setContacts] = useState<RankedContact[]>([]);
  const [since, setSince] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) return;
        const list: AccountOption[] = data.data.accounts ?? [];
        setAccounts(list);
        if (list.length > 0) setSelectedAccountId((id) => id || list[0].id);
      })
      .catch(() => setError("Konten konnten nicht geladen werden"));
  }, []);

  const load = useCallback(async () => {
    if (!selectedAccountId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/engagement?instagramAccountId=${selectedAccountId}&period=${period}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data.success) {
        const payload = data.data as EngagementResponse;
        setContacts(payload.contacts);
        setSince(payload.since);
        setError(null);
      } else {
        setError(data.error ?? "Auswertung konnte nicht geladen werden");
      }
    } catch {
      setError("Auswertung konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId, period]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            Top-Kontakte
          </h1>
          <p className="mt-0.5 text-xs text-muted">
            Ein Punkt je Kommentar, DM und Button-Tipp.{" "}
            {since ? `Erfasst seit ${formatDate(since)}.` : ""}
          </p>
        </div>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={setSelectedAccountId}
            includeAll={false}
          />
        )}
      </div>

      <div className="inline-flex rounded-lg bg-surface p-1">
        {PERIODS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setPeriod(option.value)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              period === option.value
                ? "bg-background font-medium text-foreground ring-1 ring-accent/40"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded border border-error/20 bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      <div className="panel overflow-hidden rounded">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-3 font-medium sm:px-6">#</th>
                <th className="px-4 py-3 font-medium sm:px-6">Kontakt</th>
                <th className="px-4 py-3 font-medium sm:px-6">Punkte</th>
                <th className="px-4 py-3 font-medium sm:px-6">Wovon</th>
                <th className="px-4 py-3 font-medium sm:px-6">Zuletzt</th>
              </tr>
            </thead>
            <tbody>
              {loading && contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-muted sm:px-6">
                    Lädt…
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-muted sm:px-6">
                    In diesem Zeitraum hat noch niemand interagiert.
                  </td>
                </tr>
              ) : (
                contacts.map((contact, index) => (
                  <tr
                    key={contact.contactId}
                    onClick={() =>
                      contact.conversationId && router.push("/inbox")
                    }
                    className={`border-b border-border last:border-0 ${
                      contact.conversationId
                        ? "cursor-pointer hover:bg-surface-hover"
                        : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-muted sm:px-6">{index + 1}</td>
                    <td className="px-4 py-3 sm:px-6">
                      <span className="font-medium text-foreground">
                        {contact.username ? `@${contact.username}` : contact.contactId}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground sm:px-6">
                      {contact.points}
                    </td>
                    <td className="px-4 py-3 text-muted sm:px-6">
                      {breakdown(contact)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted sm:px-6">
                      {formatDate(contact.lastAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted">
        Zeigt Kontakte, die etwas getan haben — keine Followerliste. Wer nur
        mitliest, erscheint hier nicht: Instagram gibt nicht preis, wer folgt.
        Likes und Reposts lassen sich aus demselben Grund keiner Person
        zuordnen.
      </p>
    </div>
  );
}
