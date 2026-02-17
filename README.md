# Anubix Platform — Architecture & State

## What Anubix Is

A platform that lets non-technical people build and manage full-stack web apps through conversation. Users talk to AI via a native app or web app. The AI writes code, configures services, and deploys — no terminal, no IDE, no git knowledge required.

## Repositories

Three repos:

1. **`anubix-bridge`** (this repo, formerly `claude-code-bridge`) — Runs on Fly.io machines. Express + WebSocket server. The connection between clients and Claude Code. Each user gets their own machine with a full workspace.
2. **`anubix-web`** — Browser client. Users connect to the bridge from here to build and manage their apps.
3. **`anubix-native`** — React Native mobile client (iOS/Android). Same functionality as web, on your phone.

Plus the template:

4. **`talkartech-fullstack-template-supabase`** — Opinionated Next.js + Clerk + Supabase starter. Gets copied onto the Fly.io machine when a user clicks "Create App".

## Architecture

```
anubix-web / anubix-native
    ↓ WebSocket
anubix-bridge (Fly.io machine, one per user)
    ↓
Claude Code SDK → Anthropic API
    ↓
Full terminal access on the machine
    ↓
/workspace/project (user's app, running via next dev)
```

## How It Works — The User Flow

1. User opens Anubix (web or native) and clicks **"Create App"**
2. A copy of the web template gets slapped onto their Fly.io machine
3. `next dev` starts running → user sees it live in the preview window
4. In the preview window, user goes through the **Setup Wizard** (4 steps, all in-browser)
5. They do have to create accounts (Clerk, Supabase, GitHub, Vercel) — but this is actually a **selling point**: they own everything, crystal clear instructions for each step
6. They hit **Deploy** → site is live immediately
7. They go back to the chat screen and start prompting away — Claude Code edits their app in real-time

### The Preview

- Works on both computer and phone
- Shows the live `next dev` output from the Fly.io machine
- Setup wizard runs inside the preview itself
- Still need to figure out: tunneling and how to make it cheap

## The Template — Setup Wizard (`/setup`)

Four steps, all done from the browser — no CLI, no terminal:

1. **Auth** — Paste Clerk publishable + secret keys
2. **Database** — Paste Supabase `.env.local` block (auto-detects URL + publishable key), manually paste secret key
3. **Connect** — Enable Clerk's native third-party auth in Supabase (replaces deprecated JWT templates), create profiles table via SQL Editor
4. **Deploy** — Paste GitHub fine-grained token + Vercel token → one click → creates GitHub repo, pushes all files via REST API with real-time SSE progress bar, imports on Vercel, sets env vars, triggers deployment

### Key Technical Choices
- Supabase new keys only: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` and `SUPABASE_SECRET_DEFAULT_KEY` (not the deprecated anon/service_role names)
- Clerk ↔ Supabase: Native third-party auth, not JWT templates. Uses `accessToken` callback in Supabase client
- Supabase Storage for all file uploads (replaced Digital Ocean Spaces)
- GitHub fine-grained tokens: Need Administration + Contents (both Read and write), All repositories access
- Safety: Won't overwrite repos with >2 commits. Repo name checked in real-time with debounce

## The Unsolved Piece: Pushing Changes After Initial Deploy

The gap: After the initial deploy, users keep making changes via Anubix chat → Claude Code edits files on Fly.io → but those changes never reach GitHub/Vercel → live site stays stale.

Proposed solution: During initial deploy, also `git init` the workspace and configure the remote with the user's GitHub token. Then when the user says "deploy my changes" in Anubix chat, Claude Code runs `git add . && git commit -m "..." && git push origin main`. Vercel auto-deploys from the push. No extra tokens, no extra UI.

What needs building:
- After GitHub push succeeds in step 4, initialize git locally on the Fly.io workspace (remote, credentials, initial commit)
- Optionally: a "Deploy" button in the Anubix app UI as a shortcut (in addition to saying "deploy" in chat)

## Future: Patterns (One-Click Features)

Pre-built feature templates that users can add to their app with a single button press. Each pattern is a Claude-friendly piece of markdown/code that gets sent to Claude Code and instantly implemented.

Examples:
- **Infinite scroll** — Backend pagination + filtering + search
- **Favorites system** — Save/unsave anything
- **Cart + marketplace** — Full e-commerce flow
- **RevenueCat integration** — Subscriptions and in-app purchases
- **Audio system** — Record, play sounds
- **Video player** — Embedded video playback

The idea: a library of battle-tested patterns. User hits a button, Claude implements it on their app. No prompting required.

## Current State — What's Done

- ✅ All 4 setup wizard steps working
- ✅ Deploy: GitHub repo creation + SSE progress bar + Vercel import + env vars
- ✅ Repo name availability check with debounce
- ✅ Retry logic (GitHub done? skip to Vercel on retry)
- ✅ All env vars migrated to new Supabase key names across entire codebase
- ✅ Digital Ocean Spaces fully removed, replaced with Supabase Storage
- ✅ ESLint + TypeScript + production build all pass

## What's Left

- Git initialization on Fly.io workspace after initial deploy
- The "push changes" flow (via Claude Code terminal or dedicated UI)
- Supabase Storage `profile-pictures` bucket creation (could be automated in wizard)
- End-to-end testing of the full flow on an actual Fly.io machine (vs local dev)
- Tunneling solution for preview (needs to be cheap at scale)
- Patterns system (design + first batch of patterns)
- Repo rename: `claude-code-bridge` → `anubix-bridge`, `switchai` → `anubix-native`

## Philosophy

- Users don't know what git, env vars, or API keys are. Every instruction says exactly what to click and where to find it.
- Users own their own accounts and infrastructure. Clerk, Supabase, GitHub, Vercel — all theirs. This is a feature, not a bug.
- Only the newest versions of everything. No deprecated patterns. No backward compatibility.
- If it can be automated via API, automate it. One click, zero thinking.
