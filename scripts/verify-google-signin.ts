/**
 * Exercises "Continue with Google" for a shop owner's account, over HTTP, the way the
 * corporate website's server calls it once Google has vouched for an email address.
 *
 *   pnpm dev                       # in one terminal
 *   pnpm verify:google-signin
 *
 * Point somewhere else with VERIFY_BASE_URL. Needs INTERNAL_API_SECRET in .env, the same
 * value the running app has.
 *
 * It makes three throwaway accounts and removes them (and their shops) afterwards.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { db } from "~/server/db";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_API_SECRET ?? "";
const RUN = `verify-google-${Date.now()}`;
const NEW = `${RUN}-new@example.invalid`;
const UNCONFIRMED = `${RUN}-unconfirmed@example.invalid`;
const CONFIRMED = `${RUN}-confirmed@example.invalid`;
const PASSWORD = "first-password-1";

interface Reply {
  status: number;
  body: {
    ok?: boolean;
    error?: string;
    token?: string;
    needsDetails?: boolean;
    created?: boolean;
    customer?: { id: string; email: string; name: string | null; shopName: string; emailVerified: boolean };
  };
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Reply["body"] };
  } catch {
    return { status: response.status, body: { error: text.slice(0, 200) } };
  }
}

const internal = { authorization: `Bearer ${SECRET}` };
const google = (body: unknown, headers: Record<string, string> = internal) => call("POST", "/api/customer/google", body, headers);
const register = (email: string) =>
  call("POST", "/api/customer/register", { businessName: `${RUN} shop`, contactName: "Typed Name", email, password: PASSWORD });
const signIn = (email: string) => call("POST", "/api/customer/signin", { email, password: PASSWORD });
const me = (token: string) => call("GET", "/api/customer/me", undefined, { authorization: `Bearer ${token}` });

async function main() {
  console.log(`Run ${RUN} against ${BASE}`);
  if (!SECRET) throw new Error("INTERNAL_API_SECRET is not set in .env.");

  group("Who may call");
  checkEqual("no shared secret", (await google({ email: NEW, businessName: "x" }, {})).status, 401);
  checkEqual("a wrong shared secret", (await google({ email: NEW, businessName: "x" }, { authorization: "Bearer wrong-secret-wrong-secret" })).status, 401);
  checkEqual("neither made an account", await db.customer.count({ where: { email: NEW } }), 0);
  checkEqual("something that is not an email address", (await google({ email: "not-an-address" })).status, 422);

  group("An address nobody has");
  const asked = await google({ email: NEW, name: "Mary Byrne" });
  check("with no business name, it asks for one", asked.status === 200 && asked.body.ok === false && asked.body.needsDetails === true);
  checkEqual("and makes nothing", await db.customer.count({ where: { email: NEW } }), 0);

  const made = await google({ email: NEW.toUpperCase(), name: "Mary Byrne", businessName: `${RUN} new shop`, phone: "087 000 0000" });
  check("with one, the account is made", made.status === 200 && made.body.ok === true && made.body.created === true);
  const fresh = await db.customer.findUnique({ where: { email: NEW }, include: { shops: true } });
  check("under the address in lower case", fresh !== null);
  check("with its email confirmed and no password", fresh?.emailVerifiedAt != null && fresh?.passwordHash === null);
  checkEqual("the name from Google", fresh?.name, "Mary Byrne");
  checkEqual("one shop, with the business name", fresh?.shops.map((shop) => shop.name).join(), `${RUN} new shop`);
  checkEqual("and the phone number", fresh?.shops[0]?.phone, "087 000 0000");
  checkEqual("its session works", (await me(made.body.token!)).status, 200);

  const again = await google({ email: NEW, name: "Mary Byrne" });
  check("the same address again signs in to that account", again.body.ok === true && again.body.created === false && again.body.customer?.id === fresh?.id);
  checkEqual("and makes no second one", await db.customer.count({ where: { email: NEW } }), 1);

  group("An account registered with a password, its email confirmed");
  const confirmed = await register(CONFIRMED);
  if (!confirmed.body.ok) throw new Error(`Could not register a test account: ${confirmed.body.error}`);
  await db.customer.update({ where: { email: CONFIRMED }, data: { emailVerifiedAt: new Date() } });
  const linked = await google({ email: CONFIRMED, name: "Google Name" });
  check("Google signs in to the same account", linked.body.ok === true && linked.body.created === false && linked.body.customer?.id === confirmed.body.customer?.id);
  checkEqual("the name typed at registration is kept", linked.body.customer?.name, "Typed Name");
  checkEqual("the password still works", (await signIn(CONFIRMED)).status, 200);
  checkEqual("and the session from before is still signed in", (await me(confirmed.body.token!)).status, 200);

  group("An account registered with a password, its email never confirmed");
  const unconfirmed = await register(UNCONFIRMED);
  if (!unconfirmed.body.ok) throw new Error(`Could not register a test account: ${unconfirmed.body.error}`);
  const taken = await google({ email: UNCONFIRMED });
  check("Google signs in to the same account", taken.body.ok === true && taken.body.customer?.id === unconfirmed.body.customer?.id);
  check("which now counts as confirmed", taken.body.customer?.emailVerified === true);
  checkEqual("the password no longer works", (await signIn(UNCONFIRMED)).status, 401);
  checkEqual("the session from before is signed out", (await me(unconfirmed.body.token!)).status, 401);
  checkEqual("the Google session works", (await me(taken.body.token!)).status, 200);
}

async function teardown() {
  for (const email of [NEW, UNCONFIRMED, CONFIRMED]) {
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
  summarize("Owner sign-in with Google");
  await db.$disconnect();
}
