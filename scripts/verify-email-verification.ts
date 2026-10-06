/**
 * Exercises confirming an owner's email address, and what a password change
 * does to the account's other sessions, over HTTP, the way the corporate
 * website's server calls them.
 *
 *   pnpm dev                       # in one terminal
 *   pnpm verify:email-verification
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
const RUN = `verify-email-${Date.now()}`;
const EMAIL = `${RUN}@example.invalid`;
const NEW_EMAIL = `${RUN}-new@example.invalid`;
const PASSWORD = "first-password-1";

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { error: text.slice(0, 200) } };
  }
}

const internal = { authorization: `Bearer ${SECRET}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ask = (email: unknown, headers: Record<string, string> = internal) => call("POST", "/api/customer/email-verification/request", { email }, headers);
const confirm = (token: string) => call("POST", "/api/customer/email-verification/confirm", { token });
const me = (token: string) => call("GET", "/api/customer/me", undefined, bearer(token));
const signIn = (email: string, password: string) => call("POST", "/api/customer/signin", { email, password });

async function main() {
  console.log(`Run ${RUN} against ${BASE}`);
  if (!SECRET) throw new Error("INTERNAL_API_SECRET is not set in .env.");

  const registered = await call("POST", "/api/customer/register", { businessName: `${RUN} shop`, contactName: "Verify Tester", email: EMAIL, password: PASSWORD });
  if (!registered.body.ok) throw new Error(`Could not register the test account: ${registered.body.error}`);
  const session = registered.body.token as string;
  const customer = await db.customer.findUniqueOrThrow({ where: { email: EMAIL } });

  group("A new account");
  checkEqual("registering says the address is not confirmed", registered.body.customer?.emailVerified, false);
  checkEqual("and so does the account's own summary", (await me(session)).body.customer?.emailVerified, false);

  group("Who may ask for a link");
  checkEqual("no shared secret", (await ask(EMAIL, {})).status, 401);
  checkEqual("a wrong shared secret", (await ask(EMAIL, { authorization: "Bearer wrong-secret-wrong-secret" })).status, 401);
  checkEqual("the owner's own session is not enough", (await ask(EMAIL, bearer(session))).status, 401);
  checkEqual("none of those made a link", await db.customerEmailVerification.count({ where: { customerId: customer.id } }), 0);

  group("Asking");
  const unknown = await ask(`nobody-${RUN}@example.invalid`);
  check("an address with no account gets no link, and no error", unknown.status === 200 && unknown.body.ok === true && unknown.body.verification === null);
  const asked = await ask(EMAIL);
  const token = (asked.body.verification?.token ?? "") as string;
  check("a real, unconfirmed account gets a link token", asked.status === 200 && token.length >= 40);
  checkEqual("that works for a day", asked.body.verification?.validForHours, 24);
  const stored = await db.customerEmailVerification.findMany({ where: { customerId: customer.id } });
  check("only the token's hash is stored, with the address it is for", stored.length === 1 && stored[0]!.tokenHash === createHash("sha256").update(token).digest("hex") && stored[0]!.email === EMAIL);
  checkEqual("asking confirms nothing", (await me(session)).body.customer?.emailVerified, false);

  group("Using the link");
  checkEqual("a made-up link is refused", (await confirm("not-a-real-token-not-a-real-token")).status, 410);
  const used = await confirm(token);
  check("the real link confirms the address", used.status === 200 && used.body.ok === true && used.body.email === EMAIL && used.body.alreadyVerified === false, used.body.error);
  checkEqual("the account now reads as confirmed", (await me(session)).body.customer?.emailVerified, true);
  checkEqual("and signing in says so too", (await signIn(EMAIL, PASSWORD)).body.customer?.emailVerified, true);
  const again = await confirm(token);
  check("the same link opened again still says confirmed, not expired", again.status === 200 && again.body.alreadyVerified === true);
  check("a confirmed account is not sent another link", (await ask(EMAIL)).body.verification === null);

  group("A changed address");
  const changed = await call("POST", "/api/customer/profile", { name: "Verify Tester", email: NEW_EMAIL }, bearer(session));
  check("the profile accepts a new address", changed.status === 200 && changed.body.ok === true, changed.body.error);
  const sameAgain = await call("POST", "/api/customer/profile", { name: "Verify T.", email: NEW_EMAIL }, bearer(session));
  check("saving the profile again with the same address is accepted", sameAgain.body.ok === true);
  checkEqual("a new address is not confirmed", (await me(session)).body.customer?.emailVerified, false);
  check("the old link no longer confirms anything", (await confirm(token)).status === 410);
  checkEqual("and the account still reads as not confirmed", (await me(session)).body.customer?.emailVerified, false);
  const second = (await ask(NEW_EMAIL)).body.verification?.token as string;
  check("a link for the new address confirms it", !!second && (await confirm(second)).status === 200 && (await me(session)).body.customer?.emailVerified === true);

  group("Limits");
  await db.customer.update({ where: { id: customer.id }, data: { emailVerifiedAt: null } });
  await db.customerEmailVerification.deleteMany({ where: { customerId: customer.id } });
  const replies = [];
  for (let i = 0; i < 5; i++) replies.push(await ask(NEW_EMAIL));
  checkEqual("five requests in a row make three links", replies.filter((r) => r.body.verification).length, 3);
  const late = replies[0]!.body.verification.token as string;
  await db.customerEmailVerification.updateMany({ where: { customerId: customer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  checkEqual("a link past its day is refused", (await confirm(late)).status, 410);
  checkEqual("and confirms nothing", (await me(session)).body.customer?.emailVerified, false);

  group("A password change and the account's other sessions");
  const other = (await signIn(NEW_EMAIL, PASSWORD)).body.token as string;
  const third = (await signIn(NEW_EMAIL, PASSWORD)).body.token as string;
  check("three sessions are open", (await me(session)).status === 200 && (await me(other)).status === 200 && (await me(third)).status === 200);
  const wrong = await call("POST", "/api/customer/change-password", { currentPassword: "not-the-password", newPassword: "second-password-2" }, bearer(session));
  check("a wrong current password changes nothing and ends nothing", wrong.status === 422 && (await me(other)).status === 200);
  const change = await call("POST", "/api/customer/change-password", { currentPassword: PASSWORD, newPassword: "second-password-2" }, bearer(session));
  check("the password is changed", change.status === 200 && change.body.ok === true && change.body.customerId === customer.id, change.body.error);
  checkEqual("the session that changed it stays signed in", (await me(session)).status, 200);
  check("every other session is signed out", (await me(other)).status === 401 && (await me(third)).status === 401);
  checkEqual("and exactly one session is left", await db.customerSession.count({ where: { customerId: customer.id } }), 1);
  check("the new password signs in and the old does not", (await signIn(NEW_EMAIL, "second-password-2")).status === 200 && (await signIn(NEW_EMAIL, PASSWORD)).status === 401);
}

async function teardown() {
  for (const email of [EMAIL, NEW_EMAIL]) {
    const customer = await db.customer.findUnique({ where: { email } });
    if (!customer) continue;
    await db.shop.deleteMany({ where: { customerId: customer.id } });
    await db.customer.delete({ where: { id: customer.id } });
  }
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("Owner email confirmation and password change");
  await db.$disconnect();
}
