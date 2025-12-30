import { Auth } from '@auth/core';
import GitHub from '@auth/core/providers/github';
import type { AuthConfig } from '@auth/core';
import type { APIRoute } from 'astro';

export const ALL: APIRoute = async ({ request, locals }) => {
  // Access runtime env vars on Cloudflare Pages
  const runtime = (locals as any).runtime;
  const env = runtime?.env || {};

  const config: AuthConfig = {
    basePath: '/api/auth',
    trustHost: true,
    secret: env.AUTH_SECRET || import.meta.env.AUTH_SECRET,
    providers: [
      GitHub({
        clientId: env.GITHUB_CLIENT_ID || import.meta.env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET || import.meta.env.GITHUB_CLIENT_SECRET,
      }),
    ],
    callbacks: {
      async jwt({ token, profile }) {
        // Store GitHub username from profile on initial sign-in
        if (profile) {
          token.username = (profile as any).login;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.sub) {
          session.user.id = token.sub;
          (session.user as any).username = token.username;
        }
        return session;
      },
    },
  };

  return Auth(request, config);
};

export const GET = ALL;
export const POST = ALL;
