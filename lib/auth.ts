import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    // Login is email magic links only. Two transports are supported:
    //
    //   EMAIL_SERVER set -> generic SMTP via Nodemailer. Use this to send
    //     through a provider you already run (Brevo, Postmark, your own relay)
    //     instead of adding another vendor. Format:
    //     smtp://user:pass@smtp-relay.example.com:587
    //
    //   otherwise      -> Resend, the upstream default.
    //
    // Written as a fallback rather than a replacement so the upstream default
    // keeps working untouched and this stays mergeable.
    process.env.EMAIL_SERVER
      ? Nodemailer({
          // Keep the provider id "resend" even on the SMTP path. app/login
          // calls signIn("resend", ...) by name, and Auth.js resolves
          // providers by id — a Nodemailer provider registered as
          // "nodemailer" makes that call fail, surfacing as a misleading
          // MissingCSRF error rather than "unknown provider".
          // Overriding the id here keeps app/login untouched and upstream-
          // mergeable; the transport is what changes, not the entry point.
          id: "resend",
          server: process.env.EMAIL_SERVER,
          from: process.env.EMAIL_FROM ?? "OpenReply <login@example.com>",
        })
      : Resend({
          apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
          from: process.env.EMAIL_FROM ?? "OpenReply <login@example.com>",
        }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
