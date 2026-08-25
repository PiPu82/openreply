/**
 * Start a campaign for the person whose thread is open in the inbox.
 *
 * ManyChat could push someone into a flow by hand; this is the same idea. The
 * opening DM goes out with its button, and from there nothing special happens:
 * the tap arrives as a normal postback and the worker takes over — follow
 * gate, link, follow-up — exactly as if the person had commented.
 *
 * Meta decides who can be reached. A message needs an open window: 24 hours
 * since the person last did something, or 7 days when it carries the
 * HUMAN_AGENT tag, which is what a hand-triggered send is. Beyond that there
 * is no way to write to them, in this tool or any other.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { sendDirectMessageWithButton, MetaApiError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { recordThreadMessages } from "@/lib/inbox/store";
import { renderMessageWithoutLink } from "@/lib/tracking/message";
import { reachState } from "@/lib/inbox/reach";

export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Nicht angemeldet." },
      { status: 401 }
    );
  }

  let body: {
    automationId?: string;
    recipientId?: string;
    instagramAccountId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Ungültige Anfrage." },
      { status: 400 }
    );
  }

  if (!body.automationId || !body.recipientId) {
    return NextResponse.json(
      { success: false, error: "Kampagne und Empfänger sind erforderlich." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    body.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Kein Instagram-Konto verbunden." },
      { status: 400 }
    );
  }

  // Scoped to the workspace: an automation id from elsewhere must not be
  // usable to send through this account.
  const automation = await prisma.automation.findFirst({
    where: { id: body.automationId, workspaceId, isActive: true },
  });
  if (!automation) {
    return NextResponse.json(
      { success: false, error: "Kampagne nicht gefunden oder nicht aktiv." },
      { status: 404 }
    );
  }

  if (
    !automation.openingDmEnabled ||
    !automation.openingDmMessage ||
    !automation.openingDmButtonLabel
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Diese Kampagne hat keine Start-DM mit Button — es gibt nichts zu starten.",
      },
      { status: 400 }
    );
  }

  const lastInbound = await prisma.message.findFirst({
    where: {
      fromMe: false,
      conversation: {
        instagramAccountId: account.id,
        contactId: body.recipientId,
      },
    },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });

  const reach = reachState(lastInbound?.sentAt ?? null);
  if (reach === "closed") {
    return NextResponse.json(
      {
        success: false,
        error: lastInbound
          ? "Die letzte Reaktion liegt über 7 Tage zurück — Meta lässt keine Nachricht mehr zu."
          : "Von dieser Person liegt keine Reaktion vor — Meta lässt keine Nachricht zu.",
        reach,
      },
      { status: 409 }
    );
  }

  // {username} in the opening text. The thread knows the handle for anyone
  // the sync has seen; the DM log covers whoever arrived through a comment.
  const conversation = await prisma.conversation.findUnique({
    where: {
      instagramAccountId_contactId: {
        instagramAccountId: account.id,
        contactId: body.recipientId,
      },
    },
    select: { contactUsername: true },
  });
  const contactName =
    conversation?.contactUsername ??
    (
      await prisma.dmLog.findFirst({
        where: { commenterId: body.recipientId, commenterName: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { commenterName: true },
      })
    )?.commenterName ??
    null;

  const text = renderMessageWithoutLink({
    message: automation.openingDmMessage,
    commenterName: contactName,
  });

  try {
    const result = await sendDirectMessageWithButton(
      decryptToken(account.accessToken),
      account.instagramId,
      body.recipientId,
      text,
      automation.openingDmButtonLabel,
      // The same payloads the comment path uses, so the tap lands in the
      // existing worker logic rather than a parallel one.
      automation.requireFollow
        ? `followcheck:${automation.id}`
        : `reveal:${automation.id}`,
      // No extra link buttons: the opening DM carries none on the comment
      // path either.
      [],
      reach === "human_agent"
    );

    await recordThreadMessages([
      {
        instagramAccountId: account.instagramId,
        contactId: body.recipientId,
        mid: result.message_id,
        fromMe: true,
        text,
        sentAt: new Date(),
      },
    ]).catch((error) => {
      // It was sent; only our copy failed. Saying otherwise would invite a
      // second send.
      console.error("[Trigger] Storing sent message failed:", error);
    });

    // Into the DM log too, so a hand-started campaign is not invisible next to
    // the ones a comment started. The id has to be unique per automation, and
    // starting the same person twice is allowed on purpose.
    await prisma.dmLog
      .create({
        data: {
          workspaceId,
          automationId: automation.id,
          instagramAccountId: account.id,
          commenterId: body.recipientId,
          commenterName: contactName,
          commentText: "(manuell gestartet)",
          commentId: `manual:${body.recipientId}:${Date.now()}`,
          status: "SENT",
          dmSentAt: new Date(),
        },
      })
      .catch((error) => {
        console.error("[Trigger] Writing the DM log entry failed:", error);
      });

    return NextResponse.json({
      success: true,
      data: { reach, automation: automation.name },
    });
  } catch (error) {
    const message =
      error instanceof MetaApiError
        ? error.message
        : "Senden fehlgeschlagen.";
    console.error("[Trigger] Send failed:", error);
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
