"use client";

/**
 * Inbox
 *
 * Instagram DM conversations for the selected account, with live message
 * history and a reply composer. Messages are read from the Conversations API
 * (Meta only exposes the 20 most recent per thread) and refreshed by polling.
 * Sending is subject to Instagram's 24-hour messaging window — Meta's error is
 * surfaced verbatim when it applies.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";
import type {
  ConversationListItem,
  ConversationsResponse,
} from "@/app/api/instagram/conversations/route";
import type { ThreadMessage } from "@/app/api/instagram/conversations/[id]/route";

const POLL_MS = 12_000;
// Cached list/threads are shown instantly on revisit, then revalidated in the
// background. The Instagram Conversations API is slow (often several seconds),
// so this is what makes the inbox feel fast after the first load.
const CACHE_MAX_AGE_MS = 60_000;
const convCacheKey = (accountId: string) => `inbox:convs:${accountId}`;

// Typing should not fire a request per keystroke.
const SEARCH_DEBOUNCE_MS = 300;

interface InboxFilterState {
  q: string;
  from: string;
  to: string;
  automation: string;
  keyword: string;
  state: string;
}

const EMPTY_FILTERS: InboxFilterState = {
  q: "",
  from: "",
  to: "",
  automation: "",
  keyword: "",
  state: "",
};

const STATE_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "awaiting_reply",
    label: "Wartet auf Antwort",
    hint: "Die Person hat zuletzt geschrieben und niemand hat geantwortet",
  },
  {
    value: "dm_failed",
    label: "DM fehlgeschlagen",
    hint: "Instagram hat die DM abgelehnt — nur die öffentliche Antwort kam an",
  },
  {
    value: "delivered_unread",
    label: "Zugestellt, ungelesen",
    hint: "Gesendet, aber Instagram meldet sie bis heute nicht als gelesen",
  },
  {
    value: "in_requests",
    label: "Liegt in Anfragen",
    hint: "Die Antwort liegt in Instagram unter „Anfragen“, weil wir der Person nicht folgen — dort wird sie leicht übersehen",
  },
  {
    value: "follows_us",
    label: "Folgt uns",
    hint: "Unsere DMs landen bei dieser Person im normalen Posteingang, nicht in den Anfragen",
  },
];

function buildQuery(accountId: string, filters: InboxFilterState): string {
  const params = new URLSearchParams({ instagramAccountId: accountId });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.automation) params.set("automation", filters.automation);
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.state) params.set("state", filters.state);
  return params.toString();
}

function countActiveFilters(filters: InboxFilterState): number {
  return Object.values(filters).filter((v) => v !== "").length;
}
const msgCacheKey = (conversationId: string) => `inbox:msgs:${conversationId}`;

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Timestamp under a message bubble. Unlike the conversation list, this always
 * carries the clock time: "when exactly did this go out" is the question a
 * thread gets read for, and a bare date cannot answer it. Older messages keep
 * the date in front of the time.
 */
function formatMessageTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}

