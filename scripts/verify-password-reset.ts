/**
 * Exercises "forgot password" for a shop owner's account, over HTTP, the way
 * the corporate website's server calls it.
 *
 *   pnpm dev                       # in one terminal
 *   pnpm verify:password-reset
 *
 * Point somewhere else with VERIFY_BASE_URL. Needs INTERNAL_API_SECRET in .env,
 * the same value the running app has.
 *
 * It registers one throwaway account through the real register route and
 * removes it (and its shop) afterwards.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { createHash } from "node:crypto";

import { db } from "~/server/db";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_API_SECRET ?? "";
const RUN = `verify-reset-${Date.now()}`;
const EMAIL = `${RUN}@example.invalid`;
const FIRST_PASSWORD = "first-password-1";

interface Reply {
  status: number;
  body: { ok?: boolean; error?: string; token?: string; live?: boolean; reset?: { token: string; email: string; name: string | null; validForMinutes: number } | null };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Reply["body"] };
  } catch {
    return { status: response.status, body: { error: text.slice(0, 200) } };
  }
}

const internal = { authorization: `Bearer ${SECRET}` };
const requestReset = (email: unknown, headers = internal) => post("/api/customer/password-reset/request", { email }, headers);
const confirm = (token: string, newPassword?: string) =>
  post("/api/customer/password-reset/confirm", newPassword === undefined ? { token } : { token, newPassword });
const signIn = (password: string) => post("/api/customer/signin", { email: EMAIL, password });

async function main() {
  console.log(`Run ${RUN} against ${BASE}`);
  if (!SECRET) throw new Error("INTERNAL_API_SECRET is not set in .env.");

  const registered = await post("/api/customer/register", { businessName: `${RUN} shop`, contactName: "Reset Tester", email: EMAIL, password: FIRST_PASSWORD });
  if (!registered.body.ok) throw new Error(`Could not register the test account: ${registered.body.error}`);
  const customer = await db.customer.findUniqueOrThrow({ where: { email: EMAIL } });
  const sessionBefore = registered.body.token!;

  group("Who may ask for a link");
  checkEqual("no shared secret", (await requestReset(EMAIL, {} as typeof internal)).status, 401);
  checkEqual("a wrong shared secret", (await requestReset(EMAIL, { authorization: "Bearer wrong-secret-wrong-secret" })).status, 401);
  checkEqual("neither made a link", await db.customerPasswordReset.count({ where: { customerId: customer.id } }), 0);

  group("Asking");
  const unknown = await requestReset(`nobody-${RUN}@example.invalid`);
  check("an address with no account gets no link, and no error", unknown.status === 200 && unknown.body.ok === true && unknown.body.reset === null);
  check("something that is not an email address gets no link", (await requestReset("not an email")).body.reset === null);

  const asked = await requestReset(EMAIL);
  const token = asked.body.reset?.token ?? "";
  check("a real account gets a link token", asked.status === 200 && token.length >= 40);
  checkEqual("with the account's email", asked.body.reset?.email, EMAIL);
  checkEqual("and how long it works for", asked.body.reset?.validForMinutes, 30);
  const stored = await db.customerPasswordReset.findMany({ where: { customerId: customer.id } });
  check("only the token's hash is stored", stored.length === 1 && stored[0]!.tokenHash === createHash("sha256").update(token).digest("hex") && stored[0]!.tokenHash !== token);
  checkEqual("asking does not change the password", (await signIn(FIRST_PASSWORD)).status, 200);
  check("the address is in upper case on the form, and the same account is found", (await requestReset(EMAIL.toUpperCase())).body.reset?.email === EMAIL);

  group("Using the link");
  check("the link reads as usable", (await confirm(token)).body.live === true);
  check("a made-up link reads as not usable", (await confirm("not-a-real-token-not-a-real-token")).body.live === false);
  const tooShort = await confirm(token, "short");
  checkEqual("a password that breaks the rule is refused as a password", tooShort.status, 422);
  check("and does not use the link up", (await confirm(token)).body.live === true);

  const sessionsBefore = await db.customerSession.count({ where: { customerId: customer.id } });
  const used = await confirm(token, "second-password-2");
  check("a good password is accepted", used.status === 200 && used.body.ok === true, used.body.error);
  checkEqual("the new password signs in", (await signIn("second-password-2")).status, 200);
  checkEqual("the old password no longer does", (await signIn(FIRST_PASSWORD)).status, 401);
  check("every session from before is gone", sessionsBefore > 0 && (await db.customerSession.count({ where: { token: sessionBefore } })) === 0);
  check("the email now counts as verified", (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).emailVerifiedAt !== null);
  checkEqual("the link does not work a second time", (await confirm(token, "third-password-3")).status, 410);
  check("and reads as not usable", (await confirm(token)).body.live === false);
  checkEqual("the other link that was outstanding is dead too", await db.customerPasswordReset.count({ where: { customerId: customer.id, usedAt: null } }), 0);
  checkEqual("the password is still the second one", (await signIn("second-password-2")).status, 200);

  group("Limits");
  await db.customerPasswordReset.deleteMany({ where: { customerId: customer.id } });
  const replies = [];
  for (let i = 0; i < 5; i++) replies.push(await requestReset(EMAIL));
  checkEqual("five requests in a row make three links", replies.filter((r) => r.body.reset).length, 3);
  check("the refused ones look like an address with no account", replies.slice(3).every((r) => r.status === 200 && r.body.ok === true && r.body.reset === null));

  const late = replies[0]!.body.reset!.token;
  await db.customerPasswordReset.updateMany({ where: { customerId: customer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check("a link past its 30 minutes reads as not usable", (await confirm(late)).body.live === false);
  checkEqual("and is refused", (await confirm(late, "fourth-password-4")).status, 410);
  checkEqual("the password is unchanged by it", (await signIn("second-password-2")).status, 200);

  group("Two at once");
  await db.customerPasswordReset.deleteMany({ where: { customerId: customer.id } });
  const racing = (await requestReset(EMAIL)).body.reset!.token;
  const both = await Promise.all([confirm(racing, "race-password-a1"), confirm(racing, "race-password-b2")]);
  checkEqual("the same link used twice at the same moment works once", both.filter((r) => r.status === 200).length, 1);
  const winner = both[0]!.status === 200 ? "race-password-a1" : "race-password-b2";
  const loser = winner === "race-password-a1" ? "race-password-b2" : "race-password-a1";
  check("and the password is the one from the request that won", (await signIn(winner)).status === 200 && (await signIn(loser)).status === 401);
}

async function teardown() {
  const customer = await db.customer.findUnique({ where: { email: EMAIL } });
  if (!customer) return;
  await db.shop.deleteMany({ where: { customerId: customer.id } });
  await db.customer.delete({ where: { id: customer.id } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("Owner password reset");
  await db.$disconnect();
}
