/**
 * Exercises changing, removing and taking offline a shop's website address
 * (`server/shops.ts`), against the database in .env. No server needed.
 *
 *   pnpm verify:subdomain
 *
 * It makes two throwaway accounts with one shop each and removes them, and the
 * names they gave up, afterwards.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { db } from "~/server/db";
import {
  activateSubdomain,
  changeSubdomain,
  checkSlugAvailability,
  removeSubdomain,
  setShopPublished,
} from "~/server/shops";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const RUN = `vsub${Date.now()}`;
const name = (n: number) => `${RUN}-${n}`;
const admin = { admin: "verify@example.invalid" };

async function account(label: string) {
  const customer = await db.customer.create({ data: { email: `${RUN}-${label}@example.invalid`, name: label, shopLimit: 1 } });
  const shop = await db.shop.create({ data: { name: `${RUN} ${label}`, customerId: customer.id } });
  return { customer: { customerId: customer.id }, shopId: shop.id };
}

const subdomainOf = async (shopId: string) => (await db.shop.findUniqueOrThrow({ where: { id: shopId } })).subdomain;

async function main() {
  console.log(`Run ${RUN}`);
  const a = await account("a");
  const b = await account("b");

  group("Before a shop has an address");
  check("there is nothing to change", !(await changeSubdomain(a.shopId, name(1), a.customer)).ok);
  check("and nothing to take offline", !(await setShopPublished(a.shopId, false, a.customer)).ok);

  group("Changing it");
  check("activated", (await activateSubdomain(a.customer.customerId, a.shopId, name(1))).ok);
  check("activated for the other shop", (await activateSubdomain(b.customer.customerId, b.shopId, name(9))).ok);
  check("someone else's shop is refused", !(await changeSubdomain(a.shopId, name(2), b.customer)).ok);
  check("the same name is refused", !(await changeSubdomain(a.shopId, name(1), a.customer)).ok);
  check("a name in use is refused", !(await changeSubdomain(a.shopId, name(9), a.customer)).ok);
  check("a reserved word is refused", !(await changeSubdomain(a.shopId, "admin", a.customer)).ok);
  check("a name that is not a subdomain is refused", !(await changeSubdomain(a.shopId, "Not A Name", a.customer)).ok);
  checkEqual("none of those changed anything", await subdomainOf(a.shopId), name(1));

  const first = await changeSubdomain(a.shopId, name(2), a.customer);
  check("a free name is accepted, and the old one named", first.ok && first.subdomain === name(2) && first.previous === name(1));
  checkEqual("the shop has the new name", await subdomainOf(a.shopId), name(2));

  group("The name given up");
  check("is not available to another shop", !(await checkSlugAvailability(name(1), b.shopId)).available);
  check("nor to nobody in particular", !(await checkSlugAvailability(name(1))).available);
  check("another shop cannot move to it", !(await changeSubdomain(b.shopId, name(1), b.customer)).ok);
  check("is available to the shop that gave it up", (await checkSlugAvailability(name(1), a.shopId)).available);
  check("which can take it back", (await changeSubdomain(a.shopId, name(1), a.customer)).ok);
  check("and it is no longer on the given-up list", (await db.retiredSubdomain.findUnique({ where: { subdomain: name(1) } })) === null);
  await db.retiredSubdomain.updateMany({ where: { subdomain: name(2) }, data: { retiredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
  check("after 30 days anyone may have it", (await checkSlugAvailability(name(2), b.shopId)).available);

  group("How often");
  // Two so far (1 to 2, 2 to 1), but the second took a name off the list and the 31-day-old one no longer counts.
  await db.retiredSubdomain.deleteMany({ where: { shopId: a.shopId } });
  for (const n of [3, 4, 5]) check(`change ${n - 2} of 3 is accepted`, (await changeSubdomain(a.shopId, name(n), a.customer)).ok);
  const fourth = await changeSubdomain(a.shopId, name(6), a.customer);
  check("the owner's fourth in 30 days is refused", !fourth.ok && /Contact us/.test(fourth.error));
  check("staff can still make it", (await changeSubdomain(a.shopId, name(6), admin)).ok);

  group("Offline and back");
  const off = await setShopPublished(a.shopId, false, a.customer);
  check("taken offline, keeping the address", off.ok && !off.isPublished && off.subdomain === name(6));
  checkEqual("the shop row says so", (await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).isPublished, false);
  check("someone else cannot put it back", !(await setShopPublished(a.shopId, true, b.customer)).ok);
  const on = await setShopPublished(a.shopId, true, a.customer);
  check("put back", on.ok && on.isPublished);

  group("Removing it");
  const removed = await removeSubdomain(a.shopId, admin);
  check("removed, and the old name named", removed.ok && removed.previous === name(6));
  const after = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
  check("the shop has no address and is not published", after.subdomain === null && !after.isPublished);
  check("a second removal is refused", !(await removeSubdomain(a.shopId, admin)).ok);
  check("the name is held from other shops", !(await checkSlugAvailability(name(6), b.shopId)).available);
  check("the shop can be activated again on it", (await activateSubdomain(a.customer.customerId, a.shopId, name(6))).ok);
  check("and is published again", (await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).isPublished);
}

async function teardown() {
  const customers = await db.customer.findMany({ where: { email: { startsWith: `${RUN}-` } } });
  const ids = customers.map((customer) => customer.id);
  const shops = await db.shop.findMany({ where: { customerId: { in: ids } } });
  await db.retiredSubdomain.deleteMany({ where: { shopId: { in: shops.map((shop) => shop.id) } } });
  await db.shop.deleteMany({ where: { customerId: { in: ids } } });
  await db.customer.deleteMany({ where: { id: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { summary: { contains: RUN } } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("Shop website address");
  await db.$disconnect();
}