export default function InboxPage() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  // Seed from the last-used account so a revisit can paint the cached
  // conversation list immediately, before the account list even loads.
  const [selectedAccountId, setSelectedAccountId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("inbox:selectedAccount") ?? "";
  });

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);

  // What the user typed, and what the last request used. The search box updates
  // the first immediately and the second only after a pause.
  const [filters, setFilters] = useState<InboxFilterState>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterOptions, setFilterOptions] = useState<
    ConversationsResponse["filters"]
  >({ automations: [], keywords: [] });
  const [awaitingReply, setAwaitingReply] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"export" | "delete" | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  // Accounts for the selector; default to the first connected account. Uses the
  // lightweight accounts endpoint (one query) rather than the heavy dashboard
  // stats aggregation, so the inbox isn't gated on analytics before it can load.
  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId((prev) => {
          // Keep the seeded account only if it's still connected; otherwise
          // fall back to the default so a removed account can't wedge the inbox.
          const stillValid = prev && next.some((a) => a.id === prev);
          return stillValid
            ? prev
            : payload.data.selectedInstagramAccountId || next[0]?.id || "";
        });
      })
      .catch(() => setAccounts([]));
  }, []);

  // Remember the chosen account for the next visit.
  useEffect(() => {
    if (typeof window === "undefined" || !selectedAccountId) return;
    window.sessionStorage.setItem("inbox:selectedAccount", selectedAccountId);
  }, [selectedAccountId]);

  // Debounce the search box: every keystroke would otherwise be a query with a
  // leading-wildcard match across every message.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQ(filters.q),
      SEARCH_DEBOUNCE_MS
    );
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const loadConversations = useCallback(
    async (silent: boolean) => {
      if (!selectedAccountId) return;
      if (!silent) setConvLoading(true);
      const query = buildQuery(selectedAccountId, {
        ...filters,
        q: debouncedQ,
      });
      try {
        const res = await fetch(`/api/instagram/conversations?${query}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (data.success) {
          setConversations(data.data.conversations);
          setFilterOptions(data.data.filters);
          setAwaitingReply(data.data.counts.awaitingReply);
          // Only the unfiltered list is worth caching — a cached filtered view
          // would be painted under a different filter on the next visit.
          if (countActiveFilters({ ...filters, q: debouncedQ }) === 0) {
            writeCache(convCacheKey(selectedAccountId), data.data.conversations);
          }
          setConvError(null);
        } else if (!silent) {
          setConvError(data.error ?? "Unterhaltungen konnten nicht geladen werden");
        }
      } catch {
        if (!silent) setConvError("Unterhaltungen konnten nicht geladen werden");
      } finally {
        // Always cleared, including on silent loads: a filter change reloads
        // silently, and an initial "Loading…" would otherwise never resolve.
        setConvLoading(false);
      }
    },
    [selectedAccountId, filters, debouncedQ]
  );

  // Switching accounts starts over: different threads, and the filters of the
  // previous account rarely mean anything for the next one.
  useEffect(() => {
    if (!selectedAccountId) return;
    // Intentional synchronous reset on a dependency change, not derived render
    // state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveId(null);
    setMessages([]);
    setFilters(EMPTY_FILTERS);
    const cached = readCache<ConversationListItem[]>(
      convCacheKey(selectedAccountId),
      CACHE_MAX_AGE_MS
    );
    if (cached.data) {
      setConversations(cached.data);
      setConvLoading(false);
    } else {
      setConversations([]);
      setConvLoading(true);
    }
  }, [selectedAccountId]);

  // Load and keep polling. Deliberately separate from the reset above, so
  // changing a filter re-queries without closing the thread being read.
  useEffect(() => {
    if (!selectedAccountId) return;
    // Fetching on mount and on every filter change is what this effect is for;
    // the state it settles is the loaded list, not render-derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadConversations(true);
    const timer = window.setInterval(() => void loadConversations(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedAccountId, loadConversations]);

  const loadMessages = useCallback(
    async (conversationId: string, silent: boolean) => {
      if (!selectedAccountId) return;
      if (!silent) setThreadLoading(true);
      try {
        const res = await fetch(
          `/api/instagram/conversations/${conversationId}?instagramAccountId=${selectedAccountId}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (data.success) {
          setMessages(data.data.messages);
          writeCache(msgCacheKey(conversationId), data.data.messages);
        }
      } catch {
        // keep whatever is shown
      } finally {
        if (!silent) setThreadLoading(false);
      }
    },
    [selectedAccountId]
  );

  // Load + poll the open thread. Cached messages render instantly while a fresh
  // copy loads silently; opening a thread never shows a blank pane on revisit.
  useEffect(() => {
    if (!activeId) return;
    const cached = readCache<ThreadMessage[]>(
      msgCacheKey(activeId),
      CACHE_MAX_AGE_MS
    );
    if (cached.data) {
      // Paint cached messages instantly on thread change; intentional reset.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessages(cached.data);
      setThreadLoading(false);
    } else {
      setMessages([]);
      setThreadLoading(true);
    }
    void loadMessages(activeId, Boolean(cached.data));
    const timer = window.setInterval(
      () => void loadMessages(activeId, true),
      POLL_MS
    );
    return () => window.clearInterval(timer);
  }, [activeId, loadMessages]);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function openConversation(id: string) {
    setActiveId(id);
    setSendError(null);
    // Paint any cached thread synchronously so the pane never flashes empty
    // or shows the previously open conversation while the fetch runs.
    const cached = readCache<ThreadMessage[]>(msgCacheKey(id), CACHE_MAX_AGE_MS);
    setMessages(cached.data ?? []);
    setThreadLoading(!cached.data);
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !active?.contact.id || sending) return;
    setSending(true);
    setSendError(null);

    // Optimistically show the reply immediately, then confirm with the server.
    const optimistic: ThreadMessage = {
      id: `optimistic-${Date.now()}`,
      text,
      fromMe: true,
      fromUsername: null,
      createdTime: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");

    try {
      const res = await fetch("/api/instagram/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: selectedAccountId,
          recipientId: active.contact.id,
          text,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await loadMessages(active.id, true);
        void loadConversations(true);
      } else {
        // Roll the optimistic message back and restore the draft so it's not lost.
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setDraft(text);
        setSendError(data.error ?? "Nachricht konnte nicht gesendet werden");
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setSendError("Nachricht konnte nicht gesendet werden");
    } finally {
      setSending(false);
    }
  }

  /**
   * Force a reconcile with Meta.
   *
   * Not needed to see new messages — webhooks deliver those — but it answers
   * "is something missing?" without waiting for the background pass.
   */
  async function handleRefresh() {
    if (!selectedAccountId || refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch("/api/instagram/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: selectedAccountId }),
      });
      const data = await res.json();
      if (data.success) {
        const added = data.data.messages as number;
        setRefreshNote(
          added > 0 ? `${added} Nachricht(en) nachgetragen` : "Bereits auf dem neuesten Stand"
        );
        await loadConversations(true);
        if (activeId) await loadMessages(activeId, true);
      } else {
        setRefreshNote(data.error ?? "Aktualisieren fehlgeschlagen");
      }
    } catch {
      setRefreshNote("Aktualisieren fehlgeschlagen");
    } finally {
      setRefreshing(false);
      window.setTimeout(() => setRefreshNote(null), 4000);
    }
  }

  /** Download everything stored about this contact, for a subject access request. */
  function handleExport() {
    if (!activeId || !selectedAccountId) return;
    setBusyAction("export");
    window.location.href = `/api/instagram/conversations/${activeId}/export?instagramAccountId=${selectedAccountId}`;
    window.setTimeout(() => setBusyAction(null), 1500);
  }

  /** Erase this contact, for a deletion request. */
  async function handleDelete() {
    if (!activeId || !selectedAccountId || busyAction) return;

    const who = active?.contact.username
      ? `@${active.contact.username}`
      : "this contact";
    const confirmed = window.confirm(
      `Delete everything stored about ${who}?\n\n` +
        "This removes the conversation, its messages and the automation log " +
        "entries naming them. It cannot be undone.\n\n" +
        "The conversation itself stays in Instagram — only this app's copy is erased."
    );
    if (!confirmed) return;

    setBusyAction("delete");
    try {
      const res = await fetch(
        `/api/instagram/conversations/${activeId}?instagramAccountId=${selectedAccountId}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data.success) {
        setActiveId(null);
        setMessages([]);
        await loadConversations(true);
      } else {
        setSendError(data.error ?? "Löschen fehlgeschlagen");
      }
    } catch {
      setSendError("Löschen fehlgeschlagen");
    } finally {
      setBusyAction(null);
    }
  }

  const activeFilterCount = countActiveFilters(filters);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Inbox</h1>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={setSelectedAccountId}
            includeAll={false}
          />
        )}
      </div>

      <div className="grid h-[calc(100dvh-11rem)] grid-cols-1 overflow-hidden rounded border border-border sm:grid-cols-[300px_1fr]">
        {/* Conversation list. On mobile it takes the full pane and is hidden
            once a thread is open (ManyChat-style); on sm+ it is always shown. */}
        <div
          className={`min-h-0 flex-col border-b border-border sm:flex sm:border-b-0 sm:border-r ${
            active ? "hidden" : "flex"
          }`}
        >
          <div className="shrink-0 space-y-2 border-b border-border px-3 py-3">
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={filters.q}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
                placeholder="Namen und Nachrichten durchsuchen…"
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                title="Bei Meta nachsehen, ob etwas fehlt"
                aria-label="Aktualisieren"
                className="shrink-0 rounded border border-border px-2 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-50"
              >
                {refreshing ? "…" : "⟳"}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                className="rounded px-1 py-0.5 text-muted hover:text-foreground"
              >
                Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}{" "}
                {filtersOpen ? "▴" : "▾"}
              </button>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="rounded px-1 py-0.5 text-muted hover:text-foreground"
                >
                  Zurücksetzen
                </button>
              )}
            </div>

            {filtersOpen && (
              <div className="space-y-2 pt-1">
                <div className="flex flex-wrap gap-1">
                  {STATE_OPTIONS.map((option) => {
                    const on = filters.state === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        title={option.hint}
                        onClick={() =>
                          setFilters((f) => ({
                            ...f,
                            state: on ? "" : option.value,
                          }))
                        }
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          on
                            ? "border-accent bg-accent text-white"
                            : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    value={filters.from}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, from: e.target.value }))
                    }
                    aria-label="Von Datum"
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent/40 focus:outline-none"
                  />
                  <span className="text-xs text-muted">bis</span>
                  <input
                    type="date"
                    value={filters.to}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, to: e.target.value }))
                    }
                    aria-label="Bis Datum"
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent/40 focus:outline-none"
                  />
                </div>

                <select
                  value={filters.automation}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, automation: e.target.value }))
                  }
                  aria-label="Automatisierung"
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent/40 focus:outline-none"
                >
                  <option value="">Beliebige Automatisierung</option>
                  {/* The two that are not a campaign: reached by something, and
                      reached by nothing — the latter being people who wrote in
                      on their own. */}
                  <option value="any">Von einer Automatisierung erfasst</option>
                  <option value="none">Ohne Automatisierung (von sich aus geschrieben)</option>
                  {filterOptions.automations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>

                {filterOptions.keywords.length > 0 && (
                  <select
                    value={filters.keyword}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, keyword: e.target.value }))
                    }
                    aria-label="Schlüsselwort"
                    className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent/40 focus:outline-none"
                  >
                    <option value="">Beliebiges Schlüsselwort</option>
                    {filterOptions.keywords.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <p className="text-[11px] text-muted">
              {refreshNote ??
                `${conversations.length} angezeigt · ${awaitingReply} warten auf Antwort`}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {convLoading ? (
              <p className="px-4 py-6 text-sm text-muted">Lädt…</p>
            ) : convError ? (
              <p className="px-4 py-6 text-sm text-error">{convError}</p>
            ) : conversations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">Noch keine Unterhaltungen.</p>
            ) : (
              conversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className={`block w-full border-b border-border px-4 py-3 text-left ${
                      isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        @{c.contact.username ?? "unbekannt"}
                      </span>
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        {formatTime(c.updatedTime)}
                      </span>
                    </div>
                    {c.lastMessage && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {c.lastMessage.fromMe ? "Du: " : ""}
                        {c.lastMessage.text || "(kein Text)"}
                      </p>
                    )}
                    <p className="mt-1 truncate text-[10px] text-zinc-500">
                      {c.automation ? (
                        <>
                          {c.automation.name}
                          {c.automation.matchedKeyword
                            ? ` · ${c.automation.matchedKeyword}`
                            : ""}
                          {/* Worth calling out: these people got the public
                              reply but never the DM. */}
                          {c.automation.status === "FAILED" ? " · DM failed" : ""}
                        </>
                      ) : (
                        "Ohne Automatisierung"
                      )}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Thread. On mobile it is only shown once a conversation is open and
            fills the pane; on sm+ it always sits beside the list. */}
        <div
          className={`min-h-0 flex-col ${active ? "flex" : "hidden sm:flex"}`}
        >
          {!active ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              Wähle eine Unterhaltung aus, um sie zu lesen und zu antworten.
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  className="-ml-1 rounded px-2 py-1 text-muted hover:text-foreground sm:hidden"
                  aria-label="Zurück zu den Unterhaltungen"
                >
                  Zurück
                </button>
                <div className="min-w-0 flex-1">
                  <span className="block truncate">
                    @{active.contact.username ?? "unbekannt"}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted">
                    {/* Wo eine Nachricht landet, entscheidet sich daran, wer
                        wem folgt — einen Ordner liefert Instagram nicht mit. */}
                    {active.follow.weFollowContact === false &&
                    !active.lastMessage?.fromMe
                      ? "In Anfragen · "
                      : ""}
                    {active.follow.contactFollowsUs === true ? "folgt uns · " : ""}
                    {active.automation
                      ? [
                          active.automation.name,
                          active.automation.matchedKeyword,
                          active.automation.status === "FAILED"
                            ? "DM failed"
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Ohne Automatisierung geschrieben"}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleExport}
                  disabled={busyAction !== null}
                  title="Alle gespeicherten Daten zu diesem Kontakt herunterladen"
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs font-normal text-muted hover:text-foreground disabled:opacity-50"
                >
                  Exportieren
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={busyAction !== null}
                  title="Diesen Kontakt aus dieser Anwendung löschen"
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs font-normal text-error hover:bg-error/10 disabled:opacity-50"
                >
                  {busyAction === "delete" ? "Löschen…" : "Löschen"}
                </button>
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {threadLoading && messages.length === 0 ? (
                  <p className="text-sm text-muted">Lädt…</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-muted">Keine Nachrichten.</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                          m.fromMe
                            ? "bg-accent text-white"
                            : "bg-surface text-foreground border border-border"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.text}</p>
                        <p
                          className={`mt-1 text-[10px] ${
                            m.fromMe ? "text-white/70" : "text-zinc-500"
                          }`}
                        >
                          {formatMessageTime(m.createdTime)}
                          {/* Read receipts only exist for what we sent, and
                              only once Instagram reports them. */}
                          {m.fromMe && m.readTime ? " · Gelesen" : ""}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {sendError && (
                  <p className="mb-2 text-xs text-error">{sendError}</p>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder="Antwort schreiben…  (Enter sendet, Umschalt+Enter für eine neue Zeile)"
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={sending || !draft.trim()}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {sending ? "Senden…" : "Senden"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
