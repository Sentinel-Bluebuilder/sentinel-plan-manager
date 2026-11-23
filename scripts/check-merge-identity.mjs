#!/usr/bin/env node
// ─── Pre-Merge Identity Guard ────────────────────────────────────────────────
// Run this BEFORE every `gh pr merge`. Exits non-zero if merging right now
// would stamp a personal email onto the merge commit.
//
// WHY THIS EXISTS
// ---------------
// On 2026-08-10 the merge commit for PR #19 (`8f5b0f2`) landed on master
// authored as `Build your own dVPN <dvpnstrategy@gmail.com>` — a personal
// email — even though every commit inside the PR was correctly authored as
// `Sentinel-Bluebuilder <...@users.noreply.github.com>`.
//
// THE CAUSE IS NOT A WRONG ACCOUNT. GitHub's own record for PR #19 shows
// `merged_by: Sentinel-Bluebuilder` — the correct bot account did the merge.
// The problem is that:
//
//   1. `gh pr merge` builds the merge commit SERVER-SIDE. Local git config
//      (user.name / user.email) is ignored entirely, and no client-side git
//      hook can intercept it because no local commit ever happens.
//   2. GitHub stamps that commit with the merging account's PRIMARY email.
//   3. The bot account did NOT have "Keep my email addresses private"
//      enabled, so its primary email was a personal address.
//
// THE REAL FIX is the GitHub setting, not the account choice:
//   Settings → Emails → [x] Keep my email addresses private
//   https://github.com/settings/emails   (while signed in AS THE BOT)
// With that enabled, server-side commits use <id>+<login>@users.noreply.github.com.
//
// This script is the belt-and-braces check for that setting.
//
// USAGE
//   node scripts/check-merge-identity.mjs && gh pr merge <N> --merge
//
// The `&&` matters — it is what makes the guard load-bearing rather than
// advisory. If the check fails, the merge never runs.

import { execFileSync } from 'node:child_process';

const FORBIDDEN_EMAIL_RE = /@(gmail|googlemail|outlook|hotmail|yahoo|proton(mail)?|icloud|me|aol)\./i;
const NOREPLY = '@users.noreply.github.com';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

let failed = false;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log('\nPre-merge identity check\n' + '─'.repeat(64));

// ─── 1. Which account will author the server-side merge commit? ─────────
let login = '(unknown)';
try {
  login = JSON.parse(sh('gh', ['api', 'user'])).login || '(unknown)';
  console.log(`  active gh account: ${login}`);
} catch (e) {
  fail(`could not determine the active gh account: ${e.message}`);
}

// ─── 2. Is that account's PRIMARY email private? ────────────────────────
// This is the value GitHub actually stamps on the merge commit. It is NOT
// `gh api user`.email — that field is the PUBLIC profile email and is null
// whenever the profile email is unset, which reads as "safe" even when the
// primary email is a personal address. That false-negative is exactly how
// 8f5b0f2 slipped through, so read the real list instead.
try {
  const emails = JSON.parse(sh('gh', ['api', 'user/emails']));
  const primary = emails.find((e) => e.primary) || emails[0];
  if (!primary) {
    fail('no primary email visible on the active account — cannot verify');
  } else if (primary.email.endsWith(NOREPLY)) {
    ok(`primary email is the noreply address (${primary.email})`);
  } else if (FORBIDDEN_EMAIL_RE.test(primary.email)) {
    fail(`primary email is PERSONAL: ${primary.email}`);
    fail('a server-side merge commit WOULD be stamped with it');
  } else {
    fail(`primary email is not a noreply address: ${primary.email} — verify before merging`);
  }
} catch (e) {
  // The token may lack the `user` scope (the bot token has it; some others do
  // not). Refuse rather than guess: a guard that cannot read the deciding
  // value must never report "safe". That false pass is the whole bug.
  fail('cannot read the account\'s primary email (token likely missing the "user" scope)');
  fail('run: gh auth refresh -h github.com -s user   — then re-run this check');
  console.error(`         (${e.message.split('\n')[0]})`);
}

// ─── 3. Do the commits being merged carry a clean identity? ─────────────
try {
  const base = process.argv[2] || 'origin/master';
  const authors = sh('git', ['log', '--format=%an <%ae>', `${base}..HEAD`])
    .split('\n').filter(Boolean);
  const bad = [...new Set(authors.filter((a) => FORBIDDEN_EMAIL_RE.test(a)))];
  if (bad.length) bad.forEach((a) => fail(`commit authored with a personal identity: ${a}`));
  else if (authors.length) ok(`${authors.length} commit(s) carry a clean identity`);
} catch (e) {
  console.log(`  · skipped commit-author scan (${e.message.split('\n')[0]})`);
}

console.log('─'.repeat(64));
if (failed) {
  console.error(`
  MERGE BLOCKED.

  Most likely fix — enable email privacy ON THE MERGING ACCOUNT:
    1. Sign in to github.com as ${login}
    2. Settings → Emails → [x] Keep my email addresses private
       https://github.com/settings/emails
    3. Re-run this check

  This is the setting that governs SERVER-SIDE merge commits. Local
  git config does not affect them.

  If the active account is wrong instead:
    gh auth switch --user Sentinel-Autonomybuilder
       (the bot; gh reports the pre-rename name — same token as
        Sentinel-Bluebuilder, which returns "no accounts matched")

  \`gh auth switch\` may revert between commands, so always re-verify
  IMMEDIATELY before merging, never once at the start of a session.
`);
  process.exit(1);
}

console.log('\n  Safe to merge.\n');
process.exit(0);
